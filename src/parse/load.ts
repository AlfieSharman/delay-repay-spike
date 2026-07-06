/**
 * Parses the raw NRDP feeds in data/ and loads Southeastern-relevant data
 * into data/spike.db.
 *
 * Order: stations -> SE schedules -> locations -> ticket types -> SE flows.
 * Locations and flows both need the timetable loaded first, since "served
 * by Southeastern" is derived from which stations SE schedules call at.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createSchema, openDb } from '../db/schema.js';
import { streamStations, streamSeSchedules } from './timetable.js';
import { streamLocations, streamTicketTypes, streamSeFlowsAndFares } from './fares.js';

const DB_PATH = 'data/spike.db';
const TIMETABLE_DIR = 'data/timetable';
const FARES_DIR = 'data/fares';

/** Feed filenames are stamped with a sequence number that changes every release, e.g. RJTTF883.MCA. */
async function findFile(dir: string, extension: string): Promise<string> {
  const files = await readdir(dir);
  const match = files.find((f) => f.toUpperCase().endsWith(extension.toUpperCase()));
  if (!match) throw new Error(`No *${extension} file found in ${dir}`);
  return path.join(dir, match);
}

async function loadStations(db: Database.Database): Promise<void> {
  const file = await findFile(TIMETABLE_DIR, '.MSN');
  const insert = db.prepare('INSERT OR REPLACE INTO stations (tiploc, crs, name) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  try {
    for await (const station of streamStations(file)) {
      insert.run(station.tiploc, station.crs, station.name);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function loadSeSchedules(db: Database.Database): Promise<void> {
  const file = await findFile(TIMETABLE_DIR, '.MCA');
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (uid, stp_indicator, date_from, date_to, days_run, bank_holiday, status, category, atoc_code, retail_train_id)
    VALUES (@uid, @stpIndicator, @dateFrom, @dateTo, @daysRun, @bankHoliday, @status, @category, @atocCode, @retailTrainId)
  `);
  const insertCallingPoint = db.prepare(`
    INSERT INTO calling_points (schedule_id, seq, record_type, tiploc, scheduled_arrival, scheduled_departure, scheduled_pass, platform, activity)
    VALUES (@scheduleId, @seq, @recordType, @tiploc, @scheduledArrival, @scheduledDeparture, @scheduledPass, @platform, @activity)
  `);

  db.exec('BEGIN');
  try {
    for await (const schedule of streamSeSchedules(file)) {
      const { lastInsertRowid: scheduleId } = insertSchedule.run(schedule);
      schedule.callingPoints.forEach((cp, seq) => {
        insertCallingPoint.run({ ...cp, scheduleId, seq });
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function loadLocations(db: Database.Database): Promise<void> {
  const file = await findFile(FARES_DIR, '.LOC');
  const insert = db.prepare('INSERT OR REPLACE INTO locations (nlc, crs, name, fare_group_nlc) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    for await (const location of streamLocations(file)) {
      insert.run(location.nlc, location.crs, location.name, location.fareGroupNlc);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function loadTicketTypes(db: Database.Database): Promise<void> {
  const file = await findFile(FARES_DIR, '.TTY');
  const insert = db.prepare(
    'INSERT OR REPLACE INTO ticket_types (code, description, class, type) VALUES (?, ?, ?, ?)',
  );

  db.exec('BEGIN');
  try {
    for await (const ticketType of streamTicketTypes(file)) {
      insert.run(ticketType.code, ticketType.description, ticketType.klass, ticketType.type);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The set of CRS codes that Southeastern schedules actually call at. */
function seCrsCodes(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `
      SELECT DISTINCT s.crs AS crs
      FROM calling_points cp
      JOIN stations s ON s.tiploc = cp.tiploc
      JOIN schedules sc ON sc.id = cp.schedule_id
      WHERE s.crs IS NOT NULL
    `,
    )
    .all() as { crs: string }[];
  return new Set(rows.map((r) => r.crs));
}

/**
 * NLCs that count as "served by Southeastern" for flow filtering: physical
 * SE-served stations, plus the fare groups they belong to (e.g. Cannon
 * Street, Charing Cross and Victoria are all grouped under the "LONDON
 * TERMINALS" NLC 1072, which flows are commonly priced against instead of
 * the individual terminus).
 */
function seNlcs(db: Database.Database): Set<string> {
  const seCrs = seCrsCodes(db);
  const locations = db.prepare('SELECT nlc, crs, fare_group_nlc FROM locations').all() as {
    nlc: string;
    crs: string | null;
    fare_group_nlc: string;
  }[];

  const nlcs = new Set<string>();
  for (const location of locations) {
    if (location.crs != null && seCrs.has(location.crs)) {
      nlcs.add(location.nlc);
      nlcs.add(location.fare_group_nlc);
    }
  }
  return nlcs;
}

async function loadSeFlowsAndFares(db: Database.Database): Promise<void> {
  const file = await findFile(FARES_DIR, '.FFL');
  const seServedNlcs = seNlcs(db);
  const isSeNlc = (nlc: string): boolean => seServedNlcs.has(nlc);

  const insertFlow = db.prepare(
    'INSERT INTO flows (flow_id, origin_nlc, destination_nlc, route_code) VALUES (?, ?, ?, ?)',
  );
  const insertFare = db.prepare(
    'INSERT INTO fares (flow_id, ticket_code, price_pence, restriction_code) VALUES (?, ?, ?, ?)',
  );

  db.exec('BEGIN');
  try {
    for await (const record of streamSeFlowsAndFares(file, isSeNlc)) {
      if (record.kind === 'flow') {
        insertFlow.run(record.flow.flowId, record.flow.originNlc, record.flow.destinationNlc, record.flow.routeCode);
      } else {
        insertFare.run(record.fare.flowId, record.fare.ticketCode, record.fare.pricePence, record.fare.restrictionCode);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function printRowCounts(db: Database.Database): void {
  const tables = ['stations', 'schedules', 'calling_points', 'locations', 'ticket_types', 'flows', 'fares'];
  console.log('\nRow counts:');
  for (const table of tables) {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    console.log(`  ${table}: ${count.toLocaleString()}`);
  }
}

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  createSchema(db);

  console.log('Loading stations...');
  await loadStations(db);

  console.log('Loading Southeastern schedules...');
  await loadSeSchedules(db);

  console.log('Loading locations...');
  await loadLocations(db);

  console.log('Loading ticket types...');
  await loadTicketTypes(db);

  console.log('Loading Southeastern flows and fares...');
  await loadSeFlowsAndFares(db);

  printRowCounts(db);
  db.close();
  console.log(`\nDone. Database written to ${DB_PATH}.`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
