/**
 * Per-coupon assessment: given the scan constraints and the candidate
 * itineraries (scheduled legs + actual runs) for one coupon, decide which
 * service the customer took, whether the ticket was valid, and hand the
 * journey to the eligibility engine for the delay verdict.
 *
 * Pure: all timetable/HSP access happens in the caller (the batch runner),
 * which supplies the PlannedItinerary. That keeps this logic unit-testable
 * with mocked data.
 */

import { assessEligibility } from '../eligibility/engine.js';
import type { Journey, Leg, ServiceRun } from '../eligibility/journey.js';
import { formatMinutes } from '../timetable/lookup.js';
import { compensationPence } from './compensation.js';
import { resolveBest } from './resolve.js';
import type { RouteDefinition } from './routes.js';
import { assessValidity } from './validity.js';
import type {
  Confidence,
  CouponType,
  CouponVerdict,
  IntendedLeg,
  JourneyConstraints,
  PlannedItinerary,
  PredictedLeg,
  TicketInfo,
} from './types.js';

const DEFAULT_THRESHOLD = 15;
const DEFAULT_INTERCHANGE = 5;

export interface AssessCouponInput {
  readonly ticket: TicketInfo;
  readonly coupon: CouponType;
  /** Journey direction for this coupon (Return legs are reversed). */
  readonly fromCrs: string;
  readonly toCrs: string;
  readonly constraints: JourneyConstraints;
  /** Candidate itineraries; the best-fitting one is chosen. */
  readonly itineraries: readonly PlannedItinerary[];
  /** Booked legs for an Advance ticket, else null. */
  readonly bookedLegs: readonly IntendedLeg[] | null;
  /** Route-code definition for the ticket, if resolved. */
  readonly routeDef?: RouteDefinition | null;
  readonly threshold?: number;
  readonly interchangeMinutes?: number;
}

function downgrade(level: Confidence): Confidence {
  if (level === 'CONFIRMED') return 'PROBABLE';
  if (level === 'PROBABLE') return 'INFERRED';
  return level;
}

function unresolvedVerdict(
  coupon: CouponType,
  constraints: JourneyConstraints,
  reason: string,
): CouponVerdict {
  return {
    coupon,
    entitled: false,
    reason,
    confidence: 'UNKNOWN',
    predictedLegs: [],
    delayMinutes: null,
    band: null,
    compensationPence: null,
    anomalies: constraints.anomalies,
    explanation: ['Could not reconstruct the journey from the available scans and services.'],
  };
}

/** Minimum scheduled arrival among first-leg candidates departing at/after `ready`. */
function intendedArrivalSingleLeg(candidates: readonly ServiceRun[], ready: number): number | null {
  const reachable = candidates.filter((c) => c.scheduledDeparture >= ready);
  if (reachable.length === 0) return null;
  return reachable.reduce((min, c) => Math.min(min, c.scheduledArrival), Number.POSITIVE_INFINITY);
}

function describeLeg(leg: PredictedLeg): string {
  const arr = leg.actualArrival !== null ? formatMinutes(leg.actualArrival) : 'no arrival';
  const late = leg.actualArrival !== null ? leg.actualArrival - leg.scheduledArrival : null;
  const lateText = late === null ? 'cancelled' : late > 0 ? `${late} late` : late < 0 ? `${-late} early` : 'on time';
  return `${leg.originCrs}->${leg.destinationCrs}: sched ${formatMinutes(leg.scheduledDeparture)} arr ${formatMinutes(leg.scheduledArrival)}, actual arr ${arr} (${lateText})`;
}

