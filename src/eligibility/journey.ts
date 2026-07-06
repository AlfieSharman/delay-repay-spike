/**
 * Types for the delay-repay eligibility engine.
 *
 * A Journey is what the customer intended to do: one or more legs, each a
 * scheduled origin->destination hop, plus the kind of ticket they hold. The
 * engine takes the intended journey and the actual service runs that happened
 * on the day, and decides whether the customer was delayed enough to claim.
 *
 * All times are minutes since midnight (matching the phase-2 SQLite data and
 * HSP's minute-level actuals).
 */

/**
 * advance  - fixed itinerary; the customer must travel on their booked
 *            services, falling back to the next valid service only when a
 *            booked leg is cancelled or its connection is missed.
 * flexible - the customer may take any service from their intended departure
 *            onward; delay is measured against the best journey they could
 *            have made.
 */
export type TicketKind = 'advance' | 'flexible';

/** Delay Repay pays a different share for singles vs returns. */
export type FareType = 'single' | 'return';

export interface Leg {
  /** CRS codes. */
  readonly origin: string;
  readonly destination: string;
  /** Intended (booked) scheduled times, minutes since midnight. */
  readonly scheduledDeparture: number;
  readonly scheduledArrival: number;
}

/** One actual run of a service on the day, as observed via HSP. */
export interface ServiceRun {
  /** HSP RID, or a synthetic id in tests. */
  readonly id: string;
  readonly scheduledDeparture: number;
  readonly scheduledArrival: number;
  /** Actual times; null when the service was cancelled / didn't run the hop. */
  readonly actualDeparture: number | null;
  readonly actualArrival: number | null;
  readonly cancelled: boolean;
}

export interface Journey {
  readonly legs: readonly Leg[];
  readonly ticketKind: TicketKind;
  readonly fareType: FareType;
  /** YYYY-MM-DD, for reference/narration. */
  readonly date: string;
  /** Delay (minutes) at which a claim becomes eligible. Default 15. */
  readonly threshold?: number;
  /** Minimum connection time at an interchange, minutes. Default 5. */
  readonly interchangeMinutes?: number;
}

export interface CompensationBand {
  readonly label: string;
  readonly minDelay: number;
  readonly singlePercentage: number;
  readonly returnPercentage: number;
}

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly delayMinutes: number;
  /** SE compensation band label (e.g. "30-59"), or null if below any band. */
  readonly band: string | null;
  /** Percentage of the ticket price owed, given the fare type. */
  readonly compensationPercentage: number;
  /** Step-by-step narration so a human can audit the verdict. */
  readonly explanation: string[];
}

/**
 * Southeastern Delay Repay bands, ordered high to low so the first match wins.
 * A single pays the full band percentage; a return pays against the whole
 * return fare, hence the halved share.
 */
export const COMPENSATION_BANDS: readonly CompensationBand[] = [
  { label: '120+', minDelay: 120, singlePercentage: 100, returnPercentage: 100 },
  { label: '60-119', minDelay: 60, singlePercentage: 100, returnPercentage: 50 },
  { label: '30-59', minDelay: 30, singlePercentage: 50, returnPercentage: 25 },
  { label: '15-29', minDelay: 15, singlePercentage: 25, returnPercentage: 12.5 },
];

export function bandForDelay(delayMinutes: number): CompensationBand | null {
  return COMPENSATION_BANDS.find((b) => delayMinutes >= b.minDelay) ?? null;
}
