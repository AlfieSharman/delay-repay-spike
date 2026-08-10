/**
 * End-to-end tests for the prediction pipeline, using the five real ticket
 * examples worked through by hand (see docs/service-prediction.md). Each test
 * runs the full pure path: normalise scans -> group -> extract constraints ->
 * assessCoupon, with the timetable/HSP-derived data supplied as fixtures.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServiceRun } from '../eligibility/journey.js';
import { assessCoupon } from './assess.js';
import { extractConstraints, groupByCoupon, normaliseScans, type RawScan } from './scans.js';
import type { CouponType, IntendedLeg, JourneyConstraints, PlannedItinerary, TicketInfo } from './types.js';

function at(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

const NLC_TO_CRS: Record<string, string> = {
  '5191': 'SOO', '1555': 'STP', '5196': 'WHI', '5226': 'RBR', '5143': 'CHX',
  '5199': 'CTM', '5426': 'VIC', '5234': 'EFL', '5142': 'CST',
};
const nlcToCrs = (nlc: string): string | null => NLC_TO_CRS[nlc] ?? null;

function run(
  id: string,
  schedDep: string,
  schedArr: string,
  actDep: string | null,
  actArr: string | null,
): ServiceRun {
  return {
    id,
    scheduledDeparture: at(schedDep),
    scheduledArrival: at(schedArr),
    actualDeparture: actDep === null ? null : at(actDep),
    actualArrival: actArr === null ? null : at(actArr),
    cancelled: actArr === null,
  };
}

function leg(originCrs: string, destinationCrs: string, dep: string, arr: string): IntendedLeg {
  return { originCrs, destinationCrs, scheduledDeparture: at(dep), scheduledArrival: at(arr) };
}

function ticket(partial: Partial<TicketInfo> & Pick<TicketInfo, 'utn' | 'ftot' | 'kind' | 'fareType'>): TicketInfo {
  return {
    originNlc: '', destinationNlc: '', routeCode: null, pricePence: 0,
    startDate: '2026-07-01', timeValidFrom: null, hasTimeRestriction: false,
    ...partial,
  };
}

/** Runs one coupon of a ticket through the full pipeline. */
function assessOne(
  t: TicketInfo,
  rawScans: RawScan[],
  coupon: CouponType,
  fromCrs: string,
  toCrs: string,
  itineraries: PlannedItinerary[],
  bookedLegs: IntendedLeg[] | null = null,
) {
  const scans = normaliseScans(rawScans, nlcToCrs);
  const constraints = extractConstraints(coupon, groupByCoupon(scans).get(coupon) ?? []);
  return assessCoupon({ ticket: t, coupon, fromCrs, toCrs, constraints, itineraries, bookedLegs });
}

// ---------------------------------------------------------------- T1 Strood -> St Pancras
test('T1: gated both ends, 15 min late, eligible and CONFIRMED', () => {
  const t = ticket({ utn: 'T1', ftot: 'SRR', kind: 'walk-up', fareType: 'return', pricePence: 1800, hasTimeRestriction: true });
  const scans: RawScan[] = [
    { SCANID: 1, coupon_type: 'Outward', TIME: '2026-07-01T17:21:00+01:00', STATION: '5191', scan_mode: 'entry', action_text: 'Accepted' },
    { SCANID: 2, coupon_type: 'Outward', TIME: '2026-07-01T18:27:00+01:00', STATION: '1555', scan_mode: 'exit', action_text: 'Accepted' },
    { SCANID: 3, TIME: '2026-07-07T08:03:00+01:00', STATION: null, action_text: 'DR Approved' },
  ];
  const itin: PlannedItinerary = {
    legs: [leg('SOO', 'STP', '17:35', '18:10')],
    candidatesByLeg: [[
      run('a', '17:05', '17:38', '17:08', '18:00'),
      run('b', '17:17', '18:43', '17:17', '18:41'),
      run('c', '17:35', '18:10', '17:35', '18:25'),
      run('d', '17:47', '19:13', '17:48', '19:11'),
      run('e', '18:05', '18:38', '18:06', '18:40'),
    ]],
  };
  const v = assessOne(t, scans, 'Outward', 'SOO', 'STP', [itin]);
  assert.equal(v.entitled, true);
  assert.equal(v.delayMinutes, 15);
  assert.equal(v.band, '15-29');
  assert.equal(v.compensationPence, 225); // 12.5% of £18.00
  assert.equal(v.confidence, 'CONFIRMED');
});

