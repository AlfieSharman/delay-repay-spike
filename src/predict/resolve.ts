/**
 * Journey resolution (Steps 5-6 of docs/service-prediction.md): given a
 * scheduled itinerary, the actual runs on each leg and the scan constraints,
 * work out which specific services the customer actually travelled on, then
 * grade the confidence of that reconstruction.
 *
 * Pure: no database or HSP access.
 */

import type { ServiceRun } from '../eligibility/journey.js';
import { formatMinutes } from '../timetable/lookup.js';
import type { JourneyConstraints, PlannedItinerary, PredictedLeg } from './types.js';

/** How close the chosen leg-0 departure must be to an entry tap to "match". */
const ENTRY_WINDOW = 45;
/** How close the final arrival must be to an exit tap to count as a tight fit. */
const EXIT_TIGHT_WINDOW = 15;

export interface ResolveSignals {
  readonly entryMatched: boolean;
  readonly exitMatched: boolean;
  readonly exitTight: boolean;
}

export interface ResolveResult {
  readonly predictedLegs: readonly PredictedLeg[];
  readonly reachedDestination: boolean;
  readonly signals: ResolveSignals;
  readonly notes: readonly string[];
}

function boardable(run: ServiceRun): boolean {
  return !run.cancelled && run.actualDeparture !== null && run.actualArrival !== null;
}

function toPredictedLeg(originCrs: string, destinationCrs: string, run: ServiceRun): PredictedLeg {
  return {
    originCrs,
    destinationCrs,
    scheduledDeparture: run.scheduledDeparture,
    scheduledArrival: run.scheduledArrival,
    actualDeparture: run.actualDeparture,
    actualArrival: run.actualArrival,
    cancelled: run.cancelled,
    callingPoints: run.callingPoints ?? [originCrs, destinationCrs],
  };
}

/**
 * Resolves one candidate itinerary against the scan constraints. Returns null
 * if the itinerary cannot be made to fit (e.g. every onward service on a leg
 * was cancelled). Otherwise returns the chosen services and the confidence
 * signals derived from how well the taps line up.
 */
export function resolveItinerary(
  itinerary: PlannedItinerary,
  constraints: JourneyConstraints,
  interchangeMinutes: number,
): ResolveResult | null {
  const legs = itinerary.legs;
  if (legs.length === 0) return null;

  const firstLeg = legs[0]!;
  const lastLeg = legs[legs.length - 1]!;
  const entryTime =
    constraints.entry && constraints.entry.crs === firstLeg.originCrs ? constraints.entry.timeMinutes : null;
  const exitTime =
    constraints.exit && constraints.exit.crs === lastLeg.destinationCrs ? constraints.exit.timeMinutes : null;

  const predictedLegs: PredictedLeg[] = [];
  const notes: string[] = [];
  let previousArrival: number | null = null;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const isLast = i === legs.length - 1;
    const runs = itinerary.candidatesByLeg[i] ?? [];

    const eligible = runs.filter((run) => {
      if (!boardable(run)) return false;
      if (i === 0) {
        if (entryTime !== null && run.actualDeparture! < entryTime) return false;
      } else if (run.actualDeparture! <= previousArrival! + interchangeMinutes) {
        return false;
      }
      if (isLast && exitTime !== null && run.actualArrival! > exitTime) return false;
      return true;
    });

    if (eligible.length === 0) {
      recordCancellations(runs, notes, leg.originCrs, leg.destinationCrs);
      return null;
    }

    // On the final leg with an exit tap, the customer left the gate just after
    // arriving, so take the latest arrival not exceeding the tap. Otherwise
    // take the earliest arrival (the best/first service they could catch).
    const chosen =
      isLast && exitTime !== null
        ? eligible.reduce((best, r) => (r.actualArrival! > best.actualArrival! ? r : best))
        : eligible.reduce((best, r) => (r.actualArrival! < best.actualArrival! ? r : best));

    // Note any cancelled service on this leg that would have been an earlier
    // option than the one taken (usually the intended connection).
    for (const run of runs) {
      if (run.cancelled && run.scheduledDeparture <= chosen.scheduledDeparture) {
        notes.push(
          `Intended ${leg.originCrs}->${leg.destinationCrs} ${formatMinutes(run.scheduledDeparture)} service was cancelled`,
        );
      }
    }

    predictedLegs.push(toPredictedLeg(leg.originCrs, leg.destinationCrs, chosen));
    previousArrival = chosen.actualArrival;
  }

  const firstChosen = predictedLegs[0]!;
  const lastChosen = predictedLegs[predictedLegs.length - 1]!;
  const entryMatched =
    entryTime !== null && firstChosen.actualDeparture !== null && firstChosen.actualDeparture - entryTime <= ENTRY_WINDOW;
  const exitGap = exitTime !== null && lastChosen.actualArrival !== null ? exitTime - lastChosen.actualArrival : null;
  const exitTight = exitGap !== null && exitGap >= 0 && exitGap <= EXIT_TIGHT_WINDOW;

  return {
    predictedLegs,
    reachedDestination: true,
    signals: { entryMatched, exitMatched: exitTime !== null, exitTight },
    notes,
  };
}

function recordCancellations(
  runs: readonly ServiceRun[],
  notes: string[],
  originCrs: string,
  destinationCrs: string,
): void {
  for (const run of runs) {
    if (run.cancelled) {
      notes.push(
        `${originCrs}->${destinationCrs} ${formatMinutes(run.scheduledDeparture)} service was cancelled`,
      );
    }
  }
}

/**
 * Picks the best-fitting itinerary among the candidates and returns it with
 * its resolution. Prefers, in order: reaching the destination, a tight exit
 * match, then fewer legs.
 */
export function resolveBest(
  itineraries: readonly PlannedItinerary[],
  constraints: JourneyConstraints,
  interchangeMinutes: number,
): { itinerary: PlannedItinerary; result: ResolveResult } | null {
  let best: { itinerary: PlannedItinerary; result: ResolveResult; score: number } | null = null;
  for (const itinerary of itineraries) {
    const result = resolveItinerary(itinerary, constraints, interchangeMinutes);
    if (!result) continue;
    const score =
      (result.signals.exitTight ? 100 : 0) +
      (result.signals.exitMatched ? 20 : 0) +
      (result.signals.entryMatched ? 20 : 0) -
      itinerary.legs.length;
    if (!best || score > best.score) best = { itinerary, result, score };
  }
  return best ? { itinerary: best.itinerary, result: best.result } : null;
}
