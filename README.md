# delay-repay-spike

A spike for a Proactive Delay Repay feature. This first phase handles **data ingestion only**: it downloads the UK rail static data feeds from the [National Rail Data Portal](https://opendata.nationalrail.co.uk/) (NRDP) and unzips them to disk.

There is deliberately **no parsing and no database** yet. Those come in later phases. This code exists to prove we can authenticate, pull all three feeds reliably, and see what the raw records look like.

## What it downloads

Three static feeds, each delivered as a ZIP archive:

| Feed      | Endpoint                                                        | Extracted to     |
| --------- | -------------------------------------------------------------- | ---------------- |
| Fares     | `/api/staticfeeds/2.0/fares`                                   | `data/fares/`    |
| Routeing  | `/api/staticfeeds/2.0/routeing`                                | `data/routeing/` |
| Timetable | `/api/staticfeeds/3.0/timetable`                               | `data/timetable/`|

Raw ZIPs are kept, date-stamped, under `data/zips/` (e.g. `fares-2026-07-02.zip`).

## Requirements

- Node 22+
- An NRDP account ([register here](https://opendata.nationalrail.co.uk/))

## Setup

Install dependencies:

```bash
npm install
```

Create your credentials file from the template and fill it in:

```bash
cp .env.example .env
```

```ini
# .env
NRDP_USERNAME=your-nrdp-email
NRDP_PASSWORD=your-nrdp-password
```

`.env` is git-ignored and must never be committed. So is the `data/` directory.

## Commands

### `npm run download`

Runs the full ingestion in sequence:

1. **Authenticate** with the NRDP using the credentials in `.env`. This returns a short-lived token which is fetched fresh on every run and never cached or written to disk.
2. **Download** each feed as a ZIP using that token, streaming straight to disk (the timetable feed is hundreds of MB uncompressed, so it is never buffered in memory).
3. **Unzip** each archive into its own directory under `data/`.

Progress is logged at each step, including the size of each downloaded file.

**Conditional downloads:** the `Last-Modified` header for each feed is recorded in `data/last-modified.json`. On the next run the script sends `If-Modified-Since`; if the server responds `304 Not Modified` the download is skipped and the feed is reported as unchanged.

If authentication fails (non-200 response or a missing token), the script prints a clear error pointing at your `.env` credentials and exits non-zero.

### `npm run inspect`

Prints a summary of what was downloaded: every file in each feed directory with its size, and the first 5 lines of each text file so you can see the record formats at a glance. Binary files are listed but not previewed.

### `npm run typecheck`

Type-checks the project with `tsc --noEmit`.

## Project layout

```
src/ingest/
  download.ts   # authenticate -> download -> unzip
  inspect.ts    # summarise the downloaded files
data/           # git-ignored; created on first download
  zips/         # date-stamped raw ZIP archives
  fares/        # extracted feed contents
  routeing/
  timetable/
  last-modified.json
```

## Notes for the next phase

- No record parsing exists yet. `inspect.ts` is intended to help design the parsers by exposing the raw formats.
- Data lives on disk only. A store/database is a later decision.
