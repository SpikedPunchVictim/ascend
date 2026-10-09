import { describe, expect, it } from 'vitest';
import { medianOf } from '../src/index.js';

/**
 * `median.ts` -- the one median rule, and the test the three scattered copies could not have.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE THREE THAT USE IT. The rule was written three times
 * (`association.ts`, `cluster.ts`, `changepoint.ts`) and in two conventions. `nullFrom` took the
 * median as its own `at(0.5)` -- the UPPER of the two middle values on an even count -- while the
 * other two averaged them. Bug-hunt F1 found it, and the measured divergence on a real
 * permutation null was 0.11705625295804874 against 0.11704712354972514: the same statistic under
 * one name, in the fourth decimal, in two modules a report reads side by side.
 *
 * No test accompanied that fix, and the reason is in the fix's own note: `nullFrom` is
 * module-private, the null statistics are unreachable from a test, and on the reachable fixture the
 * two middle order statistics are EQUAL -- so a literal written there would have pinned the fixture
 * rather than the rule. The even-count case with DISTINCT middles is the one that discriminates,
 * and it is reachable here for the first time. `[1, 2, 3, 4]` is the whole of it: 2.5 by the rule
 * this now ships, 3 by the rule `at(0.5)` would have given.
 *
 * The empty case is asserted although it is unreachable from all three call sites -- every caller
 * passes a non-empty slice or a permutation null of `iterations >= 1` values -- because a shared
 * helper is public, and an unreachable branch still has to have a stated answer.
 */

describe('medianOf', () => {
  it('takes the middle value on an odd count', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values on an even count -- the case the two conventions disagree on', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not take the upper middle on an even count, which is the convention it was extracted to end', () => {
    expect(medianOf([1, 2, 3, 4])).not.toBe(3);
  });

  it('returns the coincident value when the two middle order statistics are equal', () => {
    expect(medianOf([1, 2, 2, 3])).toBe(2);
  });

  it('sorts what it is given, so a call site cannot be wrong by forgetting to', () => {
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it('leaves the caller array untouched', () => {
    const values = [3, 1, 2];
    medianOf(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('handles a single value, where both conventions agree', () => {
    expect(medianOf([7])).toBe(7);
  });

  it('orders negative values as numbers, not as strings', () => {
    expect(medianOf([-10, -2, -1])).toBe(-2);
  });

  it('answers zero on an empty array, the branch no call site reaches', () => {
    expect(medianOf([])).toBe(0);
  });
});
