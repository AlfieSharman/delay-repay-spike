/**
 * The delay-repay eligibility engine.
 *
 * Given an intended Journey and, per leg, the actual ServiceRuns that happened
 * on the day, it works out how delayed the customer was AT THE FINAL
 * DESTINATION and which compensation band that falls into.
 *
 * The engine is pure: it takes plain data in and returns a result. The CLI
 * (src/check.ts) is responsible for building the ServiceRuns from the local
 * timetable and HSP; tests feed mocked runs directly.
 *
 * Key modelling decisions (see the phase-3 notes in CLAUDE.md):
 *  - Delay is only ever measured at the final destination, against the
 *    intended journey's scheduled arrival there.
 *  - advance: the customer rides their booked services. If a booked leg is
 *    cancelled, or a booked connection can't be made, they fall through to the
 *    next valid service for that and all remaining legs.
 *  - flexible: from the intended departure onward, the customer takes the best
 *    (earliest-arriving) services available - the best journey they could have
 *    made. If that best journey arrives <threshold late, they aren't eligible.
 *  - A connection is made only if the passenger is ready (previous actual
 *    arrival + interchange) STRICTLY before the onward service departs. Being
 *    ready at the exact departure minute counts as missed - this is what makes
 *    the worked multi-leg example resolve to the next service.
 */

import {
  bandForDelay,
  type EligibilityResult,
  type Journey,
  type Leg,
  type ServiceRun,
} from './journey.js';
import { formatMinutes } from '../timetable/lookup.js';

const DEFAULT_THRESHOLD = 15;
const DEFAULT_INTERCHANGE = 5;

function describeLateness(minutes: number): string {
  if (minutes > 0) return `${minutes} min late`;
  if (minutes < 0) return `${-minutes} min early`;
  return 'on time';
}

/** Actual runs a passenger who is ready at `readyTime` could board for a leg. */
function boardableRuns(runs: readonly ServiceRun[], isFirstLeg: boolean, readyTime: number): ServiceRun[] {
  return runs.filter((run) => {
    if (run.cancelled || run.actualDeparture === null || run.actualArrival === null) return false;
    // On the first leg the passenger is waiting at the origin and can board a
    // train departing at or after their intended time; at an interchange they
    // must reach the platform strictly before the onward train departs.
    return isFirstLeg ? run.actualDeparture >= readyTime : run.actualDeparture > readyTime;
  });
}

/** The earliest-arriving boardable run, or null if none can be caught. */
function bestBoardableRun(
  runs: readonly ServiceRun[],
  isFirstLeg: boolean,
  readyTime: number,
): ServiceRun | null {
  const boardable = boardableRuns(runs, isFirstLeg, readyTime);
  if (boardable.length === 0) return null;
  return boardable.reduce((best, run) => (run.actualArrival! < best.actualArrival! ? run : best));
}

function findBookedRun(runs: readonly ServiceRun[], leg: Leg): ServiceRun | undefined {
  return runs.find(
    (run) => run.scheduledDeparture === leg.scheduledDeparture && run.scheduledArrival === leg.scheduledArrival,
  );
}

interface Simulation {
  readonly reachedDestination: boolean;
  /** Actual arrival at the final destination, if reached. */
  readonly finalArrival: number | null;
  readonly explanation: string[];
}

/**
 * Walks the legs in order, choosing which actual service the customer boards
 * on each, and narrating every step. `honourBooked` is true for advance
 * tickets (ride the booked services until one can't be made) and false for
 * flexible (always take the best available).
 */
