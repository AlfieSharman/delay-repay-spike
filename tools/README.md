# Spike tooling (Python)

Helper scripts used to turn the OTR ticketing/scan exports into the
batch-ready ticket JSON the spike consumes, and to write the verdicts back
into the review spreadsheet. These are **spike helpers**, not production code:
they use `openpyxl` and have hard-coded input paths you'll need to adapt.

Setup:

```
python3 -m venv .venv && .venv/bin/pip install openpyxl
```

## `xlsx-plus-txt-to-tickets.py`

Merges a spreadsheet of tickets (UTN, journey date, ticket type, route code,
outward/return itinerary + service UID) with a separate scan-data text file
(`===== UTN: X =====` blocks each holding the ticketing-export JSON), and
writes one `data/<dir>/<UTN>.json` per ticket. It:

- injects the **route code** (zero-padded to 5 digits) into the Ticket object;
- embeds an **Itinerary** block (outward/return legs, CRS resolved from the
  SQLite `locations` table, fare groups expanded);
- repairs JSON truncated when `UP3_DR` scans were removed (auto-closes brackets);
- matches UTNs case-insensitively and skips duplicates / "no ticket found".

Then run: `npm run batch -- data/<dir>`.

## `score-spreadsheet.py`

Reads `data/<dir>/results.json` and fills the spreadsheet's output columns
(Entitled, journey taken, delay length, compensation, and the reason where not
entitled), aggregating outward + return per ticket, and saves a `*_scored.xlsx`
copy. Maps the verdict reason codes to plain English.

## Notes

- The scan-data JSON already contains most ticket fields; only the route code
  and itinerary come from the spreadsheet. Ideally the BE export would emit
  `RouteCode` and an `Itinerary` block directly, removing the merge step.
- Earlier one-off variants (scan data embedded in the spreadsheet cell;
  outward-only itinerary) were used for the first two sample sets; this merge
  script is the current shape. Adapt column names / paths per export.
