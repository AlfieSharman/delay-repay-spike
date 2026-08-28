/**
 * Ticket time-restriction handling (the RST data), per RSPS5045 4.18.
 *
 * An Off-Peak / Super Off-Peak ticket carries a 2-character restriction code.
 * The restriction has one or more Time Restriction (TR) records giving a time
 * window at a location for outward/return journeys, plus date bands (TD) and
 * an optional TOC filter (TT). Whether the window BARS travel depends on the
 * header's TYPE_OUT/RET flag:
 *   'P' positive - the window is when the restriction applies (travel barred /
 *       minimum fare).
 *   'N' negative - the windows are the ONLY times travel is allowed.
 *
 * Worked example (Southeastern F4 "SUPER OFF-PEAK DAY", type_out P): outward,
 * departure 04:00-09:59, fare not valid. So a train departing 09:32 is barred;
 * 10:02 is fine - matching the Odyssey Rochester responses.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseHHMM } from '../timetable/lookup.js';

export type RestrictionPolarity = 'P' | 'N';

/** One Time Restriction (TR) plus its date bands (TD) and TOC filter (TT). */
export interface TimeRestriction {
  readonly sequence: string;
  readonly outReturn: 'O' | 'R';
  /** Minutes since midnight. */
  readonly timeFrom: number;
  readonly timeTo: number;
  /** 'A' arrival, 'D' departure, 'V' via/changing - at `location`. */
  readonly arrDepVia: 'A' | 'D' | 'V';
  /** CRS the time applies at, or null if not station-specific (origin/dest). */
  readonly location: string | null;
  /** false = fare not valid if the restriction applies; true = valid but a
   *  minimum fare must be used. */
  readonly minFareOnly: boolean;
  /** MMDD date bands with a Mon..Sun days mask; empty means always. */
  readonly dateBands: readonly { from: string; to: string; days: string }[];
  /** TOC codes the restriction is limited to; empty means all TOCs. */
  readonly tocs: ReadonlySet<string>;
}

export interface RestrictionDefinition {
  readonly code: string;
  readonly description: string;
  readonly typeOut: RestrictionPolarity;
  readonly typeReturn: RestrictionPolarity;
  readonly timeRestrictions: readonly TimeRestriction[];
}

/** The journey facts a restriction is evaluated against. */
export interface RestrictionJourney {
  /** 'O' for single/outward, 'R' for return. */
  readonly direction: 'O' | 'R';
  /** YYYY-MM-DD. */
  readonly date: string;
  /** Departure from origin, minutes since midnight. */
  readonly originDeparture: number;
  /** Arrival at destination, minutes since midnight. */
  readonly destinationArrival: number;
  readonly originCrs: string;
  readonly destinationCrs: string;
  /** TOC codes operating the journey's legs. */
  readonly tocs: ReadonlySet<string>;
}

export type RestrictionOutcome = 'valid' | 'invalid' | 'min-fare-only' | 'not-applicable';

function mondayIndexedWeekday(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (dow + 6) % 7;
}

function inTimeBand(t: number, from: number, to: number): boolean {
  return from <= to ? t >= from && t <= to : t >= from || t <= to; // handle wrap past midnight
}

function dateInBand(date: string, band: { from: string; to: string; days: string }): boolean {
  const mmdd = date.slice(5, 7) + date.slice(8, 10);
  const inRange = band.from <= band.to ? mmdd >= band.from && mmdd <= band.to : mmdd >= band.from || mmdd <= band.to;
  if (!inRange) return false;
  const dow = mondayIndexedWeekday(date);
  return band.days.length < 7 || band.days[dow] === 'Y';
}

/** The time a TR tests against, given what it restricts (arrival/departure). */
function relevantTime(tr: TimeRestriction, journey: RestrictionJourney): number | null {
  if (tr.location && tr.location !== journey.originCrs && tr.location !== journey.destinationCrs) {
    return null; // station-specific restriction at a location this journey's ends aren't
  }
  if (tr.arrDepVia === 'A') return journey.destinationArrival;
  if (tr.arrDepVia === 'D') return journey.originDeparture;
  return null; // 'V' (via/passing) needs intermediate times we don't check here
}

/** Whether a single TR is "in force" for this journey (right direction, date, TOC, time). */
function restrictionApplies(tr: TimeRestriction, journey: RestrictionJourney): boolean {
  if (tr.outReturn !== journey.direction) return false;
  if (tr.tocs.size > 0 && ![...journey.tocs].some((t) => tr.tocs.has(t))) return false;
  if (tr.dateBands.length > 0 && !tr.dateBands.some((b) => dateInBand(journey.date, b))) return false;
  const time = relevantTime(tr, journey);
  if (time === null) return false;
  return inTimeBand(time, tr.timeFrom, tr.timeTo);
}

