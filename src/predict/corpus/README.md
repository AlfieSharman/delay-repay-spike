# Regression corpus

Real claims whose verdicts were verified by hand against HSP, kept as the
exact inputs to `assessCoupon` so `npm test` can replay them with no database
and no credentials (`corpus.test.ts`). Each fixture holds the HSP-derived
candidates, the scan constraints and the flags for one coupon, plus the
verdict fields it must reproduce. Explanation text is not asserted.

The fixtures carry the UTN, CRS codes, times, `train_info` and HSP RIDs only:
no scan ids, devices or coordinates.

## Adding a claim

Only record a claim once its verdict has been checked against HSP by hand
(the tool's output is not its own oracle). Then:

```
npm run batch -- <dir with the claim's JSON> --record src/predict/corpus
```

and add a row below saying what the claim proves and why the verdict is
right. If a model change legitimately changes a verdict, re-record the
fixture and update the row: the corpus documents the current *verified* truth,
not the first answer.

## What each claim proves

All from the 28 Sep 2026 test set (journeys on 18 to 24 Aug 2026).

| Fixture | Verdict | What it proves |
| --- | --- | --- |
| `TRB23VDJ7J2-Single` | YES, 36 min, 30-59, £2.48, CONFIRMED | Fully gated two-leg journey. The 17:10 Canterbury East -> Dover ran 16 late, the 17:48 Dover -> Folkestone was missed (ready 18:00), the 18:24 arrived 18:34 against an intended 17:58. The 18:35 exit tap corroborates. |
| `TRB26SQNNGT-Single` | no, 14 min, CONFIRMED (below threshold) | Clip pinning on a through service where the destination is an intermediate stop: clipped on the 16:45 Charing Cross -> Hastings (SE2102), alighted Tonbridge. Its own delay there, 17:43 vs 17:29. The booked Kent House itinerary ran on time but was not what they rode. |
| `TRB2VTTTNVR-Outward` | no, 0 min, INFERRED | Boarded downstream of the ticket origin (Strood, not Chatham) on the booked 07:32 (clip 2T14), exit Tunbridge Wells 08:44 vs 08:43. Itinerary fallback. |
| `TRB2VTTTNVR-Return` | YES, 96 min, 60-119, £11.15, INFERRED | Return with no itinerary: outward reversed for structure, times from its own scans. Tonbridge -> Strood has no direct evening train, so a change was inserted from the timetable at Paddock Wood. At Strood the 19:02, 19:07, 19:28, 19:32 and 19:58 to Chatham were all cancelled (HSP reason 832); first running train 20:58, arriving 21:11 vs intended 19:35. The 19:54 (arrival 20:39, departure blank) is treated as unboardable; if catchable the delay is 64, same band. |
| `TRB2VYL3Q3H-Outward` | YES, 115 min, 60-119, £45.70, PROBABLE | Cross-London missed connection. The 13:30 Hastings -> Charing Cross ran 27 late into London; the 15:35 Waterloo East exit tap proves the booked 15:20 Waterloo -> Honiton had gone. The only later Honiton train, the 17:23, arrived 20:37 vs 18:42. (HSP has no Waterloo East arrival for the 13:30, so the first leg narrates the 13:50; verdict unaffected.) |
| `TRB2VYL3Q3H-Return` | no, 2 min, INFERRED | Open return travelled three days later (24 Aug), on its own date. 10:31 Honiton -> Waterloo (clip-anchored, exit 13:54 corroborates), a five-hour break of journey, then the tap-in at Waterloo East 19:06 floors the onward leg: the 19:18 to Hastings, 20:55 vs 20:53. |
| `TRB2YWZBWVY-Single` | YES, 17 min, 15-29, £4.24, INFERRED | Cancellation baseline. Clipped on the 17:45 Cannon Street -> Hastings (SE2195), cancelled before Robertsbridge (reason 574); finished on the 17:54, 19:13 vs the intended 18:56, not vs the replacement's own 19:05. |

## Known limits of the replay

- `resolveRouteingPoints` is a function and is not recorded, so route-code
  via / not-via checks replay at raw CRS level rather than routeing-group
  level. None of these claims turned on that.
- The fixtures capture the assessment inputs, not the discovery that produced
  them (`provider.ts`: itinerary windows, structured returns, inserted changes,
  clip services). A regression there would not be caught here; re-running the
  batch on the source claims and comparing is the end-to-end check.
