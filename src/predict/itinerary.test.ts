import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItineraryLegs, type RawItinerary } from './itinerary.js';

const itinerary: RawItinerary[] = [
  {
    coupon_type: 'Outward',
    legs: [
      { origin_crs: 'EFL', destination_crs: 'PDW', scheduled_departure: '07:03', scheduled_arrival: '07:20' },
      { origin_crs: 'PDW', destination_crs: 'CST', scheduled_departure: '07:37', scheduled_arrival: '08:31' },
    ],
  },
];

test('parses the legs for the requested coupon into minutes', () => {
  const legs = parseItineraryLegs(itinerary, 'Outward');
  assert.ok(legs);
  assert.equal(legs!.length, 2);
  assert.deepEqual(legs![0], { originCrs: 'EFL', destinationCrs: 'PDW', scheduledDeparture: 423, scheduledArrival: 440 });
  assert.equal(legs![1]!.scheduledArrival, 8 * 60 + 31);
});

test('returns null when no itinerary matches the coupon', () => {
  assert.equal(parseItineraryLegs(itinerary, 'Return'), null);
  assert.equal(parseItineraryLegs(undefined, 'Single'), null);
});

test('returns null when a leg is missing a required field', () => {
  const bad: RawItinerary[] = [{ coupon_type: 'Single', legs: [{ origin_crs: 'TON', scheduled_departure: '08:00' }] }];
  assert.equal(parseItineraryLegs(bad, 'Single'), null);
});
