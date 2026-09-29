# National Routeing Guide: status and remaining work

Where the routeing-guide work got to, and what's left, so it can be picked up
later. Code is in `src/routeing/`. The authoritative spec is **RSPS5047**
(National Routeing Guide Data Feed Specification); the route-code
include/exclude records are in **RSPS5045 §4.20**.

## What the routeing guide is (and why it's hard)

It answers "is this journey a permitted route for this fare?" It is a rule
engine, not a lookup. A journey is validated by mapping its physical path to
**routeing points** and checking that path follows a **permitted sequence of
maps** between the origin and destination routeing points, subject to the
fare's **route code** (via/not-via constraints), a **shortest-route mileage
margin**, and **easements** (named exceptions).

Crucially, this needs the journey's **geographical path** - the routeing
points a train *passes through*, not just where it stops. A journey planner
(e.g. Odyssey) has this natively because it *constructs* the journey from the
full national timetable. Working backwards from HSP stop data alone does not
give the passed-through points, which is what limited base-route validation.
That gap is now closed on the data side: `geographicalPath` (in
`src/timetable/lookup.ts`) returns the ordered CRS a CIF service stops at **or
passes through**, built from the stored pass records (see item 1 below). What
remains is wiring that dense path into the tracer as a gate and validating it.

## Done and wired in

- **Feed parser** (`src/routeing/parse.ts`) - stations -> routeing points,
  station groups, routeing points, permitted routes, and node links.
- **Permitted-routes lookup** (`RouteingGuide.permittedRoutes`, `npm run routes`).
- **Route-code validity** (in `src/predict/validity.ts`) - parses the fares
  `.RTE` include/exclude locations (RSPS5045 §4.20.3) and applies RSPS5047 §9.1
  at **routeing-point/group level**: the journey must not call at an exclude
  location and must call at include locations. Correctly handles:
  - HS1 vs classic (`00130` / `00131`) via Ebbsfleet / Stratford International;
    St Pancras is flagged as ambiguous (HS1 or Thameslink) rather than assumed.
  - "NOT VIA LONDON" (`00700`) at group level - any London terminal (all in
    group `G01`), not just Euston.
  Validated against the Ashford, Gravesend, Rochester, Deal, Hastings,
  Dover->Brighton and Chatham->Bedford Odyssey responses.

## Built but NOT wired (and why)

- **`RouteingGuide.followsPermittedRoute`** - the map-sequence tracer
  (RSPS5047 §7.3.5). Given an accurate node path it correctly accepts on-route
  and rejects off-route paths (see `guide.test.ts`). It is **not yet** wired as
  a validity gate. The original blocker was the node path: built from HSP
  *stops* it was too sparse and collapsed to "a permitted route exists" (almost
  always true), unable to tell a via-Ebbsfleet (HS1) journey from a via-Dartford
  (classic) one because the deciding points are passed, not stopped at. That
  blocker is now removed - `geographicalPath` gives the dense passed-through path
  (on GRV->STP it separates 36 via-Ebbsfleet HS1 services from 38 via-Dartford
  classic ones). The remaining step is to feed that path into
  `followsPermittedRoute` as a gate and validate it against Odyssey before it
  can change verdicts; until then it stays dormant to avoid false rejects.

## Remaining work (in dependency order)

1. **Geographical node path** - DONE. `geographicalPath` (in
   `src/timetable/lookup.ts`) derives the ordered routeing points each CIF
   service stops at or *passes* between two stations, from the stored
   `scheduled_pass` records (phase-2 loads pass-only calling points, so no
   re-ingest was needed - only the "services calling at" query filters them out).
   Unit-tested in `lookup.test.ts`. This was the unlock for everything below.
2. **Base permitted-route gate** - wire `followsPermittedRoute` on the dense
   `geographicalPath` (per leg, concatenated across legs) and validate the
   accept/reject calls against Odyssey before making it a gate. This is the next
   increment; keep it dormant until validated to avoid false rejects.
3. **Shortest-route / mileage margin** (RSPS5047 §7.2.4/7.2.6) - uses the
   station-link distances (`.RGD`, parsed shape available).
4. **Deviations / doublebacks** (§7.2.8) and "no station twice" (§7.3.4).
5. **Easements** (§4.10 / `.RGF`, `.RGE`, `.RGH`) - named exceptions.
6. **Zonal London** rules (§9.2.2 / `.RGA`, `.RGB`, `.RGV`).
7. **Cross-London / Elizabeth line / Thameslink / Underground** specifics (§8).
8. **TOC-restricted routes** ("Southern only", "EMR only") - checkable from the
   leg TOC (HSP `toc_code`), just not wired.

## Recommendation

Route-code validity (done) covers the high-frequency route-based invalid
claims (HS1 misuse, via/not-via). The remaining items are edge cases for
delay-repay and all depend on planner-grade geographical-path data. The
pragmatic options are:

- **Reuse Odyssey** for base permitted-route validation (it already does items
  1-7 correctly and is maintained), calling it for the rare cases; or
- **Plumb the geographical path** from the CIF timetable and continue the
  engine here - only worth it if base-route validation proves to matter.

Do not build the full engine speculatively; let real claim data show whether
base-route violations occur often enough to justify it.