function simulate(
  journey: Journey,
  servicesByLeg: readonly (readonly ServiceRun[])[],
  honourBooked: boolean,
  interchange: number,
): Simulation {
  const explanation: string[] = [];
  let readyTime = journey.legs[0]!.scheduledDeparture;
  let onBooked = honourBooked;
  let finalArrival: number | null = null;

  for (let i = 0; i < journey.legs.length; i++) {
    const leg = journey.legs[i]!;
    const runs = servicesByLeg[i] ?? [];
    const isFirstLeg = i === 0;
    const label = `Leg ${i + 1} (${leg.origin}->${leg.destination})`;

    let chosen: ServiceRun | null = null;

    if (onBooked) {
      const booked = findBookedRun(runs, leg);
      const canRideBooked =
        booked != null &&
        !booked.cancelled &&
        booked.actualArrival !== null &&
        // Leg 1: the customer simply waits for their booked train, however
        // late. Later legs: only if they can still make the connection.
        (isFirstLeg || readyTime < booked.actualDeparture!);

      if (canRideBooked) {
        chosen = booked!;
        const lateBy = booked!.actualArrival! - leg.scheduledArrival;
        explanation.push(
          `${label}: booked ${formatMinutes(leg.scheduledDeparture)} service arrived ${leg.destination} ` +
            `${formatMinutes(booked!.actualArrival!)}, ${describeLateness(lateBy)}`,
        );
      } else {
        onBooked = false;
        if (booked?.cancelled) {
          explanation.push(`${label}: booked ${formatMinutes(leg.scheduledDeparture)} service was cancelled`);
        } else if (booked) {
          explanation.push(
            `${label}: missed booked ${formatMinutes(leg.scheduledDeparture)} connection ` +
              `(ready ${formatMinutes(readyTime)}, it departed ${formatMinutes(booked.actualDeparture ?? leg.scheduledDeparture)})`,
          );
        } else {
          explanation.push(`${label}: no booked service found, taking next valid service`);
        }
      }
    }

    if (chosen === null) {
      chosen = bestBoardableRun(runs, isFirstLeg, readyTime);
      if (chosen === null) {
        explanation.push(`${label}: no valid onward service after ${formatMinutes(readyTime)} - journey could not be completed`);
        return { reachedDestination: false, finalArrival: null, explanation };
      }
      explanation.push(
        `${label}: next valid service ${formatMinutes(chosen.scheduledDeparture)} departed ` +
          `${formatMinutes(chosen.actualDeparture!)}, arrived ${leg.destination} ${formatMinutes(chosen.actualArrival!)}`,
      );
    }

    finalArrival = chosen.actualArrival;
    readyTime = chosen.actualArrival! + interchange;
  }

  return { reachedDestination: true, finalArrival, explanation };
}

export function assessEligibility(
  journey: Journey,
  servicesByLeg: readonly (readonly ServiceRun[])[],
): EligibilityResult {
  if (journey.legs.length === 0) throw new Error('Journey has no legs');
  if (servicesByLeg.length !== journey.legs.length) {
    throw new Error('servicesByLeg must have one entry per leg');
  }

  const threshold = journey.threshold ?? DEFAULT_THRESHOLD;
  const interchange = journey.interchangeMinutes ?? DEFAULT_INTERCHANGE;
  const finalLeg = journey.legs[journey.legs.length - 1]!;
  const intendedArrival = finalLeg.scheduledArrival;

  const sim = simulate(journey, servicesByLeg, journey.ticketKind === 'advance', interchange);
  const explanation = [...sim.explanation];

  // Couldn't complete the journey (every onward option cancelled): the
  // customer never arrived, which is at least as bad as the top delay band.
  if (!sim.reachedDestination || sim.finalArrival === null) {
    const band = bandForDelay(120)!;
    explanation.push(
      `Journey could not be completed - treated as the maximum ${band.label} band (eligible).`,
    );
    return {
      eligible: true,
      delayMinutes: Number.POSITIVE_INFINITY,
      band: band.label,
      compensationPercentage:
        journey.fareType === 'return' ? band.returnPercentage : band.singlePercentage,
      explanation,
    };
  }

  const delayMinutes = Math.max(0, sim.finalArrival - intendedArrival);
  const band = bandForDelay(delayMinutes);
  const eligible = delayMinutes >= threshold;
  const compensationPercentage =
    eligible && band ? (journey.fareType === 'return' ? band.returnPercentage : band.singlePercentage) : 0;

  explanation.push(
    `Arrived ${finalLeg.destination} ${formatMinutes(sim.finalArrival)} vs intended ${formatMinutes(intendedArrival)}: ` +
      `total delay ${delayMinutes} min (threshold ${threshold}) - ` +
      `${eligible ? `ELIGIBLE, band ${band?.label}, ${compensationPercentage}% of a ${journey.fareType}` : 'not eligible'}`,
  );

  return {
    eligible,
    delayMinutes,
    band: band?.label ?? null,
    compensationPercentage,
    explanation,
  };
}
