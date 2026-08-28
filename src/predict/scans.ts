/**
 * Scan parsing, classification and constraint extraction (Steps 1-3 of
 * docs/service-prediction.md). Pure functions: raw scan objects plus an
 * NLC->CRS resolver in, typed events and constraints out.
 */

import { lookupReasonCode } from './reason-codes.js';
import type {
  CouponType,
  JourneyConstraints,
  OnTrainSighting,
  ScanEvent,
  ScanKind,
  ScanMode,
  TrainInfo,
} from './types.js';

/** The raw scan shape as it appears in the ticketing export JSON. */
export interface RawScan {
  readonly SCANID?: number | string;
  readonly coupon_type?: string | null;
  readonly TIME?: string;
  readonly STATION?: string | null;
  readonly scan_mode?: string | null;
  readonly action_text?: string | null;
  readonly reason_code?: string | null;
  readonly train_info?: string | null;
  readonly DEVICE?: string | null;
}

/** Extract local wall-clock minutes from an ISO datetime, ignoring the zone. */
function localMinutes(iso: string): number {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Parses a `train_info` string such as "We1150 HGS-CHX 1H80/SE2280".
 * Returns the route endpoints (CRS) and any service ids present.
 */
export function parseTrainInfo(raw: string | null | undefined): TrainInfo | null {
  if (!raw || raw.trim() === '') return null;
  const tokens = raw.trim().split(/\s+/);
  let routeFromCrs: string | null = null;
  let routeToCrs: string | null = null;
  const serviceIds: string[] = [];

  for (const token of tokens) {
    const route = /^([A-Z]{3})-([A-Z]{3})$/.exec(token);
    if (route) {
      routeFromCrs = route[1]!;
      routeToCrs = route[2]!;
      continue;
    }
    if (/\d/.test(token) && /[A-Z]/.test(token)) {
      // e.g. "1H80/SE2280" -> ["1H80", "SE2280"]
      for (const part of token.split('/')) {
        if (/^[A-Z0-9]{4,}$/.test(part) && /\d/.test(part)) serviceIds.push(part);
      }
    }
  }
  return { raw: raw.trim(), routeFromCrs, routeToCrs, serviceIds };
}

function classify(mode: ScanMode, accepted: boolean, hasStation: boolean, trainInfo: TrainInfo | null): ScanKind {
  if (!accepted) return 'rejected';
  if (!hasStation && mode === null) return 'admin';
  if (mode === 'clip' || trainInfo) return 'on-train';
  return 'gateline';
}

function normaliseCoupon(raw: string | null | undefined): CouponType | null {
  if (raw === 'Single' || raw === 'Outward' || raw === 'Return') return raw;
  return null;
}

function normaliseMode(raw: string | null | undefined): ScanMode {
  if (raw === 'entry' || raw === 'exit' || raw === 'clip') return raw;
  return null;
}

/** Normalises one raw scan, resolving its station NLC to a CRS code. */
export function normaliseScan(raw: RawScan, nlcToCrs: (nlc: string) => string | null): ScanEvent {
  const iso = raw.TIME ?? '';
  const stationNlc = raw.STATION ?? null;
  const trainInfo = parseTrainInfo(raw.train_info);
  const accepted = (raw.action_text ?? '').toLowerCase() === 'accepted';
  const mode = normaliseMode(raw.scan_mode);
  return {
    scanId: String(raw.SCANID ?? ''),
    coupon: normaliseCoupon(raw.coupon_type),
    date: localDate(iso),
    timeMinutes: localMinutes(iso),
    stationNlc,
    stationCrs: stationNlc ? nlcToCrs(stationNlc) : null,
    mode,
    accepted,
    reasonCode: raw.reason_code ?? null,
    trainInfo,
    device: raw.DEVICE ?? null,
    kind: classify(mode, accepted, stationNlc != null, trainInfo),
  };
}

export function normaliseScans(
  raw: readonly RawScan[],
  nlcToCrs: (nlc: string) => string | null,
): ScanEvent[] {
  return raw.map((r) => normaliseScan(r, nlcToCrs));
}

/**
 * Groups scans into journeys by coupon. `Single` is one journey; `Outward`
 * and `Return` are separate journeys. Admin scans (no coupon) are dropped.
 */
export function groupByCoupon(scans: readonly ScanEvent[]): Map<CouponType, ScanEvent[]> {
  const groups = new Map<CouponType, ScanEvent[]>();
  for (const scan of scans) {
    if (scan.kind === 'admin' || scan.coupon === null) continue;
    const group = groups.get(scan.coupon) ?? [];
    group.push(scan);
    groups.set(scan.coupon, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.timeMinutes - b.timeMinutes);
  return groups;
}

/**
 * Derives the hard travel constraints from one coupon's scans (Step 3):
 * the entry and exit gateline facts, any on-train service hints, and any
 * anomalies (rejected scans) that should be surfaced for review.
 */
export function extractConstraints(coupon: CouponType, scans: readonly ScanEvent[]): JourneyConstraints {
  let entry: { crs: string; timeMinutes: number } | undefined;
  let exit: { crs: string; timeMinutes: number } | undefined;
  const onTrain: OnTrainSighting[] = [];
  const reasonCodes: string[] = [];
  const anomalies: string[] = [];

  for (const scan of scans) {
    if (scan.kind === 'gateline' && scan.stationCrs) {
      if (scan.mode === 'entry' && !entry) entry = { crs: scan.stationCrs, timeMinutes: scan.timeMinutes };
      if (scan.mode === 'exit') exit = { crs: scan.stationCrs, timeMinutes: scan.timeMinutes };
    }
    if (scan.kind === 'on-train' && scan.trainInfo) {
      onTrain.push({ info: scan.trainInfo, timeMinutes: scan.timeMinutes, accepted: true });
    }
    if (scan.kind === 'rejected') {
      const where = scan.stationCrs ?? scan.stationNlc ?? 'unknown location';
      let reason = '';
      if (scan.reasonCode) {
        reasonCodes.push(scan.reasonCode);
        reason = ` ${scan.reasonCode} (${lookupReasonCode(scan.reasonCode).meaning})`;
      }
      anomalies.push(`Rejected scan${reason} at ${where} ${formatMin(scan.timeMinutes)}`);
      // A rejected scan may still name the train it was presented on, but as an
      // anomaly it must not pin the service (accepted: false).
      if (scan.trainInfo) onTrain.push({ info: scan.trainInfo, timeMinutes: scan.timeMinutes, accepted: false });
    }
  }

  return { coupon, entry, exit, onTrain, reasonCodes, anomalies };
}

function formatMin(m: number): string {
  if (!Number.isFinite(m)) return '??:??';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
