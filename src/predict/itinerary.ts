/**
 * Parses a customer's planned itinerary when it is embedded in the ticket
 * export. Having the real itinerary removes the guesswork in prediction: it
 * pins the legs and interchange, gives Advance tickets their booked service
 * directly, and sets the intended-arrival baseline without a timetable search.
 *
 * Expected shape on the Ticket object (times "HH:MM", CRS codes):
 *   "Itinerary": [
 *     { "coupon_type": "Outward",
 *       "legs": [
 *         { "origin_crs": "EFL", "destination_crs": "PDW",
 *           "scheduled_departure": "07:03", "scheduled_arrival": "07:20",
 *           "service_id": "SE..." }
 *       ] }
 *   ]
 */

import { parseHHMM } from '../timetable/lookup.js';
import type { CouponType, IntendedLeg } from './types.js';

export interface RawItineraryLeg {
  readonly origin_crs?: string;
  readonly destination_crs?: string;
  readonly scheduled_departure?: string;
  readonly scheduled_arrival?: string;
  readonly service_id?: string;
}

export interface RawItinerary {
  readonly coupon_type?: string;
  readonly legs?: readonly RawItineraryLeg[];
}

function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  return parseHHMM(hhmm.replace(':', '').padStart(4, '0'));
}

/**
 * Extracts the legs for one coupon from an embedded itinerary, or null if none
 * is present or it is malformed. Only fully-specified legs (both CRS codes and
 * both times) are returned.
 */
export function parseItineraryLegs(
  itinerary: readonly RawItinerary[] | undefined,
  coupon: CouponType,
): IntendedLeg[] | null {
  if (!itinerary) return null;
  const forCoupon = itinerary.find((i) => i.coupon_type === coupon);
  if (!forCoupon?.legs?.length) return null;

  const legs: IntendedLeg[] = [];
  for (const leg of forCoupon.legs) {
    const dep = toMinutes(leg.scheduled_departure);
    const arr = toMinutes(leg.scheduled_arrival);
    if (!leg.origin_crs || !leg.destination_crs || dep === null || arr === null) return null;
    legs.push({
      originCrs: leg.origin_crs,
      destinationCrs: leg.destination_crs,
      scheduledDeparture: dep,
      scheduledArrival: arr,
    });
  }
  return legs.length > 0 ? legs : null;
}
