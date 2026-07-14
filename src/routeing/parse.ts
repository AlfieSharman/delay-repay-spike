/**
 * Parsers for the National Routeing Guide feed (data/routeing/, the RGx
 * files). Field layouts are from RSPS5047 "National Routeing Guide Data Feed
 * Specification" section 4.
 *
 * Files are comma-separated; lines beginning with "/" are header or section
 * comments and are skipped. Each file's sequence number varies per release, so
 * files are located by extension.
 *
 * This first increment loads what the permitted-routes lookup needs:
 *   .RGS  STATION          CRS -> related routeing points (+ station group)
 *   .RGG  STATION GROUP    Gnn -> main station CRS
 *   .RGP  ROUTEING POINTS  the set of routeing-point codes
 *   .RGR  PERMITTED ROUTES routeing-point pair -> permitted map sequence(s)
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function findByExtension(dir: string, ext: string): Promise<string> {
  const files = await readdir(dir);
  const match = files.find((f) => f.toUpperCase().endsWith(ext.toUpperCase()));
  if (!match) throw new Error(`No *${ext} file found in ${dir}`);
  return path.join(dir, match);
}

/** Non-comment, non-empty lines of a routeing feed file. */
async function dataLines(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith('/'));
}

/** A station's routeing entry (RSPS5047 4.2.2). */
export interface StationRouteing {
  /** Related routeing points (CRS or Gnn group codes); empty if the station is
   *  itself a routeing point or a member of a routeing-point group. */
  readonly routeingPoints: readonly string[];
  /** Station-group id (Gnn) the station belongs to, if any. */
  readonly group: string | null;
}

export async function loadStations(dir: string): Promise<Map<string, StationRouteing>> {
  const map = new Map<string, StationRouteing>();
  for (const line of await dataLines(await findByExtension(dir, '.RGS'))) {
    const [crs, rp1, rp2, rp3, rp4, group] = line.split(',');
    if (!crs) continue;
    const routeingPoints = [rp1, rp2, rp3, rp4].filter((r): r is string => !!r && r.length > 0);
    map.set(crs, { routeingPoints, group: group && group.length > 0 ? group : null });
  }
  return map;
}

/** Gnn station-group -> main station CRS (RSPS5047 4.3.2). */
export async function loadStationGroups(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const line of await dataLines(await findByExtension(dir, '.RGG'))) {
    const [group, mainStation] = line.split(',');
    if (group && mainStation) map.set(group, mainStation);
  }
  return map;
}

/** The set of routeing-point codes (CRS or Gnn) (RSPS5047 4.4.3). */
export async function loadRouteingPoints(dir: string): Promise<Set<string>> {
  const set = new Set<string>();
  for (const line of await dataLines(await findByExtension(dir, '.RGP'))) {
    const code = line.split(',')[0];
    if (code) set.add(code);
  }
  return set;
}

/**
 * Permitted routes between routeing-point pairs (RSPS5047 4.8.2). Keyed
 * "START>END"; each value is a list of permitted map sequences (each an
 * ordered list of 2-char map codes; "LO" is the London map).
 */
export async function loadPermittedRoutes(dir: string): Promise<Map<string, string[][]>> {
  const map = new Map<string, string[][]>();
  for (const line of await dataLines(await findByExtension(dir, '.RGR'))) {
    const parts = line.split(',');
    const start = parts[0];
    const end = parts[1];
    const maps = parts.slice(2).filter((m) => m.length > 0);
    if (!start || !end || maps.length === 0) continue;
    const key = `${start}>${end}`;
    const seqs = map.get(key) ?? [];
    seqs.push(maps);
    map.set(key, seqs);
  }
  return map;
}
