/**
 * Inspect the National Routeing Guide feed:
 *   npm run routes -- <origin CRS> <dest CRS>
 *
 * Prints the routeing points for each station and the permitted routes
 * (map sequences) between them. A sanity-check tool while the routeing engine
 * is built; not part of the eligibility pipeline yet.
 */

import { RouteingGuide } from './guide.js';

async function main(): Promise<void> {
  const [origin, dest] = process.argv.slice(2).map((s) => s?.toUpperCase());
  if (!origin || !dest) {
    console.log('Usage: npm run routes -- <origin CRS> <dest CRS>');
    process.exit(1);
  }

  const guide = await RouteingGuide.load();
  console.log(`${origin} routeing point(s): ${guide.routeingPointsFor(origin).join(', ') || '(none)'}`);
  console.log(`${dest} routeing point(s): ${guide.routeingPointsFor(dest).join(', ') || '(none)'}`);

  const routes = guide.permittedRoutes(origin, dest);
  console.log(`\nPermitted routes ${origin} -> ${dest}: ${routes.length}`);
  for (const r of routes) {
    const hs = r.maps.includes('HS') ? '  [High Speed]' : '';
    console.log(`  ${r.fromRouteingPoint} -> ${r.toRouteingPoint}: ${r.maps.join(', ')}${hs}`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
