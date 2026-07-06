/**
 * Demo CLI: simulate a customer's journey on a given day and decide whether
 * they qualify for Delay Repay.
 *
 *   npm run check -- <origin CRS> <dest CRS> <YYYY-MM-DD> <intended dep HHMM>
 *     [--via <CRS>] [--advance] [--return] [--threshold 15] [--no-cache]
 *
 * Flow:
 *   1. Look up the intended journey in the local timetable (phase-2 SQLite).
 *   2. Query HSP for what the relevant services actually did that day.
 *   3. Run the eligibility engine and print the step-by-step verdict.
 *
 * --advance treats the ticket as a fixed itinerary (must travel on booked
 * services); the default is a flexible ticket (best journey from the intended
 * departure onward). --return splits the compensation as a return fare would.
 */

import 'dotenv/config';
import { openDb } from './db/schema.js';
import { formatMinutes, parseHHMM, scheduledJourneysBetween, type ScheduledJourney } from './timetable/lookup.js';
import { HspClient, type Days } from './hsp/client.js';
import { assessEligibility } from './eligibility/engine.js';
import type { Journey, Leg, ServiceRun } from './eligibility/journey.js';

const DB_PATH = 'data/spike.db';
const INTERCHANGE_MINUTES = 5;
/** How far either side of the target departure to ask HSP for services. */
const WINDOW_BEFORE = 15;
const WINDOW_AFTER = 180;

interface Args {
  readonly origin: string;
  readonly dest: string;
  readonly date: string;
  readonly depMinutes: number;
  readonly via?: string;
  readonly advance: boolean;
  readonly fareReturn: boolean;
  readonly threshold: number;
  readonly cache: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  const positional: string[] = [];
  let via: string | undefined;
  let advance = false;
  let fareReturn = false;
  let threshold = 15;
  let cache = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--via') via = argv[++i]?.toUpperCase();
    else if (arg === '--advance') advance = true;
    else if (arg === '--return') fareReturn = true;
    else if (arg === '--threshold') threshold = Number(argv[++i]);
    else if (arg === '--no-cache') cache = false;
    else positional.push(arg);
  }

  const [origin, dest, date, dep] = positional;
  if (!origin || !dest || !date || !dep) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(dep)) return null;

  return {
    origin: origin.toUpperCase(),
    dest: dest.toUpperCase(),
    date,
    depMinutes: parseHHMM(dep),
    via,
    advance,
    fareReturn,
    threshold: Number.isFinite(threshold) ? threshold : 15,
    cache,
  };
}

function usage(): void {
  console.log(
    [
      'Usage:',
      '  npm run check -- <origin CRS> <dest CRS> <YYYY-MM-DD> <intended dep HHMM>',
      '    [--via <CRS>] [--advance] [--return] [--threshold 15] [--no-cache]',
    ].join('\n'),
  );
}

function daysOfWeek(date: string): Days {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0) return 'SUNDAY';
  if (dow === 6) return 'SATURDAY';
  return 'WEEKDAY';
}

function clampMinutes(m: number): number {
  return Math.max(0, Math.min(1439, m));
}

function toHHMM(minutes: number): string {
  const c = clampMinutes(minutes);
  return `${String(Math.floor(c / 60)).padStart(2, '0')}${String(c % 60).padStart(2, '0')}`;
}

/** HSP time string ("HHMM", "" when N/A) -> minutes since midnight or null. */
function hspTime(raw: string | undefined): number | null {
  if (!raw || raw.trim() === '') return null;
  return parseHHMM(raw);
}

function nearestByDeparture<T extends { scheduledDeparture: number }>(items: readonly T[], target: number): T | undefined {
  if (items.length === 0) return undefined;
  return items.reduce((best, it) =>
    Math.abs(it.scheduledDeparture - target) < Math.abs(best.scheduledDeparture - target) ? it : best,
  );
}

/**
 * Fetches the actual service runs for one leg from HSP: serviceMetrics to find
 * the RIDs on the flow around the target time, then serviceDetails per RID to
 * read the actual arrival/departure at this leg's origin and destination.
 */
async function fetchLegRuns(
  hsp: HspClient,
  originCrs: string,
  destCrs: string,
  date: string,
  days: Days,
  targetDep: number,
): Promise<ServiceRun[]> {
  const metrics = await hsp.serviceMetrics({
    from_loc: originCrs,
    to_loc: destCrs,
    from_time: toHHMM(targetDep - WINDOW_BEFORE),
    to_time: toHHMM(targetDep + WINDOW_AFTER),
    from_date: date,
    to_date: date,
    days,
  });

  const runs: ServiceRun[] = [];
  const seen = new Set<string>();

  for (const entry of metrics.Services) {
    const attrs = entry.serviceAttributesMetrics;
    const scheduledDeparture = hspTime(attrs.gbtt_ptd);
    const scheduledArrival = hspTime(attrs.gbtt_pta);
    if (scheduledDeparture === null || scheduledArrival === null) continue;

    for (const rid of attrs.rids) {
      if (seen.has(rid)) continue;
      seen.add(rid);

      const details = await hsp.serviceDetails(rid);
      const locations = details.serviceAttributesDetails.locations;
      const originLoc = locations.find((l) => l.location === originCrs);
      const destLoc = locations.find((l) => l.location === destCrs);

      const actualDeparture = hspTime(originLoc?.actual_td);
      const actualArrival = hspTime(destLoc?.actual_ta);
      // A cancelled service returns no actual arrival at the destination.
      const cancelled = actualArrival === null;

      runs.push({ id: rid, scheduledDeparture, scheduledArrival, actualDeparture, actualArrival, cancelled });
    }
  }

  return runs.sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
}

