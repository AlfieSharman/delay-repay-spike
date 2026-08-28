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
