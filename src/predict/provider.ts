/**
 * Concrete data provider for the batch runner: resolves ticket metadata and
 * station codes from the phase-2 SQLite database, and builds candidate
 * itineraries (scheduled legs + actual runs) from the timetable and HSP.
 *
 * This is the impure half of the pipeline; the decision logic in assess.ts
 * stays pure and consumes what this produces.
 */

import type Database from 'better-sqlite3';
import type { HspClient, Days } from '../hsp/client.js';
import type { ServiceRun } from '../eligibility/journey.js';
import {
  originServiceTermini,
  parseHHMM,
  scheduledJourneysBetween,
  type OriginService,
} from '../timetable/lookup.js';
import type { IntendedLeg, PlannedItinerary, ScanEvent, TicketInfo } from './types.js';

const INTERCHANGE = 5;
const MAX_ITINERARIES = 6;

function toHHMM(minutes: number): string {
  const c = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}${String(c % 60).padStart(2, '0')}`;
}

function daysOfWeek(date: string): Days {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0) return 'SUNDAY';
  if (dow === 6) return 'SATURDAY';
  return 'WEEKDAY';
}

function hspTime(raw: string | undefined): number | null {
  if (!raw || raw.trim() === '') return null;
  return parseHHMM(raw);
}

export class BatchDataProvider {
  private readonly nlcCache = new Map<string, string | null>();

  constructor(
    private readonly db: Database.Database,
    private readonly hsp: HspClient,
    private readonly date: string,
  ) {}

  nlcToCrs(nlc: string): string | null {
    if (this.nlcCache.has(nlc)) return this.nlcCache.get(nlc)!;
    const row = this.db.prepare('SELECT crs FROM locations WHERE nlc = ? AND crs IS NOT NULL').get(nlc) as
      | { crs: string }
      | undefined;
    const crs = row?.crs ?? null;
    this.nlcCache.set(nlc, crs);
    return crs;
  }

  /**
   * Resolves a ticket origin or destination NLC to a CRS. A fare-group NLC
   * (e.g. 1072 "LONDON TERMINALS") has no CRS of its own, so we expand it to
   * its member stations and pick the terminal the scans point to:
   *   1. a gate scan physically at a member station;
   *   2. else a member named as the origin/destination of a clipped service
   *      (the terminal a service runs from/to - via train_info); this is what
   *      recovers ungated-London Kent journeys, where no London gate scan
   *      exists but a clip names e.g. LBG-DVP or CST-TON.
   *   3. else the first member as a last resort (arbitrary - the group has no
   *      CRS and nothing pins it; e.g. LONDON TERMINALS defaults to Euston,
   *      which serves no SE Kent flow, so this usually just falls through to
   *      SERVICE_UNRESOLVED).
   */
  resolveCrs(nlc: string, scans: readonly ScanEvent[]): string | null {
    const direct = this.nlcToCrs(nlc);
    if (direct) return direct;
    const members = (
      this.db.prepare('SELECT crs FROM locations WHERE fare_group_nlc = ? AND crs IS NOT NULL').all(nlc) as {
        crs: string;
      }[]
    ).map((r) => r.crs);
    const memberSet = new Set(members);
    const gateScanned = scans.find((s) => s.stationCrs && memberSet.has(s.stationCrs));
    if (gateScanned?.stationCrs) return gateScanned.stationCrs;
    for (const s of scans) {
      const ti = s.trainInfo;
      if (ti?.routeFromCrs && memberSet.has(ti.routeFromCrs)) return ti.routeFromCrs;
      if (ti?.routeToCrs && memberSet.has(ti.routeToCrs)) return ti.routeToCrs;
    }
    return members[0] ?? null;
  }

  /** NLC plus its fare group, for fare lookups. */
  private faresNlcs(nlc: string): string[] {
    const row = this.db.prepare('SELECT nlc, fare_group_nlc FROM locations WHERE nlc = ?').get(nlc) as
      | { nlc: string; fare_group_nlc: string }
      | undefined;
    return row ? [...new Set([row.nlc, row.fare_group_nlc])] : [nlc];
  }

  /**
   * The restriction code on the ticket's fare (flow + ticket type, matching the
   * route code where given). Returns null when there is no restriction (e.g.
   * Anytime tickets) or it can't be resolved unambiguously.
   */
  restrictionCodeFor(originNlc: string, destNlc: string, ticketCode: string, routeCode: string | null): string | null {
    const oN = this.faresNlcs(originNlc);
    const dN = this.faresNlcs(destNlc);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT fl.route_code AS route, f.restriction_code AS restriction
         FROM flows fl JOIN fares f ON f.flow_id = fl.flow_id
         WHERE fl.origin_nlc IN (${oN.map(() => '?').join(',')})
           AND fl.destination_nlc IN (${dN.map(() => '?').join(',')})
           AND f.ticket_code = ?`,
      )
      .all(...oN, ...dN, ticketCode) as { route: string | null; restriction: string | null }[];
    const matched = routeCode ? rows.filter((r) => r.route === routeCode) : rows;
    const codes = new Set((matched.length > 0 ? matched : rows).map((r) => r.restriction).filter((c): c is string => !!c));
    return codes.size === 1 ? [...codes][0]! : null;
  }

  ticketMeta(ftot: string): Pick<TicketInfo, 'kind' | 'fareType' | 'hasTimeRestriction'> {
    const row = this.db.prepare('SELECT description, type FROM ticket_types WHERE code = ?').get(ftot) as
      | { description: string; type: string | null }
      | undefined;
    const description = (row?.description ?? '').toUpperCase();
    const kind = description.includes('ADVANCE') ? 'advance' : 'walk-up';
    const fareType = row?.type === 'R' ? 'return' : 'single';
    const hasTimeRestriction = kind === 'walk-up' && /OFF|OFFPK|OFF-PEAK|SUPER/.test(description);
    return { kind, fareType, hasTimeRestriction };
  }

  /** Actual service runs on a flow, from HSP, within a scheduled-departure window. */
  async legActuals(
    fromCrs: string,
    toCrs: string,
    fromTimeMin: number,
    toTimeMin: number,
  ): Promise<ServiceRun[]> {
    const metrics = await this.hsp.serviceMetrics({
      from_loc: fromCrs,
      to_loc: toCrs,
      from_time: toHHMM(fromTimeMin),
      to_time: toHHMM(toTimeMin),
      from_date: this.date,
      to_date: this.date,
      days: daysOfWeek(this.date),
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
        const details = await this.hsp.serviceDetails(rid);
        const toc = details.serviceAttributesDetails.toc_code;
        const locations = details.serviceAttributesDetails.locations;
        const originIdx = locations.findIndex((l) => l.location === fromCrs);
        const destIdx = locations.findIndex((l) => l.location === toCrs);
        const originLoc = originIdx >= 0 ? locations[originIdx] : undefined;
        const destLoc = destIdx >= 0 ? locations[destIdx] : undefined;
        const actualDeparture = hspTime(originLoc?.actual_td);
        const actualArrival = hspTime(destLoc?.actual_ta);
        // Calling points ridden: origin..destination inclusive (CRS codes).
        const callingPoints =
          originIdx >= 0 && destIdx > originIdx
            ? locations.slice(originIdx, destIdx + 1).map((l) => l.location)
            : [fromCrs, toCrs];
        // Normalise past-midnight arrivals: an arrival earlier than the
        // departure means the service crossed midnight, so it is +1 day.
        const schedArr = scheduledArrival < scheduledDeparture ? scheduledArrival + 1440 : scheduledArrival;
        const depRef = actualDeparture ?? scheduledDeparture;
        const actArr = actualArrival !== null && actualArrival < depRef ? actualArrival + 1440 : actualArrival;
        runs.push({
          id: rid,
          scheduledDeparture,
          scheduledArrival: schedArr,
          actualDeparture,
          actualArrival: actArr,
          cancelled: actualArrival === null,
          callingPoints,
          toc,
        });
      }
    }
    return runs.sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
  }

  /**
   * Builds a PlannedItinerary from an explicit set of legs (the customer's
   * planned itinerary), fetching the actual runs for each leg from HSP. The
   * final leg's window extends to the exit tap so a later service taken after
   * a cancellation is included.
   */
  async itineraryActuals(legs: readonly IntendedLeg[], exitMin: number | null): Promise<PlannedItinerary> {
    const candidatesByLeg: ServiceRun[][] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      const isLast = i === legs.length - 1;
      const toTime = isLast && exitMin !== null ? Math.max(exitMin, leg.scheduledArrival) : leg.scheduledDeparture + 90;
      candidatesByLeg.push(await this.legActuals(leg.originCrs, leg.destinationCrs, leg.scheduledDeparture - 20, toTime));
    }
    return { legs: [...legs], candidatesByLeg };
  }

  /** Builds the booked itinerary for an Advance ticket (inferred if needed). */
  async advanceItinerary(
    fromCrs: string,
    toCrs: string,
    bookedDeparture: number,
  ): Promise<{ itineraries: PlannedItinerary[]; bookedLegs: IntendedLeg[] }> {
    const runs = await this.legActuals(fromCrs, toCrs, bookedDeparture - 20, bookedDeparture + 20);
    const booked = nearest(runs, bookedDeparture);
    const bookedLeg: IntendedLeg = {
      originCrs: fromCrs,
      destinationCrs: toCrs,
      scheduledDeparture: booked?.scheduledDeparture ?? bookedDeparture,
      scheduledArrival: booked?.scheduledArrival ?? bookedDeparture,
    };
    // Widen the fetch so any non-booked service the customer actually rode is present.
    const runsWide = await this.legActuals(fromCrs, toCrs, bookedDeparture - 90, bookedDeparture + 90);
    return {
      itineraries: [{ legs: [bookedLeg], candidatesByLeg: [runsWide] }],
      bookedLegs: [bookedLeg],
    };
  }

  /** Builds candidate itineraries for a walk-up ticket (direct, else one change). */
  async walkUpItineraries(
    fromCrs: string,
    toCrs: string,
    entryMin: number | null,
    exitMin: number | null,
  ): Promise<PlannedItinerary[]> {
    const [depFrom, depTo] =
      entryMin !== null
        ? [entryMin - 15, entryMin + 180]
        : exitMin !== null
          ? [exitMin - 240, exitMin]
          : [0, 1439];

    const direct = await this.legActuals(fromCrs, toCrs, depFrom, depTo);
    if (direct.length > 0) {
      const first = direct[0]!;
      return [
        {
          legs: [
            {
              originCrs: fromCrs,
              destinationCrs: toCrs,
              scheduledDeparture: first.scheduledDeparture,
              scheduledArrival: first.scheduledArrival,
            },
          ],
          candidatesByLeg: [direct],
        },
      ];
    }

    // No direct service: discover an interchange from the timetable. Group the
    // origin services by where they terminate; each terminus is a candidate
    // interchange to change for the destination.
    const termini = originServiceTermini(this.db, fromCrs, this.date, depFrom, depTo - depFrom);
    const byTerminus = new Map<string, OriginService[]>();
    for (const o of termini) {
      const group = byTerminus.get(o.terminusCrs) ?? [];
      group.push(o);
      byTerminus.set(o.terminusCrs, group);
    }

    const scored: { itinerary: PlannedItinerary; score: number }[] = [];
    let processed = 0;

    for (const [terminusCrs, origins] of byTerminus) {
      if (processed >= MAX_ITINERARIES) break;
      const onwardSchedule = scheduledJourneysBetween(this.db, terminusCrs, toCrs, this.date);
      if (onwardSchedule.length === 0) continue;
      processed += 1;

      // Actual onward runs, anchored on the exit tap where we have one.
      const l2From = exitMin !== null ? exitMin - 180 : onwardSchedule[0]!.scheduledDeparture - 10;
      const l2To = exitMin !== null ? exitMin : onwardSchedule[0]!.scheduledDeparture + 120;
      const leg2 = await this.legActuals(terminusCrs, toCrs, l2From, l2To);
      const arrivable = leg2.filter((r) => !r.cancelled && r.actualArrival !== null && r.actualDeparture !== null);
      if (arrivable.length === 0) continue;

      // The onward service the customer most likely caught.
      const caught =
        exitMin !== null
          ? arrivable
              .filter((r) => r.actualArrival! <= exitMin + INTERCHANGE)
              .reduce<ServiceRun | null>((best, r) => (!best || r.actualArrival! > best.actualArrival! ? r : best), null)
          : arrivable.reduce<ServiceRun | null>((best, r) => (!best || r.actualArrival! < best.actualArrival! ? r : best), null);
      if (!caught) continue;

      // First leg: the origin service that connects to `caught`, latest first.
      const leg1o = origins
        .filter((o) => o.terminusArrival + INTERCHANGE <= caught.actualDeparture!)
        .reduce<OriginService | null>((best, o) => (!best || o.terminusArrival > best.terminusArrival ? o : best), null);
      if (!leg1o) continue;

      const leg1 = await this.legActuals(fromCrs, terminusCrs, leg1o.originDeparture - 10, leg1o.originDeparture + 10);
      if (leg1.length === 0) continue;

      // Intended connection: the earliest scheduled onward the customer could
      // have caught after arriving at the interchange (the best journey they
      // planned). This is the baseline the delay is measured against.
      const intended =
        onwardSchedule
          .filter((j) => j.scheduledDeparture >= leg1o.terminusArrival + INTERCHANGE)
          .sort((a, b) => a.scheduledArrival - b.scheduledArrival)[0] ?? onwardSchedule[0]!;

      const itinerary: PlannedItinerary = {
        legs: [
          { originCrs: fromCrs, destinationCrs: terminusCrs, scheduledDeparture: leg1o.originDeparture, scheduledArrival: leg1o.terminusArrival },
          { originCrs: terminusCrs, destinationCrs: toCrs, scheduledDeparture: intended.scheduledDeparture, scheduledArrival: intended.scheduledArrival },
        ],
        candidatesByLeg: [leg1, leg2],
      };
      // Prefer a tight exit match, then the latest-departing first leg (people
      // take the last train that still makes the connection, not the first).
      const exitFit = exitMin !== null ? -Math.abs(exitMin - caught.actualArrival!) : 0;
      scored.push({ itinerary, score: exitFit * 1000 + leg1o.originDeparture });
    }

    return scored.sort((a, b) => b.score - a.score).map((s) => s.itinerary);
  }
}

function nearest(runs: readonly ServiceRun[], target: number): ServiceRun | undefined {
  if (runs.length === 0) return undefined;
  return runs.reduce((best, r) =>
    Math.abs(r.scheduledDeparture - target) < Math.abs(best.scheduledDeparture - target) ? r : best,
  );
}