// ---------------------------------------------------------------- T2 St Pancras -> Whitstable
test('T2: gated origin only, wrong-direction rejected scan, eligible but INFERRED', () => {
  const t = ticket({ utn: 'T2', ftot: 'SWS', kind: 'walk-up', fareType: 'single', pricePence: 2650, hasTimeRestriction: true });
  const scans: RawScan[] = [
    { SCANID: 1, coupon_type: 'Single', TIME: '2026-07-01T18:19:00+01:00', STATION: '1555', scan_mode: 'entry', action_text: 'Accepted' },
    { SCANID: 2, coupon_type: 'Single', TIME: '2026-07-01T19:09:30+01:00', STATION: '1555', scan_mode: 'clip', action_text: 'Rejected', reason_code: 'LOCDIR', train_info: 'We1621 RAM-STP 1C53/SE8153' },
  ];
  const itin: PlannedItinerary = {
    legs: [leg('STP', 'WHI', '18:25', '19:44')],
    candidatesByLeg: [[
      run('a', '18:25', '19:44', '18:37', '20:05'),
      run('b', '19:20', '20:39', '19:26', '20:42'),
    ]],
  };
  const v = assessOne(t, scans, 'Single', 'STP', 'WHI', [itin]);
  assert.equal(v.entitled, true);
  assert.equal(v.delayMinutes, 21);
  assert.equal(v.band, '15-29');
  assert.equal(v.confidence, 'INFERRED');
  assert.ok(v.anomalies.some((a) => a.includes('LOCDIR')));
  assert.ok(v.anomalies.some((a) => /restriction not automatically verified/.test(a)));
});

// ---------------------------------------------------------------- T3 Robertsbridge <-> Charing Cross
test('T3 outward: train_info + exit tap, on time, not eligible and CONFIRMED', () => {
  const t = ticket({ utn: 'T3', ftot: 'SRR', kind: 'walk-up', fareType: 'return', pricePence: 1700, hasTimeRestriction: true });
  const scans: RawScan[] = [
    { SCANID: 1, coupon_type: 'Outward', TIME: '2026-07-01T12:35:00+01:00', STATION: '5143', scan_mode: 'clip', action_text: 'Accepted', train_info: 'We1150 HGS-CHX 1H80/SE2280' },
    { SCANID: 2, coupon_type: 'Outward', TIME: '2026-07-01T13:34:00+01:00', STATION: '5143', scan_mode: 'exit', action_text: 'Accepted' },
  ];
  const itin: PlannedItinerary = {
    legs: [leg('RBR', 'CHX', '12:14', '13:33')],
    candidatesByLeg: [[run('a', '12:14', '13:33', '12:16', '13:32')]],
  };
  const v = assessOne(t, scans, 'Outward', 'RBR', 'CHX', [itin]);
  assert.equal(v.entitled, false);
  assert.equal(v.reason, 'NOT_DELAYED');
  assert.equal(v.delayMinutes, 0);
  assert.equal(v.confidence, 'CONFIRMED');
});

