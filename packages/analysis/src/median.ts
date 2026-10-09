/**
 * The median -- one rule in one place, which is the whole of what this module is for.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN EACH CALLER. The rule was written three times --
 * `association.ts`'s `nullFrom`, `cluster.ts`'s `permutationNull`, `changepoint.ts`'s `segmentOf` --
 * and in two conventions. `nullFrom` took its median as the `at(0.5)` quantile, which on an even
 * count is the UPPER of the two middle values; the other two averaged them. Both were returned
 * under the name `median`, both were shuffled nulls built the same way, and a report reads them
 * side by side, where two different numbers under one name is indistinguishable from a bug in
 * either. Bug-hunt F1 found it, and the divergence it measured on a real permutation null was
 * 0.11705625295804874 against 0.11704712354972514 -- the fourth decimal, which is exactly the size
 * of difference a reader would put down to a seed.
 *
 * The convention was aligned at `association.ts` when F1 was fixed. Aligning it did not remove the
 * duplication, and the duplication is what let the two drift apart in the first place -- the same
 * argument `random.ts` makes for holding this package's only generator: *one store, one notion of a
 * seed*. This is that argument one level down. Three copies of a two-line rule is also one more
 * than the p-value correction the three call sites share, whose own docblock says the shared
 * correction is the thing that keeps the two nulls comparable.
 *
 * WHAT IT DELIBERATELY IS NOT -- a sorting contract. It sorts a COPY rather than requiring a
 * pre-sorted array, because a precondition is the one thing a call site can violate silently:
 * handed an unsorted array, a sorting-free `medianOf` returns a plausible number that is not the
 * median, and nothing about the call looks wrong. Two of the three call sites already hold a sorted
 * array and pay one redundant sort of at most `iterations` values -- that is the price of a rule
 * that cannot be wrong at a call site. The caller's array is left untouched, which `association.ts`
 * needs: it sorts its own and goes on using it for `p95`, `max` and the p-value.
 *
 * THE EMPTY ARRAY ANSWERS ZERO, stated rather than left to whichever slice arithmetic got there.
 * No call site reaches it -- `segmentOf` is only ever handed an interior split, because `describe`
 * reads `points[index + 1]` on the line above the slice that would empty it, and both permutation
 * nulls hold `iterations >= 1` values. A shared helper is public, so the branch has an answer even
 * where nothing can currently ask the question.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`).
 */

/** The median of `values`, by the averaging convention for an even count. Sorts a copy. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
