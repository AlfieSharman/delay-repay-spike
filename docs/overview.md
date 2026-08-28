# Proactive Delay Repay Spike: Overview

A shareable summary of what the spike does today, what is still to build, and
how we test it. For the detailed technical notes and gotchas, see
[CLAUDE.md](../CLAUDE.md). Deeper design docs:
[service-prediction.md](service-prediction.md) and
[routeing-guide.md](routeing-guide.md).

## Purpose

Detect Southeastern (SE) delays automatically from industry data and work out
whether a customer's journey qualified for Delay Repay, and by how much. The
wider goal is to check submitted claims against what actually happened: predict
which service a customer really travelled on from their scan data, confirm the
ticket was valid on it, and produce an auditable per-claim verdict.

This is exploratory code, not production. It is meant to prove the approach and
be picked up by a developer, not to be complete.

## Where we are

| Phase | Status | What it does |
| --- | --- | --- |
| 1. Ingest | Done | Downloads the national timetable, fares and routeing feeds from NRDP into `data/`. |
| 2. Parse and load | Done | Parses the raw feeds, filters to Southeastern, loads into a local SQLite database (`data/spike.db`). |
| 3. HSP client and eligibility engine | Done | Pulls actual vs scheduled times from the Historic Service Performance (HSP) API and decides whether a journey was delayed enough to claim, in which band, at what compensation percentage. |
| 4. Service prediction and batch verdicts | Done | From a ticket plus its scan data, predicts the service travelled, checks ticket validity, and produces a Delay Repay verdict per coupon. |
| 5. National Routeing Guide | Partial | Route-code (via / not-via / HS1) validity is done and wired. The base permitted-route engine is built but deliberately paused (see below). |

### What it can do today

Two entry points, both producing a step-by-step explanation trail.

**Batch claim assessment (the headline).** `npm run batch -- <dir>` reads
ticketing-export JSON files, and for each coupon:

1. Normalises and classifies the scans (gateline / on-train / admin /
   rejected), and extracts the travel constraints (entry tap, exit tap,
   on-train hints, anomalies).
2. Predicts which service(s) the customer travelled on, working from the scans
   against the timetable and HSP actuals, with a confidence tier
   (CONFIRMED / PROBABLE / INFERRED / UNKNOWN).
3. Checks validity: Advance booked-service enforcement, `TimeValidFrom`, scan
   reason-code anomalies, route-code include/exclude rules, and Off-Peak /
   Super Off-Peak time restrictions.
4. Runs the eligibility engine for the delay verdict and computes the
   compensation figure.

It prints one line per coupon (entitled, delay, band, compensation,
confidence, reason/notes) and writes a full `results.json`. Add `--verbose`
for the explanation trail per coupon.

**Single-journey check.** `npm run check -- <origin> <dest> <date> <dep>`
simulates one customer journey (no scan data): looks up the intended journey
in the timetable, asks HSP what actually ran, and prints the verdict. Flags:
`--via <CRS>`, `--advance`, `--return`, `--threshold <min>`, `--no-cache`.

The eligibility engine
([src/eligibility/engine.ts](../src/eligibility/engine.ts)) handles single and
multi-leg journeys, missed connections (catch the next valid onward service),
delay measured only at the final destination, Advance versus flexible tickets,
and cancellations (a cancelled service shows up as a missing actual arrival).

### How the pieces fit

| Area | Code | Role |
| --- | --- | --- |
| Ingest / load | `src/ingest/`, `src/parse/`, `src/db/` | Download feeds, parse CIF + fares, load SE data into SQLite. |
| Timetable lookup | `src/timetable/` | STP resolution, calendar checks, scheduled journeys between two stations. |
| HSP client | `src/hsp/` | Typed, cached, rate-limited client for actual vs scheduled times. |
| Eligibility | `src/eligibility/` | Pure delay verdict: eligible, delay, band, compensation percentage. |
| Prediction | `src/predict/` | Scan parsing, service reconstruction, validity (route code, restrictions, reason codes), per-coupon assessment. |
| Routeing | `src/routeing/` | Routeing-guide feed parser and permitted-routes lookup. |
| Runners | `src/batch.ts`, `src/check.ts`, `src/query.ts` | The three CLIs. |

Most of `src/predict/` and all of `src/eligibility/` are pure functions, so the
logic is unit-tested with mocked data (no database or credentials needed). The
impure data layer (`src/predict/provider.ts`, `src/batch.ts`) is what touches
SQLite and HSP.

