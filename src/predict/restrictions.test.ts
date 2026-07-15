import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRestriction, type RestrictionDefinition, type RestrictionJourney } from './restrictions.js';

function at(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

// Southeastern F4 "Super Off-Peak Day": outward, departure 04:00-09:59, not valid.
const F4: RestrictionDefinition = {
  code: 'F4',
  description: 'SUPER OFF-PEAK DAY',
  typeOut: 'P',
  typeReturn: 'P',
  timeRestrictions: [
    { sequence: '0001', outReturn: 'O', timeFrom: at('04:00'), timeTo: at('09:59'), arrDepVia: 'D', location: null, minFareOnly: false, dateBands: [], tocs: new Set() },
  ],
};

function journey(direction: 'O' | 'R', depHHMM: string): RestrictionJourney {
  return {
    direction,
    date: '2026-07-01',
    originDeparture: at(depHHMM),
    destinationArrival: at('11:00'),
    originCrs: 'RTR',
    destinationCrs: 'STP',
    tocs: new Set(['SE']),
  };
}

test('Super Off-Peak: barred departing in the peak window, valid after it', () => {
  assert.equal(evaluateRestriction(F4, journey('O', '09:32')), 'invalid'); // Rochester 09:32
  assert.equal(evaluateRestriction(F4, journey('O', '09:44')), 'invalid'); // Rochester 09:44
  assert.equal(evaluateRestriction(F4, journey('O', '10:02')), 'valid'); // Rochester 10:02
  assert.equal(evaluateRestriction(F4, journey('O', '04:00')), 'invalid'); // window is inclusive
});

test('a restriction with no rules for the direction is not applicable', () => {
  assert.equal(evaluateRestriction(F4, journey('R', '09:32')), 'not-applicable'); // no return TR
});

test('minimum-fare restriction reports min-fare-only, not invalid', () => {
  const minFare: RestrictionDefinition = {
    ...F4,
    timeRestrictions: [{ ...F4.timeRestrictions[0]!, minFareOnly: true }],
  };
  assert.equal(evaluateRestriction(minFare, journey('O', '09:32')), 'min-fare-only');
});

test('TOC-limited restriction only applies to the listed TOC', () => {
  const seTom: RestrictionDefinition = {
    ...F4,
    timeRestrictions: [{ ...F4.timeRestrictions[0]!, tocs: new Set(['SN']) }], // Southern only
  };
  assert.equal(evaluateRestriction(seTom, journey('O', '09:32')), 'valid'); // journey is SE, not SN
});
