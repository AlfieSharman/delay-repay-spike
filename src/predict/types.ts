/**
 * Types for the service-prediction pipeline: from a ticket plus its scans,
 * work out which service(s) the customer travelled on, then hand off to the
 * eligibility engine for the delay verdict.
 *
 * See docs/service-prediction.md for the algorithm these types implement.
 * Times are minutes since midnight (local wall-clock), matching the timetable
 * data and HSP actuals.
 */

import type { FareType, ServiceRun } from '../eligibility/journey.js';

export type CouponType = 'Single' | 'Outward' | 'Return';

/** How a scan is used: location fact, service hint, ignore, or anomaly flag. */
export type ScanKind = 'gateline' | 'on-train' | 'admin' | 'rejected';

export type ScanMode = 'entry' | 'exit' | 'clip' | null;

/** A ticket's ticketing-system record, as fed into the pipeline. */
export interface TicketInfo {
  readonly utn: string;
  readonly ftot: string;
  readonly originNlc: string;
  readonly destinationNlc: string;
  readonly routeCode: string | null;
  readonly pricePence: number;
  readonly startDate: string;
  /** "HH:MM" earliest valid travel time, or null if unrestricted. */
  readonly timeValidFrom: string | null;
  readonly kind: 'advance' | 'walk-up';
  readonly fareType: FareType;
  /** True for Off-Peak / Super Off-Peak types whose time restrictions we
   *  cannot yet verify (the RST restriction data is not parsed). */
  readonly hasTimeRestriction: boolean;
}

/** A normalised scan event (NLCs resolved to CRS, time to minutes). */
export interface ScanEvent {
  readonly scanId: string;
  readonly coupon: CouponType | null;
  readonly date: string;
  readonly timeMinutes: number;
  readonly stationNlc: string | null;
  readonly stationCrs: string | null;
  readonly mode: ScanMode;
  readonly accepted: boolean;
  readonly reasonCode: string | null;
  readonly trainInfo: TrainInfo | null;
  readonly device: string | null;
  readonly kind: ScanKind;
}

/** Parsed `train_info`, e.g. "We1150 HGS-CHX 1H80/SE2280". */
export interface TrainInfo {
  readonly raw: string;
  readonly routeFromCrs: string | null;
  readonly routeToCrs: string | null;
  /** Headcode / retail service ids, e.g. ["1H80", "SE2280"]. */
  readonly serviceIds: readonly string[];
}

/** Hard constraints a candidate journey must satisfy, from one coupon's scans. */
export interface JourneyConstraints {
  readonly coupon: CouponType;
  readonly entry?: { readonly crs: string; readonly timeMinutes: number };
  readonly exit?: { readonly crs: string; readonly timeMinutes: number };
  readonly onTrain: readonly TrainInfo[];
  readonly anomalies: readonly string[];
}

/** One leg of a scheduled itinerary (from the timetable planner). */
export interface IntendedLeg {
  readonly originCrs: string;
  readonly destinationCrs: string;
  readonly scheduledDeparture: number;
  readonly scheduledArrival: number;
}

/** A candidate scheduled itinerary plus the actual runs available per leg. */
export interface PlannedItinerary {
  readonly legs: readonly IntendedLeg[];
  /** Actual service runs on each leg's flow, aligned by index with `legs`. */
  readonly candidatesByLeg: readonly (readonly ServiceRun[])[];
}

export type Confidence = 'CONFIRMED' | 'PROBABLE' | 'INFERRED' | 'UNKNOWN';

/** A leg of the journey we believe the customer actually travelled. */
export interface PredictedLeg {
  readonly originCrs: string;
  readonly destinationCrs: string;
  readonly scheduledDeparture: number;
  readonly scheduledArrival: number;
  readonly actualDeparture: number | null;
  readonly actualArrival: number | null;
  readonly cancelled: boolean;
  /** CRS codes the leg called at, origin to destination inclusive (from HSP). */
  readonly callingPoints: readonly string[];
}

/** The final per-coupon verdict returned to the caller. */
export interface CouponVerdict {
  readonly coupon: CouponType;
  readonly entitled: boolean;
  /** Reason code when not entitled (see docs/service-prediction.md). */
  readonly reason: string | null;
  readonly confidence: Confidence;
  readonly predictedLegs: readonly PredictedLeg[];
  readonly delayMinutes: number | null;
  readonly band: string | null;
  readonly compensationPence: number | null;
  readonly anomalies: readonly string[];
  readonly explanation: readonly string[];
}

export interface TicketVerdict {
  readonly utn: string;
  readonly coupons: readonly CouponVerdict[];
}