### The paused piece: base permitted-route validation

Route-code validity (does the fare's via / not-via / HS1 constraint permit this
journey) is done and validated against Odyssey. The remaining routeing work,
full permitted-route validation (does the journey follow a permitted map
sequence at all), is built (`RouteingGuide.followsPermittedRoute`) but not
wired as a gate: the node path we can build from HSP *stops* is too sparse to
discriminate routes, so it would collapse to "a permitted route exists" and add
false confidence. Making it useful needs the geographical points a service
*passes* (from the CIF timetable, currently discarded) or is the clearest case
for calling Odyssey rather than reproducing its engine. Full detail and resume
steps are in [routeing-guide.md](routeing-guide.md).

## Known limitations and open gaps

- **Reason-code dictionary is conservative.** Rejected-scan reason codes are
  surfaced with their meaning, but only codes we can confirm mean invalid
  travel contribute to a rejection; the rest are review flags. The authoritative
  code list from the ticketing team would let more be classified confidently.
- **Season tickets / travelcards** are not handled (different compensation
  model).
- **Non-SE / multi-TOC journeys** come back unresolved: the timetable is
  filtered to Southeastern. National journeys, and the "notify but redirect to
  the responsible TOC" idea, are out of scope for the spike.
- **Base permitted-route validation** is paused (see above).
- **HSP has no data for today or yesterday** and covers roughly the last two
  years. Very recent journeys cannot be checked yet.
- **Overnight journeys** (arrivals past midnight) are handled in prediction
  (times normalised) but not in the single-journey `check` CLI.
- **Delay threshold is a placeholder 15 minutes.** SE may apply a lower
  threshold; the tool always reports the exact delay in minutes so the real
  policy threshold can be applied on top.

## Roadmap

Rough order of value, pending real claim data:

1. **Reason-code dictionary completion.** Fill in the authoritative meaning and
   action for every scan reason code once the ticketing team supplies the list.
2. **Season tickets / travelcards.** Add their compensation model.
3. **Non-SE / multi-TOC support and delay attribution.** Broaden beyond the SE
   timetable filter; attribute delay to the responsible TOC.
4. **Base permitted-route engine**, only if real claims show base-route
   violations happen often enough to justify it, and then either by plumbing the
   CIF geographical path or by calling Odyssey.

## How we test

The spike is layered so most logic can be tested with no database and no
credentials.

| What | Command | Needs |
| --- | --- | --- |
| Engine + prediction logic | `npm test` | Nothing. Uses mocked timetable and HSP data. |
| Types compile | `npm run typecheck` | Nothing. |
| Loaded data sanity | `npm run query -- stats` / `services <CRS> <date>` / `fares <o> <d>` | `data/spike.db`. |
| Routeing points / permitted routes | `npm run routes -- <o> <d>` | The routeing feed in `data/`. |
| Single journey verdict | `npm run check -- <o> <d> <date> <dep>` | `data/spike.db` and NRDP credentials in `.env`. |
| Batch claim assessment | `npm run batch -- <dir>` | `data/spike.db`, NRDP credentials, and ticketing-export JSON files. |

Notes:

- **`npm test`** is the fast feedback loop. The eligibility engine and the
  prediction pipeline are pure functions, tested end to end against the real
  reference tickets. Add cases by constructing scans / service runs by hand; no
  network needed.
- **New validity logic is validated against the Odyssey journey-planner
  oracle** (which fares and route codes it sells per journey), not just against
  a manual reading of the spec.
- **HSP responses are cached** to `data/hsp-cache/`, so re-running the same
  `check` or `batch` is free and offline after the first call. Use `--no-cache`
  to force a fresh query. HSP is a shared industry service, so requests are
  serialised and rate-limited.
- Pick a **weekday at least two days in the past**, since HSP has no recent
  data.

## Running it from scratch

```
npm install
cp .env.example .env        # then fill in NRDP_USERNAME and NRDP_PASSWORD
npm run download            # downloads the feeds (the timetable is large)
npm run load                # builds data/spike.db, filtered to Southeastern
npm test                    # confirm the engine and prediction pass
npm run check -- TON CST 2026-07-02 0746 --advance
npm run batch -- data/dr-spike-1
```

`data/` and `.env` are git-ignored. The database and feeds are regenerable with
`npm run download` then `npm run load`.
</content>
</invoke>
