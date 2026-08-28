/**
 * Batch runner: read a directory of ticketing-export JSON files, predict the
 * service each customer travelled on, assess Delay Repay entitlement, and
 * print a verdict per coupon.
 *
 *   npm run batch -- <dir> [--verbose]
 *
 * Each JSON file is the raw export shape (Response[].Tickets[].Ticket with a
 * Scans array). Results are written to <dir>/results.json with the full
 * explanation trail; the console shows a compact summary.
 */

import 'dotenv/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDb } from './db/schema.js';
import { HspClient } from './hsp/client.js';
import { assessCoupon } from './predict/assess.js';
import { parseItineraryLegs, type RawItinerary } from './predict/itinerary.js';
import { BatchDataProvider } from './predict/provider.js';
import { findRstFile, loadRestrictions, type RestrictionDefinition } from './predict/restrictions.js';
import { findRteFile, loadRouteDefinitions, type RouteDefinition } from './predict/routes.js';
import { extractConstraints, groupByCoupon, normaliseScans, type RawScan } from './predict/scans.js';
import { RouteingGuide } from './routeing/guide.js';
import type { CouponType, CouponVerdict, IntendedLeg, PlannedItinerary, ScanEvent, TicketInfo } from './predict/types.js';
import { parseHHMM } from './timetable/lookup.js';

const DB_PATH = 'data/spike.db';

interface RawTicket {
  readonly UTN: string;
  readonly FTOT: string;
  readonly OriginNLC: string;
  readonly DestinationNLC: string;
  readonly purchase_price: number;
  readonly StartDate: string;
  readonly TimeValidFrom?: string;
  readonly RouteCode?: string;
  readonly Itinerary?: readonly RawItinerary[];
  readonly Scans?: readonly { readonly Scan: RawScan }[];
}

function extractTickets(json: unknown): RawTicket[] {
  const tickets: RawTicket[] = [];
  const response = (json as { Response?: unknown[] }).Response;
  if (!Array.isArray(response)) return tickets;
  for (const entry of response) {
    const list = (entry as { Tickets?: { Ticket: RawTicket }[] }).Tickets ?? [];
    for (const t of list) if (t.Ticket) tickets.push(t.Ticket);
  }
  return tickets;
}

function entryFor(constraints: ReturnType<typeof extractConstraints>, crs: string): number | null {
  return constraints.entry && constraints.entry.crs === crs ? constraints.entry.timeMinutes : null;
}

function exitFor(constraints: ReturnType<typeof extractConstraints>, crs: string): number | null {
  return constraints.exit && constraints.exit.crs === crs ? constraints.exit.timeMinutes : null;
}

async function assessTicket(
  raw: RawTicket,
  db: ReturnType<typeof openDb>,
  hsp: HspClient,
  routes: Map<string, RouteDefinition>,
  guide: RouteingGuide | null,
  restrictions: Map<string, RestrictionDefinition>,
): Promise<CouponVerdict[]> {
  const provider = new BatchDataProvider(db, hsp, raw.StartDate);
  const routeDef = raw.RouteCode ? routes.get(raw.RouteCode) ?? null : null;
  const resolveRouteingPoints = guide ? (crs: string): string[] => guide.routeingPointsFor(crs) : undefined;
  const restrictionCode = provider.restrictionCodeFor(raw.OriginNLC, raw.DestinationNLC, raw.FTOT, raw.RouteCode ?? null);
  const restrictionDef = restrictionCode ? restrictions.get(restrictionCode) ?? null : null;
  const rawScans = (raw.Scans ?? []).map((s) => s.Scan);
  const scans: ScanEvent[] = normaliseScans(rawScans, (nlc) => provider.nlcToCrs(nlc));
  const meta = provider.ticketMeta(raw.FTOT);

  const originCrs = provider.resolveCrs(raw.OriginNLC, scans);
  const destCrs = provider.resolveCrs(raw.DestinationNLC, scans);
  const timeValidFrom = raw.TimeValidFrom && raw.TimeValidFrom !== '00:00' ? raw.TimeValidFrom : null;

  const ticket: TicketInfo = {
    utn: raw.UTN,
    ftot: raw.FTOT,
    originNlc: raw.OriginNLC,
    destinationNlc: raw.DestinationNLC,
    routeCode: raw.RouteCode ?? null,
    pricePence: raw.purchase_price,
    startDate: raw.StartDate,
    timeValidFrom,
    kind: meta.kind,
    fareType: meta.fareType,
    hasTimeRestriction: meta.hasTimeRestriction,
  };

  const groups = groupByCoupon(scans);
  const verdicts: CouponVerdict[] = [];

  for (const coupon of groups.keys()) {
    const couponScans = groups.get(coupon)!;
    const constraints = extractConstraints(coupon, couponScans);
    const plannedLegs = parseItineraryLegs(raw.Itinerary, coupon);

    // The itinerary, when present, is authoritative for the journey endpoints.
    // This is how a "London Terminals" (1072) destination gets its true
    // terminal: the itinerary names it (via its final service), rather than the
    // tool guessing a terminus from a clip or an arbitrary group member.
    const [fromCrs, toCrs] =
      plannedLegs && plannedLegs.length > 0
        ? [plannedLegs[0]!.originCrs, plannedLegs[plannedLegs.length - 1]!.destinationCrs]
        : coupon === 'Return'
          ? [destCrs, originCrs]
          : [originCrs, destCrs];

    if (!fromCrs || !toCrs) {
      verdicts.push(unresolved(coupon, 'NO_TRAVEL_EVIDENCE', 'Could not resolve origin/destination CRS.'));
      continue;
    }

    try {
      let itineraries: PlannedItinerary[];
      let bookedLegs: IntendedLeg[] | null = null;

      if (plannedLegs) {
        // Use the customer's planned itinerary: it pins the legs directly.
        itineraries = [await provider.itineraryActuals(plannedLegs, exitFor(constraints, toCrs))];
        bookedLegs = meta.kind === 'advance' ? plannedLegs : null;
      } else if (meta.kind === 'advance') {
        // No itinerary supplied: infer the booked service from TimeValidFrom.
        const bookedDeparture = timeValidFrom
          ? parseHHMM(timeValidFrom.replace(':', ''))
          : entryFor(constraints, fromCrs) ?? 12 * 60;
        const built = await provider.advanceItinerary(fromCrs, toCrs, bookedDeparture);
        itineraries = built.itineraries;
        bookedLegs = built.bookedLegs;
      } else {
        itineraries = await provider.walkUpItineraries(
          fromCrs,
          toCrs,
          entryFor(constraints, fromCrs),
          exitFor(constraints, toCrs),
        );
      }

      if (itineraries.length === 0) {
        verdicts.push(unresolved(coupon, 'SERVICE_UNRESOLVED', `No services found for ${fromCrs}->${toCrs} on ${raw.StartDate}.`));
        continue;
      }

      verdicts.push(
        assessCoupon({ ticket, coupon, fromCrs, toCrs, constraints, itineraries, bookedLegs, routeDef, resolveRouteingPoints, restrictionDef, itineraryPinned: plannedLegs != null }),
      );
    } catch (err) {
      verdicts.push(unresolved(coupon, 'NO_HSP_DATA_YET', `HSP lookup failed: ${(err as Error).message}`));
    }
  }

  return verdicts;
}

