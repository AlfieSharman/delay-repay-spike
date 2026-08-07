# Service Prediction: How to Determine Which Service a Customer Travelled On

A specification of the logic for predicting the actual service(s) a customer
travelled on, from their ticket, itinerary and scan data. Written to be
implemented in the backend. Every rule here was derived from and tested
against real ticket examples (referenced throughout as T1 to T5, described at
the end).

## Inputs

| Input | What it provides |
| --- | --- |
| Ticket | Origin NLC, destination NLC, ticket type (FTOT), route code, `TimeValidFrom`, `StartDate`, coupon structure (Single / Outward+Return) |
| Itinerary (if held) | The booked or intended legs: services, scheduled departure and arrival per leg |
| Scan data | Timestamped events: gateline entry/exit, on-train validations, administrative events |
| Timetable | Scheduled services and calling points (CIF data, STP-resolved for the travel date) |
| HSP | Actual departure/arrival times per service run, cancellations |

## Reference data required

- **NLC to CRS mapping.** Scan `STATION` fields are NLCs, not CRS codes
  (e.g. 5191 = Strood, 1555 = St Pancras). HSP and the timetable work in CRS.
- **Fare group expansion.** A ticket destination like NLC 1072 ("LONDON
  TERMINALS") is a group, not a station. Expand it to the set of member
  stations (Cannon Street, Charing Cross, Victoria, St Pancras SE side, etc.).
  The scan data then tells you which terminus was actually used: in T5 the
  ticket said 1072 but the exit tap at 5142 pinned it to Cannon Street.
- **Timetable topology.** Needed to know whether a direct service exists at
  all, and where interchanges happen (T5: the Medway Valley line terminates at
  Paddock Wood, so any London journey from East Farleigh must change there).

## Step 1: Normalise and classify the scans

Discard nothing yet; classify each scan into one of four types:

1. **Gateline scans** (`scan_mode` = `entry` or `exit`, station device like
   `LBS <CRS>`). These are location + time facts: the customer was physically
   at that station at that time, entering or leaving the system.
2. **On-train validations** (`scan_mode` = `clip`, handheld/on-board device,
   usually with `train_info` populated). These potentially name the exact
   service.
3. **Administrative events** (no station, devices like `UP3_DR`, actions like
   "DR Approved"). Not travel evidence. Exclude from prediction, but keep for
   cross-referencing the claim outcome.
4. **Rejected scans** (`action_text` = "Rejected", or a `reason_code` such as
   `LOCDIR` or `INCTIM`). Do NOT use as location/direction evidence, but
   surface them as anomaly flags (see Step 7). A rejected scan often means the
   ticket was presented somewhere it should not have been.

Convert scan `STATION` NLCs to CRS. Keep timestamps timezone-aware.

## Step 2: Split scans into journeys

Group scans by `coupon_type`:

- `Single` = one journey.
- `Outward` and `Return` = two independent journeys, predicted separately
  (T1: outward Strood to St Pancras, return St Pancras to Strood; T3: both
  directions Robertsbridge to Charing Cross).

Within each group, order scans by time. The expected shape is
`entry -> [on-train validations] -> exit`, but any element can be missing.

## Step 3: Extract the hard constraints

From the classified scans, derive constraints that any candidate service (or
service chain) must satisfy. All comparisons use HSP **actual** times, not
scheduled times: a customer who taps in at 17:21 can still catch the 17:17
scheduled service if it actually left at 17:25.

- **Entry tap at station X at time T_in**: the first service boarded must
  actually depart X at or after T_in. Allow a boarding window: a departure
  more than ~45 minutes after T_in is suspicious (lower confidence, they may
  have waited or the data is incomplete).
- **Exit tap at station Y at time T_out**: the last service must actually
  arrive at Y before T_out, and plausibly close to it. Working buffer:
  arrival within 15 minutes before T_out (T1: arrived 18:25, tapped out
  18:27; T5: arrived 08:49, tapped out 08:52). If the closest arrival is much
  earlier than T_out, confidence drops but the constraint still holds.
- **Accepted on-train validation with `train_info`**: a direct service
  identifier (RSID / headcode, e.g. `1H80/SE2280` in T3). This is the
  strongest single signal. BUT it must be sanity-checked before pinning:
  - The named service's direction and calling pattern must be consistent
    with the journey. In T2 the on-board device named a Ramsgate TO St
    Pancras working while the customer was travelling St Pancras TO
    Whitstable: HS1 units turn around quickly, so a validator can still be
    advertising the previous working. An inconsistent `train_info` is an
    anomaly flag, not evidence.
  - Corroborate with the scan's own timestamp: the customer should have
    been on that train at that moment per HSP actual times.

## Step 4: Build the candidate set (ticket type decides the search space)

This is where ticket type, route code and itinerary come in. The customer may
NOT have travelled their itinerary, so the itinerary seeds the search but
never limits it on a walk-up ticket.

**Advance (fixed itinerary, e.g. FTOT L14):**
- Primary candidate: the booked service(s) from the itinerary.
- Fallback candidates: if a booked leg was cancelled or a connection missed,
  the next valid service(s) for the remaining legs (same rule as the
  eligibility engine).
- Anything else the scans show them on is a validity anomaly, not a
  legitimate candidate (T4: Advance valid from 07:49, but the customer gated
  in at 07:23 and rode an earlier peak train, confirmed by an `INCTIM`
  rejection. Predict the ridden service if the evidence supports it, but flag
  the claim: entitlement is assessed against the BOOKED service, which ran on
  time).

**Walk-up tickets (Anytime / Off-Peak / Super Off-Peak):**
- Candidates: every service (or service chain) from the ticket origin to the
  ticket destination on the travel date that is
  1. permitted by the route code (e.g. "HS1 only", "not via HS1" - route
     codes change which paths are legal), and
  2. permitted by the ticket's time restrictions (Off-Peak/Super Off-Peak
     restriction codes; requires the RST restriction data),
  filtered to the plausible time window from the scans.
