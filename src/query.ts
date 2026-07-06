/**
 * Sanity-check CLI for the loaded database.
 *
 *   npm run query -- stats
 *   npm run query -- services <CRS> <YYYY-MM-DD>
 *   npm run query -- fares <origin CRS> <dest CRS>
 */

import Database from 'better-sqlite3';
import { openDb } from './db/schema.js';

const DB_PATH = 'data/spike.db';

interface ScheduleRow {
  readonly id: number;
  readonly uid: string;
  readonly stp_indicator: string;
  readonly date_from: string;
  readonly date_to: string;
  readonly days_run: string;
  readonly category: string;
  readonly retail_train_id: string;
}

interface CallingPointRow {
  readonly schedule_id: number;
  readonly scheduled_arrival: number | null;
  readonly scheduled_departure: number | null;
  readonly scheduled_pass: number | null;
  readonly platform: string | null;
}

/** Monday=0 .. Sunday=6, matching the order of a CIF days_run bitmask. */
function mondayIndexedWeekday(dateStr: string): number {
  const sundayIndexed = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return (sundayIndexed + 6) % 7;
}

function isActiveOnDate(schedule: ScheduleRow, dateStr: string): boolean {
  if (dateStr < schedule.date_from || dateStr > schedule.date_to) return false;
  return schedule.days_run[mondayIndexedWeekday(dateStr)] === '1';
}

function formatMinutes(minutes: number | null): string {
  if (minutes == null) return '--:--';
  const hh = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Resolves CIF STP overlays for one calendar date: a cancellation (C) beats
 * everything (the service doesn't run), an overlay (O) or new schedule (N)
 * beats the permanent (P) schedule they override.
 */
function resolveStp(candidates: readonly ScheduleRow[]): ScheduleRow | null {
  const byIndicator = (indicator: string): ScheduleRow | undefined =>
    candidates.find((s) => s.stp_indicator === indicator);
  if (byIndicator('C')) return null;
  return byIndicator('O') ?? byIndicator('N') ?? byIndicator('P') ?? null;
}

function runServices(db: Database.Database, crs: string, date: string): void {
  const tiplocs = (db.prepare('SELECT tiploc FROM stations WHERE crs = ?').all(crs) as { tiploc: string }[]).map(
    (r) => r.tiploc,
  );
  if (tiplocs.length === 0) {
    console.log(`No station found with CRS "${crs}".`);
    return;
  }

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

  const active = rows.filter((r) => isActiveOnDate(r, date));

  const byUid = new Map<string, (ScheduleRow & CallingPointRow)[]>();
  for (const row of active) {
    const group = byUid.get(row.uid) ?? [];
    group.push(row);
    byUid.set(row.uid, group);
  }

  const results: (ScheduleRow & CallingPointRow)[] = [];
  for (const group of byUid.values()) {
    const winner = resolveStp(group);
    if (winner) results.push(winner as ScheduleRow & CallingPointRow);
  }

  results.sort((a, b) => (a.scheduled_departure ?? a.scheduled_arrival ?? 0) - (b.scheduled_departure ?? b.scheduled_arrival ?? 0));

  console.log(`Southeastern services calling at ${crs} on ${date}:\n`);
  if (results.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of results) {
    const time = r.scheduled_departure != null ? formatMinutes(r.scheduled_departure) : formatMinutes(r.scheduled_arrival);
    const platform = r.platform ? ` plat ${r.platform}` : '';
    console.log(`  ${time}  uid=${r.uid}  ${r.category}${platform}`);
  }
}

/**
 * NLCs a fare query should match for a given CRS: the station's own NLC(s)
 * plus any fare group(s) it belongs to (e.g. London termini are commonly
 * priced as a group - "LONDON TERMINALS" - rather than individually).
 */
function faresNlcsForCrs(db: Database.Database, crs: string): string[] {
  const rows = db.prepare('SELECT nlc, fare_group_nlc FROM locations WHERE crs = ?').all(crs) as {
    nlc: string;
    fare_group_nlc: string;
  }[];
  return [...new Set(rows.flatMap((r) => [r.nlc, r.fare_group_nlc]))];
}

function runFares(db: Database.Database, origin: string, destination: string): void {
  const originNlcs = faresNlcsForCrs(db, origin);
  const destNlcs = faresNlcsForCrs(db, destination);
  if (originNlcs.length === 0 || destNlcs.length === 0) {
    console.log(`No location found for ${originNlcs.length === 0 ? origin : destination}.`);
    return;
  }

  const originPlaceholders = originNlcs.map(() => '?').join(',');
  const destPlaceholders = destNlcs.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT DISTINCT tt.code, tt.description, f2.price_pence, f2.restriction_code
      FROM flows fl
      JOIN fares f2 ON f2.flow_id = fl.flow_id
      JOIN ticket_types tt ON tt.code = f2.ticket_code
      WHERE fl.origin_nlc IN (${originPlaceholders}) AND fl.destination_nlc IN (${destPlaceholders})
      ORDER BY f2.price_pence ASC
    `,
    )
    .all(...originNlcs, ...destNlcs) as {
    code: string;
    description: string;
    price_pence: number;
    restriction_code: string | null;
  }[];

  console.log(`Fares from ${origin} to ${destination}:\n`);
  if (rows.length === 0) {
    console.log('  (none found)');
    return;
  }
  for (const r of rows) {
    const price = (r.price_pence / 100).toFixed(2);
    const restriction = r.restriction_code ? ` (${r.restriction_code})` : '';
    console.log(`  ${r.code}  ${r.description.padEnd(20)} £${price}${restriction}`);
  }
}

function runStats(db: Database.Database): void {
  const tables = ['stations', 'schedules', 'calling_points', 'locations', 'ticket_types', 'flows', 'fares'];
  console.log('Row counts:');
  for (const table of tables) {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    console.log(`  ${table}: ${count.toLocaleString()}`);
  }
}

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  npm run query -- stats',
      '  npm run query -- services <CRS> <YYYY-MM-DD>',
      '  npm run query -- fares <origin CRS> <dest CRS>',
    ].join('\n'),
  );
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const db = openDb(DB_PATH);

  switch (command) {
    case 'stats':
      runStats(db);
      break;
    case 'services': {
      const [crs, date] = args;
      if (!crs || !date) {
        printUsage();
        process.exit(1);
      }
      runServices(db, crs.toUpperCase(), date);
      break;
    }
    case 'fares': {
      const [origin, destination] = args;
      if (!origin || !destination) {
        printUsage();
        process.exit(1);
      }
      runFares(db, origin.toUpperCase(), destination.toUpperCase());
      break;
    }
    default:
      printUsage();
      process.exit(1);
  }

  db.close();
}

main();