function unresolved(coupon: CouponType, reason: string, note: string): CouponVerdict {
  return {
    coupon,
    entitled: false,
    reason,
    confidence: 'UNKNOWN',
    predictedLegs: [],
    delayMinutes: null,
    band: null,
    compensationPence: null,
    anomalies: [],
    explanation: [note],
  };
}

function money(pence: number | null): string {
  return pence === null ? '-' : `£${(pence / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.log('Usage: npm run batch -- <dir of ticket JSON files> [--verbose]');
    process.exit(1);
  }

  const username = process.env.NRDP_USERNAME;
  const password = process.env.NRDP_PASSWORD;
  if (!username || !password) {
    console.error('Missing NRDP_USERNAME or NRDP_PASSWORD in .env.');
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  const hsp = new HspClient({ username, password });

  const rteFile = await findRteFile(path.join('data', 'fares'));
  const routes = rteFile ? await loadRouteDefinitions(rteFile) : new Map<string, RouteDefinition>();
  if (!rteFile) console.log('Note: no .RTE file found in data/fares - route codes will not be checked.\n');

  const guide = await RouteingGuide.load().catch(() => {
    console.log('Note: routeing guide not loaded - "via" checks will use raw station codes only.\n');
    return null;
  });

  const rstFile = await findRstFile(path.join('data', 'fares'));
  const restrictions = rstFile ? await loadRestrictions(rstFile) : new Map<string, RestrictionDefinition>();
  if (!rstFile) console.log('Note: no .RST file found - off-peak restrictions will not be checked.\n');

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'results.json').sort();
  const results: { utn: string; coupons: CouponVerdict[] }[] = [];

  console.log(`\nUTN            Coupon    Entitled  Delay  Band    Comp     Confidence  Reason / notes`);
  console.log('-'.repeat(100));

  for (const file of files) {
    const json = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as unknown;
    for (const ticket of extractTickets(json)) {
      const coupons = await assessTicket(ticket, db, hsp, routes, guide, restrictions);
      results.push({ utn: ticket.UTN, coupons });
      for (const v of coupons) {
        const delay = v.delayMinutes === null ? '-' : `${v.delayMinutes}m`;
        const tail = v.reason ?? (v.anomalies.length > 0 ? `${v.anomalies.length} anomaly flag(s)` : 'ok');
        console.log(
          `${ticket.UTN.padEnd(14)} ${v.coupon.padEnd(9)} ${(v.entitled ? 'YES' : 'no').padEnd(9)} ${delay.padEnd(6)} ` +
            `${(v.band ?? '-').padEnd(7)} ${money(v.compensationPence).padEnd(8)} ${v.confidence.padEnd(11)} ${tail}`,
        );
        if (verbose) for (const line of v.explanation) console.log(`    ${line}`);
      }
    }
  }

  db.close();
  const outPath = path.join(dir, 'results.json');
  await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(`\nFull results with explanations written to ${outPath}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
