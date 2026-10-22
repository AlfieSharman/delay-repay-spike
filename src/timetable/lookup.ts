/**
 * Shared timetable helpers over the phase-2 SQLite data.
 *
 * The STP overlay resolution and calendar logic here was originally written
 * inline in query.ts. Phase 3 (the eligibility engine) needs the same rules
 * to decide which scheduled service actually ran on a given date, so it lives
 * in one place and both callers import it.
 */

import type Database from 'better-sqlite3';

export interface ScheduleRow {
  readonly id: number;
  readonly uid: string;
  readonly stp_indicator: string;
  readonly date_from: string;
  readonly date_to: string;
  readonly days_run: string;
  readonly category: string;
  readonly retail_train_id: string;
}

/** A scheduled call: a schedule plus the time it serves one specific station. */
export interface CallingPointRow {
  readonly schedule_id: number;
  readonly scheduled_arrival: number | null;
  readonly scheduled_departure: number | null;
  readonly scheduled_pass: number | null;
  readonly platform: string | null;
}

/** A resolved scheduled journey between two stations on a given date. */
export interface ScheduledJourney {
  readonly uid: string;
  readonly category: string;
  /** Minutes since midnight. */
  readonly scheduledDeparture: number;
  readonly scheduledArrival: number;
}

/** Monday=0 .. Sunday=6, matching the order of a CIF days_run bitmask. */
export function mondayIndexedWeekday(dateStr: string): number {
  const sundayIndexed = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return (sundayIndexed + 6) % 7;
}

export function isActiveOnDate(schedule: ScheduleRow, dateStr: string): boolean {
  if (dateStr < schedule.date_from || dateStr > schedule.date_to) return false;
  return schedule.days_run[mondayIndexedWeekday(dateStr)] === '1';
}

