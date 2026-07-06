/**
 * Sanity-check CLI for the loaded database.
 *
 *   npm run query -- stats
 *   npm run query -- services <CRS> <YYYY-MM-DD>
 *   npm run query -- fares <origin CRS> <dest CRS>
 */

import Database from 'better-sqlite3';
import { openDb } from './db/schema.js';
import { formatMinutes, servicesCallingAt } from './timetable/lookup.js';

const DB_PATH = 'data/spike.db';

function runServices(db: Database.Database, crs: string, date: string): void {
  const results = servicesCallingAt(db, crs, date);
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