- The itinerary (if any) is a tie-breaker, not a filter.

**Both cases:** honour `StartDate` + `NumberOfDaysValid` and
`TimeValidFrom`. A scan before `TimeValidFrom` is an anomaly flag (T4).

## Step 5: Multi-leg resolution

Try single-service candidates first: query HSP for direct services on the
origin-to-destination flow within the window. If a direct service satisfies
all constraints, prefer it.

If no direct service exists in the timetable, or none fits the constraints,
the journey involves at least one change:

1. **Find the interchange(s) from the timetable**, not by guessing: take the
   services departing the origin in the window and see where they terminate
   or where the itinerary changes legs. In T5 the 07:03 from East Farleigh
   terminates at Paddock Wood at 07:20, which makes Paddock Wood the
   interchange by necessity.
2. **Leg 1 candidates:** services from the origin whose actual departure
   satisfies the entry-tap constraint.
3. **Connections:** for each leg-1 candidate arriving at the interchange at
   actual time A, onward candidates are services whose **actual** departure
   is **strictly after A + minimum interchange time** (default 5 minutes).
   Strictly: being ready at the exact departure minute counts as missed.
   This matches the eligibility engine.
4. **Cancelled connections:** a service with no actual arrival at the
   relevant station was cancelled. It cannot be ridden, but record it: "the
   intended 07:37 connection was cancelled" is central to both the
   prediction narrative and the delay assessment (T5).
5. **Final leg:** must satisfy the exit-tap constraint at the destination.
6. Chain the legs and score the complete path.

Depth: one interchange covers the overwhelming majority of SE journeys.
Support two; beyond that, require itinerary guidance.

## Step 6: Score and assign confidence

If more than one candidate survives the constraints, rank by:

1. Named by a consistent, accepted `train_info` scan (T3).
2. Tightest fit to the exit tap (actual arrival closest before T_out).
3. Matches the itinerary / booked service.
4. Earliest departure after the entry tap (customers overwhelmingly take the
   first valid train).

Confidence tiers to attach to the output:

- **CONFIRMED**: two or more independent signals agree (gateline bracket both
  ends, or gate + consistent train_info). T1, T3, T5.
- **PROBABLE**: one strong signal, others absent but nothing contradicts
  (entry tap only, unique candidate in window).
- **INFERRED**: single scan or no scan on a leg; prediction leans on the
  itinerary or on "first valid service" assumption. Say so in the output. T2.
- **UNKNOWN**: no candidate satisfies the constraints, or contradictory
  evidence. Do not guess; emit the contradiction.

### Single-scan journeys (ungated stations)

This is common on SE and must not be treated as an error:

- **Origin tap only** (ungated destination, e.g. Whitstable in T2): anchor on
  the entry time. Candidates are services actually departing after T_in;
  default prediction is the first valid one. Confidence at most PROBABLE,
  and INFERRED if several plausible candidates leave close together.
- **Destination tap only** (ungated origin, e.g. East Farleigh in T5): work
  backwards from the exit tap. Find services (or chains) whose actual arrival
  falls just before T_out, then check each is reachable from the origin
  (including connections). Corroborate with the itinerary. T5 reached
  CONFIRMED despite one scan because the cancelled intended connection plus
  the 08:49 arrival against an 08:52 exit left exactly one consistent story.
