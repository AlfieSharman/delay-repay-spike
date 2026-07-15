# delay-repay-spike

## What this is

A spike for OTR's **Proactive Delay Repay** feature, focused on **Southeastern (SE)**
services. The idea: detect delays automatically from HSP data and proactively tell
eligible customers they can claim compensation, using fares data to work out what
they're owed.

This is exploratory code, not production. It will be handed to a developer to take
forward, so it needs to be clean and easy to pick up, not necessarily complete.

## Phase plan

1. **Ingest** (done) - download NRDP static feeds (fares, routeing, timetable) to
   `data/`. See `src/ingest/`.
2. **Parse & load** (done) - parse the raw CIF/fares files, filter to Southeastern,
   load into a local SQLite database at `data/spike.db`. See `src/db/`,
   `src/parse/`, `src/query.ts`.
3. **HSP client + eligibility logic** (done) - pull actual/planned times from the
   Historic Service Performance API, compare against the timetable, and work out
   delay-repay eligibility and the compensation band. See `src/hsp/`,
   `src/eligibility/`, `src/timetable/`, `src/check.ts`.
4. **Service prediction + batch verdicts** (in progress) - from a ticket plus
   its scan data, predict which service the customer travelled on, check
   validity, and produce a Delay Repay verdict. See `src/predict/`, `src/batch.ts`
   and the algorithm in `docs/service-prediction.md`.
