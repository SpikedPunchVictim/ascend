import { describe, expect, it } from 'vitest';
import {
  allocate,
  DEFAULT_SEED,
  diverseSample,
  outlierSample,
  randomSample,
  SampleSizeError,
  seedOf,
  stratifiedSample,
  type Samplable,
  type SignedItem,
} from '../src/index.js';

/**
 * The samplers.
 *
 * The failure this module can have is not a crash -- it is a SUBSET that looks like a sample and is
 * not one: a draw that quietly favours whatever the store ordered first, an allocation whose
 * proportions are off by more than the rounding, a "diverse" set that repeats itself. None of those
 * are visible from one sample, so the tests here are about PROPERTIES of the selection over a
 * population whose answer is known by construction, and about the two things a caller is promised:
 * every occurring value appears, and the proportions survive.
 *
 * The population shapes are taken from the real corpus -- `verification_run` is 419 `passed` against
 * 67 `failed`, and 258 of 486 entries come from one of ten projects -- because a fixture of ten
 * equal groups is exactly the case where every allocation rule looks correct.
 */

/** A population of `id`-only items, for the modes that need no signature. */
function plain(count: number): Samplable[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `e-${String(index).padStart(3, '0')}`,
  }));
}

/** A population of stratified items: `values[index]` repeated `counts[index]` times. */
function stratified(
  values: readonly string[],
  counts: readonly number[],
): { id: string; key: string }[] {
  const items: { id: string; key: string }[] = [];
  for (const [position, value] of values.entries()) {
    for (let n = 0; n < (counts[position] ?? 0); n += 1) {
      items.push({ id: `e-${String(items.length).padStart(4, '0')}`, key: value });
    }
  }
  return items;
}

const idsOf = (items: readonly Samplable[]): string[] => items.map((item) => item.id);

