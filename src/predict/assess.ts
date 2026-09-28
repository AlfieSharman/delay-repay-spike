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
import { bandForDelay } from '../eligibility/journey.js';
import type { Journey, Leg, ServiceRun } from '../eligibility/journey.js';
import { formatMinutes } from '../timetable/lookup.js';
import { compensationPence } from './compensation.js';
import { resolveBest } from './resolve.js';
import type { RestrictionDefinition } from './restrictions.js';
import type { RouteDefinition } from './routes.js';
import { assessValidity } from './validity.js';
import type {
  Confidence,
  CouponType,
  CouponVerdict,
  IntendedLeg,
  JourneyConstraints,
  OnTrainSighting,
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
  /** Maps a CRS to its routeing point(s)/group, for group-level "via" checks. */
  readonly resolveRouteingPoints?: (crs: string) => string[];
  /** The ticket's time restriction (Off-Peak etc.), if resolved. */
  readonly restrictionDef?: RestrictionDefinition | null;
  /** True when itineraries[0] is the customer's actual (pinned) itinerary, not
   *  an inferred candidate. Enables the walk-up itinerary-baseline fallback. */
  readonly itineraryPinned?: boolean;
  /** Actual runs of services named by accepted clips, fetched to the
   *  destination - lets a through service on which the destination is an
   *  intermediate stop be pinned even though it isn't an itinerary leg. */
  readonly clipServices?: readonly ServiceRun[];
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

/**
 * Walk-up fallback verdict when the journey can't be established from the ticket
 * origin but the customer's itinerary is known. Delay is measured against the
 * itinerary's intended arrival. The actual arrival is the itinerary service's
 * own arrival when it ran ("assume they travelled the itinerary", and it is the
 * train arrival, consistent with the engine); otherwise the exit tap. Heuristic,
 * so INFERRED.
 */
function itineraryFallbackVerdict(
  coupon: CouponType,
  ticket: TicketInfo,
  constraints: JourneyConstraints,
  itinerary: PlannedItinerary | undefined,
  toCrs: string,
  threshold: number,
): CouponVerdict | null {
  if (!itinerary || itinerary.legs.length === 0) return null;
  const legs = itinerary.legs;
  const lastLeg = legs[legs.length - 1]!;
  const itineraryArrival = lastLeg.scheduledArrival;

  const exitAtDest = constraints.exit && constraints.exit.crs === toCrs ? constraints.exit.timeMinutes : null;
  const itinService = findBookedRun(itinerary.candidatesByLeg[legs.length - 1] ?? [], lastLeg);
  const ranItinService = !!itinService && !itinService.cancelled && itinService.actualArrival !== null;
  const actualArrival = ranItinService ? itinService!.actualArrival! : exitAtDest;
  if (actualArrival === null) return null;

  const delayMinutes = Math.max(0, actualArrival - itineraryArrival);
  const band = bandForDelay(delayMinutes)?.label ?? null;
  const eligible = delayMinutes >= threshold;
  const compensation = eligible ? compensationPence(band, ticket.fareType, ticket.pricePence) : 0;

  const predictedLegs: PredictedLeg[] = legs.map((l, i) => ({
    originCrs: l.originCrs,
    destinationCrs: l.destinationCrs,
    scheduledDeparture: l.scheduledDeparture,
    scheduledArrival: l.scheduledArrival,
    actualDeparture: null,
    actualArrival: i === legs.length - 1 ? actualArrival : null,
    cancelled: false,
    callingPoints: [l.originCrs, l.destinationCrs],
  }));

  const source = ranItinService ? 'itinerary service actual arrival' : 'exit tap';
  return {
    coupon,
    entitled: eligible,
    reason: eligible ? null : delayMinutes === 0 ? 'NOT_DELAYED' : 'BELOW_THRESHOLD',
    confidence: 'INFERRED',
    predictedLegs,
    delayMinutes: Number.isFinite(delayMinutes) ? delayMinutes : null,
    band,
    compensationPence: eligible ? compensation : null,
    anomalies: [...constraints.anomalies],
    explanation: [
      `Could not reconstruct a clean journey from ${legs[0]!.originCrs} (scans don't establish travel from the ticket origin).`,
      `Fell back to the itinerary: intended arrival ${formatMinutes(itineraryArrival)}, actual arrival ` +
        `${formatMinutes(actualArrival)} (${source}) = ${delayMinutes} min late (threshold ${threshold}).`,
    ],
  };
}

/** The tightest-fitting run whose actual travel window contains an accepted
 *  clip's time - i.e. the customer was on board then. */
function pinClipRun(
  clips: readonly OnTrainSighting[],
  runs: readonly ServiceRun[],
): ServiceRun | null {
  let pinned: ServiceRun | null = null;
  for (const clip of clips) {
    for (const r of runs) {
      if (r.cancelled || r.actualDeparture === null || r.actualArrival === null) continue;
      if (r.actualDeparture - 5 > clip.timeMinutes || clip.timeMinutes > r.actualArrival + 5) continue;
      // If several fit the clip time, take the tightest-fitting run.
      if (!pinned || r.actualArrival - r.actualDeparture < pinned.actualArrival! - pinned.actualDeparture!) {
        pinned = r;
      }
    }
    if (pinned) break;
  }
  return pinned;
}

/**
 * Level-2 clip pinning: an accepted on-train clip names the service the customer
 * was on, so we can measure that service's OWN delay (actual minus scheduled
 * arrival at the destination) with no baseline inference - the most accurate
 * case for a non-advance ticket. Two ways to find the service:
 *  (a) it terminates at the destination on a single-leg itinerary - matched
 *      within that leg's candidate runs (the original case); or
 *  (b) it is a through service on which the destination is an intermediate stop,
 *      so it isn't an itinerary leg - matched within `clipServices`, the runs
 *      fetched to the destination for the clips. This covers a customer who
 *      alights partway along a longer service.
 */
function clipPinnedVerdict(
  coupon: CouponType,
  ticket: TicketInfo,
  constraints: JourneyConstraints,
  itinerary: PlannedItinerary,
  toCrs: string,
  threshold: number,
  clipServices: readonly ServiceRun[],
): CouponVerdict | null {
  const clipsToDest = constraints.onTrain.filter((s) => s.accepted && s.info.routeToCrs === toCrs);
  const acceptedClips = constraints.onTrain.filter((s) => s.accepted);

  let pinned: ServiceRun | null = null;
  let originCrs = toCrs;
  if (itinerary.legs.length === 1 && clipsToDest.length > 0) {
    pinned = pinClipRun(clipsToDest, itinerary.candidatesByLeg[0] ?? []);
    if (pinned) originCrs = itinerary.legs[0]!.originCrs;
  }
  if (!pinned && clipServices.length > 0) {
    pinned = pinClipRun(acceptedClips, clipServices);
    if (pinned) originCrs = pinned.callingPoints?.[0] ?? toCrs;
  }
  if (!pinned || pinned.actualArrival === null) return null;

  const delayMinutes = Math.max(0, pinned.actualArrival - pinned.scheduledArrival);
  const band = bandForDelay(delayMinutes)?.label ?? null;
  const eligible = delayMinutes >= threshold;
  const predictedLegs: PredictedLeg[] = [{
    originCrs,
    destinationCrs: toCrs,
    scheduledDeparture: pinned.scheduledDeparture,
    scheduledArrival: pinned.scheduledArrival,
    actualDeparture: pinned.actualDeparture,
    actualArrival: pinned.actualArrival,
    cancelled: false,
    callingPoints: pinned.callingPoints ?? [originCrs, toCrs],
    toc: pinned.toc,
  }];
  return {
    coupon,
    entitled: eligible,
    reason: eligible ? null : delayMinutes === 0 ? 'NOT_DELAYED' : 'BELOW_THRESHOLD',
    confidence: 'CONFIRMED',
    predictedLegs,
    delayMinutes: Number.isFinite(delayMinutes) ? delayMinutes : null,
    band,
    compensationPence: eligible ? compensationPence(band, ticket.fareType, ticket.pricePence) : null,
    anomalies: [...constraints.anomalies],
    explanation: [
      `Clip pinned the service travelled (${originCrs}->${toCrs}, ` +
        `sched arr ${formatMinutes(pinned.scheduledArrival)}, actual ${formatMinutes(pinned.actualArrival)}): ` +
        `${delayMinutes} min late (threshold ${threshold}).`,
    ],
  };
}

/** The booked run within a leg's candidate runs, matched on scheduled times. */
function findBookedRun(candidates: readonly ServiceRun[], leg: IntendedLeg): ServiceRun | undefined {
  return candidates.find(
    (r) => r.scheduledDeparture === leg.scheduledDeparture && r.scheduledArrival === leg.scheduledArrival,
  );
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

  // Level 2 (clipped): an accepted clip identifies the exact service travelled,
  // so measure that service's own delay - more accurate than any tap-based
  // inference. Advance (level 1) is handled below; this is for walk-up.
  if (resolved && ticket.kind !== 'advance') {
    const clipVerdict = clipPinnedVerdict(coupon, ticket, constraints, resolved.itinerary, toCrs, threshold, input.clipServices ?? []);
    if (clipVerdict) return clipVerdict;
  }

  // Walk-up itinerary baseline: when the customer's itinerary is known but the
  // scans don't establish a clean journey from the ticket origin - either
  // resolution failed, or there is no entry tap at the origin (exit-only, or
  // boarded downstream) - assess the delay against the itinerary's intended
  // arrival rather than a best-achievable service picked to fit the exit tap.
  // Fully-scanned walk-ups (entry tap at the origin) keep the best-achievable
  // rule and never take this path.
  const entryAtOrigin = !!(constraints.entry && constraints.entry.crs === fromCrs);
  if (ticket.kind !== 'advance' && input.itineraryPinned && (!resolved || !entryAtOrigin)) {
    const fallback = itineraryFallbackVerdict(coupon, ticket, constraints, input.itineraries[0], toCrs, threshold);
    if (fallback) return fallback;
  }
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
    // Intended-arrival baseline. When the itinerary is pinned but the customer
    // isn't scanned from the origin (boarded downstream, or the intended service
    // was cancelled and they took a later one), the itinerary's own final
    // scheduled arrival is the baseline - not a best-achievable arrival
    // recomputed from `ready`, which would exclude the cancelled/earlier intended
    // service and understate the delay. Fully-scanned walk-ups (entry tap at the
    // origin) keep the best-achievable rule.
    const itineraryArrival = itinerary.legs[itinerary.legs.length - 1]!.scheduledArrival;
    const intendedArrival =
      input.itineraryPinned && !entryAtOrigin
        ? itineraryArrival
        : itinerary.legs.length === 1
          ? intendedArrivalSingleLeg(itinerary.candidatesByLeg[0] ?? [], ready) ??
            predictedLegs[predictedLegs.length - 1]!.scheduledArrival
          : itineraryArrival;

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
  const validity = assessValidity(
    ticket,
    constraints,
    predictedLegs,
    bookedLegs,
    input.routeDef ?? null,
    input.resolveRouteingPoints,
    input.restrictionDef ?? null,
  );

  // Confidence from how well the taps and train_info line up.
  const directionAnomaly = constraints.onTrain.some((t) => t.info.routeToCrs === fromCrs);
  const trainInfoConsistent = constraints.onTrain.some((t) => t.info.routeToCrs === toCrs);
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

  let delayMinutes = eligibility.delayMinutes;
  let band = eligibility.band;
  let eligible = eligibility.eligible;

  // Advance disruption: the booked itinerary service was cancelled, or ran late
  // enough (or didn't run) that the customer couldn't travel it as booked, so
  // they took the next service. That deviation is then legitimate - we excuse
  // the "non-booked service" / valid-from flags and assess the delay of the
  // journey actually taken against the BOOKED itinerary's intended arrival.
  // (A booked service that ran on time but was skipped by choice - the T4 case -
  // is not disrupted, so it stays INVALID_TICKET_FOR_SERVICE.)
  let deviationExcused = false;
  const disruptionNotes: string[] = [];
  if (ticket.kind === 'advance' && bookedLegs && bookedLegs.length > 0 && predictedLegs.length > 0) {
    const bookedFirst = bookedLegs[0]!;
    const bookedLast = bookedLegs[bookedLegs.length - 1]!;
    const first = predictedLegs[0]!;
    const travelledBooked =
      first.scheduledDeparture === bookedFirst.scheduledDeparture &&
      first.scheduledArrival === bookedFirst.scheduledArrival;
    const bookedRun = findBookedRun(itinerary.candidatesByLeg[0] ?? [], bookedFirst);
    const bookedDisrupted =
      !bookedRun ||
      bookedRun.cancelled ||
      bookedRun.actualArrival === null ||
      bookedRun.actualArrival - bookedFirst.scheduledArrival >= threshold;

    if (!travelledBooked && bookedDisrupted) {
      // The customer's real arrival: prefer the exit tap at the destination,
      // else the predicted final-leg arrival.
      const exitAtDest = constraints.exit && constraints.exit.crs === toCrs ? constraints.exit.timeMinutes : null;
      const actualArrival = exitAtDest ?? predictedLegs[predictedLegs.length - 1]!.actualArrival;
      if (actualArrival !== null) {
        delayMinutes = Math.max(0, actualArrival - bookedLast.scheduledArrival);
        band = bandForDelay(delayMinutes)?.label ?? null;
        eligible = delayMinutes >= threshold;
        deviationExcused = true;
        const why = !bookedRun || bookedRun.actualArrival === null || bookedRun.cancelled
          ? 'cancelled'
          : `${bookedRun.actualArrival - bookedFirst.scheduledArrival} min late`;
        disruptionNotes.push(
          `Advance booked ${formatMinutes(bookedFirst.scheduledDeparture)} service was disrupted (${why}); ` +
            `assessed the journey actually taken: arrived ${formatMinutes(actualArrival)} vs booked itinerary arrival ` +
            `${formatMinutes(bookedLast.scheduledArrival)} = ${delayMinutes} min late.`,
        );
      }
    }
  }

  // The deviation and valid-from flags are excused when the booked itinerary was
  // disrupted; any other validity failure (route, restriction) still blocks.
  const validityBlocking =
    !validity.valid &&
    !(deviationExcused && (validity.reason === 'INVALID_TICKET_FOR_SERVICE' || validity.reason === 'OUTSIDE_VALIDITY'));

  const entitled = eligible && !validityBlocking;
  let reason: string | null = null;
  if (validityBlocking) reason = validity.reason;
  else if (!eligible) reason = delayMinutes === 0 ? 'NOT_DELAYED' : 'BELOW_THRESHOLD';

  const compensation = entitled ? compensationPence(band, ticket.fareType, ticket.pricePence) : 0;

  const explanation = [
    `Predicted journey (${coupon}):`,
    ...predictedLegs.map((l) => `  ${describeLeg(l)}`),
    ...result.notes,
    ...eligibility.explanation,
    ...disruptionNotes,
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
    delayMinutes: Number.isFinite(delayMinutes) ? delayMinutes : null,
    band,
    compensationPence: entitled ? compensation : null,
    anomalies: [...constraints.anomalies, ...validity.anomalies],
    explanation,
  };
}
