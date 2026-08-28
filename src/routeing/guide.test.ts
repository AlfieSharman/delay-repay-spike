/**
 * Unit tests for the routeing-guide lookup logic, using small in-memory
 * fixtures so they run without the (git-ignored) routeing feed. The feed
 * parsers are exercised separately by the inspect CLI against real data.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RouteingGuide } from './guide.js';
import type { StationRouteing } from './parse.js';

function guide(): RouteingGuide {
  const stations = new Map<string, StationRouteing>([
    ['LBG', { routeingPoints: [], group: 'G01' }], // London terminal -> London group
    ['STP', { routeingPoints: [], group: 'G01' }],
    ['AFK', { routeingPoints: [], group: null }], // itself a routeing point
    ['GRV', { routeingPoints: [], group: null }],
    ['SVG', { routeingPoints: ['CBG', 'FPK'], group: 'G28' }], // related routeing points
  ]);
  const groups = new Map([['G01', 'EUS']]);
  const points = new Set(['AFK', 'GRV', 'G01', 'CBG', 'FPK']);
  const permitted = new Map<string, string[][]>([
    ['AFK>G01', [['HS'], ['AF'], ['AR', 'TN']]],
    ['GRV>G01', [['NK', 'CT']]],
  ]);
  return new RouteingGuide(stations, groups, points, permitted);
}

test('routeingPointsFor resolves stations, London-group termini, and related points', () => {
  const g = guide();
  assert.deepEqual(g.routeingPointsFor('AFK'), ['AFK']); // its own routeing point
  assert.deepEqual(g.routeingPointsFor('LBG'), ['G01']); // London terminal -> London group
  assert.deepEqual(g.routeingPointsFor('STP'), ['G01']);
  assert.deepEqual(g.routeingPointsFor('SVG'), ['CBG', 'FPK']); // related routeing points
});

test('permittedRoutes returns the map sequences between the routeing points', () => {
  const g = guide();
  const routes = g.permittedRoutes('AFK', 'LBG');
  assert.equal(routes.length, 3);
  assert.ok(routes.every((r) => r.fromRouteingPoint === 'AFK' && r.toRouteingPoint === 'G01'));
  const sequences = routes.map((r) => r.maps.join(','));
  assert.deepEqual(sequences.sort(), ['AF', 'AR,TN', 'HS']);
});

test('followsPermittedRoute accepts a path on the map sequence and rejects one off it', () => {
  // Permitted route A->B is [M1, M2], changing maps at X. Y is off-route.
  const g = new RouteingGuide(
    new Map<string, StationRouteing>([
      ['A', { routeingPoints: [], group: null }],
      ['B', { routeingPoints: [], group: null }],
      ['X', { routeingPoints: [], group: null }],
      ['Y', { routeingPoints: [], group: null }],
    ]),
    new Map(),
    new Set(['A', 'B', 'X', 'Y']),
    new Map([['A>B', [['M1', 'M2']]]]),
    {
      mapsByPair: new Map(),
      nodesByMap: new Map([
        ['M1', new Set(['A', 'X'])],
        ['M2', new Set(['X', 'B'])],
        ['M3', new Set(['A', 'Y', 'B'])],
      ]),
    },
  );
  assert.deepEqual(g.followsPermittedRoute('A', 'B', ['X']).maps, ['M1', 'M2']); // on-route
  assert.equal(g.followsPermittedRoute('A', 'B', ['Y']).permitted, false); // Y is off-route
  assert.equal(g.followsPermittedRoute('A', 'B', []).permitted, true); // endpoints only: lenient
});

test('hasLondonRoute detects a permitted route consisting only of the London map', () => {
  const g = new RouteingGuide(
    new Map<string, StationRouteing>([
      ['TON', { routeingPoints: [], group: null }],
      ['LBG', { routeingPoints: [], group: 'G01' }],
    ]),
    new Map([['G01', 'EUS']]),
    new Set(['TON', 'G01']),
    new Map([['TON>G01', [['LO'], ['XX', 'YY']]]]),
  );
  assert.equal(g.hasLondonRoute('TON', 'LBG'), true);
  assert.equal(g.hasLondonRoute('LBG', 'TON'), false); // no G01>TON pair defined
});
