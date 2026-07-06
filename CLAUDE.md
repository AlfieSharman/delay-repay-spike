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
3. **HSP client + eligibility logic** (next) - pull actual/planned times from the
   Historic Service Performance API, compare against the timetable, and work out
   delay-repay eligibility and compensation amount using the fares data.

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
  everything (train doesn't run), O or N beat P. See `resolveStp` in
  `src/query.ts` - this logic will need to move into the eligibility checker in
  phase 3, since it decides whether a service ran at all on a given day.
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
| `npm run typecheck` | `tsc --noEmit`. |

Run `npm run download` before `npm run load` - the parsers read from `data/`.
