/**
 * Tests for the scan reason-code dictionary. The key guarantees: only codes
 * confirmed to mean invalid travel drive a rejection, and every other code
 * (including unknown ones) is surfaced as a review flag rather than a reject.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInvalidTravelCode, lookupReasonCode } from './reason-codes.js';
import { extractConstraints, normaliseScans, type RawScan } from './scans.js';

const nlcToCrs = (nlc: string): string | null => (nlc === '1555' ? 'STP' : null);

test('INCTIM is confirmed invalid travel; LOCDIR is confirmed review only', () => {
  assert.equal(isInvalidTravelCode('INCTIM'), true);
  assert.equal(lookupReasonCode('INCTIM').confirmed, true);

  assert.equal(isInvalidTravelCode('LOCDIR'), false);
  assert.equal(lookupReasonCode('LOCDIR').action, 'review');
  assert.equal(lookupReasonCode('LOCDIR').confirmed, true);
});

test('unconfirmed known codes are review only, never invalid travel', () => {
  for (const code of ['DNYLST', 'EXPDTE', 'LOCORG', 'CPNRPL', 'FUTURE']) {
    assert.equal(isInvalidTravelCode(code), false, `${code} must not drive a rejection`);
    assert.equal(lookupReasonCode(code).confirmed, false, `${code} is not yet confirmed`);
  }
});

test('an unrecognised code falls back to review, not a rejection', () => {
  const info = lookupReasonCode('WOTSIT');
  assert.equal(info.action, 'review');
  assert.equal(info.confirmed, false);
  assert.equal(isInvalidTravelCode('WOTSIT'), false);
});

test('extractConstraints collects raw codes and enriches the anomaly with the meaning', () => {
  const raw: RawScan[] = [
    { SCANID: 1, coupon_type: 'Single', TIME: '2026-07-01T19:09:00+01:00', STATION: '1555', scan_mode: 'clip', action_text: 'Rejected', reason_code: 'LOCDIR' },
  ];
  const scans = normaliseScans(raw, nlcToCrs);
  const c = extractConstraints('Single', scans);

  assert.deepEqual([...c.reasonCodes], ['LOCDIR']);
  assert.ok(c.anomalies.some((a) => a.includes('LOCDIR') && a.includes('Wrong direction')));
});
