/**
 * Unit tests for the timetable lookup helpers that need real SQLite behaviour,
 * run against a tiny in-memory database rather than the full loaded feed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { geographicalPath } from './lookup.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE stations (tiploc TEXT PRIMARY KEY, crs TEXT, name TEXT);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY, uid TEXT, stp_indicator TEXT,
      date_from TEXT, date_to TEXT, days_run TEXT, category TEXT, retail_train_id TEXT);
    CREATE TABLE calling_points (id INTEGER PRIMARY KEY, schedule_id INTEGER, seq INTEGER,
      record_type TEXT, tiploc TEXT, scheduled_arrival INTEGER, scheduled_departure INTEGER, scheduled_pass INTEGER);
  `);
  return db;
}

// The path must include a station the service PASSES (pass-only record) between
// origin and destination, and drop junctions that have no CRS - this is the
// dense node path HSP stops can't give.
test('geographicalPath includes passed-through stations and drops CRS-less junctions', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO stations VALUES ('HGST','HGS','Hastings'),('SEVT','SEV','Sevenoaks'),
      ('TONT','TON','Tonbridge'),('JNCT',NULL,'A junction');
    INSERT INTO schedules VALUES (1,'X1','P','2026-08-01','2026-08-31','1111100','XX','SE1');
    INSERT INTO calling_points VALUES
      (1,1,0,'LO','HGST',NULL,480,NULL),
      (2,1,1,'LI','JNCT',NULL,NULL,485),   -- junction passed, no CRS -> dropped
      (3,1,2,'LI','SEVT',NULL,NULL,495),   -- station PASSED (pass-only) -> kept
      (4,1,3,'LT','TONT',510,NULL,NULL);
  `);
  const paths = geographicalPath(db, 'HGS', 'TON', '2026-08-21'); // a Friday in range
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0]!.crsPath, ['HGS', 'SEV', 'TON']);
  db.close();
});

// A cancelling STP overlay ('C') for the date must remove the service entirely.
test('geographicalPath resolves STP: a cancellation for the date yields nothing', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO stations VALUES ('HGST','HGS','Hastings'),('TONT','TON','Tonbridge');
    INSERT INTO schedules VALUES
      (1,'X1','P','2026-08-01','2026-08-31','1111100','XX','SE1'),
      (2,'X1','C','2026-08-21','2026-08-21','1111100','XX','SE1');
    INSERT INTO calling_points VALUES
      (1,1,0,'LO','HGST',NULL,480,NULL),
      (2,1,1,'LT','TONT',510,NULL,NULL),
      (3,2,0,'LO','HGST',NULL,480,NULL),
      (4,2,1,'LT','TONT',510,NULL,NULL);
  `);
  assert.equal(geographicalPath(db, 'HGS', 'TON', '2026-08-21').length, 0);
  db.close();
});
