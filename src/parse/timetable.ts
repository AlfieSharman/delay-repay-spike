/**
 * Parses the CIF timetable feed (.MCA) and the master station names file
 * (.MSN).
 *
 * CIF records are fixed-width, 80 characters, CRLF-terminated. Field
 * positions below were confirmed against the real feed files, column by
 * column - the wiki spec page is unreachable (403s non-browser clients).
 *
 * Schedules are kept only if their BX record's ATOC code is "SE"
 * (Southeastern).
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type StpIndicator = 'N' | 'C' | 'O' | 'P';

export interface BsRecord {
  readonly uid: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly daysRun: string;
  readonly bankHoliday: string;
  readonly status: string;
  readonly category: string;
  readonly stpIndicator: StpIndicator;
}

export interface BxRecord {
  readonly atocCode: string;
  readonly retailTrainId: string;
}

export type CallingPointType = 'LO' | 'LI' | 'LT';

export interface CallingPoint {
  readonly recordType: CallingPointType;
  readonly tiploc: string;
  /** Minutes since midnight, or null if not applicable to this record type. */
  readonly scheduledArrival: number | null;
  readonly scheduledDeparture: number | null;
  readonly scheduledPass: number | null;
  readonly platform: string | null;
  readonly activity: string | null;
}

export interface SeSchedule extends BsRecord, BxRecord {
  readonly callingPoints: readonly CallingPoint[];
}

export interface StationRecord {
  readonly tiploc: string;
  readonly crs: string;
  readonly name: string;
}

/** CIF dates are YYMMDD with no century. Pivot: 00-59 -> 2000s, 60-99 -> 1900s. */
export function parseCifDate(yymmdd: string): string {
  const yy = Number(yymmdd.slice(0, 2));
  const month = yymmdd.slice(2, 4);
  const day = yymmdd.slice(4, 6);
  const year = yy < 60 ? 2000 + yy : 1900 + yy;
  return `${year}-${month}-${day}`;
}

/**
 * CIF times are HHMM, optionally suffixed with "H" for a half-minute, in a
 * 5-character field. Blank fields mean "not applicable" for that record type.
 * The half-minute flag is truncated: delay-repay logic works in whole
 * minutes (HSP data is minute-level), so sub-minute precision isn't useful.
 */
export function parseCifTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const digits = trimmed.endsWith('H') ? trimmed.slice(0, -1) : trimmed;
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  return hours * 60 + minutes;
}

export function parseBsLine(line: string): BsRecord {
  return {
    uid: line.slice(3, 9),
    dateFrom: parseCifDate(line.slice(9, 15)),
    dateTo: parseCifDate(line.slice(15, 21)),
    daysRun: line.slice(21, 28),
    bankHoliday: line.slice(28, 29).trim(),
    status: line.slice(29, 30).trim(),
    category: line.slice(30, 32).trim(),
    stpIndicator: line.slice(79, 80) as StpIndicator,
  };
}

export function parseBxLine(line: string): BxRecord {
  return {
    atocCode: line.slice(11, 13),
    retailTrainId: line.slice(14, 22).trim(),
  };
}

export function parseLoLine(line: string): CallingPoint {
  return {
    recordType: 'LO',
    tiploc: line.slice(2, 9).trim(),
    scheduledArrival: null,
    scheduledDeparture: parseCifTime(line.slice(10, 15)),
    scheduledPass: null,
    platform: line.slice(19, 22).trim() || null,
    activity: line.slice(29, 41).trim() || null,
  };
}

export function parseLiLine(line: string): CallingPoint {
  return {
    recordType: 'LI',
    tiploc: line.slice(2, 9).trim(),
    scheduledArrival: parseCifTime(line.slice(10, 15)),
    scheduledDeparture: parseCifTime(line.slice(15, 20)),
    scheduledPass: parseCifTime(line.slice(20, 25)),
    platform: line.slice(33, 36).trim() || null,
    activity: line.slice(42, 54).trim() || null,
  };
}

export function parseLtLine(line: string): CallingPoint {
  return {
    recordType: 'LT',
    tiploc: line.slice(2, 9).trim(),
    scheduledArrival: parseCifTime(line.slice(10, 15)),
    scheduledDeparture: null,
    scheduledPass: null,
    platform: line.slice(19, 22).trim() || null,
    activity: line.slice(25, 37).trim() || null,
  };
}

/**
 * Parses an MSN station name ("A") record. Returns null for header/footer
 * lines and the file-spec line, which also start with "A" but don't carry a
 * valid 3-letter CRS code in columns 50-52.
 */
export function parseStationLine(line: string): StationRecord | null {
  if (line[0] !== 'A' || line.length < 52) return null;
  const crs = line.slice(49, 52);
  if (!/^[A-Z]{3}$/.test(crs)) return null;
  const tiploc = line.slice(36, 43).trim();
  if (!tiploc) return null;
  return { tiploc, crs, name: line.slice(5, 35).trim() };
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

export async function* streamStations(filePath: string): AsyncGenerator<StationRecord> {
  for await (const line of readLines(filePath)) {
    const station = parseStationLine(line);
    if (station) yield station;
  }
}

/**
 * ATOC codes whose schedules we load. Southeastern (SE) is the spike's focus;
 * the rest are operators whose services connect with SE across London, so a
 * cross-London onward leg can be modelled: Thameslink (TL, St Pancras/Blackfriars
 * core), Southern (SN, Victoria/London Bridge), Elizabeth line (XR, Abbey Wood),
 * Gatwick Express (GX, Victoria) and Great Northern (GN, Thameslink core). Fares
 * stay SE-only (see load.ts seCrsCodes), so this only adds timetable coverage.
 */
export const KEEP_ATOC = new Set(['SE', 'TL', 'SN', 'XR', 'GX', 'GN']);

/**
 * Streams the .MCA file and yields one SeSchedule per BS/BX block whose ATOC
 * code is one we keep (see KEEP_ATOC), without ever holding the whole file in
 * memory.
 */
export async function* streamSeSchedules(filePath: string): AsyncGenerator<SeSchedule> {
  let currentBs: BsRecord | null = null;
  let currentBx: BxRecord | null = null;
  let callingPoints: CallingPoint[] = [];

  function* flush(): Generator<SeSchedule> {
    if (currentBs && currentBx && KEEP_ATOC.has(currentBx.atocCode)) {
      yield { ...currentBs, ...currentBx, callingPoints };
    }
  }

  for await (const line of readLines(filePath)) {
    const recordType = line.slice(0, 2);
    if (recordType === 'BS') {
      yield* flush();
      currentBs = parseBsLine(line);
      currentBx = null;
      callingPoints = [];
    } else if (recordType === 'BX' && currentBs) {
      currentBx = parseBxLine(line);
    } else if (recordType === 'LO' && currentBs) {
      callingPoints.push(parseLoLine(line));
    } else if (recordType === 'LI' && currentBs) {
      callingPoints.push(parseLiLine(line));
    } else if (recordType === 'LT' && currentBs) {
      callingPoints.push(parseLtLine(line));
    }
  }
  yield* flush();
}
