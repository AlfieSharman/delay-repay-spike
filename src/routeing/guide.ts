/**
 * The National Routeing Guide, loaded into memory for lookups.
 *
 * This first increment answers "what are the permitted routes between two
 * stations?" - the foundation the fuller rule engine (RSPS5047 sections 7-9:
 * shortest-route margin, map-sequence validation, easements, zonal London
 * rules) will build on. It does NOT yet decide whether a specific journey path
 * is permitted for a given route code; that comes next.
 */

import {
  loadLinks,
  loadPermittedRoutes,
  loadRouteingPoints,
  loadStationGroups,
  loadStations,
  type LinkData,
  type StationRouteing,
} from './parse.js';

/** A permitted route between two routeing points: an ordered map sequence. */
export interface PermittedRoute {
  readonly fromRouteingPoint: string;
  readonly toRouteingPoint: string;
  readonly maps: readonly string[];
}

export class RouteingGuide {
  constructor(
    private readonly stations: Map<string, StationRouteing>,
    private readonly groups: Map<string, string>,
    private readonly routeingPoints: Set<string>,
    private readonly permitted: Map<string, string[][]>,
    private readonly links: LinkData = { mapsByPair: new Map(), nodesByMap: new Map() },
  ) {}

  static async load(dir = 'data/routeing'): Promise<RouteingGuide> {
    const [stations, groups, routeingPoints, permitted, links] = await Promise.all([
      loadStations(dir),
      loadStationGroups(dir),
      loadRouteingPoints(dir),
      loadPermittedRoutes(dir),
      loadLinks(dir),
    ]);
    return new RouteingGuide(stations, groups, routeingPoints, permitted, links);
  }

  isRouteingPoint(code: string): boolean {
    return this.routeingPoints.has(code);
  }

  /**
   * The routeing point(s) that represent a station (RSPS5047 4.2). A station
   * either lists its related routeing points, or - if it is itself a routeing
   * point or a member of a routeing-point group - is represented by itself or
   * its group.
   */
  routeingPointsFor(crs: string): string[] {
    const entry = this.stations.get(crs);
    if (!entry) return this.isRouteingPoint(crs) ? [crs] : [];
    if (entry.routeingPoints.length > 0) return [...entry.routeingPoints];
    const candidates = [crs];
    if (entry.group) candidates.push(entry.group);
    return candidates.filter((c) => this.isRouteingPoint(c));
  }

  /**
   * All permitted routes between an origin and destination station, across
   * every routeing-point pairing. Each result is a permitted map sequence.
   */
  permittedRoutes(originCrs: string, destinationCrs: string): PermittedRoute[] {
    const results: PermittedRoute[] = [];
    for (const from of this.routeingPointsFor(originCrs)) {
      for (const to of this.routeingPointsFor(destinationCrs)) {
        for (const maps of this.permitted.get(`${from}>${to}`) ?? []) {
          results.push({ fromRouteingPoint: from, toRouteingPoint: to, maps });
        }
      }
    }
    return results;
  }

  /** True if any permitted route between origin and destination is via London (map "LO"). */
  hasLondonRoute(originCrs: string, destinationCrs: string): boolean {
    return this.permittedRoutes(originCrs, destinationCrs).some((r) => r.maps.length === 1 && r.maps[0] === 'LO');
  }

  /**
   * Whether a journey's node path follows a permitted sequence of maps
   * (RSPS5047 7.3.5). `viaNodes` is the ordered list of routeing-guide nodes
   * the journey passes between origin and destination (its calling points that
   * are routeing points / groups). Returns the matched map sequence if one
   * accepts the path.
   *
   * The check is a conservative greedy trace: each node in the path must lie on
   * the "current" map of a permitted sequence, advancing to the next map only
   * when the node is not on the current one. Because our node path comes from
   * stops (not the full geographical path), a match is trustworthy but a
   * non-match means "not confirmed permitted" rather than "definitely barred".
   */
  followsPermittedRoute(
    originCrs: string,
    destinationCrs: string,
    viaNodes: readonly string[],
  ): { permitted: boolean; maps?: readonly string[] } {
    const origins = this.routeingPointsFor(originCrs);
    const dests = this.routeingPointsFor(destinationCrs);
    // Resolve each via-station to the routeing-guide node/group it sits on
    // (e.g. a London terminal -> G01), keeping only ones the guide knows.
    const via = viaNodes.map((n) => this.asNode(n)).filter((n): n is string => n !== null);
    for (const orp of origins) {
      for (const drp of dests) {
        const path = dedupeConsecutive([orp, ...via, drp]);
        for (const maps of this.permitted.get(`${orp}>${drp}`) ?? []) {
          if (this.pathFitsMapSequence(path, maps)) return { permitted: true, maps };
        }
      }
    }
    return { permitted: false };
  }

  /** Greedy check that an ordered node path stays within a map sequence. */
  private pathFitsMapSequence(path: readonly string[], maps: readonly string[]): boolean {
    let mapIdx = 0;
    for (const node of path) {
      while (mapIdx < maps.length - 1 && !this.nodesOnMap(maps[mapIdx]!).has(node)) mapIdx += 1;
      if (!this.nodesOnMap(maps[mapIdx]!).has(node)) return false;
    }
    return true;
  }

  private nodesOnMap(mapCode: string): ReadonlySet<string> {
    return this.links.nodesByMap.get(mapCode) ?? EMPTY_SET;
  }

  /** A station's routeing-guide node: itself if a routeing point, else its group. */
  private asNode(crs: string): string | null {
    if (this.isRouteingPoint(crs)) return crs;
    return this.routeingPointsFor(crs).find((rp) => this.isRouteingPoint(rp)) ?? null;
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function dedupeConsecutive(path: readonly string[]): string[] {
  return path.filter((v, i) => i === 0 || v !== path[i - 1]);
}
