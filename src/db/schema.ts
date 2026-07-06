/**
 * SQLite schema for the delay-repay spike.
 *
 * Times are stored as minutes since midnight (0-1439), truncating the CIF
 * half-minute flag - delay-repay decisions operate at whole-minute
 * granularity (HSP data is minute-level), so the extra precision isn't
 * useful here.
 *
 * Prices are stored in pence as integers, matching the source feed.
 */

import Database from 'better-sqlite3';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  return db;
}

/** Drops and recreates every table so `npm run load` can be re-run from scratch. */
export function createSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS fares;
    DROP TABLE IF EXISTS flows;
    DROP TABLE IF EXISTS ticket_types;
    DROP TABLE IF EXISTS locations;
    DROP TABLE IF EXISTS calling_points;
    DROP TABLE IF EXISTS schedules;
    DROP TABLE IF EXISTS stations;

    CREATE TABLE stations (
      tiploc TEXT PRIMARY KEY,
      crs TEXT,
      name TEXT NOT NULL
    );
    CREATE INDEX idx_stations_crs ON stations(crs);

    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      stp_indicator TEXT NOT NULL CHECK (stp_indicator IN ('N', 'C', 'O', 'P')),
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      days_run TEXT NOT NULL,
      bank_holiday TEXT,
      status TEXT,
      category TEXT,
      atoc_code TEXT NOT NULL,
      retail_train_id TEXT
    );
    CREATE INDEX idx_schedules_uid ON schedules(uid);

    CREATE TABLE calling_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL REFERENCES schedules(id),
      seq INTEGER NOT NULL,
      record_type TEXT NOT NULL CHECK (record_type IN ('LO', 'LI', 'LT')),
      tiploc TEXT NOT NULL,
      scheduled_arrival INTEGER,
      scheduled_departure INTEGER,
      scheduled_pass INTEGER,
      platform TEXT,
      activity TEXT
    );
    CREATE INDEX idx_calling_points_schedule ON calling_points(schedule_id);
    CREATE INDEX idx_calling_points_tiploc ON calling_points(tiploc);

    CREATE TABLE locations (
      nlc TEXT PRIMARY KEY,
      crs TEXT,
      name TEXT NOT NULL,
      fare_group_nlc TEXT NOT NULL
    );
    CREATE INDEX idx_locations_crs ON locations(crs);

    CREATE TABLE ticket_types (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      class TEXT,
      type TEXT
    );

    CREATE TABLE flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id TEXT NOT NULL UNIQUE,
      origin_nlc TEXT NOT NULL,
      destination_nlc TEXT NOT NULL,
      route_code TEXT
    );
    CREATE INDEX idx_flows_origin_dest ON flows(origin_nlc, destination_nlc);

    CREATE TABLE fares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id TEXT NOT NULL REFERENCES flows(flow_id),
      ticket_code TEXT NOT NULL REFERENCES ticket_types(code),
      price_pence INTEGER NOT NULL,
      restriction_code TEXT
    );
    CREATE INDEX idx_fares_flow ON fares(flow_id);
  `);
}
