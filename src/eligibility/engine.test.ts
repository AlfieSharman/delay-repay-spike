/**
 * Unit tests for the eligibility engine, using mocked service runs so no
 * database or HSP access is needed. Times are minutes since midnight.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessEligibility } from './engine.js';
import type { Journey, ServiceRun } from './journey.js';

/** "HH:MM" -> minutes since midnight, to keep the test data readable. */
function at(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

function run(partial: Partial<ServiceRun> & Pick<ServiceRun, 'id' | 'scheduledDeparture' | 'scheduledArrival'>): ServiceRun {
  return {
    actualDeparture: partial.scheduledDeparture,
    actualArrival: partial.scheduledArrival,
    cancelled: false,
    ...partial,
  };
}

test('single leg on time is not eligible', () => {
  const journey: Journey = {
    legs: [{ origin: 'TON', destination: 'CST', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30') }],
    ticketKind: 'advance',
    fareType: 'single',
    date: '2026-06-30',
  };
  const result = assessEligibility(journey, [[run({ id: 's1', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30') })]]);
  assert.equal(result.eligible, false);
  assert.equal(result.delayMinutes, 0);
  assert.equal(result.band, null);
  assert.equal(result.compensationPercentage, 0);
});

test('single leg delayed 20 min is eligible in the 15-29 band', () => {
  const journey: Journey = {
    legs: [{ origin: 'TON', destination: 'CST', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30') }],
    ticketKind: 'advance',
    fareType: 'single',
    date: '2026-06-30',
  };
  const result = assessEligibility(journey, [
    [run({ id: 's1', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30'), actualArrival: at('08:50') })],
  ]);
  assert.equal(result.eligible, true);
  assert.equal(result.delayMinutes, 20);
  assert.equal(result.band, '15-29');
  assert.equal(result.compensationPercentage, 25);
});

// The worked multi-leg example from the phase-3 brief.
// Leg 1: A dep 16:00 -> B arr 16:30, actually arrives B 16:50.
// Leg 2 booked: B dep 16:55 -> C arr 17:30. Ready at B is 16:50+5=16:55, so the
// booked 16:55 connection is missed; the customer takes the next valid B->C
// service. Threshold 15, intended arrival at C is 17:30.
function workedExample(): Journey {
  return {
    legs: [
      { origin: 'AAA', destination: 'BBB', scheduledDeparture: at('16:00'), scheduledArrival: at('16:30') },
      { origin: 'BBB', destination: 'CCC', scheduledDeparture: at('16:55'), scheduledArrival: at('17:30') },
    ],
    ticketKind: 'advance',
    fareType: 'single',
    date: '2026-06-30',
    threshold: 15,
    interchangeMinutes: 5,
  };
}

function workedExampleServices(nextArrivalAtC: string): ServiceRun[][] {
  return [
    [run({ id: 'leg1', scheduledDeparture: at('16:00'), scheduledArrival: at('16:30'), actualArrival: at('16:50') })],
    [
      // Booked connection, runs on time but can't be caught (ready exactly 16:55).
      run({ id: 'leg2-booked', scheduledDeparture: at('16:55'), scheduledArrival: at('17:30') }),
      // Next valid service to C.
      run({ id: 'leg2-next', scheduledDeparture: at('17:00'), scheduledArrival: at('17:35'), actualDeparture: at('17:00'), actualArrival: at(nextArrivalAtC) }),
    ],
  ];
}

test('multi-leg missed connection arriving 17:44 is NOT eligible (delay 14)', () => {
  const result = assessEligibility(workedExample(), workedExampleServices('17:44'));
  assert.equal(result.delayMinutes, 14);
  assert.equal(result.eligible, false);
  assert.equal(result.band, null);
});

test('multi-leg missed connection arriving 17:45 IS eligible (delay 15)', () => {
  const result = assessEligibility(workedExample(), workedExampleServices('17:45'));
  assert.equal(result.delayMinutes, 15);
  assert.equal(result.eligible, true);
  assert.equal(result.band, '15-29');
  assert.equal(result.compensationPercentage, 25);
  // The narration should show the missed connection and the next service.
  assert.ok(result.explanation.some((line) => /missed booked 16:55 connection/.test(line)));
  assert.ok(result.explanation.some((line) => /next valid service/.test(line)));
});

test('flexible ticket: an earlier-arriving alternative removes eligibility', () => {
  const journey: Journey = {
    legs: [{ origin: 'TON', destination: 'CST', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30') }],
    ticketKind: 'flexible',
    fareType: 'single',
    date: '2026-06-30',
  };
  const services: ServiceRun[][] = [
    [
      // Intended service, badly delayed.
      run({ id: 'intended', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30'), actualArrival: at('08:50') }),
      // Alternative departing after the intended time, arriving only 10 late.
      run({ id: 'alt', scheduledDeparture: at('08:10'), scheduledArrival: at('08:45'), actualDeparture: at('08:12'), actualArrival: at('08:40') }),
    ],
  ];
  const result = assessEligibility(journey, services);
  assert.equal(result.delayMinutes, 10);
  assert.equal(result.eligible, false);
});

test('cancelled booked service: customer takes a later train and is eligible', () => {
  const journey: Journey = {
    legs: [{ origin: 'TON', destination: 'CST', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30') }],
    ticketKind: 'advance',
    fareType: 'single',
    date: '2026-06-30',
  };
  const services: ServiceRun[][] = [
    [
      run({ id: 'booked', scheduledDeparture: at('08:00'), scheduledArrival: at('08:30'), cancelled: true, actualDeparture: null, actualArrival: null }),
      run({ id: 'next', scheduledDeparture: at('08:30'), scheduledArrival: at('09:00'), actualDeparture: at('08:35'), actualArrival: at('09:10') }),
    ],
  ];
  const result = assessEligibility(journey, services);
  assert.equal(result.eligible, true);
  assert.equal(result.delayMinutes, 40);
  assert.equal(result.band, '30-59');
  assert.equal(result.compensationPercentage, 50);
  assert.ok(result.explanation.some((line) => /was cancelled/.test(line)));
});