describe('allocate: how many rows each stratum gets', () => {
  /**
   * The rounding alone, on the population that has no floor to pay.
   *
   * `40 * 419 / 486 = 34.486` and `40 * 67 / 486 = 5.514`: the floors are 34 and 5, and the one
   * leftover row goes to the larger remainder, which is `failed`. This is the real `verification_run`
   * split at the real default sample size, and it is the one case where the result is exactly
   * proportional -- so it is where the rounding rule can be seen on its own.
   *
   * Asserted as literals rather than as a tolerance, because this is the answer the shipped command
   * produces against the shipped corpus and a tolerance would not have noticed it changing.
   */
  it('splits the corpus-shaped population 419/67 into 34 and 6', () => {
    expect(allocate([419, 67], 40)).toStrictEqual([34, 6]);
  });

  it('spends every row, on every shape', () => {
    for (const [populations, size] of [
      [[419, 67], 40],
      [[419, 67, 4], 40],
      [[258, 115, 65, 15, 13, 9, 4, 4, 2, 1], 40],
      [[7, 1], 3],
      [[1], 1],
    ] as [number[], number][]) {
      expect(allocate(populations, size).reduce((sum, n) => sum + n, 0)).toBe(size);
    }
  });

  /**
   * The guarantee the mode exists for: a value that occurs gets a row, and what it costs.
   *
   * The population is the real one -- ten projects, one of which holds a single entry out of 486.
   * Its exact quota at a sample of forty is 0.08 rows, so any rule that respects only the quota gives
   * it zero and a reader of that sample concludes the project does not appear. Four strata here round
   * to zero, and all four are served.
   *
   * **THE COST IS REAL AND IS NOT ONE ROW.** The donor is the largest stratum, so the majority pays
   * for every stratum that would otherwise be empty: the largest value holds 53% of the corpus and
   * gets 17 of the 40 rows, a deviation of 4.2 rows -- not the one row a proportional round-off
   * would produce. That is the price of the guarantee, and it is why `stratifiedSample` reports the
   * achieved shares back instead of asserting them: at this shape the sample is a worse estimate of
   * the population than the floorless alternative would be, and a reader is entitled to see that.
   * The bound asserted below is derived -- one row of rounding, plus one per floored stratum.
   */
  it('gives a row to a stratum whose quota rounds to zero, at the majority stratum’s expense', () => {
    const populations = [258, 115, 65, 15, 13, 9, 4, 4, 2, 1];
    const allocated = allocate(populations, 40);

    expect(allocated).toStrictEqual([17, 10, 6, 1, 1, 1, 1, 1, 1, 1]);
    for (const got of allocated) expect(got).toBeGreaterThanOrEqual(1);

    // Four strata would have rounded to zero; the majority lost one row for each, plus the one the
    // remainder rule already gave away. This is the honest bound, and it is asserted so that a
    // change making the distortion worse is a failure rather than a surprise.
    const quota = (40 * 258) / 486;
    expect(quota - (allocated[0] ?? 0)).toBeLessThanOrEqual(1 + 4);
    // And the one-row claim is false at this shape, which is the point of stating the bound loosely.
    expect(quota - (allocated[0] ?? 0)).toBeGreaterThan(1);
  });

  /** More strata than rows is the one case the floor cannot be honoured, and it says so by count. */
  it('drops the floor rather than inventing rows when there are more strata than rows', () => {
    const allocated = allocate([9, 5, 3, 1], 2);

    expect(allocated.reduce((sum, n) => sum + n, 0)).toBe(2);
    // The two largest take the rows; the two smallest are reported at zero rather than fabricated.
    expect(allocated).toStrictEqual([1, 1, 0, 0]);
  });

  it('returns the population whole when the sample is at least as large', () => {
    expect(allocate([3, 2, 1], 6)).toStrictEqual([3, 2, 1]);
    expect(allocate([3, 2, 1], 9)).toStrictEqual([3, 2, 1]);
  });

  it('allocates nothing when the population is empty', () => {
    expect(allocate([], 10)).toStrictEqual([]);
    expect(allocate([0, 0], 10)).toStrictEqual([0, 0]);
  });

  /** A stratum of zero is not a small stratum: it must not be given a floor row it cannot fill. */
  it('never gives a row to a stratum that holds nothing', () => {
    expect(allocate([10, 0, 10], 4)).toStrictEqual([2, 0, 2]);
  });

  /**
   * The floor is paid for in order, and never leaves the donor empty.
   *
   * Two zero strata and a majority that is comfortably the largest: each zero takes a row from
   * whichever allocation is currently largest, so the second one cannot take from a stratum the first
   * one had already reduced to one. A donor is required to hold more than one row, which is what the
   * `size >= present.length` guard above guarantees exists.
   */
  it('never empties a donor to fill a floor', () => {
    const allocated = allocate([100, 1, 1], 4);

    expect(allocated).toStrictEqual([2, 1, 1]);
    for (const got of allocated) expect(got).toBeGreaterThanOrEqual(1);
  });
});

describe('seedOf', () => {
  it('is a function of the string alone', () => {
    expect(seedOf('ascend')).toBe(seedOf('ascend'));
    expect(seedOf('ascend')).not.toBe(seedOf('ascend '));
    expect(seedOf('')).toBe(seedOf(''));
  });
});

