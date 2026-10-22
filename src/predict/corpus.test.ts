/**
 * Regression corpus: real claims whose verdicts were verified by hand against
 * HSP, captured as the exact inputs to assessCoupon so the replay is pure and
 * offline (no database, no credentials). Each fixture in ./corpus/ was written
 * by `npm run batch -- <claims dir> --record src/predict/corpus`; the README
 * there records what each one proves and why its verdict is right.
 *
 * Only the verdict fields are asserted, not the explanation text, so the
 * narration can improve without churning the corpus.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessCoupon, type AssessCouponInput } from './assess.js';

interface Fixture {
  readonly utn: string;
  readonly coupon: string;
  readonly input: Omit<AssessCouponInput, 'resolveRouteingPoints'>;
  readonly expected: {
    readonly entitled: boolean;
    readonly reason: string | null;
    readonly confidence: string;
    readonly delayMinutes: number | null;
    readonly band: string | null;
    readonly compensationPence: number | null;
  };
}

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus');

for (const file of readdirSync(corpusDir).filter((f) => f.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(path.join(corpusDir, file), 'utf8')) as Fixture;
  test(`corpus: ${fixture.utn} ${fixture.coupon}`, () => {
    const v = assessCoupon(fixture.input);
    assert.deepEqual(
      {
        entitled: v.entitled,
        reason: v.reason,
        confidence: v.confidence,
        delayMinutes: v.delayMinutes,
        band: v.band,
        compensationPence: v.compensationPence,
      },
      fixture.expected,
    );
  });
}