/**
 * Evaluates a restriction against a journey. For a positive restriction, a
 * matched window bars travel (or forces a minimum fare); for a negative one,
 * travel is only valid inside a matched window.
 */
export function evaluateRestriction(def: RestrictionDefinition, journey: RestrictionJourney): RestrictionOutcome {
  const polarity = journey.direction === 'O' ? def.typeOut : def.typeReturn;
  const relevant = def.timeRestrictions.filter((tr) => tr.outReturn === journey.direction);
  if (relevant.length === 0) return 'not-applicable';

  const matched = relevant.filter((tr) => restrictionApplies(tr, journey));

  if (polarity === 'P') {
    if (matched.length === 0) return 'valid';
    return matched.some((tr) => !tr.minFareOnly) ? 'invalid' : 'min-fare-only';
  }
  // Negative: valid only if the journey falls inside one of the allowed windows.
  return matched.length > 0 ? 'valid' : 'invalid';
}

// ---------------------------------------------------------------- parsing

const rt = (line: string): string => line.slice(1, 3);

export async function findRstFile(faresDir: string): Promise<string | null> {
  try {
    const files = await readdir(faresDir);
    const match = files.find((f) => f.toUpperCase().endsWith('.RST'));
    return match ? path.join(faresDir, match) : null;
  } catch {
    return null;
  }
}

/** Loads restriction definitions from the fares `.RST` file. */
export async function loadRestrictions(filePath: string): Promise<Map<string, RestrictionDefinition>> {
  const text = await readFile(filePath, 'utf8');

  interface MutableTR {
    sequence: string; outReturn: 'O' | 'R'; timeFrom: number; timeTo: number;
    arrDepVia: 'A' | 'D' | 'V'; location: string | null; minFareOnly: boolean;
    dateBands: { from: string; to: string; days: string }[]; tocs: Set<string>;
  }
  const headers = new Map<string, { description: string; typeOut: RestrictionPolarity; typeReturn: RestrictionPolarity }>();
  const trs = new Map<string, MutableTR>(); // key: code|seq|outRet

  for (const line of text.split(/\r?\n/)) {
    const type = rt(line);
    const code = line.slice(4, 6);
    if (type === 'RH') {
      if (!headers.has(code)) {
        headers.set(code, {
          description: line.slice(6, 36).trim(),
          typeOut: (line.slice(136, 137) as RestrictionPolarity) || 'P',
          typeReturn: (line.slice(137, 138) as RestrictionPolarity) || 'P',
        });
      }
    } else if (type === 'TR') {
      const seq = line.slice(6, 10);
      const outReturn = line.slice(10, 11) as 'O' | 'R';
      const key = `${code}|${seq}|${outReturn}`;
      if (!trs.has(key)) {
        trs.set(key, {
          sequence: seq,
          outReturn,
          timeFrom: parseHHMM(line.slice(11, 15)),
          timeTo: parseHHMM(line.slice(15, 19)),
          arrDepVia: (line.slice(19, 20) as 'A' | 'D' | 'V') || 'D',
          location: line.slice(20, 23).trim() || null,
          minFareOnly: line.slice(25, 26) === 'Y',
          dateBands: [],
          tocs: new Set(),
        });
      }
    } else if (type === 'TD') {
      const key = `${code}|${line.slice(6, 10)}|${line.slice(10, 11)}`;
      const tr = trs.get(key);
      if (tr) tr.dateBands.push({ from: line.slice(11, 15), to: line.slice(15, 19), days: line.slice(19, 26) });
    } else if (type === 'TT') {
      const key = `${code}|${line.slice(6, 10)}|${line.slice(10, 11)}`;
      const tr = trs.get(key);
      if (tr) tr.tocs.add(line.slice(11, 13));
    }
  }

  const grouped = new Map<string, MutableTR[]>();
  for (const [key, tr] of trs) {
    const code = key.split('|')[0]!;
    (grouped.get(code) ?? grouped.set(code, []).get(code)!).push(tr);
  }

  const result = new Map<string, RestrictionDefinition>();
  for (const [code, header] of headers) {
    result.set(code, {
      code,
      description: header.description,
      typeOut: header.typeOut,
      typeReturn: header.typeReturn,
      timeRestrictions: (grouped.get(code) ?? []).map((tr) => ({ ...tr, tocs: tr.tocs })),
    });
  }
  return result;
}
