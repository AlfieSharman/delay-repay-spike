/**
 * Unit tests for the timetable lookup helpers that need real SQLite behaviour,
 * run against a tiny in-memory database rather than the full loaded feed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { crossLondonOnwardOrigin, earliestScheduledArrival, geographicalPath, oneChangeJourney, segmentsFromTaps } from './lookup.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE stations (tiploc TEXT PRIMARY KEY, crs TEXT, name TEXT);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY, uid TEXT, stp_indicator TEXT,
      date_from TEXT, date_to TEXT, days_run TEXT, category TEXT, retail_train_id TEXT);
    CREATE TABLE calling_points (id INTEGER PRIMARY KEY, schedule_id INTEGER, seq INTEGER,
      record_type TEXT, tiploc TEXT, scheduled_arrival INTEGER, scheduled_departure INTEGER, scheduled_pass INTEGER);
    CREATE TABLE locations (nlc TEXT PRIMARY KEY, crs TEXT, name TEXT, fare_group_nlc TEXT);
  `);
  return db;
}

// ---------------------------------------------------------------- tap segmentation
test('segmentsFromTaps splits at an intermediate tap-out; a following tap-in is the onward origin', () => {
  // Out at Waterloo East with no tap-in: the onward origin is unknown.
  assert.deepEqual(
    segmentsFromTaps('HGS', 'HON', [
      { crs: 'HGS', timeMinutes: 796, mode: 'entry' },
      { crs: 'WAE', timeMinutes: 935, mode: 'exit' },
    ]),
    [{ originCrs: 'HGS', destinationCrs: 'WAE' }, { originCrs: null, destinationCrs: 'HON' }],
  );
  // Out at Waterloo, back in at Waterloo East: the onward leg starts there.
  assert.deepEqual(
    segmentsFromTaps('HON', 'HGS', [
      { crs: 'WAT', timeMinutes: 834, mode: 'exit' },
      { crs: 'WAE', timeMinutes: 1146, mode: 'entry' },
    ]),
    [{ originCrs: 'HON', destinationCrs: 'WAT' }, { originCrs: 'WAE', destinationCrs: 'HGS' }],
  );
  // Only an exit at the destination: nothing to segment.
  assert.equal(
    segmentsFromTaps('CBE', 'FKC', [
      { crs: 'CBE', timeMinutes: 1030, mode: 'entry' },
      { crs: 'FKC', timeMinutes: 1115, mode: 'exit' },
    ]),
    null,
  );
});

// After tapping out at Waterloo East, trains to Honiton leave from Waterloo
// (same LONDON TERMINALS fare group), so that is the onward origin, with the
// walk allowed for; Waterloo East itself has no onward service.
test('crossLondonOnwardOrigin finds the group mate the onward service leaves from', async () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO stations VALUES ('WATRLOE','WAE','Waterloo East'),('WATRLMN','WAT','Waterloo'),('HONITON','HON','Honiton');
    INSERT INTO locations VALUES ('5158','WAE','LONDON WATRLOO E','1072'),('5598','WAT','LONDON WATERLOO','1072'),
      ('5717','HON','HONITON','5717');
    INSERT INTO schedules VALUES (1,'S1','P','2026-08-01','2026-08-31','1111100','XX','SW1');
    INSERT INTO calling_points VALUES (1,1,0,'LO','WATRLMN',NULL,920,NULL),(2,1,1,'LT','HONITON',1122,NULL,NULL); -- 15:20 -> 18:42
  `);
  // The probe here is the loaded timetable; in the batch it is HSP (national).
  const probe = async (from: string, ready: number) => earliestScheduledArrival(db, from, 'HON', '2026-08-21', ready);
  assert.deepEqual(await crossLondonOnwardOrigin(db, 'WAE', 899, 5, probe), { originCrs: 'WAT', transfer: 15 });
  assert.equal(await crossLondonOnwardOrigin(db, 'WAE', 1000, 5, probe), null); // 15:20 already gone by 16:40 + walk
  db.close();
});

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

// No direct TBW->SOO service. The 17:50 from TBW calls at TON then PDW; only
// PDW has an onward service to SOO, so the change goes there (not at TON),
// and the connection must leave at/after arrival + interchange.
test('oneChangeJourney finds the change point with an onward service and respects the interchange', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO stations VALUES ('TBWT','TBW','Tunbridge Wells'),('TONT','TON','Tonbridge'),
      ('PDWT','PDW','Paddock Wood'),('SOOT','SOO','Strood');
    INSERT INTO schedules VALUES
      (1,'A1','P','2026-08-01','2026-08-31','1111100','XX','SE1'),
      (2,'B1','P','2026-08-01','2026-08-31','1111100','XX','SE2'),
      (3,'B2','P','2026-08-01','2026-08-31','1111100','XX','SE3');
    INSERT INTO calling_points VALUES
      (1,1,0,'LO','TBWT',NULL,1070,NULL),   -- 17:50
      (2,1,1,'LI','TONT',1081,1082,NULL),   -- 18:01
      (3,1,2,'LT','PDWT',1095,NULL,NULL),   -- 18:15
      (4,2,0,'LO','PDWT',NULL,1098,NULL),   -- 18:18, too tight (arr 18:15 + 5 = 18:20)
      (5,2,1,'LT','SOOT',1130,NULL,NULL),   -- 18:50
      (6,3,0,'LO','PDWT',NULL,1110,NULL),   -- 18:30, catchable
      (7,3,1,'LT','SOOT',1150,NULL,NULL),   -- 19:10
      (8,4,0,'LO','TONT',NULL,1087,NULL),   -- 18:07 TON->LBG (a London detour)
      (9,4,1,'LT','LBGT',1121,NULL,NULL),   -- 18:41
      (10,5,0,'LO','LBGT',NULL,1398,NULL),  -- 23:18 LBG->SOO ...
      (11,5,1,'LT','SOOT',27,NULL,NULL);    -- ... arriving 00:27 next day: stored as 27, must not look "earliest"
    INSERT INTO stations VALUES ('LBGT','LBG','London Bridge');
    INSERT INTO schedules VALUES
      (4,'C1','P','2026-08-01','2026-08-31','1111100','XX','SE4'),
      (5,'C2','P','2026-08-01','2026-08-31','1111100','XX','SE5');
  `);
  const j = oneChangeJourney(db, 'TBW', 'SOO', '2026-08-18', 1068, 5); // from 17:48, a Tuesday
  assert.ok(j);
  assert.equal(j!.changeAt, 'PDW'); // not LBG: its 00:27 arrival is normalised to next day, and TON has no SOO onward
  assert.deepEqual(j!.first, { scheduledDeparture: 1070, scheduledArrival: 1095 });
  assert.deepEqual(j!.second, { scheduledDeparture: 1110, scheduledArrival: 1150 }); // the 18:30, not the uncatchable 18:18
  assert.equal(oneChangeJourney(db, 'TBW', 'TON', '2026-08-18', 1068, 5), null); // TON is reached directly; nothing to split
  db.close();
});

// With only the London detour available, its real arrival (00:27 next day) is
// over five hours out: not a credible reconstruction, so nothing is returned.
test('oneChangeJourney rejects a path that would take longer than the credible maximum', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO stations VALUES ('TONT','TON','Tonbridge'),('LBGT','LBG','London Bridge'),('SOOT','SOO','Strood');
    INSERT INTO schedules VALUES
      (4,'C1','P','2026-08-01','2026-08-31','1111100','XX','SE4'),
      (5,'C2','P','2026-08-01','2026-08-31','1111100','XX','SE5');
    INSERT INTO calling_points VALUES
      (8,4,0,'LO','TONT',NULL,1087,NULL),
      (9,4,1,'LT','LBGT',1121,NULL,NULL),
      (10,5,0,'LO','LBGT',NULL,1398,NULL),
      (11,5,1,'LT','SOOT',27,NULL,NULL);
  `);
  assert.equal(oneChangeJourney(db, 'TON', 'SOO', '2026-08-18', 1084, 5), null);
  db.close();
});
