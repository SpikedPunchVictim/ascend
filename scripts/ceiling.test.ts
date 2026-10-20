import { describe, expect, it } from 'vitest';
import { ROUTE_MEAN_USD, projectedNext, wouldCross } from '../spike/ceiling.mjs';

/**
 * The EV-16 harness's spend ceiling, as the decision it now is (`asc-kzvi`).
 *
 * **The defect these pin is an ordering one, and it cost a pre-registered denominator.** The
 * harness tested what had ALREADY been spent against the ceiling, so with `EV16_MAX_USD=3` EV-30
 * reached $3.2169 -- the line was crossed, not held -- and arm G's third repetition never ran,
 * leaving n=2 against a pre-registered n=3. The question has to be asked BEFORE the next session:
 * would one more, at what this route has cost so far, cross?
 *
 * **The fallback is a measured number, not a guess.** With no sessions there is nothing to average,
 * and the inherited ~$0.14/session came from claude-haiku on a first-party route; EV-30 measured
 * $0.4508-$0.82172 (mean $0.64339, n=5) on the GLM gateway route this harness uses. Sizing the
 * ceiling with the cheaper figure is how a ceiling gets crossed.
 */

describe('projectedNext()', () => {
  it('uses the route mean when nothing has been observed, because the inherited figure is 4.6x low', () => {
    expect(projectedNext([])).toBe(ROUTE_MEAN_USD);
    expect(ROUTE_MEAN_USD).toBeCloseTo(0.64339, 5);
  });

  it('averages what this route has actually cost', () => {
    // EV-30's measured session costs, which is the data the fallback came from.
    expect(projectedNext([0.4508, 0.82172, 0.64339, 0.6, 0.7021])).toBeCloseTo(0.643602, 5);
  });

  it('excludes a failed session rather than letting its zero pull the projection down', () => {
    // A session that produced no billable envelope costs 0 in the record; averaging that in would
    // make the ceiling believe the next session is cheaper than the route has ever been.
    expect(projectedNext([0, 0.8])).toBeCloseTo(0.8, 6);
    expect(projectedNext([Number.NaN, 0.6])).toBeCloseTo(0.6, 6);
  });
});

describe('wouldCross()', () => {
  it('refuses a session that would take the run PAST the ceiling', () => {
    expect(wouldCross(2.5, 0.64, 3)).toBe(true);
  });

  it('allows one that lands exactly on it, because the ceiling is a maximum to use', () => {
    // Strictly greater on purpose: a run stopped short of an explicit maximum has not used what it
    // was given. The operands are exact in binary so the boundary case is the boundary, not float
    // noise -- which is why this reads 2.5 + 0.5 and not 2.36 + 0.64.
    expect(wouldCross(2.5, 0.5, 3)).toBe(false);
  });
});
