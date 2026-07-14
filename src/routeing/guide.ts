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
  loadPermittedRoutes,
  loadRouteingPoints,
  loadStationGroups,
  loadStations,
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
  ) {}

  static async load(dir = 'data/routeing'): Promise<RouteingGuide> {
    const [stations, groups, routeingPoints, permitted] = await Promise.all([
      loadStations(dir),
      loadStationGroups(dir),
      loadRouteingPoints(dir),
      loadPermittedRoutes(dir),
    ]);
    return new RouteingGuide(stations, groups, routeingPoints, permitted);
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
}