// ---------------------------------------------------------------- T4 Chatham -> Victoria (Advance)
test('T4: Advance ticket ridden on a non-booked earlier train, not entitled', () => {
  const t = ticket({ utn: 'T4', ftot: 'L14', kind: 'advance', fareType: 'single', pricePence: 2110, timeValidFrom: '07:49' });
  const scans: RawScan[] = [
    { SCANID: 1, coupon_type: 'Single', TIME: '2026-07-01T07:23:00+01:00', STATION: '5199', scan_mode: 'entry', action_text: 'Accepted' },
    { SCANID: 2, coupon_type: 'Single', TIME: '2026-07-01T08:18:00+01:00', STATION: '5426', scan_mode: 'clip', action_text: 'Rejected', reason_code: 'INCTIM', train_info: 'We0648 DVP-VIC 1P14/SE5114' },
    { SCANID: 3, coupon_type: 'Single', TIME: '2026-07-01T08:55:00+01:00', STATION: '5426', scan_mode: 'exit', action_text: 'Accepted' },
  ];
  const booked = [leg('CTM', 'VIC', '07:49', '09:04')];
  const itin: PlannedItinerary = {
    legs: booked,
    candidatesByLeg: [[
      run('dvp', '07:03', '07:56', '07:02', '08:05'),
      run('glm1', '07:19', '08:31', '07:19', '08:31'),
      run('ram', '07:30', '08:26', '07:30', '08:24'),
      run('glm2', '07:49', '09:04', null, '09:02'), // booked; no actual departure recorded
    ]],
  };
  const v = assessOne(t, scans, 'Single', 'CTM', 'VIC', [itin], booked);
  assert.equal(v.entitled, false);
  assert.equal(v.reason, 'INVALID_TICKET_FOR_SERVICE');
  assert.ok(v.anomalies.some((a) => a.includes('INCTIM')));
  assert.ok(v.anomalies.some((a) => /non-booked service/.test(a)));
  // Booked service ran on time, so even setting validity aside there is no delay.
  assert.equal(v.delayMinutes, 0);
});

// -------------------------------- Advance with a disrupted booked service
test('Advance booked service disrupted: eligible against the itinerary arrival', () => {
  // Booked 06:01 Strood->St Pancras (arr 06:34) ran 43 late; the customer took
  // the 06:31 instead and arrived 07:13 (exit tap) = 39 late vs the itinerary.
  const t = ticket({ utn: 'ADV', ftot: 'L13', kind: 'advance', fareType: 'single', pricePence: 2190, timeValidFrom: '06:01' });
  const scans: RawScan[] = [
    { SCANID: 1, coupon_type: 'Single', TIME: '2026-07-01T06:27:00+01:00', STATION: '5191', scan_mode: 'entry', action_text: 'Accepted' },
    { SCANID: 2, coupon_type: 'Single', TIME: '2026-07-01T07:13:00+01:00', STATION: '1555', scan_mode: 'exit', action_text: 'Accepted' },
  ];
  const booked = [leg('SOO', 'STP', '06:01', '06:34')];
  const itin: PlannedItinerary = {
    legs: booked,
    candidatesByLeg: [[
      run('booked', '06:01', '06:34', '06:01', '07:17'), // booked, 43 late
      run('alt', '06:31', '07:04', '06:31', '07:10'), // the service actually taken
    ]],
  };
  const v = assessOne(t, scans, 'Single', 'SOO', 'STP', [itin], booked);
  assert.equal(v.entitled, true);
  assert.equal(v.reason, null);
  assert.equal(v.delayMinutes, 39); // 07:13 exit vs 06:34 booked itinerary arrival
  assert.equal(v.band, '30-59');
  assert.equal(v.compensationPence, 1095); // 50% of £21.90
});

// A booked service that ran on time but was skipped by choice stays invalid: see
// the T4 test above (INVALID_TICKET_FOR_SERVICE), which the disruption rule must
// not weaken.

