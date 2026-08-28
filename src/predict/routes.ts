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
  /** CRS the journey must pass through for the ticket to be valid (RSPS5045
   *  4.20.3 'I' locations; RSPS5047 9.1 "must include"). */
  readonly includeLocations: readonly string[];
  /** CRS the journey must NOT pass through ('E' locations; "must not include"). */
  readonly excludeLocations: readonly string[];
}

/**
 * Stations that are unambiguously on High Speed 1: Ebbsfleet International and
 * Stratford International (HS1-only). A journey calling at either is a High
 * Speed journey. St Pancras is deliberately NOT here - it has both HS1 and
 * classic (Thameslink) platforms, so it alone does not prove HS1 use.
 */
export const HS1_STATIONS: ReadonlySet<string> = new Set(['EBD', 'SFA']);

/** St Pancras: an HS1-capable terminus that is ambiguous on stops alone. */
export const ST_PANCRAS = 'STP';

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
  return { code, description, category: classifyRoute(description), includeLocations: [], excludeLocations: [] };
}

/** Parses one `L` (Route Include/Exclude Locations) record: RSPS5045 4.20.3. */
export function parseRouteLocationRecord(line: string): { code: string; crs: string; exclude: boolean } | null {
  if (!line.startsWith('RL')) return null;
  const code = line.slice(2, 7);
  const crs = line.slice(22, 25).trim();
  const inclExcl = line.slice(25, 26);
  if (!/^\d{5}$/.test(code) || crs.length !== 3) return null;
  return { code, crs, exclude: inclExcl === 'E' };
}

/**
 * Loads route-code definitions from a fares `.RTE` file: the `R` records give
 * the code and description; the `L` records add its include/exclude locations.
 */
export async function loadRouteDefinitions(filePath: string): Promise<Map<string, RouteDefinition>> {
  const text = await readFile(filePath, 'utf8');
  const map = new Map<string, RouteDefinition>();
  const includes = new Map<string, Set<string>>();
  const excludes = new Map<string, Set<string>>();

  for (const line of text.split(/\r?\n/)) {
    const def = parseRouteRecord(line);
    if (def) {
      if (!map.has(def.code)) map.set(def.code, def);
      continue;
    }
    const loc = parseRouteLocationRecord(line);
    if (loc) {
      const target = loc.exclude ? excludes : includes;
      const set = target.get(loc.code) ?? new Set<string>();
      set.add(loc.crs);
      target.set(loc.code, set);
    }
  }

  // Attach the location sets to their definitions.
  const result = new Map<string, RouteDefinition>();
  for (const [code, def] of map) {
    result.set(code, {
      ...def,
      includeLocations: [...(includes.get(code) ?? [])],
      excludeLocations: [...(excludes.get(code) ?? [])],
    });
  }
  return result;
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