export function assessCoupon(input: AssessCouponInput): CouponVerdict {
  const { ticket, coupon, fromCrs, toCrs, constraints, bookedLegs } = input;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const interchange = input.interchangeMinutes ?? DEFAULT_INTERCHANGE;

  const resolved = resolveBest(input.itineraries, constraints, interchange);
  if (!resolved) {
    const reason = constraints.entry || constraints.exit ? 'SERVICE_UNRESOLVED' : 'NO_TRAVEL_EVIDENCE';
    return unresolvedVerdict(coupon, constraints, reason);
  }

  const { itinerary, result } = resolved;
  const predictedLegs = result.predictedLegs;

  // Build the journey for the eligibility engine.
  let journey: Journey;
  if (ticket.kind === 'advance' && bookedLegs && bookedLegs.length > 0) {
    const legs: Leg[] = bookedLegs.map((l) => ({
      origin: l.originCrs,
      destination: l.destinationCrs,
      scheduledDeparture: l.scheduledDeparture,
      scheduledArrival: l.scheduledArrival,
    }));
    journey = {
      legs,
      ticketKind: 'advance',
      fareType: ticket.fareType,
      date: ticket.startDate,
      threshold,
      interchangeMinutes: interchange,
    };
  } else {
    const ready =
      constraints.entry && constraints.entry.crs === fromCrs
        ? constraints.entry.timeMinutes
        : predictedLegs[0]!.scheduledDeparture;
    const intendedArrival =
      itinerary.legs.length === 1
        ? intendedArrivalSingleLeg(itinerary.candidatesByLeg[0] ?? [], ready) ??
          predictedLegs[predictedLegs.length - 1]!.scheduledArrival
        : itinerary.legs[itinerary.legs.length - 1]!.scheduledArrival;

    const legs: Leg[] = itinerary.legs.map((l, i) => ({
      origin: l.originCrs,
      destination: l.destinationCrs,
      scheduledDeparture: i === 0 ? ready : l.scheduledDeparture,
      scheduledArrival: i === itinerary.legs.length - 1 ? intendedArrival : l.scheduledArrival,
    }));
    journey = {
      legs,
      ticketKind: 'flexible',
      fareType: ticket.fareType,
      date: ticket.startDate,
      threshold,
      interchangeMinutes: interchange,
    };
  }

  const eligibility = assessEligibility(journey, itinerary.candidatesByLeg);
  const validity = assessValidity(ticket, constraints, predictedLegs, bookedLegs, input.routeDef ?? null);

  // Confidence from how well the taps and train_info line up.
  const directionAnomaly = constraints.onTrain.some((t) => t.routeToCrs === fromCrs);
  const trainInfoConsistent = constraints.onTrain.some((t) => t.routeToCrs === toCrs);
  const anomalyDowngrade = directionAnomaly || constraints.anomalies.length > 0;
  const strong =
    (result.signals.entryMatched ? 1 : 0) +
    (result.signals.exitTight ? 1 : 0) +
    (trainInfoConsistent ? 1 : 0);
  let confidence: Confidence = strong >= 2 ? 'CONFIRMED' : strong === 1 ? 'PROBABLE' : 'INFERRED';
  if (anomalyDowngrade) confidence = downgrade(confidence);
  if (directionAnomaly) {
    // Never claim high confidence when a scan points the wrong way.
    if (confidence === 'CONFIRMED') confidence = 'PROBABLE';
  }

  const entitled = eligibility.eligible && validity.valid;
  let reason: string | null = null;
  if (!validity.valid) reason = validity.reason;
  else if (!eligibility.eligible) reason = eligibility.delayMinutes === 0 ? 'NOT_DELAYED' : 'BELOW_THRESHOLD';

  const compensation = entitled ? compensationPence(eligibility.band, ticket.fareType, ticket.pricePence) : 0;

  const explanation = [
    `Predicted journey (${coupon}):`,
    ...predictedLegs.map((l) => `  ${describeLeg(l)}`),
    ...result.notes,
    ...eligibility.explanation,
    ...validity.anomalies.map((a) => `Validity: ${a}`),
  ];
  if (directionAnomaly) {
    explanation.push('Anomaly: an on-train scan named a service heading back towards the origin (stale or wrong-direction).');
  }

  return {
    coupon,
    entitled,
    reason,
    confidence,
    predictedLegs,
    delayMinutes: Number.isFinite(eligibility.delayMinutes) ? eligibility.delayMinutes : null,
    band: eligibility.band,
    compensationPence: entitled ? compensation : null,
    anomalies: [...constraints.anomalies, ...validity.anomalies],
    explanation,
  };
}
