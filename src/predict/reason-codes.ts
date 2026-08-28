/**
 * Scan reason-code dictionary.
 *
 * A rejected gateline / on-train scan carries a `reason_code` from the
 * ticketing system saying why it was rejected. This is the single place that
 * maps a code to a human meaning and an action:
 *
 *   - 'invalid-travel': strong evidence the ticket was not valid on the service
 *     travelled. Contributes to a NOT-entitled verdict.
 *   - 'review': surface as an anomaly for a human to check, but never
 *     auto-reject on it alone.
 *
 * Conservative by design (see docs/service-prediction.md, Step 7): a code is
 * only 'invalid-travel' where its meaning is confirmed. Everything unconfirmed,
 * and every unknown code, is 'review', so the tool never invents a rejection
 * from a code it cannot vouch for.
 *
 * `confirmed` records whether the meaning and action are authoritative (from
 * the ticketing team's code list) or our current best inference. The meanings
 * marked `confirmed: false` are inferred from the mnemonic and the samples and
 * need confirming; until then they stay 'review'. Add codes and flip
 * `confirmed`/`action` here as the authoritative list arrives.
 */

export type ReasonAction = 'invalid-travel' | 'review';

export interface ReasonCodeInfo {
  readonly code: string;
  readonly meaning: string;
  readonly action: ReasonAction;
  /** True once confirmed against the ticketing team's authoritative list. */
  readonly confirmed: boolean;
}

/**
 * Known reason codes. The confirmed entries (INCTIM, LOCDIR) are backed by the
 * design doc and the worked reference tickets; the rest are inferred from the
 * mnemonic and the sample exports (data/dr-spike-*) and default to 'review'.
 */
const REASON_CODES: Readonly<Record<string, ReasonCodeInfo>> = {
  INCTIM: { code: 'INCTIM', meaning: 'Invalid time: ticket presented outside its valid time band', action: 'invalid-travel', confirmed: true },
  LOCDIR: { code: 'LOCDIR', meaning: 'Wrong direction for the ticket', action: 'review', confirmed: true },

  LOCORG: { code: 'LOCORG', meaning: 'Scanned at a station that is not the ticket origin', action: 'review', confirmed: false },
  LOCDST: { code: 'LOCDST', meaning: 'Scanned at a station that is not the ticket destination', action: 'review', confirmed: false },
  LOCSTN: { code: 'LOCSTN', meaning: 'Scanned at a station not on the ticket route', action: 'review', confirmed: false },
  EXPDTE: { code: 'EXPDTE', meaning: 'Ticket expired (travel date after its validity)', action: 'review', confirmed: false },
  BADDTE: { code: 'BADDTE', meaning: 'Invalid or unreadable travel date', action: 'review', confirmed: false },
  FUTURE: { code: 'FUTURE', meaning: 'Ticket not yet valid (future dated)', action: 'review', confirmed: false },
  CPNRPL: { code: 'CPNRPL', meaning: 'Coupon replaced / re-issued', action: 'review', confirmed: false },
  DNYLST: { code: 'DNYLST', meaning: 'Ticket or media on a deny (block) list', action: 'review', confirmed: false },
  BADBCD: { code: 'BADBCD', meaning: 'Bad or unreadable barcode', action: 'review', confirmed: false },
  ERRDEV: { code: 'ERRDEV', meaning: 'Device error at scan', action: 'review', confirmed: false },
  ERROPR: { code: 'ERROPR', meaning: 'Operator error at scan', action: 'review', confirmed: false },
};

/**
 * Look up a reason code. An unrecognised code is returned as 'review' and
 * unconfirmed, so it is surfaced for a human rather than driving a rejection.
 */
export function lookupReasonCode(code: string): ReasonCodeInfo {
  return REASON_CODES[code] ?? { code, meaning: 'Unrecognised reason code', action: 'review', confirmed: false };
}

/** True if the code is confirmed evidence of invalid travel (drives a reject). */
export function isInvalidTravelCode(code: string): boolean {
  return lookupReasonCode(code).action === 'invalid-travel';
}
