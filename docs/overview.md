# Proactive Delay Repay Spike: Overview

A shareable summary of what the spike does today, what is still to build, and
how we test it. For the detailed technical notes and gotchas, see
[CLAUDE.md](../CLAUDE.md).

## Purpose

Detect Southeastern (SE) delays automatically from industry data and work out
whether a customer's journey qualified for Delay Repay, and by how much. The
longer-term goal is to check submitted claims against what actually happened,
so we can spot claims for journeys the customer was not valid to travel on, or
did not actually take.

This is exploratory code, not production. It is meant to prove the approach and
be picked up by a developer, not to be complete.

## Where we are

| Phase | Status | What it does |
| --- | --- | --- |
| 1. Ingest | Done | Downloads the national timetable, fares and routeing feeds from NRDP into `data/`. |
| 2. Parse and load | Done | Parses the raw feeds, filters to Southeastern, loads into a local SQLite database (`data/spike.db`). |
| 3. HSP client and eligibility engine | Done | Pulls actual vs scheduled times from the Historic Service Performance (HSP) API and decides whether a journey was delayed enough to claim. |
| 4. Scan matching and ticket validity | Not started | Predict which service a customer travelled on from scan data, check the ticket was valid on it, and cross-reference against submitted claims. |

### What it can do today

Given an origin, destination, date and departure time, the spike looks up the
intended journey in the local timetable, asks HSP what the trains actually did
that day, and prints a Delay Repay verdict with a step-by-step explanation:
eligible or not, delay in minutes, the SE band (15 / 30 / 60 / 120), and the
compensation percentage.

The eligibility engine ([src/eligibility/engine.ts](../src/eligibility/engine.ts))
handles:

- Single and multi-leg journeys, including a missed connection where the
  customer catches the next valid onward service.
- Delay measured only at the final destination, against the intended arrival.
- Advance tickets (must travel on booked services) versus flexible tickets
  (best journey from the intended departure onward).
- Cancellations (a cancelled service shows up as a missing actual arrival).

Example runs against real HSP data:

```
# A service that arrived 36 minutes late -> ELIGIBLE, band 30-59
npm run check -- TON CST 2026-07-02 0746 --advance

# An on-time service -> NOT ELIGIBLE
npm run check -- TON CST 2026-07-02 0624
```

### Known limitations today

- **CLI supports one interchange only** (`--via <CRS>`). The engine itself
  handles any number of legs, but `check.ts` only wires up a single change of
  train.
- **No ticket validity check.** The spike does not yet decide whether a ticket
  was valid on a given service (for example an Off-Peak ticket on a Peak
  train). The restriction data is downloaded but not parsed or loaded.
- **No cash figure.** The engine returns a compensation percentage, not a
  pounds-and-pence amount. Wiring in the loaded SE fares to produce an actual
  value is a small, separate task.
- **HSP has no data for today or yesterday** and covers roughly the last two
  years. Very recent journeys cannot be checked yet.
- **Overnight journeys** (arrivals past midnight) are out of scope.

## What is next: phase 4

The goal is to take recent Delay Repay claims and work out, from scan data,
which service the customer actually travelled on, whether their ticket was
valid on it, and whether that matches what they claimed for.

Planned flow:

1. **Predict the service.** For each ticket, take its scan events, shortlist
   candidate services from the local timetable between the scanned locations
   around the scan time, then confirm against HSP actuals. This is the reverse
   of what `check.ts` does today. Output: a predicted service plus a confidence
   score.
2. **Check validity.** Parse the restriction dataset already downloaded
   (`.RST`, `.TRR`, `.TPB`, `.TPN`), resolve the ticket's restriction code, and
   decide whether the predicted service was permitted.
3. **Cross-reference.** Compare the predicted service against the service the
   customer claimed on, and output a per-ticket verdict: match, mismatch,
   invalid ticket, or no HSP actuals yet.

### Dependency: data export from a BE developer

Phase 4 is fed by a file a backend developer exports (claims, tickets and scan
events). The predicted-service accuracy depends heavily on the scan data, so we
need to see the real shape before building. The two fields that matter most:

- **Location coverage.** Scans at both origin and destination make prediction
  reliable. Origin-only scans (common on SE, where many stations are ungated)
  make it a best-guess with a confidence score, not a fact.
- **Direction or type.** Tap-in versus tap-out versus on-train check.

Agreed principle: where scan data is sparse, the spike **flags** mismatches for
review rather than auto-rejecting claims.

The export needs, per ticket: claim and ticket IDs, origin and destination CRS,
route code, ticket type code, single or return, restriction code (if held),
travel date, and the service the claim was submitted against. Per ticket, the
scan events need: timestamp (with timezone), location (CRS or a mappable
gateline ID), and direction or type. An anonymised sample of around five
tickets is enough to start.

## How we test

The spike is layered so most of the logic can be tested with no database and no
credentials.

| What | Command | Needs |
| --- | --- | --- |
| Engine logic | `npm test` | Nothing. Uses mocked timetable and HSP data. |
| Types compile | `npm run typecheck` | Nothing. |
| Loaded data sanity | `npm run query -- stats` / `services <CRS> <date>` | `data/spike.db`. |
| End-to-end verdict | `npm run check -- <o> <d> <date> <dep>` | `data/spike.db` and NRDP credentials in `.env`. |

Notes:

- **`npm test`** is the fast feedback loop. The engine is a pure function:
  intended journey plus actual service runs in, verdict out. Tests cover
  on-time, delayed, the multi-leg missed-connection case (both the just-under
  and just-over threshold outcomes), a flexible-ticket alternative, and a
  cancellation. Add cases by constructing service runs by hand; no network
  needed.
- **HSP responses are cached** to `data/hsp-cache/`, so re-running the same
  `check` is free and offline after the first call. Use `--no-cache` to force a
  fresh query. HSP is a shared industry service, so requests are serialised and
  rate-limited.
- Pick a **weekday at least two days in the past** for `check`, since HSP has no
  recent data.

### Testing plan for phase 4

Same layered approach:

1. Build the scan parser and predictor as **pure functions** (scan events in,
   candidate services out), unit-tested with small fixtures. No database or HSP
   needed for the logic tests.
2. Add fixtures shaped like the BE export (a handful of anonymised tickets) so
   the parser is tested against the real format.
3. Test validity against known cases: an Off-Peak ticket on a Peak service
   should be rejected with a clear reason; the same ticket on an Off-Peak
   service should pass.
4. End-to-end: run the real exported sample through predict, validity and
   cross-reference, and confirm each ticket produces an auditable line
   (predicted service, confidence, valid or invalid with reason, and
   match or mismatch against the claim).

Success for phase 4: for the sample tickets, the spike outputs a predicted
service with confidence, a validity verdict with a reason, and a match or
mismatch against the submitted claim, all auditable line by line, in the same
style as the current engine's explanation trail.

## Running it from scratch

```
npm install
cp .env.example .env        # then fill in NRDP_USERNAME and NRDP_PASSWORD
npm run download            # downloads the feeds (the timetable is large)
npm run load                # builds data/spike.db, filtered to Southeastern
npm test                    # confirm the engine passes
npm run check -- TON CST 2026-07-02 0746 --advance
```

`data/` and `.env` are git-ignored. The database and feeds are regenerable with
`npm run download` then `npm run load`.
