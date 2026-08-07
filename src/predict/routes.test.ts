import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCoupon } from './assess.js';
import { classifyRoute, parseRouteLocationRecord, parseRouteRecord } from './routes.js';
import type { IntendedLeg, JourneyConstraints, PlannedItinerary, TicketInfo } from './types.js';
import type { ServiceRun } from '../eligibility/journey.js';

test('classifyRoute maps the common Southeastern codes', () => {
  assert.equal(classifyRoute('ANY PERMITTED'), 'any-permitted');
  assert.equal(classifyRoute('NOT VALID ON HS1'), 'hs1-excluded');
  assert.equal(classifyRoute('PLUS HIGH SPEED'), 'hs1-included');
  assert.equal(classifyRoute('NOT VIA LONDON'), 'other');
});

test('parseRouteRecord reads code and short description from an RR line', () => {
  const line = 'RR00130311229990509202311122017NOT VALID ON HS1NOT VALID ON SOUTHEASTERN HIGH';
  const def = parseRouteRecord(line);
  assert.ok(def);
  assert.equal(def!.code, '00130');
  assert.equal(def!.description, 'NOT VALID ON HS1');
  assert.equal(def!.category, 'hs1-excluded');
});

test('parseRouteLocationRecord reads code, CRS and include/exclude flag', () => {
  // route 00130 excludes Ebbsfleet; route 00790 includes City Thameslink.
  const excl = parseRouteLocationRecord('RL001303112299970 5566EBDE');
  assert.deepEqual(excl, { code: '00130', crs: 'EBD', exclude: true });
  const incl = parseRouteLocationRecord('RL007903112299970 5121CTKI');
  assert.deepEqual(incl, { code: '00790', crs: 'CTK', exclude: false });
});

function ticket(kind: 'advance' | 'walk-up'): TicketInfo {
  return {
    utn: 'R1', ftot: 'SDS', originNlc: '', destinationNlc: '', routeCode: '00130',
    pricePence: 2000, startDate: '2026-07-01', timeValidFrom: null, hasTimeRestriction: false,
    kind, fareType: 'single',
  };
}

function at(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

// Group-level "via" check (increment 3): a NOT-VIA-LONDON ticket (route 00700,
// exclude Euston) is valid on a journey that avoids London but not on one via a
// London terminal - matching the Dover->Brighton Odyssey example, where the
// cheap 00700 fare is only sold on the via-Ashford journey.
test('NOT VIA LONDON is invalid via any London terminal, valid when avoided', () => {
  // London terminals all resolve to group G01; other stations to themselves.
  const london = new Set(['EUS', 'VIC', 'STP', 'LBG', 'CST', 'CHX']);
  const resolve = (crs: string): string[] => (london.has(crs) ? ['G01'] : [crs]);
  const notViaLondon = {
    code: '00700', description: 'NOT VIA LONDON', category: 'other' as const,
    includeLocations: [], excludeLocations: ['EUS'],
  };
  const assess = (calling: string[]) => {
    const runs: ServiceRun[] = [
      { id: 's', scheduledDeparture: at('06:48'), scheduledArrival: at('09:39'), actualDeparture: at('06:48'), actualArrival: at('09:39'), cancelled: false, callingPoints: calling },
    ];
    const itin: PlannedItinerary = {
      legs: [{ originCrs: calling[0]!, destinationCrs: calling[calling.length - 1]!, scheduledDeparture: at('06:48'), scheduledArrival: at('09:39') }],
      candidatesByLeg: [runs],
    };
    const constraints: JourneyConstraints = { coupon: 'Single', onTrain: [], reasonCodes: [], anomalies: [] };
    return assessCoupon({
      ticket: { ...ticket('walk-up'), routeCode: '00700' }, coupon: 'Single',
      fromCrs: calling[0]!, toCrs: calling[calling.length - 1]!, constraints,
      itineraries: [itin], bookedLegs: null, routeDef: notViaLondon, resolveRouteingPoints: resolve,
    });
  };

  const viaAshford = assess(['DVP', 'AFK', 'HMD', 'BTN']); // avoids London
  assert.notEqual(viaAshford.reason, 'ROUTE_NOT_PERMITTED');

  const viaVictoria = assess(['DVP', 'VIC', 'BTN']); // through London Victoria
  assert.equal(viaVictoria.reason, 'ROUTE_NOT_PERMITTED');
  assert.ok(viaVictoria.anomalies.some((a) => /excluded location/.test(a)));
});

// A ticket flagged NOT VALID ON HS1, used on a High Speed service to St Pancras.
test('HS1-excluded route on a High Speed journey is not permitted', () => {
  const runs: ServiceRun[] = [
    { id: 's', scheduledDeparture: at('08:25'), scheduledArrival: at('09:00'), actualDeparture: at('08:25'), actualArrival: at('09:20'), cancelled: false },
  ];
  const itin: PlannedItinerary = { legs: [{ originCrs: 'EBD', destinationCrs: 'STP', scheduledDeparture: at('08:25'), scheduledArrival: at('09:00') }], candidatesByLeg: [runs] };
  const constraints: JourneyConstraints = { coupon: 'Single', entry: { crs: 'EBD', timeMinutes: at('08:20') }, exit: { crs: 'STP', timeMinutes: at('09:22') }, onTrain: [], reasonCodes: [], anomalies: [] };
  const v = assessCoupon({
    ticket: ticket('walk-up'), coupon: 'Single', fromCrs: 'EBD', toCrs: 'STP', constraints,
    itineraries: [itin], bookedLegs: null,
    routeDef: { code: '00130', description: 'NOT VALID ON HS1', category: 'hs1-excluded', includeLocations: [], excludeLocations: ['EBD', 'SFA'] },
  });
  // Delayed 20 min, but the ticket wasn't valid on HS1, so not entitled.
  assert.equal(v.entitled, false);
  assert.equal(v.reason, 'ROUTE_NOT_PERMITTED');
  assert.ok(v.anomalies.some((a) => /does not permit High Speed/.test(a)));
});
