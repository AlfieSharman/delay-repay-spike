/**
 * Compensation amount from a delay band. The band percentage applies to the
 * ticket price; returns pay against the whole return fare, hence the halved
 * percentages already encoded in COMPENSATION_BANDS.
 */

import { COMPENSATION_BANDS, type FareType } from '../eligibility/journey.js';

/** Pence owed for a band label and fare type against a ticket price in pence. */
export function compensationPence(band: string | null, fareType: FareType, pricePence: number): number {
  if (!band) return 0;
  const definition = COMPENSATION_BANDS.find((b) => b.label === band);
  if (!definition) return 0;
  const percentage = fareType === 'return' ? definition.returnPercentage : definition.singlePercentage;
  return Math.round((pricePence * percentage) / 100);
}
