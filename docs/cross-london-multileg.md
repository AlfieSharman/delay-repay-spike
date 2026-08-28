# Cross-London multi-leg journeys: build vs Odyssey

An options note for whoever takes the spike forward. It covers assessing a
Delay Repay claim for a journey that starts on Southeastern, crosses London, and
continues to a destination **beyond the London interchange** on another
operator's service - e.g. Gravesend -> St Pancras (SE) -> Blackfriars
(Thameslink). This is a recurring shape, not a one-off, so it is worth a
deliberate decision rather than incremental patching.

## The problem

A "London Terminals" ticket (NLC `1072`) hides which terminal the customer was
actually travelling to, and on a cross-London journey the customer:

- boards on SE, taps **out** of one gateline at the interchange, taps **in** at
  the adjacent gateline, and continues on a **different operator** (Thameslink,
  Southern, Elizabeth line, ...);
- often has **no gate scan at the true destination** (it may be ungated, or the
  onward operator's platforms aren't gated separately);
- has a delay that is only visible **at the true destination**, past the
  interchange.

The batch today mis-handles this: it resolves the destination to the
**interchange** (where the outward exit scan is) and assesses only the first
leg. For the worked example (`TRBYW25Q8FL`) it returned "0m NOT_DELAYED".

## What we found on the worked example

`TRBYW25Q8FL` (Gravesend -> Blackfriars via a St Pancras change) was approved by
the live system at band **60-119**. Once the Thameslink timetable was loaded and
the full journey could be modelled, the data showed the customer reached St
Pancras by 06:52 (exit tap) and caught an **on-time** Thameslink to Blackfriars
(HSP: 07:07 vs 07:06), arriving **~9 minutes late** against the 06:58 itinerary
- **not 60-119**. So:

- The **60-119 award was over-generous** (consistent with the standing caution
  that the live approve/reject outcomes are unreliable).
- **No honest model can reproduce 60-119** - the delay simply isn't in the data.
  A correct model lands ~9-16 min; even a naive best-achievable model lands
  ~34 min (30-59).

The point of a cross-London build is therefore **not** to match the live award,
but to produce the *correct* (small, in this case) verdict automatically and so
**surface over-payments** like this one.

## What is already in place

The foundation is mostly built, which is why this is a days-scale piece:

- **Timetable coverage for the onward legs.** `KEEP_ATOC`
  (`src/parse/timetable.ts`) loads SE plus the operators that connect with SE
  across London - TL, SN, XR, GX, GN. Fares stay SE-only. Re-run `npm run load`
  after changing the set.
- **The eligibility engine already chains multi-leg journeys** - interchanges,
  missed connections, and delay measured only at the final destination
  (`src/eligibility/engine.ts`).
- **The provider already does interchange discovery** (`walkUpItineraries`) and
  can pin legs from an itinerary (`itineraryActuals`); the **HSP client** gives
  national actual times.
- The two signals needed are **present in the data**: the true destination from
  a **return coupon's origin scan**, and the interchange from an
  **exit-then-reentry at the same station**.

So the remaining work is wiring and robustness, not building from scratch.

## Remaining work (either path needs the inputs; the planning differs)

| Piece | What | Rough effort |
| --- | --- | --- |
| Destination resolution | Infer the true terminal: return-origin scan -> outward destination; prefer a destination gate scan; else the itinerary. Returns resolve cleanly; a **single** with an ungated destination can't be pinned without an explicit itinerary. | ~0.5-1 day |
| Interchange detection | Treat exit-then-reentry at the same station as a change; use the interchange arrival from the scans. | ~0.5 day |
| Multi-leg assembly + delay | Build board->interchange->destination, fetch actuals per leg, chain, measure at the true destination against the intended arrival. | ~1-2 days |
| Validation | Test against a set of real cross-London claims (and Odyssey where available). | ~1 day |

Estimates are **soft** - multi-leg reconstruction is edge-case-heavy (which
interchange, which onward service, ungated ends, disruption).

## Option A - build it in-house

Do the multi-leg assembly ourselves, reusing the engine, the loaded timetable,
and HSP.

- **Effort:** ~3-5 focused days.
- **Pros:** no runtime dependency; reuses everything already built; full control.
- **Cons:** we are reproducing journey-planner logic, which is fiddly and
  never quite complete at the edges; ongoing maintenance as the network changes.

## Option B - call Odyssey

Odyssey is a maintained journey planner that already reconstructs multi-leg
journeys natively. There is existing Odyssey experience and a `jp-to-odyssey`
helper. This is the case the routeing notes flagged as "the clearest case for
calling Odyssey rather than reproducing it".

- **Effort:** ~2-3 days - build a client, map ticket + scans to an Odyssey query,
  parse the journey back.
- **Pros:** offloads the hard planning to something maintained and more robust at
  the edges; it is already our validation oracle, so results stay consistent.
- **Cons:** a runtime dependency - latency, availability and per-call cost;
  interactively-authenticated in some environments (headless/cron caveats).

## Recommendation

The deciding factor is **how much cross-London volume is expected**:

- **A handful of claims:** build in-house (Option A). It reuses everything and
  avoids a new dependency.
- **A material, ongoing slice:** lean Odyssey (Option B). Less code to own, more
  robust, roughly the same or less effort, and consistent with the oracle we
  already trust.

Either way it is **days, not weeks**, because the engine, the loaded timetable
and the required signals are all in place. Defer the build until the volume is
known; in the meantime the tool correctly assesses the SE portion and the
loaded timetable already lets the full journey be inspected by hand
(`npm run check -- <o> <d> <date> <dep> --via <interchange>`).
