/**
 * Ticket validity checks (Step 4 / Step 7 of docs/service-prediction.md).
 *
 * Pragmatic v1: enforces Advance booked-service travel and TimeValidFrom, and
 * surfaces scan reason-code anomalies. Off-Peak / Super Off-Peak restriction
 * bands (the RST data) are NOT parsed yet, so those tickets get a "not
 * verified" flag rather than a false pass.
 */

import { parseHHMM } from '../timetable/lookup.js';
import { HS1_STATIONS, ST_PANCRAS, type RouteDefinition } from './routes.js';
import type { IntendedLeg, JourneyConstraints, PredictedLeg, TicketInfo } from './types.js';

export interface ValidityResult {
  readonly valid: boolean;
  /** Reason code when not valid, e.g. INVALID_TICKET_FOR_SERVICE. */
  readonly reason: string | null;
  readonly anomalies: readonly string[];
}

/** Reason codes from the scanning system that indicate invalid travel. */
const INVALID_TRAVEL_REASON_CODES = new Set(['INCTIM']);

/** The CRS codes a journey called at, across all legs. */
function journeyStations(legs: readonly PredictedLeg[]): Set<string> {
  return new Set(legs.flatMap((l) => (l.callingPoints.length > 0 ? l.callingPoints : [l.originCrs, l.destinationCrs])));
}

export function assessValidity(
  ticket: TicketInfo,
  constraints: JourneyConstraints,
  predictedLegs: readonly PredictedLeg[],
  bookedLegs: readonly IntendedLeg[] | null,
  routeDef: RouteDefinition | null = null,
  /** Maps a CRS to its routeing point(s)/group, so "via" checks work at group
   *  level (e.g. any London terminal counts as "via London"). */
  resolveRouteingPoints?: (crs: string) => string[],
): ValidityResult {
  const anomalies: string[] = [];
  let reason: string | null = null;

  const firstLeg = predictedLegs[0];

  // Advance: the customer must travel on the booked service.
  if (ticket.kind === 'advance' && bookedLegs && bookedLegs.length > 0 && firstLeg) {
    const booked = bookedLegs[0]!;
    const rodeBooked =
      firstLeg.scheduledDeparture === booked.scheduledDeparture &&
      firstLeg.scheduledArrival === booked.scheduledArrival;
    if (!rodeBooked) {
      reason = 'INVALID_TICKET_FOR_SERVICE';
      anomalies.push(
        `Advance ticket used on a non-booked service (booked ${fmt(booked.scheduledDeparture)}, ` +
          `travelled ${fmt(firstLeg.scheduledDeparture)})`,
      );
    }
  }

  // TimeValidFrom: the first service must not depart before the valid-from time.
  if (ticket.timeValidFrom && firstLeg) {
    const validFrom = parseHHMM(ticket.timeValidFrom.replace(':', ''));
    const departed = firstLeg.actualDeparture ?? firstLeg.scheduledDeparture;
    if (departed < validFrom) {
      if (!reason) reason = 'OUTSIDE_VALIDITY';
      anomalies.push(`Travelled at ${fmt(departed)}, before the ticket's valid-from time ${ticket.timeValidFrom}`);
    }
  }

  // Reason-code anomalies from the scans.
  for (const code of scanReasonCodes(constraints)) {
    if (INVALID_TRAVEL_REASON_CODES.has(code) && !reason) reason = 'INVALID_TICKET_FOR_SERVICE';
  }

  // Route code (RSPS5047 9.1): the journey must not pass through the route's
  // "exclude" locations and must pass through its "include" locations. We
  // check against the stations we know (leg endpoints + interchanges); passing
  // points aren't loaded yet, so a "must include" we can't see is flagged for
  // review rather than failed.
  if (routeDef) {
    const stations = journeyStations(predictedLegs);
    // A location and the routeing point(s)/group it belongs to, so a "via"
    // check matches at group level (any London terminal -> London group G01).
    const expand = (crs: string): string[] => (resolveRouteingPoints ? [crs, ...resolveRouteingPoints(crs)] : [crs]);
    const journeySet = new Set([...stations].flatMap(expand));
    const passesThrough = (loc: string): boolean => expand(loc).some((x) => journeySet.has(x));

    // Must-not-pass-through locations the journey travelled via.
    const viaExcluded = routeDef.excludeLocations.filter(passesThrough);
    const hs1Hit = viaExcluded.filter((c) => HS1_STATIONS.has(c));
    const otherHit = viaExcluded.filter((c) => !HS1_STATIONS.has(c));
    if (viaExcluded.length > 0 && !reason) reason = 'ROUTE_NOT_PERMITTED';
    if (hs1Hit.length > 0) {
      anomalies.push(
        `Route ${routeDef.code} (${routeDef.description}) does not permit High Speed, but the journey used HS1 (${hs1Hit.join(', ')})`,
      );
    }
    if (otherHit.length > 0) {
      anomalies.push(`Route ${routeDef.code} (${routeDef.description}): journey travelled via excluded location(s) ${otherHit.join(', ')}`);
    }

    // St Pancras is HS1-capable but ambiguous on stops (HS1 or Thameslink); if
    // an HS1-excluded ticket ends there and we didn't confirm HS1 above, flag it.
    const hs1Excluded =
      routeDef.category === 'hs1-excluded' || routeDef.excludeLocations.some((c) => HS1_STATIONS.has(c));
    const toStPancras = predictedLegs.some((l) => l.destinationCrs === ST_PANCRAS);
    if (hs1Excluded && toStPancras && hs1Hit.length === 0) {
      anomalies.push(
        `Route ${routeDef.code} (${routeDef.description}): journey ends at St Pancras, which is HS1-capable; can't confirm from stops whether HS1 was used`,
      );
    }

    // Must-include locations we can't confirm from the stops we have.
    const unconfirmedIncludes = routeDef.includeLocations.filter((c) => !passesThrough(c));
    if (unconfirmedIncludes.length > 0) {
      anomalies.push(
        `Route ${routeDef.code} (${routeDef.description}) requires travel via ${unconfirmedIncludes.join(', ')}; not confirmed from available stops (passing points not loaded)`,
      );
    }

    // Codes we can't classify and have no location rules to check.
    if (routeDef.category === 'other' && routeDef.includeLocations.length === 0 && routeDef.excludeLocations.length === 0) {
      anomalies.push(`Route ${routeDef.code} (${routeDef.description || 'unknown'}) not automatically verified`);
    }
  }

  // Off-Peak time restrictions are not machine-checked yet.
  if (ticket.hasTimeRestriction) {
    anomalies.push('Off-peak time restriction not automatically verified (RST data not loaded)');
  }

  return { valid: reason === null, reason, anomalies };
}

function scanReasonCodes(constraints: JourneyConstraints): string[] {
  const codes: string[] = [];
  for (const anomaly of constraints.anomalies) {
    const match = /\(([A-Z]+)\)/.exec(anomaly);
    if (match) codes.push(match[1]!);
  }
  return codes;
}

function fmt(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