/** Turns the chosen HSP run's scheduled times into the intended booked leg. */
function legFromRun(originCrs: string, destCrs: string, run: ServiceRun): Leg {
  return {
    origin: originCrs,
    destination: destCrs,
    scheduledDeparture: run.scheduledDeparture,
    scheduledArrival: run.scheduledArrival,
  };
}

function warnIfTooRecent(date: string): void {
  const target = Date.parse(`${date}T00:00:00Z`);
  const twoDaysAgo = Date.now() - 2 * 86_400_000;
  if (target > twoDaysAgo) {
    console.log('Warning: HSP has no data for today or yesterday. Pick a date at least 2 days in the past.\n');
  }
}

function printTimetableIntent(label: string, journey: ScheduledJourney | undefined, near: string): void {
  if (journey) {
    console.log(
      `Timetable: intended ${label} dep ${formatMinutes(journey.scheduledDeparture)} ` +
        `arr ${formatMinutes(journey.scheduledArrival)} (uid ${journey.uid})`,
    );
  } else {
    console.log(`Timetable: no scheduled ${label} service near ${near}. Falling back to HSP.`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exit(1);
  }

  const username = process.env.NRDP_USERNAME;
  const password = process.env.NRDP_PASSWORD;
  if (!username || !password) {
    console.error('Missing NRDP_USERNAME or NRDP_PASSWORD in .env.');
    process.exit(1);
  }

  warnIfTooRecent(args.date);

  const db = openDb(DB_PATH);
  const hsp = new HspClient({ username, password, cache: args.cache });
  const days = daysOfWeek(args.date);

  const firstDest = args.via ?? args.dest;
  console.log(
    `Checking ${args.origin} -> ${args.via ? `${args.via} -> ` : ''}${args.dest} on ${args.date} ` +
      `(intended dep ${formatMinutes(args.depMinutes)}, ${args.advance ? 'advance' : 'flexible'} ticket, threshold ${args.threshold} min)\n`,
  );

  // Leg 1: look up the intended service in the local timetable, then find the
  // matching HSP run and everything around it.
  const leg1Timetable = nearestByDeparture(
    scheduledJourneysBetween(db, args.origin, firstDest, args.date),
    args.depMinutes,
  );
  printTimetableIntent(`${args.origin}->${firstDest}`, leg1Timetable, formatMinutes(args.depMinutes));

  const leg1Runs = await fetchLegRuns(hsp, args.origin, firstDest, args.date, days, args.depMinutes);
  if (leg1Runs.length === 0) {
    console.error(`\nNo HSP services found for ${args.origin}->${firstDest} around ${formatMinutes(args.depMinutes)} on ${args.date}.`);
    db.close();
    process.exit(1);
  }
  const leg1Booked = nearestByDeparture(leg1Runs, args.depMinutes)!;
  const legs: Leg[] = [legFromRun(args.origin, firstDest, leg1Booked)];
  const servicesByLeg: ServiceRun[][] = [leg1Runs];

  // Leg 2 (only with --via): the booked connection is the earliest scheduled
  // service from the interchange to the destination that leaves after the
  // customer could reasonably change trains.
  if (args.via) {
    const connectionTarget = leg1Booked.scheduledArrival + INTERCHANGE_MINUTES;
    const leg2Timetable = scheduledJourneysBetween(db, args.via, args.dest, args.date)
      .filter((j) => j.scheduledDeparture >= connectionTarget)
      .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture)[0];
    printTimetableIntent(`${args.via}->${args.dest}`, leg2Timetable, formatMinutes(connectionTarget));

    const leg2Runs = await fetchLegRuns(hsp, args.via, args.dest, args.date, days, connectionTarget);
    if (leg2Runs.length === 0) {
      console.error(`\nNo HSP services found for ${args.via}->${args.dest} around ${formatMinutes(connectionTarget)} on ${args.date}.`);
      db.close();
      process.exit(1);
    }
    const leg2Booked =
      leg2Runs.filter((r) => r.scheduledDeparture >= connectionTarget)[0] ?? nearestByDeparture(leg2Runs, connectionTarget)!;
    legs.push(legFromRun(args.via, args.dest, leg2Booked));
    servicesByLeg.push(leg2Runs);
  }

  db.close();

  const journey: Journey = {
    legs,
    ticketKind: args.advance ? 'advance' : 'flexible',
    fareType: args.fareReturn ? 'return' : 'single',
    date: args.date,
    threshold: args.threshold,
    interchangeMinutes: INTERCHANGE_MINUTES,
  };

  const result = assessEligibility(journey, servicesByLeg);

  console.log('\nExplanation:');
  for (const line of result.explanation) console.log(`  - ${line}`);

  const delay = Number.isFinite(result.delayMinutes) ? `${result.delayMinutes} min` : 'did not arrive';
  const bandInfo = result.band
    ? `, band ${result.band}, ${result.compensationPercentage}% of a ${journey.fareType}`
    : '';
  console.log(`\nVerdict: ${result.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'} (delay ${delay}${bandInfo})`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
