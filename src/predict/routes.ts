/**
 * Pragmatic route-code interpretation for validity checks.
 *
 * The full National Routeing Guide (the RGx feed) is a large, separate piece
 * of work. For the spike we lean on the route-code descriptions in the fares
 * `.RTE` file, which decode the common Southeastern cases directly:
 *   00000  ANY PERMITTED      -> no route constraint
 *   00130  NOT VALID ON HS1   -> High Speed not permitted
 *   00131  PLUS HIGH SPEED    -> High Speed permitted (plus classic)
 *   00700  NOT VIA LONDON     -> (not verified here; needs intermediate calls)
 *
 * Anything we can't classify confidently is left as 'other' and flagged for
 * human review rather than passed or failed silently.
 */

import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export type RouteCategory = 'any-permitted' | 'hs1-excluded' | 'hs1-included' | 'other';

export interface RouteDefinition {
  readonly code: string;
  readonly description: string;
  readonly category: RouteCategory;
}

/**
 * Southeastern stations that are unambiguously on High Speed 1 (HS1) - St
 * Pancras, Stratford International and Ebbsfleet International. A journey using
 * any of these is a High Speed journey. (Ashford and Gravesend are excluded
 * because they also have classic services.)
 */
export const HS1_STATIONS: ReadonlySet<string> = new Set(['STP', 'SFA', 'EBD']);

export function classifyRoute(description: string): RouteCategory {
  const d = description.toUpperCase();
  if (d.includes('ANY PERMITTED')) return 'any-permitted';
  if (d.includes('HIGH SPEED') || d.includes('HS1')) {
    return d.includes('NOT') ? 'hs1-excluded' : 'hs1-included';
  }
  return 'other';
}

/**
 * Parses one `RR` record from the `.RTE` file. Fixed-width: "RR" + 5-char
 * code + three 8-char date fields + a 16-char short description.
 */
export function parseRouteRecord(line: string): RouteDefinition | null {
  if (!line.startsWith('RR')) return null;
  const code = line.slice(2, 7);
  if (!/^\d{5}$/.test(code)) return null;
  const description = line.slice(31, 47).trim();
  return { code, description, category: classifyRoute(description) };
}

/** Loads route-code definitions from a fares `.RTE` file, first record wins. */
export async function loadRouteDefinitions(filePath: string): Promise<Map<string, RouteDefinition>> {
  const text = await readFile(filePath, 'utf8');
  const map = new Map<string, RouteDefinition>();
  for (const line of text.split(/\r?\n/)) {
    const def = parseRouteRecord(line);
    if (def && !map.has(def.code)) map.set(def.code, def);
  }
  return map;
}

/** Locates the `.RTE` file in a fares directory (its sequence number varies). */
export async function findRteFile(faresDir: string): Promise<string | null> {
  try {
    const files = await readdir(faresDir);
    const match = files.find((f) => f.toUpperCase().endsWith('.RTE'));
    return match ? path.join(faresDir, match) : null;
  } catch {
    return null;
  }
}