// -------------------------------- Walk-up itinerary fallback (boarded downstream of origin)
test('Walk-up: boarded downstream of the ticket origin falls back to the itinerary baseline', () => {
  // Ticket Gravesend->Stratford Intl, itinerary 06:11->06:26. The booked service
  // was cancelled and the customer boarded at Ebbsfleet (downstream), exiting
  // Stratford at 06:45. No GRV->SFA actual fits the exit, so normal resolution
  // fails; the fallback measures 06:45 vs the 06:26 itinerary arrival = 19 late.
  const t = ticket({ utn: 'WUF', ftot: 'SDS', kind: 'walk-up', fareType: 'single', pricePence: 1470 });
  const itin: PlannedItinerary = {
    legs: [leg('GRV', 'SFA', '06:11', '06:26')],
    candidatesByLeg: [[
      run('booked', '06:11', '06:26', null, null), // cancelled
      run('next', '06:44', '06:59', '06:44', '06:59'), // arrives after the exit tap
    ]],
  };
  const constraints: JourneyConstraints = {
    coupon: 'Single',
    entry: { crs: 'EBD', timeMinutes: at('06:27') }, // downstream of GRV
    exit: { crs: 'SFA', timeMinutes: at('06:45') },
    onTrain: [], reasonCodes: [], anomalies: [],
  };
  const v = assessCoupon({
    ticket: t, coupon: 'Single', fromCrs: 'GRV', toCrs: 'SFA', constraints,
    itineraries: [itin], bookedLegs: null, itineraryPinned: true,
  });
  assert.equal(v.entitled, true);
  assert.equal(v.delayMinutes, 19);
  assert.equal(v.band, '15-29');
  assert.equal(v.confidence, 'INFERRED');
  assert.equal(v.compensationPence, 368); // 25% of £14.70
});

// Without itineraryPinned the same unresolvable journey stays UNKNOWN (the
// fallback must not fire for inferred candidates or fully-scanned walk-ups).
test('Walk-up fallback does not fire without a pinned itinerary', () => {
  const t = ticket({ utn: 'WUF2', ftot: 'SDS', kind: 'walk-up', fareType: 'single', pricePence: 1470 });
  const itin: PlannedItinerary = {
    legs: [leg('GRV', 'SFA', '06:11', '06:26')],
    candidatesByLeg: [[run('next', '06:44', '06:59', '06:44', '06:59')]],
  };
  const constraints: JourneyConstraints = {
    coupon: 'Single',
    entry: { crs: 'EBD', timeMinutes: at('06:27') },
    exit: { crs: 'SFA', timeMinutes: at('06:45') },
    onTrain: [], reasonCodes: [], anomalies: [],
  };
  const v = assessCoupon({
    ticket: t, coupon: 'Single', fromCrs: 'GRV', toCrs: 'SFA', constraints,
    itineraries: [itin], bookedLegs: null, // itineraryPinned omitted
  });
  assert.equal(v.entitled, false);
  assert.equal(v.reason, 'SERVICE_UNRESOLVED');
});

// ---------------------------------------------------------------- T5 East Farleigh -> Cannon Street
test('T5: single destination scan, multi-leg with a cancelled connection, 18 late eligible', () => {
  const t = ticket({ utn: 'T5', ftot: 'SDS', kind: 'walk-up', fareType: 'single', pricePence: 1835 });
  const scans: RawScan[] = [
    { SCANID: 1, coupon_type: 'Single', TIME: '2026-07-01T08:52:00+01:00', STATION: '5142', scan_mode: 'exit', action_text: 'Accepted' },
  ];
  const itin: PlannedItinerary = {
    legs: [leg('EFL', 'PDW', '07:03', '07:20'), leg('PDW', 'CST', '07:37', '08:31')],
    candidatesByLeg: [
      [run('l1', '07:03', '07:20', '07:03', '07:20')],
      [
        run('conn', '07:37', '08:31', null, null), // cancelled intended connection
        run('next', '07:45', '08:38', '07:45', '08:49'),
      ],
    ],
  };
  const v = assessOne(t, scans, 'Single', 'EFL', 'CST', [itin]);
  assert.equal(v.entitled, true);
  assert.equal(v.delayMinutes, 18);
  assert.equal(v.band, '15-29');
  assert.equal(v.compensationPence, 459); // 25% of £18.35
  assert.equal(v.predictedLegs.length, 2);
  assert.ok(v.explanation.some((line) => /07:37 service was cancelled/.test(line)));
});
