/**
 * Ticket validity checks (Step 4 / Step 7 of docs/service-prediction.md).
 *
 * Pragmatic v1: enforces Advance booked-service travel and TimeValidFrom, and
 * surfaces scan reason-code anomalies. Off-Peak / Super Off-Peak restriction
 * bands (the RST data) are NOT parsed yet, so those tickets get a "not
 * verified" flag rather than a false pass.
 */

import { parseHHMM } from '../timetable/lookup.js';
import type { IntendedLeg, JourneyConstraints, PredictedLeg, TicketInfo } from './types.js';

export interface ValidityResult {
  readonly valid: boolean;
  /** Reason code when not valid, e.g. INVALID_TICKET_FOR_SERVICE. */
  readonly reason: string | null;
  readonly anomalies: readonly string[];
}

/** Reason codes from the scanning system that indicate invalid travel. */
const INVALID_TRAVEL_REASON_CODES = new Set(['INCTIM']);

export function assessValidity(
  ticket: TicketInfo,
  constraints: JourneyConstraints,
  predictedLegs: readonly PredictedLeg[],
  bookedLegs: readonly IntendedLeg[] | null,
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