/** Minutes since midnight -> "HH:MM". Null renders as "--:--". */
export function formatMinutes(minutes: number | null): string {
  if (minutes == null) return '--:--';
  const hh = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** "HHMM" (e.g. "0800") -> minutes since midnight. */
export function parseHHMM(hhmm: string): number {
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  return hours * 60 + minutes;
}

/**
 * Resolves CIF STP overlays for one calendar date: a cancellation (C) beats
 * everything (the service doesn't run), an overlay (O) or new schedule (N)
 * beats the permanent (P) schedule they override.
 */
export function resolveStp<T extends ScheduleRow>(candidates: readonly T[]): T | null {
  const byIndicator = (indicator: string): T | undefined =>
    candidates.find((s) => s.stp_indicator === indicator);
  if (byIndicator('C')) return null;
  return byIndicator('O') ?? byIndicator('N') ?? byIndicator('P') ?? null;
}

function tiplocsForCrs(db: Database.Database, crs: string): string[] {
  return (db.prepare('SELECT tiploc FROM stations WHERE crs = ?').all(crs) as { tiploc: string }[]).map(
    (r) => r.tiploc,
  );
}

/**
 * Southeastern services calling at one station on a date, STP-resolved.
 * Used by the `services` query command. Each row carries the schedule plus
 * that station's arrival/departure time.
 */
export function servicesCallingAt(
  db: Database.Database,
  crs: string,
  date: string,
): (ScheduleRow & CallingPointRow)[] {
  const tiplocs = tiplocsForCrs(db, crs);
  if (tiplocs.length === 0) return [];

  const placeholders = tiplocs.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT sc.id, sc.uid, sc.stp_indicator, sc.date_from, sc.date_to, sc.days_run, sc.category, sc.retail_train_id,
             cp.schedule_id, cp.scheduled_arrival, cp.scheduled_departure, cp.scheduled_pass, cp.platform
      FROM calling_points cp
      JOIN schedules sc ON sc.id = cp.schedule_id
      WHERE cp.tiploc IN (${placeholders})
        AND (cp.scheduled_arrival IS NOT NULL OR cp.scheduled_departure IS NOT NULL)
    `,
    )
    .all(...tiplocs) as (ScheduleRow & CallingPointRow)[];

  return resolveActive(rows.filter((r) => isActiveOnDate(r, date)));
}

/** Groups rows by schedule UID, STP-resolves each group, keeps the winners. */
function resolveActive<T extends ScheduleRow>(rows: readonly T[]): T[] {
  const byUid = new Map<string, T[]>();
  for (const row of rows) {
    const group = byUid.get(row.uid) ?? [];
    group.push(row);
    byUid.set(row.uid, group);
  }
  const winners: T[] = [];
  for (const group of byUid.values()) {
    const winner = resolveStp(group);
    if (winner) winners.push(winner);
  }
  return winners;
}

/**
 * Scheduled Southeastern journeys from origin to destination on a date: any
 * service that departs origin and later arrives at destination (origin's
 * calling point sequence precedes destination's), STP-resolved and sorted by
 * scheduled departure.
 */
export function scheduledJourneysBetween(
  db: Database.Database,
  originCrs: string,
  destCrs: string,
  date: string,
): ScheduledJourney[] {
  const originTiplocs = tiplocsForCrs(db, originCrs);
  const destTiplocs = tiplocsForCrs(db, destCrs);
  if (originTiplocs.length === 0 || destTiplocs.length === 0) return [];

  const originPlaceholders = originTiplocs.map(() => '?').join(',');
  const destPlaceholders = destTiplocs.map(() => '?').join(',');

  interface JourneyRow extends ScheduleRow {
    readonly scheduled_departure: number;
    readonly scheduled_arrival: number;
  }

  const rows = db
    .prepare(
      `
      SELECT sc.id, sc.uid, sc.stp_indicator, sc.date_from, sc.date_to, sc.days_run, sc.category, sc.retail_train_id,
             o.scheduled_departure AS scheduled_departure,
             d.scheduled_arrival AS scheduled_arrival
      FROM schedules sc
      JOIN calling_points o ON o.schedule_id = sc.id
        AND o.tiploc IN (${originPlaceholders}) AND o.scheduled_departure IS NOT NULL
      JOIN calling_points d ON d.schedule_id = sc.id
        AND d.tiploc IN (${destPlaceholders}) AND d.scheduled_arrival IS NOT NULL
        AND d.seq > o.seq
    `,
    )
    .all(...originTiplocs, ...destTiplocs) as JourneyRow[];

  const resolved = resolveActive(rows.filter((r) => isActiveOnDate(r, date)));
  return resolved
    .map((r) => ({
      uid: r.uid,
      category: r.category,
      scheduledDeparture: r.scheduled_departure,
      scheduledArrival: r.scheduled_arrival,
    }))
    .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
}

/** The dense geographical path of one CIF service between two stations. */
export interface GeographicalPath {
  readonly uid: string;
  readonly scheduledDeparture: number;
  readonly scheduledArrival: number;
  /** Ordered CRS codes the service stops at OR passes through, origin to
   *  destination inclusive. Junctions with no CRS are dropped. */
  readonly crsPath: readonly string[];
}

/**
 * The geographical path of the CIF service(s) running originCrs -> destCrs on a
 * date: the ordered CRS the service stops at OR passes through, built from the
 * stored pass records (LI records with only a pass time), origin to destination
 * inclusive. This is the dense node path the routeing-guide base-route tracer
 * (`RouteingGuide.followsPermittedRoute`) needs and HSP can't give: HSP reports
 * only stops, but the points that decide a route (e.g. Ebbsfleet vs Dartford)
 * are often passed through, not stopped at. STP-resolved like the other lookups.
 */
export function geographicalPath(
  db: Database.Database,
  originCrs: string,
  destCrs: string,
  date: string,
): GeographicalPath[] {
  const originTiplocs = tiplocsForCrs(db, originCrs);
  const destTiplocs = tiplocsForCrs(db, destCrs);
  if (originTiplocs.length === 0 || destTiplocs.length === 0) return [];

  const originPlaceholders = originTiplocs.map(() => '?').join(',');
  const destPlaceholders = destTiplocs.map(() => '?').join(',');

  interface PathRow extends ScheduleRow {
    readonly origin_seq: number;
    readonly dest_seq: number;
    readonly scheduled_departure: number;
    readonly scheduled_arrival: number;
  }

  const rows = db
    .prepare(
      `
      SELECT sc.id, sc.uid, sc.stp_indicator, sc.date_from, sc.date_to, sc.days_run, sc.category, sc.retail_train_id,
             o.seq AS origin_seq, d.seq AS dest_seq,
             o.scheduled_departure AS scheduled_departure,
             d.scheduled_arrival AS scheduled_arrival
      FROM schedules sc
      JOIN calling_points o ON o.schedule_id = sc.id
        AND o.tiploc IN (${originPlaceholders}) AND o.scheduled_departure IS NOT NULL
      JOIN calling_points d ON d.schedule_id = sc.id
        AND d.tiploc IN (${destPlaceholders}) AND d.scheduled_arrival IS NOT NULL
        AND d.seq > o.seq
    `,
    )
    .all(...originTiplocs, ...destTiplocs) as PathRow[];

  const active = resolveActive(rows.filter((r) => isActiveOnDate(r, date)));

  // The CRS-bearing points (stops and pass-through stations) between the origin
  // and destination sequence, in order. Junctions without a CRS are excluded.
  const pathStmt = db.prepare(
    `
    SELECT st.crs AS crs
    FROM calling_points cp
    JOIN stations st ON st.tiploc = cp.tiploc
    WHERE cp.schedule_id = ? AND cp.seq BETWEEN ? AND ? AND st.crs IS NOT NULL
    ORDER BY cp.seq
  `,
  );

  return active
    .map((r) => {
      const crsRows = pathStmt.all(r.id, r.origin_seq, r.dest_seq) as { crs: string }[];
      const crsPath: string[] = [];
      for (const { crs } of crsRows) {
        if (crsPath[crsPath.length - 1] !== crs) crsPath.push(crs); // drop consecutive repeats
      }
      return {
        uid: r.uid,
        scheduledDeparture: r.scheduled_departure,
        scheduledArrival: r.scheduled_arrival,
        crsPath,
      };
    })
    .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
}

/** A scheduled journey with exactly one change, found from the timetable. */
export interface OneChangeJourney {
  readonly changeAt: string;
  readonly first: { readonly scheduledDeparture: number; readonly scheduledArrival: number };
  readonly second: { readonly scheduledDeparture: number; readonly scheduledArrival: number };
}

const ONE_CHANGE_MAX_SERVICES = 6;
/** An inserted-change journey longer than this (from `depFrom` to arrival) is
 *  not a credible reconstruction and is rejected rather than reported. */
const ONE_CHANGE_MAX_DURATION = 300;

/** Arrival on the same clock as its departure: +1440 when it wrapped past
 *  midnight, so an 00:27 arrival never ranks "earlier" than 19:10. */
function arrivalAfter(departure: number, arrival: number): number {
  return arrival < departure ? arrival + 1440 : arrival;
}

/**
 * The earliest-arriving scheduled journey from origin to destination with
 * exactly one change, departing the origin at or after `depFrom`. The first
 * ONE_CHANGE_MAX_SERVICES origin departures in the window are tried, and each
 * station one then calls at is tried as the change point against the direct
 * services from there. Bounded and heuristic: it finds *a* plausible
 * single-change path from the timetable, not the customer's actual one, so a
 * verdict built on it should be INFERRED. Used when a leg expected to be
 * direct has no direct service at that time of day (Tonbridge -> Strood is a
 * through service in the morning but not in the evening).
 */
export function oneChangeJourney(
  db: Database.Database,
  originCrs: string,
  destCrs: string,
  date: string,
  depFrom: number,
  interchangeMinutes: number,
  windowMin = 180,
): OneChangeJourney | null {
  const originTiplocs = tiplocsForCrs(db, originCrs);
  if (originTiplocs.length === 0) return null;
  const placeholders = originTiplocs.map(() => '?').join(',');

  interface Row extends ScheduleRow {
    readonly origin_seq: number;
    readonly origin_departure: number;
  }

  const rows = db
    .prepare(
      `
      SELECT sc.id, sc.uid, sc.stp_indicator, sc.date_from, sc.date_to, sc.days_run, sc.category, sc.retail_train_id,
             o.seq AS origin_seq, o.scheduled_departure AS origin_departure
      FROM schedules sc
      JOIN calling_points o ON o.schedule_id = sc.id
        AND o.tiploc IN (${placeholders}) AND o.scheduled_departure IS NOT NULL
        AND o.scheduled_departure BETWEEN ? AND ?
    `,
    )
    .all(...originTiplocs, depFrom, depFrom + windowMin) as Row[];

  const services = resolveActive(rows.filter((r) => isActiveOnDate(r, date)))
    .sort((a, b) => a.origin_departure - b.origin_departure)
    .slice(0, ONE_CHANGE_MAX_SERVICES);

  const stopsStmt = db.prepare(
    `
    SELECT st.crs AS crs, cp.scheduled_arrival AS arrival
    FROM calling_points cp
    JOIN stations st ON st.tiploc = cp.tiploc
    WHERE cp.schedule_id = ? AND cp.seq > ? AND cp.scheduled_arrival IS NOT NULL AND st.crs IS NOT NULL
    ORDER BY cp.seq
  `,
  );

  const onwardByCrs = new Map<string, ScheduledJourney[]>();
  let best: OneChangeJourney | null = null;
  let bestArrival = Number.POSITIVE_INFINITY;

  for (const svc of services) {
    const stops = stopsStmt.all(svc.id, svc.origin_seq) as { crs: string; arrival: number }[];
    for (const stop of stops) {
      if (stop.crs === originCrs || stop.crs === destCrs) continue;
      const changeArrival = arrivalAfter(svc.origin_departure, stop.arrival);
      let onward = onwardByCrs.get(stop.crs);
      if (!onward) {
        onward = scheduledJourneysBetween(db, stop.crs, destCrs, date);
        onwardByCrs.set(stop.crs, onward);
      }
      const ready = changeArrival + interchangeMinutes;
      // Earliest-arriving connection the customer could make (on a normalised
      // clock, so a past-midnight arrival is not "earliest"), not just the
      // first to leave.
      let connection: ScheduledJourney | null = null;
      let connectionArrival = Number.POSITIVE_INFINITY;
      for (const j of onward) {
        if (j.scheduledDeparture < ready) continue;
        const arr = arrivalAfter(j.scheduledDeparture, j.scheduledArrival);
        if (arr < connectionArrival) {
          connection = j;
          connectionArrival = arr;
        }
      }
      if (!connection) continue;
      if (connectionArrival - depFrom > ONE_CHANGE_MAX_DURATION) continue;
      if (connectionArrival < bestArrival) {
        bestArrival = connectionArrival;
        best = {
          changeAt: stop.crs,
          first: { scheduledDeparture: svc.origin_departure, scheduledArrival: stop.arrival },
          second: { scheduledDeparture: connection.scheduledDeparture, scheduledArrival: connection.scheduledArrival },
        };
      }
    }
  }
  return best;
}

/** Allowance for a walk or tube hop between two different London stations. */
export const LONDON_TRANSFER = 15;

/** One leg of a journey structure: the origin is null when it still has to be
 *  discovered (a tap-out with no tap-in: the onward train left from a nearby
 *  station, e.g. out at Waterloo East, onward from Waterloo). */
export interface StructureLeg {
  readonly originCrs: string | null;
  readonly destinationCrs: string;
}

/**
 * Segments a journey at its intermediate tap-outs. A tap-out at a station
 * that is not the destination means the customer changed there; the next
 * tap-in, if any, is where the onward leg starts, otherwise its origin is
 * unknown (null) and must be discovered. Returns null when there is no
 * intermediate tap-out, i.e. nothing to segment.
 */
export function segmentsFromTaps(
  fromCrs: string,
  toCrs: string,
  taps: readonly { readonly crs: string; readonly timeMinutes: number; readonly mode: 'entry' | 'exit' }[],
): StructureLeg[] | null {
  const legs: StructureLeg[] = [];
  let origin: string | null = fromCrs;
  for (const tap of taps) {
    if (tap.mode === 'exit') {
      if (tap.crs === toCrs) break; // arrived
      legs.push({ originCrs: origin, destinationCrs: tap.crs });
      origin = null;
    } else if (legs.length > 0 && origin === null) {
      origin = tap.crs; // a tap-in after a tap-out: the onward leg starts here
    }
  }
  if (legs.length === 0) return null;
  legs.push({ originCrs: origin, destinationCrs: toCrs });
  return legs;
}

/** Where an onward leg starts after a tap-out with no tap-in. */
export interface OnwardOrigin {
  readonly originCrs: string;
  /** Minutes to allow from the previous leg's arrival to the onward departure. */
  readonly transfer: number;
}

/** Earliest scheduled arrival (normalised past midnight) at `toCrs` from
 *  `fromCrs` departing at or after `readyMin`, from the loaded timetable. */
export function earliestScheduledArrival(
  db: Database.Database,
  fromCrs: string,
  toCrs: string,
  date: string,
  readyMin: number,
): number | null {
  return scheduledJourneysBetween(db, fromCrs, toCrs, date)
    .filter((j) => j.scheduledDeparture >= readyMin)
    .reduce<number | null>((b, j) => {
      const arr = arrivalAfter(j.scheduledDeparture, j.scheduledArrival);
      return b === null || arr < b ? arr : b;
    }, null);
}

/** Earliest arrival at the destination from a station, departing at/after a
 *  time, or null if nothing serves it. Supplied by the caller so the probe
 *  can be national (HSP) rather than the loaded timetable, which only holds
 *  Southeastern and its London connectors: the onward leg is often another
 *  operator's (Waterloo -> Honiton is South Western). */
export type EarliestArrival = (fromCrs: string, readyMin: number) => Promise<number | null>;

/**
 * After a tap-out at `changeCrs`, the station the onward leg to the
 * destination leaves from: `changeCrs` itself if it has an onward service,
 * else the station in the same fare group (e.g. LONDON TERMINALS: Waterloo
 * East -> Waterloo) whose onward service arrives earliest, allowing
 * LONDON_TRANSFER for the walk. Null when nothing serves the destination.
 * The fare-group mates come from the local `locations` table; whether each
 * has an onward service comes from `earliestArrival`.
 */
export async function crossLondonOnwardOrigin(
  db: Database.Database,
  changeCrs: string,
  prevArrivalMin: number,
  sameStationTransfer: number,
  earliestArrival: EarliestArrival,
): Promise<OnwardOrigin | null> {
  if ((await earliestArrival(changeCrs, prevArrivalMin + sameStationTransfer)) !== null) {
    return { originCrs: changeCrs, transfer: sameStationTransfer };
  }

  const mates = (
    db
      .prepare(
        `
        SELECT DISTINCT l2.crs AS crs
        FROM locations l1
        JOIN locations l2 ON l2.fare_group_nlc = l1.fare_group_nlc
        WHERE l1.crs = ? AND l1.fare_group_nlc <> l1.nlc AND l2.crs IS NOT NULL AND l2.crs <> l1.crs
      `,
      )
      .all(changeCrs) as { crs: string }[]
  ).map((r) => r.crs);

  let best: OnwardOrigin | null = null;
  let bestArrival = Number.POSITIVE_INFINITY;
  for (const mate of mates) {
    const arr = await earliestArrival(mate, prevArrivalMin + LONDON_TRANSFER);
    if (arr !== null && arr < bestArrival) {
      bestArrival = arr;
      best = { originCrs: mate, transfer: LONDON_TRANSFER };
    }
  }
  return best;
}

/** A service leaving one station, with where it terminates. */
export interface OriginService {
  readonly uid: string;
  readonly originDeparture: number;
  readonly terminusCrs: string;
  readonly terminusArrival: number;
}

/**
 * Services departing a station within a time window, each paired with the CRS
 * and arrival time of where it terminates. Used to discover an interchange
 * when no direct origin->destination service exists (many SE branch services
 * terminate at the junction where you change for London).
 */
export function originServiceTermini(
  db: Database.Database,
  originCrs: string,
  date: string,
  startMin: number,
  windowMin: number,
): OriginService[] {
  const originTiplocs = tiplocsForCrs(db, originCrs);
  if (originTiplocs.length === 0) return [];
  const placeholders = originTiplocs.map(() => '?').join(',');

  interface Row extends ScheduleRow {
    readonly origin_departure: number;
    readonly terminus_crs: string;
    readonly terminus_arrival: number;
  }

  const rows = db
    .prepare(
      `
      SELECT sc.id, sc.uid, sc.stp_indicator, sc.date_from, sc.date_to, sc.days_run, sc.category, sc.retail_train_id,
             o.scheduled_departure AS origin_departure,
             s.crs AS terminus_crs,
             t.scheduled_arrival AS terminus_arrival
      FROM schedules sc
      JOIN calling_points o ON o.schedule_id = sc.id
        AND o.tiploc IN (${placeholders}) AND o.scheduled_departure IS NOT NULL
        AND o.scheduled_departure BETWEEN ? AND ?
      JOIN calling_points t ON t.schedule_id = sc.id AND t.record_type = 'LT'
      JOIN stations s ON s.tiploc = t.tiploc
      WHERE s.crs IS NOT NULL AND t.scheduled_arrival IS NOT NULL AND t.seq > o.seq
    `,
    )
    .all(...originTiplocs, startMin, startMin + windowMin) as Row[];

  const resolved = resolveActive(rows.filter((r) => isActiveOnDate(r, date)));
  return resolved
    .filter((r) => r.terminus_crs !== originCrs)
    .map((r) => ({
      uid: r.uid,
      originDeparture: r.origin_departure,
      terminusCrs: r.terminus_crs,
      terminusArrival: r.terminus_arrival,
    }))
    .sort((a, b) => a.originDeparture - b.originDeparture);
}