- **On-train scan only**: the train_info names the service directly; verify
  direction and time consistency, then treat as PROBABLE.

## Step 7: Anomaly flags (emit alongside the prediction, never silently drop)

- Rejected scan with `LOCDIR` (wrong location/direction, T2) or `INCTIM`
  (invalid time, T4). Reason codes are mapped in `src/predict/reason-codes.ts`:
  each code has a meaning and an action of `invalid-travel` (drives a
  rejection) or `review` (flag only). It is conservative on purpose: only
  codes confirmed to mean invalid travel reject, so only `INCTIM` does today.
  Unconfirmed and unknown codes are `review`. Fill in the authoritative meaning
  and action per code once the ticketing team supplies the full list, flipping
  `confirmed`/`action` in that file.
- Travel before `TimeValidFrom` or outside the validity dates.
- Advance ticket evidence inconsistent with the booked service (T4).
- `train_info` inconsistent with journey direction (T2).
- No candidate satisfying all constraints.
- Prediction contradicts the service the Delay Repay claim was made against.

The principle agreed for this project: where evidence is thin or
contradictory, **flag for human review rather than auto-reject**.

## Step 8: Hand off to delay assessment

Once the actual journey is pinned, delay is assessed by the existing
eligibility engine rules:

- Delay = actual arrival at the **final destination** minus the **intended**
  scheduled arrival there. Never at intermediate points.
- "Intended" for Advance = the booked itinerary. For walk-up = the journey
  they set out to make (in practice: the service implied by their entry tap,
  or the claimed journey, whichever the use case dictates; T5 used the
  intended 08:31 arrival of the cancelled connection).
- Cancellation shows up in HSP as an empty `actual_ta` at the destination.
  There is no explicit cancelled flag; `late_canc_reason` is a delay OR
  cancellation reason and is not reliable on its own.

## Data gotchas (all observed in the real samples)

- Scan `STATION` is an **NLC**; convert before touching HSP or the timetable.
- Scan timestamps carry a timezone offset (`+01:00` in summer); HSP times are
  local wall-clock HHMM strings. Normalise carefully around BST/GMT.
- HSP has **no data for today or yesterday**, and covers roughly two years
  back. Predictions for the most recent two days must wait for actuals.
- HSP times are whole minutes. A delay computed as exactly 15 sits on the
  eligibility threshold (T1 was exactly 15); avoid any rounding that could
  move a claim across a band boundary.
- Gateline device codes embed the station (`LBS5191`), which is a useful
  cross-check on the STATION field.
- The same physical train can carry stale `train_info` from its previous
  working (T2). Never pin from train_info alone without a direction check.
- Overnight (past-midnight) journeys are not handled by the current engine
  and need explicit design in the backend.

## The five reference tickets

| | Route | Ticket | Scans available | Outcome | What it proved |
| --- | --- | --- | --- | --- | --- |
| T1 | Strood to St Pancras | Super Off-Peak Return | Gate in + gate out | 17:35 service, 15 min late, eligible | Gateline bracket uniquely identifies a service |
| T2 | St Pancras to Whitstable | Super Off-Peak Day Single | Gate in only + rejected on-train scan | 18:25 service, 21 late, eligible but flagged | Ungated destination; stale train_info; LOCDIR anomaly |
| T3 | Robertsbridge to Charing Cross return | Super Off-Peak Return | Gates + accepted train_info both legs | Both legs on time; claim approved with no basis: flag | train_info + gate corroboration = highest confidence |
| T4 | Chatham to Victoria | Advance | Gate in + rejected on-train + gate out | Rode earlier non-booked train; booked service on time; not entitled | Validity check is inseparable from prediction |
| T5 | East Farleigh to Cannon Street | Anytime Day Single | Gate out only | Change at Paddock Wood; intended connection cancelled; 18 late, eligible | Multi-leg reconstruction from a single scan |

## Pseudocode sketch

```
predictJourney(ticket, itinerary, scans, date):
  journeysByCoupon = groupScans(normalise(scans))
  results = []
  for (coupon, scanSet) in journeysByCoupon:
    constraints = extractConstraints(scanSet)        # Step 3
    candidates  = buildCandidates(ticket, itinerary, # Step 4
                                  constraints.window, date)
    if none satisfy constraints:
      candidates = multiLegSearch(ticket, constraints, date)  # Step 5
    ranked = score(candidates, constraints, itinerary)        # Step 6
    results.push({
      coupon,
      prediction: ranked[0] or null,
      confidence: tier(ranked, constraints),
      anomalies:  collectFlags(scanSet, ticket, ranked[0]),   # Step 7
    })
  return results
```