5. **National Routeing Guide** (in progress) - parse the routeing feed and
   validate whether a journey's route is permitted. See `src/routeing/`.
   Record layouts and rules are RSPS5047 (in the RGD spec set).
   - Done: parse the feed and look up permitted routes between two stations
     (`npm run routes`); route-code include/exclude validity at
     routeing-point/group level (wired into `src/predict/validity.ts`).
   - Built but NOT wired as a gate: `RouteingGuide.followsPermittedRoute`, the
     map-sequence tracer (RSPS5047 7.3.5). It is correct given an accurate node
     path, but the journey's node path from HSP stops is too sparse to
     discriminate routes in practice (it collapses to "a permitted route
     exists", almost always true). Making base permitted-route validation
     useful needs the geographical routeing points a service *passes* (from the
     timetable/CIF, not just HSP stops) - or is the clearest case for calling
     Odyssey rather than reproducing it. Shortest-route margin and easements
     (RSPS5047 7.2 / 4.10) are further still.

### What phase 2 built

- `src/db/schema.ts` - SQLite schema: `stations`, `schedules`, `calling_points`,
  `locations`, `ticket_types`, `flows`, `fares`. Re-created from scratch on every
  `npm run load` run.
- `src/parse/timetable.ts` - streams the CIF `.MCA` file (BS/BX/LO/LI/LT records)
  and the `.MSN` station names file. Keeps only schedules whose BX ATOC code is
  `SE`. Field positions were confirmed by hand against the real feed files, since
  wiki.openraildata.com 403s non-browser clients.
- `src/parse/fares.ts` - streams the fares `.LOC`, `.FFL` and `.TTY` files.
- `src/parse/load.ts` - orchestrates the load in order: stations -> SE schedules ->
  locations -> ticket types -> SE flows/fares. Each stage runs in one transaction.
- `src/query.ts` - `stats`, `services <CRS> <date>`, `fares <origin> <dest>`.

**Non-obvious things a developer picking this up should know:**

- **CIF times are truncated to whole minutes.** The half-minute `H` suffix is
  dropped - delay-repay logic works in whole minutes (HSP data is minute-level),
  so it isn't useful precision. Times are stored as minutes since midnight.
- **STP overlay resolution matters and is easy to get wrong.** A schedule UID can
  have several CIF records (P = permanent, O = overlay, N = new/STP-only, C =
  cancellation) covering different date ranges. For a given date: C beats
  everything (train doesn't run), O or N beat P. `resolveStp` was factored out
  of `src/query.ts` into `src/timetable/lookup.ts` in phase 3 so both the query
  CLI and the eligibility engine share it - it decides whether a service ran at
  all on a given day.
  - Passing/non-stopping calling points (CIF `LI` records with only a pass time,
    no arrival/departure) are excluded from "services calling at" - a train can
    be scheduled through a station without it counting as a call there.
- **Fares to London termini are usually priced against a shared "fare group" NLC,
  not the individual station.** E.g. Cannon Street, Charing Cross and Victoria are
  all grouped under NLC `1072` ("LONDON TERMINALS") in the `.FFL` flow file - a
  flow's destination is very often the group code, not the terminus's own NLC.
  `locations.fare_group_nlc` captures this (equal to the station's own NLC when
  it isn't part of a group). Any fare lookup must check both the station's NLC
  and its fare group, in both the load-time Southeastern filter and query-time
  lookups - missing this silently drops most fares into London.

### What phase 3 built

- `src/timetable/lookup.ts` - shared timetable helpers over the phase-2 SQLite
  data: STP resolution (`resolveStp`), calendar checks, `servicesCallingAt`
  (used by the query CLI) and `scheduledJourneysBetween` (origin->destination
  services on a date, used by the check CLI). `src/query.ts` now imports these.
- `src/hsp/client.ts` - typed client for HSP `serviceMetrics` (find RIDs on a
  flow) and `serviceDetails` (actual vs scheduled times for one RID). HTTP Basic
  auth with the NRDP creds. Requests are serialised 200ms apart and cached to
  `data/hsp-cache/` keyed on a hash of the request body; `--no-cache` bypasses.
- `src/eligibility/journey.ts` - types (`Journey`, `Leg`, `ServiceRun`,
  `EligibilityResult`) and the SE compensation bands.
- `src/eligibility/engine.ts` - `assessEligibility`: pure logic, takes the
  intended journey plus the actual runs per leg and returns eligibility, delay,
  band, compensation % and a step-by-step `explanation`. Unit-tested in
  `engine.test.ts` (`npm test`).
- `src/check.ts` - the demo CLI (`npm run check`), tying timetable + HSP +
  engine together for "a customer with this ticket on this day".

**Non-obvious things a developer picking this up should know:**

- **Delay is measured only at the final destination**, against the intended
  journey's scheduled arrival there - never at intermediate points.
- **advance vs flexible tickets differ in the engine.** advance rides the booked
  services and only falls through to the next valid service when a booked leg is
  cancelled or a connection is missed; flexible always takes the best
  (earliest-arriving) service from the intended departure onward, and is
  ineligible if that best journey arrives less than the threshold late.
- **Connections use a strict "ready before departure" rule.** A connection is
  made only if `previous actual arrival + interchange` is *strictly* less than
  the onward service's actual departure. Being ready at the exact departure
  minute counts as missed - this is what makes the worked multi-leg example
  (leg 1 arrives 16:50, 5-min interchange, booked 16:55 connection) resolve to
  the next service. Default interchange is 5 minutes.
- **HSP `location` fields are CRS codes**, and its `gbtt_ptd`/`gbtt_pta` public
  times match the CIF public timetable, so they're used as the intended-journey
  baseline; `actual_td`/`actual_ta` are the actuals. Empty actual arrival at the
  destination is how a cancelled service shows up - there is no explicit flag.
  (`late_canc_reason` is a delay *or* cancellation reason, so it is not a
  reliable cancellation signal on its own.)
- **HSP has no data for today or yesterday** and covers ~2 years back; the check
  CLI warns if you pass a too-recent date. Overnight journeys (past-midnight
  arrivals) are not handled - out of spike scope.

### What phase 4 built

- `src/predict/scans.ts` - normalise raw scan JSON (NLC->CRS, ISO->minutes),
  classify each scan (gateline / on-train / admin / rejected), group by coupon,
  and extract the travel constraints (entry tap, exit tap, on-train service
  hints, anomalies). Pure.
- `src/predict/resolve.ts` - given a scheduled itinerary, the actual runs per
  leg and the scan constraints, pick which services the customer actually
  travelled on and grade the reconstruction (entry/exit tap fit).
- `src/predict/validity.ts` - Advance booked-service enforcement, `TimeValidFrom`
  and scan reason-code checks.
- `src/predict/restrictions.ts` - parses the RST time-restriction data
  (RSPS5045 4.18: RH headers, TR time windows, TD date bands, TT TOC filters)
  and evaluates whether an Off-Peak / Super Off-Peak ticket's restriction bars
  the travelled service. Validated against the Odyssey Rochester responses (the
  F4 "Super Off-Peak Day" code bars outward departures 04:00-09:59, so 09:32
  is invalid and 10:02 valid). **Wired into the verdict**: the batch resolves a
  ticket's restriction code from the fares table
  (`BatchDataProvider.restrictionCodeFor`, flow + ticket type + route ->
  `fare.restriction_code`) and validity evaluates it against the predicted
  journey's departure/arrival, reason `RESTRICTION_NOT_VALID` when the ticket
  wasn't valid on the service. Where the code can't be resolved unambiguously
  it falls back to the "not verified" flag rather than guessing.
- `src/predict/assess.ts` - orchestrates one coupon: resolve -> eligibility
  engine -> validity -> confidence -> compensation. Pure; unit-tested end to
  end against the five real tickets in `predict.test.ts`.
- `src/predict/provider.ts` - the impure data layer for the batch runner:
  resolves NLCs/fare groups and ticket metadata from SQLite, and builds
  candidate itineraries from the timetable + HSP (direct, or one interchange).
- `src/predict/itinerary.ts` - parses a customer's planned itinerary when it is
  embedded in the ticket export (`Itinerary` block, legs per coupon). When
  present it pins the legs and interchange directly, so prediction does not
  have to infer them.
- `src/batch.ts` - `npm run batch -- <dir>`: reads ticketing-export JSON files,
  runs the pipeline, prints a verdict per coupon and writes `results.json`.

**Non-obvious things a developer picking this up should know:**

- **Ticket origin/destination NLCs can be fare groups** (e.g. 1072 "LONDON
  TERMINALS") with no CRS of their own. `resolveCrs` expands the group and
  picks the member the scans actually used - resolve BOTH origin and
  destination this way, not just destination.
- **`STATION` in a scan is an NLC; a `clip` scan is on-train, not a gate.** Its
  `STATION` is often just the booked end, not where the scan physically
  happened, so on-train scans must not be treated as gateline entry/exit.
- **Rejected scan reason codes are signals**: `INCTIM` (invalid time) implies
  invalid travel; `LOCDIR` (wrong direction) is a review flag, not an
  auto-reject. `train_info` can be stale (a unit still advertising its previous
  working), so its direction is checked, never trusted blindly.
- **Past-midnight arrivals must be normalised** (+1440 when arrival < departure)
  before any min-arrival comparison, or a late-evening return that arrives after
  midnight looks *earlier* than an on-time one and corrupts the delay.
- **Delay baseline differs by ticket type**: Advance is judged against the
  booked service; walk-up uses the eligibility engine's *flexible* mode (best
  achievable arrival vs the intended scheduled arrival).
- **Destination-only multi-leg journeys are the hard case.** With just an exit
  tap the planner anchors on it and works backwards to find the interchange and
  first leg; the intended baseline is the earliest scheduled onward connection.
  This is heuristic - confidence caps at PROBABLE and it should be reviewed.
  Supplying the customer's planned itinerary (embedded `Itinerary` block)
  removes the guesswork entirely.
- **Route code is enforced from the real include/exclude locations, not just a
  description.** `src/predict/routes.ts` parses the fares `.RTE` `R` (description)
  and `L` (Route Include/Exclude Locations, RSPS5045 4.20.3) records. Validity
  applies RSPS5047 9.1: the journey must not call at any "exclude" location and
  must call at every "include" location, checked against the service's calling
  points (now captured from HSP - `ServiceRun.callingPoints`).
  - **HS1 is detected via Ebbsfleet / Stratford International (HS1-only), NOT
    St Pancras.** St Pancras has both HS1 and classic (Thameslink) platforms,
    so a journey ending there is HS1-*capable* but not certainly HS1; an
    `hs1-excluded` ticket to St Pancras is flagged for review, not rejected.
    This was caught by the Odyssey oracle (a via-London-Bridge Gravesend->St
    Pancras journey legitimately sells the not-HS1 fare).
  - **"Via" checks are done at routeing-point/group level, not raw CRS.** The
    batch passes `RouteingGuide.routeingPointsFor` into validity so, e.g., a
    "NOT VIA LONDON" code (exclude Euston) correctly rejects a journey via any
    London terminal (all resolve to group G01), not just via Euston. Validated
    against the Dover->Brighton Odyssey example (the cheap not-via-London fare
    is sold only on the via-Ashford journey, not the via-St Pancras/Victoria
    ones).
  - "Must include" locations that are passing (not stopping) points can't be
    confirmed from HSP stops yet, so they're flagged rather than failed.
  - Full permitted-route validation (does the journey follow a permitted map
    sequence at all - the `RGx` routeing guide, RSPS5047 7-9) is the next
    increment; see `src/routeing/`.

## Conventions

- TypeScript, strict mode, ESM (`type: module`). No transpiled JS committed.
- Minimal dependencies. Only add a package if there's no reasonable way to do the
  job with the Node stdlib.
- Large NRDP files (the timetable `.MCA` is ~600MB, fares `.FFL` has ~9.6M records)
  are always **streamed**, never loaded fully into memory. Use `readline` /
  `node:stream` over a file, not `readFile`.
- Credentials (`NRDP_USERNAME`, `NRDP_PASSWORD`) live only in `.env`, which is
  git-ignored. `.env.example` documents the shape. Never commit real credentials.
- `data/` is git-ignored and regenerable (`npm run download` then `npm run load`).
- Parsers are pure functions where possible: a line of text in, a typed record out.
  This makes them unit-testable later without needing the real feed files.
- Code should read cleanly for someone who didn't write it - this is getting handed
  off. Prefer clarity over cleverness.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run download` | Authenticate with NRDP and download+unzip the three static feeds into `data/`. |
| `npm run inspect` | Print a summary of what's in `data/` (file sizes, first few lines) - no parsing. |
| `npm run load` | Parse the raw feeds and load Southeastern-relevant data into `data/spike.db`. |
| `npm run query -- <command>` | Sanity-check the loaded data. Commands: `stats`, `services <CRS> <YYYY-MM-DD>`, `fares <origin CRS> <dest CRS>`. |
| `npm run check -- <origin CRS> <dest CRS> <YYYY-MM-DD> <dep HHMM>` | Simulate a customer's journey and print the Delay Repay verdict. Flags: `--via <CRS>`, `--advance` (default is a flexible ticket), `--return`, `--threshold <min>` (default 15), `--no-cache`. |
| `npm run batch -- <dir>` | Read ticketing-export JSON files from a directory, predict the service travelled and print a Delay Repay verdict per coupon; writes `results.json`. Add `--verbose` for the full explanation trail. |
| `npm run routes -- <origin CRS> <dest CRS>` | Print the routeing points and permitted routes (map sequences) between two stations, from the National Routeing Guide feed. `[High Speed]` marks routes using the HS1 map. |
| `npm test` | Run the eligibility engine and prediction unit tests (`node:test`). |
| `npm run typecheck` | `tsc --noEmit`. |

Run `npm run download` before `npm run load` - the parsers read from `data/`.
`npm run check` needs `data/spike.db` loaded and valid NRDP creds in `.env`.