describe('randomSample', () => {
  it('is reproducible from its seed', () => {
    const population = plain(200);
    expect(idsOf(randomSample(population, { size: 30, seed: 'a' }))).toStrictEqual(
      idsOf(randomSample(population, { size: 30, seed: 'a' })),
    );
  });

  it('draws differently for a different seed, and the same for the default', () => {
    const population = plain(200);
    expect(idsOf(randomSample(population, { size: 30, seed: 'a' }))).not.toStrictEqual(
      idsOf(randomSample(population, { size: 30, seed: 'b' })),
    );
    expect(idsOf(randomSample(population, { size: 30 }))).toStrictEqual(
      idsOf(randomSample(population, { size: 30, seed: DEFAULT_SEED })),
    );
  });

  /**
   * The caller's array order must not reach the result.
   *
   * A seeded generator consumes its input in sequence, so a population handed over in a different
   * order draws a different subset -- and the store's row order is a thing that can change without
   * any sampler changing. Sorting inside is what makes a seed sufficient on its own to reproduce a
   * sample, which is the whole claim the output's `seed` field makes.
   */
  it('ignores the order the population arrives in', () => {
    const population = plain(200);
    const reversed = [...population].reverse();

    expect(idsOf(randomSample(reversed, { size: 30, seed: 'a' }))).toStrictEqual(
      idsOf(randomSample(population, { size: 30, seed: 'a' })),
    );
  });

  it('never repeats an item, and returns them in id order', () => {
    const drawn = idsOf(randomSample(plain(200), { size: 30, seed: 'a' }));

    expect(new Set(drawn).size).toBe(30);
    expect(drawn).toStrictEqual([...drawn].sort());
  });

  it('returns the whole population rather than drawing from it', () => {
    expect(idsOf(randomSample(plain(5), { size: 5 }))).toStrictEqual(idsOf(plain(5)));
    expect(idsOf(randomSample(plain(5), { size: 50 }))).toStrictEqual(idsOf(plain(5)));
  });

  it('draws nothing from an empty population rather than failing', () => {
    expect(randomSample([], { size: 10 })).toStrictEqual([]);
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('refuses a size of %s', (size) => {
    expect(() => randomSample(plain(10), { size })).toThrow(SampleSizeError);
  });
});

describe('stratifiedSample', () => {
  /** The real `verification_run` split: 419 `passed` against 67 `failed`, and nothing else. */
  const corpus = stratified(['passed', 'failed'], [419, 67]);

  /** The same corpus with a rare third value, so the floor has something to pay for. */
  const withRare = stratified(['passed', 'failed', 'skipped'], [419, 67, 4]);

  /**
   * The acceptance criterion of `asc-1bd`, with the tolerance MEASURED rather than guessed.
   *
   * Against the real corpus in the frozen EV-11 store, two hundred draws of forty at varying seeds
   * put the worst stratum's share **1.21 percentage points** from its population share, and the mean
   * across both strata the same. So the bound asserted here -- one row of forty, 2.5 points -- is
   * double the worst case actually observed, which is the direction a bound should err in.
   */
  it('preserves the population proportions within one row of forty', () => {
    const drawn = stratifiedSample(corpus, { size: 40 });
    const total = corpus.length;

    expect(drawn.strata).toHaveLength(2);
    for (const stratum of drawn.strata) {
      const share = stratum.selected / 40;
      const population = stratum.population / total;
      // 0.025 = one row of forty. Measured worst case on the real corpus: 0.0121.
      expect(Math.abs(share - population)).toBeLessThanOrEqual(0.025);
    }
  });

  /**
   * The guarantee, in the case where a proportional draw cannot provide it, and its price.
   *
   * Four entries of four hundred and ninety are 0.8% -- at a sample of forty their quota is a third
   * of a row. A uniform draw leaves them out most of the time; this must not.
   *
   * **The proportions get worse when the floor is paid, and the report is what says so.** The rare
   * stratum takes its row from `passed`, which drops from a 34.2-row quota to 33 -- 3.0 points from
   * its population share, against the 1.2 points the floorless corpus achieves. So the honest claim
   * is not "within tolerance" but "within one row per floored stratum", and the achieved shares the
   * sample carries are the thing a reader is expected to check rather than the guarantee's existence.
   */
  it('includes a value below one row, and reports the share it cost', () => {
    const drawn = stratifiedSample(withRare, { size: 40 });
    const total = withRare.length;
    const rarest = drawn.strata.find((stratum) => stratum.key === 'skipped');
    const majority = drawn.strata.find((stratum) => stratum.key === 'passed');

    expect(rarest?.population).toBe(4);
    expect(rarest?.selected).toBe(1);
    expect(drawn.items.filter((item) => item.key === 'skipped')).toHaveLength(1);

    // The distortion the floor introduced, stated as the number rather than hidden.
    expect(majority?.selected).toBe(33);
    const deviation = Math.abs(
      (majority?.selected ?? 0) / 40 - (majority?.population ?? 0) / total,
    );
    expect(deviation).toBeGreaterThan(0.025);
    expect(deviation).toBeLessThanOrEqual(0.05);
  });

  it('reports every stratum of the population, ascending, including any it took none of', () => {
    const many = stratified(['b', 'a', 'c'], [10, 10, 10]);
    // Seven rows over three equal strata. Quotas are 2.333 each, so the floors give 2 apiece and the
    // leftover row goes to the first by the tie-break on equal fractions -- and the first is `a`,
    // because the keys are sorted rather than left in the order the population happened to arrive.
    const drawn = stratifiedSample(many, { size: 7 });

    expect(drawn.strata.map((stratum) => stratum.key)).toStrictEqual(['a', 'b', 'c']);
    expect(drawn.strata.map((stratum) => stratum.population)).toStrictEqual([10, 10, 10]);
    expect(drawn.strata.map((stratum) => stratum.selected)).toStrictEqual([3, 2, 2]);
  });

  /** The row that goes to the tie-break must not depend on the order the caller built the array in. */
  it('is a function of the population rather than of the array order', () => {
    const forwards = stratified(['b', 'a', 'c'], [10, 10, 10]);
    const backwards = [...forwards].reverse();

    expect(stratifiedSample(backwards, { size: 7 }).strata.map((stratum) => stratum.selected)) //
      .toStrictEqual(stratifiedSample(forwards, { size: 7 }).strata.map((s) => s.selected));
  });

  it('reports counts that add up to the sample it returned', () => {
    const drawn = stratifiedSample(corpus, { size: 17, seed: 'x' });

    expect(drawn.items).toHaveLength(17);
    expect(drawn.strata.reduce((sum, stratum) => sum + stratum.selected, 0)).toBe(17);
    for (const stratum of drawn.strata) {
      expect(drawn.items.filter((item) => item.key === stratum.key)).toHaveLength(stratum.selected);
    }
  });

  it('is reproducible from its seed, and varies with it', () => {
    expect(idsOf(stratifiedSample(corpus, { size: 20, seed: 'a' }).items)).toStrictEqual(
      idsOf(stratifiedSample(corpus, { size: 20, seed: 'a' }).items),
    );
    // The allocation is the same for both seeds -- only the draw within each stratum moves, which
    // is the design: proportionality is a decision, and the seed governs what is not decided.
    const left = stratifiedSample(corpus, { size: 20, seed: 'a' });
    const right = stratifiedSample(corpus, { size: 20, seed: 'b' });
    expect(left.strata).toStrictEqual(right.strata);
    expect(idsOf(left.items)).not.toStrictEqual(idsOf(right.items));
  });

  it('draws nothing from an empty population, without inventing a stratum', () => {
    expect(stratifiedSample([], { size: 10 })).toStrictEqual({ items: [], strata: [] });
  });
});

describe('diverseSample', () => {
  /**
   * A population where a uniform draw is measurably worse at showing spread.
   *
   * Ninety entries share one signature and thirty carry twenty distinct runners between them. Random
   * draws of twenty land on the shared signature five times in six; the maximiser must spend almost
   * all of its rows on the diverse tail. Asserted as a comparison against the control arm rather
   * than as a coverage number, because the number is not the claim -- the claim is that this mode
   * exists for a reason.
   */
  const shared: SignedItem[] = Array.from({ length: 90 }, (_unused, index) => ({
    id: `shared-${String(index).padStart(3, '0')}`,
    keys: ['project_alpha', 'runner_beta'],
  }));
  const varied: SignedItem[] = Array.from({ length: 30 }, (_unused, index) => ({
    id: `varied-${String(index).padStart(3, '0')}`,
    keys: [`project_${String(index)}`, `runner_${String(index)}`],
  }));
  const population = [...shared, ...varied];

  const distinctKeys = (items: readonly SignedItem[]): number =>
    new Set(items.flatMap((item) => item.keys)).size;

  it('covers more of the value space than a uniform draw of the same size', () => {
    const diverse = diverseSample(population, { size: 20 });
    const random = randomSample(population, { size: 20, seed: 'a' });
    const randomKeys = new Set(
      random.flatMap((item) => population.find((other) => other.id === item.id)?.keys ?? []),
    ).size;

    expect(distinctKeys(diverse)).toBeGreaterThan(randomKeys);
    // Not merely better -- maximal. Twenty rows, two distinct pairs each, and no row may repeat a
    // pair: the shared signature contributes its two pairs once and then stops being worth a row.
    expect(distinctKeys(diverse)).toBe(40);
    expect(new Set(idsOf(diverse)).size).toBe(diverse.length);
  });

  /**
   * The duplicate signature gets exactly one row, and that one is the documented tie-break.
   *
   * Nineteen of the twenty go to the varied tail because those are the only rows that buy coverage.
   * The twentieth is the FIRST item in id order, taken when every candidate still had the same gain
   * -- so a reader looking at this sample sees one representative of the majority signature and
   * nineteen of the tail, which is what a maximum-coverage draw should look like. Asserting the one
   * rather than the nineteen is what pins the tie-break: without it, the count would drift with the
   * population's order and nothing would notice.
   */
  it('spends one row on the duplicated signature and the rest on the tail', () => {
    const diverse = diverseSample(population, { size: 20 });

    expect(diverse.filter((item) => item.id.startsWith('shared-')).map((item) => item.id)) //
      .toStrictEqual(['shared-000']);
    expect(diverse.filter((item) => item.id.startsWith('varied-'))).toHaveLength(19);
  });

  it('is a function of the population alone -- no seed, and no variation to have', () => {
    expect(idsOf(diverseSample(population, { size: 20 }))).toStrictEqual(
      idsOf(diverseSample(population, { size: 20 })),
    );
    expect(idsOf(diverseSample([...population].reverse(), { size: 20 }))).toStrictEqual(
      idsOf(diverseSample(population, { size: 20 })),
    );
  });

  /**
   * The early stop, which is a real behaviour rather than an edge case.
   *
   * Once every pair is covered, further rows add no spread -- and on the real corpus this is what
   * `--sample diverse --limit 40` does, returning twenty-nine rows because there are that many kinds
   * of `verification_run`. Padding would report a diverse sample where the value space had run out.
   */
  it('stops early when the value space is exhausted rather than padding', () => {
    const tiny: SignedItem[] = [
      { id: 'a', keys: ['x'] },
      { id: 'b', keys: ['x'] },
      { id: 'c', keys: ['x'] },
    ];

    expect(idsOf(diverseSample(tiny, { size: 3 }))).toStrictEqual(['a', 'b', 'c']);
    expect(idsOf(diverseSample(tiny, { size: 2 }))).toHaveLength(1);
  });

  it('returns the whole population when the sample is at least as large', () => {
    expect(idsOf(diverseSample(population, { size: 500 }))).toHaveLength(population.length);
  });
});

describe('outlierSample', () => {
  const population: SignedItem[] = [
    ...Array.from({ length: 100 }, (_unused, index) => ({
      id: `common-${String(index).padStart(3, '0')}`,
      keys: ['passed', 'majority'],
    })),
    { id: 'rare-000', keys: ['failed', 'rare_one'] },
    { id: 'rare-001', keys: ['failed', 'rare_two'] },
  ];

  /**
   * The population's majority value must NOT be what this mode returns.
   *
   * It is the inverse of `diverse`, and the failure that would matter is the two being the same
   * function: a reader asking for the tail would be handed the middle and would have no way to see
   * it, since both report a subset of the right size.
   */
  it('takes the rare entries and leaves the majority behind', () => {
    const drawn = idsOf(outlierSample(population, { size: 2 }));

    expect(drawn).toStrictEqual(['rare-000', 'rare-001']);
    expect(drawn).not.toContain('common-000');
  });

  it('scores a property that never varies as worth nothing', () => {
    // Every entry holds `constant`; only the second key separates them, so the ranking must be
    // decided by the second key alone rather than by a constant term added to everyone.
    const flat: SignedItem[] = [
      ...Array.from({ length: 50 }, (_unused, index) => ({
        id: `a-${String(index).padStart(3, '0')}`,
        keys: ['constant', 'wide'],
      })),
      { id: 'b-000', keys: ['constant', 'narrow'] },
    ];

    expect(idsOf(outlierSample(flat, { size: 1 }))).toStrictEqual(['b-000']);
  });

  it('is a function of the population alone, and reports them in id order', () => {
    expect(idsOf(outlierSample(population, { size: 3 }))).toStrictEqual(
      idsOf(outlierSample([...population].reverse(), { size: 3 })),
    );
    const drawn = idsOf(outlierSample(population, { size: 3 }));
    expect(drawn).toStrictEqual([...drawn].sort());
  });

  it('returns the whole population when the sample is at least as large', () => {
    expect(idsOf(outlierSample(population, { size: 500 }))).toHaveLength(population.length);
  });
});
