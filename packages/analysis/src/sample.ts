/**
 * Sampling -- choosing a SUBSET that shows spread, rather than the first N rows.
 *
 * WHY THIS EXISTS. Paging answers "give me entries", and on a derived corpus it answers badly: the
 * first forty entries of a type are near-identical to one another, because one ingest run derived
 * them from one burst and stamped them all with the same instant (measured -- every derived type in
 * the corpus has exactly one distinct `recorded_at`). A reader shown forty of those generalises from
 * an accident of ordering. Sampling is the same budget spent deliberately.
 *
 * FOUR MODES, AND WHAT EACH ONE IS FOR.
 *
 *   - `random`     -- an unbiased draw. The control arm. Right when the question is a rate and the
 *                     corpus is not badly skewed.
 *   - `stratified` -- a draw that preserves the population's proportions across ONE categorical
 *                     property, with every value that occurs represented at least once. The
 *                     guarantee is the point, not the randomness: a value holding 1% of the corpus
 *                     is absent from a random draw of forty more often than not, and a reader who
 *                     never sees it concludes it does not occur.
 *   - `diverse`    -- the subset covering the most of the value space. Not a probability sample at
 *                     all: a deterministic maximisation, so two runs agree. For "what kinds of
 *                     entry exist here".
 *   - `outlier`    -- the entries least like the rest, scored by the rarity of their values. For the
 *                     tail, which is where the interesting cases are and where a random draw is
 *                     least likely to land.
 *
 * WHAT A `key` IS, AND WHY IT IS A STRING. An item's categorical identity is called a `key` here
 * and is deliberately opaque: this module groups by it, counts it, sorts it, and never interprets
 * it. The producer decides what it means, and the producer is the CLI, which builds it from a
 * property's STATE and its value -- `measured`/`passed` and `not_measured`/absent are different
 * strata and must not collapse into one. The vocabulary for that (`PropertyState`) lives in
 * `@ascend/core`, and this package does not import it, because `analysis` is pure statistics over
 * plain arrays and nothing here should need to know what an ascend property is. So the state
 * vocabulary stays in one place, and the only thing crossing the boundary is a string.
 *
 * THE GENERATOR LIVES IN `random.ts`, not here. It was private to this file until the permutation
 * control in `association.ts` needed the same seed vocabulary; see that file for why one generator
 * beats two identical ones.
 *
 * DETERMINISM IS THE DEFAULT AND THE SEED IS THE EXCEPTION, matching the rule the rest of this
 * store follows: two runs over one store must agree. `random` and `stratified` derive every choice
 * from a seeded generator whose default is fixed, so a sample is reproducible from its parameters
 * alone. `diverse` and `outlier` take no seed, because they are not draws -- a maximum is a maximum,
 * and accepting a seed would imply the result could vary when it cannot.
 *
 * EVERY SAMPLER RETURNS ITS ITEMS IN ID ORDER. What varies between seeds and modes is the SELECTION;
 * the presentation does not vary with it. So a re-run that chose differently shows up as a change in
 * membership rather than as a reshuffled list, which is the difference between a diff a reader can
 * read and one they cannot.
 *
 * NOTHING HERE TOUCHES A DATABASE OR A CLOCK. Pure functions over plain arrays, importing no Node
 * builtin at all (enforced by `align check` and the `purity-enforcement` test). The population is
 * materialised by the caller -- the store's `signatures` -- and this file only chooses from it.
 */

import { DEFAULT_SEED, mulberry32, seedOf } from './random.js';

/** An item a sampler can order reproducibly. Every other interface here extends it. */
export interface Samplable {
  readonly id: string;
}

/** An item carrying one categorical key: what `stratified` groups by. */
export interface StratifiedItem extends Samplable {
  /** The categorical identity of this item, opaque here. See the file comment. */
  readonly key: string;
}

/** An item carrying a categorical signature: what `diverse` and `outlier` compare. */
export interface SignedItem extends Samplable {
  /**
   * One key per property, aligned across every item of the population. Alignment is the caller's
   * obligation and the store's projection provides it; the positions are never named here, because
   * which property sits at which position is a fact about the query rather than about the choice.
   */
  readonly keys: readonly string[];
}

/** What every mode is asked for. */
export interface SampleOptions {
  /** How many items to select. */
  readonly size: number;
  /** The seed the choice is derived from. Defaults to `DEFAULT_SEED`. */
  readonly seed?: string;
}

/** A caller asked for a sample size the sampler will not serve. */
export class SampleSizeError extends Error {
  constructor(readonly requested: number) {
    super(`sample size must be at least 1, got ${String(requested)}`);
    this.name = 'SampleSizeError';
  }
}

/** One key's share of the population and of the sample. */
export interface StratumReport {
  readonly key: string;
  readonly population: number;
  readonly selected: number;
}

/** A stratified sample, with the proportions it achieved stated rather than asserted. */
export interface StratifiedSample<T extends Samplable> {
  readonly items: readonly T[];
  /** Every key that occurs in the population, ascending. */
  readonly strata: readonly StratumReport[];
}

/** Items in id order, which is where every sampler starts. */
function byId<T extends Samplable>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Refuses a size no mode can serve, in the caller's terms. */
function assertSize(size: number): void {
  if (!Number.isInteger(size) || size < 1) throw new SampleSizeError(size);
}

/**
 * `size` items drawn uniformly from `pool`, by partial Fisher-Yates.
 *
 * Partial rather than a full shuffle because only the first `size` positions are ever read: a full
 * shuffle of a hundred-thousand-entry population costs the same as one of forty, for nothing.
 */
function draw<T>(pool: readonly T[], size: number, next: () => number): T[] {
  const remaining = [...pool];
  const chosen: T[] = [];

  for (let index = 0; index < size && index < remaining.length; index += 1) {
    const swap = index + Math.floor(next() * (remaining.length - index));
    const held = remaining[index];
    const taken = remaining[swap];
    // Unreachable: both indices are below `remaining.length` by construction.
    if (held === undefined || taken === undefined)
      throw new Error('sample: draw index out of range');
    remaining[index] = taken;
    remaining[swap] = held;
    chosen.push(taken);
  }

  return chosen;
}

/**
 * How many of `size` go to each stratum -- largest remainder, with a floor of one.
 *
 * Two requirements pull against each other, and this is where they are reconciled.
 *
 * **Proportionality** is what makes a stratified sample an estimate of the whole: a value holding
 * 86% of the population should hold about 86% of the sample. Largest remainder is the standard way
 * to round shares without the rounding itself biasing the result -- floors alone systematically
 * under-allocate to every stratum, and the rows are handed back to whoever was cut hardest.
 *
 * **The floor** is what makes this stratified rather than merely proportional: every value that
 * OCCURS gets at least one row, because a value absent from a sample is a value the reader concludes
 * does not exist. The floor is what distorts the proportions, so the two cannot both hold exactly.
 * The distortion is bounded by one row per stratum, and `stratifiedSample` reports the achieved
 * proportions back rather than this function hiding them.
 *
 * A population smaller than the requested size is returned whole -- there is nothing to choose
 * between. More strata than rows is the one case where the floor is impossible, and the rows go to
 * the largest strata rather than being spread thinly, which would only make the failure less visible.
 */
export function allocate(populations: readonly number[], size: number): readonly number[] {
  const allocated = populations.map(() => 0);

  const present = populations
    .map((population, index) => ({ population, index }))
    .filter((stratum) => stratum.population > 0);

  const total = present.reduce((sum, stratum) => sum + stratum.population, 0);
  if (present.length === 0 || size <= 0) return allocated;

  if (size >= total) {
    for (const stratum of present) allocated[stratum.index] = stratum.population;
    return allocated;
  }

  // Fewer rows than strata: the floor cannot be honoured for everyone. The largest strata take the
  // rows, ranked by population and then by position so two runs agree.
  if (size < present.length) {
    const ranked = [...present].sort((a, b) => b.population - a.population || a.index - b.index);
    for (const stratum of ranked.slice(0, size)) allocated[stratum.index] = 1;
    return allocated;
  }

  const quotas = present.map((stratum) => (size * stratum.population) / total);
  for (const [position, stratum] of present.entries()) {
    allocated[stratum.index] = Math.floor(quotas[position] ?? 0);
  }

  let left = size - allocated.reduce((sum, count) => sum + count, 0);
  const byRemainder = present
    .map((stratum, position) => ({
      index: stratum.index,
      fraction: (quotas[position] ?? 0) - Math.floor(quotas[position] ?? 0),
      population: stratum.population,
    }))
    .sort((a, b) => b.fraction - a.fraction || b.population - a.population || a.index - b.index);

  // Cyclic rather than once-through: `left` is below the stratum count on every input that reaches
  // here, and a loop that wraps is obviously exhaustive where one that does not would need a proof.
  for (let position = 0; left > 0; position += 1) {
    const stratum = byRemainder[position % byRemainder.length];
    if (stratum === undefined) break;
    allocated[stratum.index] = (allocated[stratum.index] ?? 0) + 1;
    left -= 1;
  }

  // The floor, applied last so the rounding above cannot undo it. A zero is repaired by taking a
  // row from the largest allocation, which always leaves that stratum at one or more -- so this
  // pass never creates a new zero and one sweep suffices. `size >= present.length` above is what
  // guarantees a donor exists.
  for (const empty of present) {
    if ((allocated[empty.index] ?? 0) > 0) continue;
    const donor = present
      .filter((stratum) => (allocated[stratum.index] ?? 0) > 1)
      .sort(
        (a, b) =>
          (allocated[b.index] ?? 0) - (allocated[a.index] ?? 0) ||
          b.population - a.population ||
          a.index - b.index,
      )[0];
    if (donor === undefined) break;
    allocated[donor.index] = (allocated[donor.index] ?? 0) - 1;
    allocated[empty.index] = 1;
  }

  return allocated;
}

/** A uniform draw of `size` items. The control arm every other mode is measured against. */
export function randomSample<T extends Samplable>(
  items: readonly T[],
  options: SampleOptions,
): readonly T[] {
  assertSize(options.size);
  const ordered = byId(items);
  if (options.size >= ordered.length) return ordered;

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  return byId(draw(ordered, options.size, next));
}

/**
 * A draw preserving one property's proportions, with every value that occurs present at least once.
 *
 * Within a stratum the choice is uniform, so the sample is not biased toward whatever the store
 * happened to order first -- only the ALLOCATION is deliberate, and the seed governs the rest.
 */
export function stratifiedSample<T extends StratifiedItem>(
  items: readonly T[],
  options: SampleOptions,
): StratifiedSample<T> {
  assertSize(options.size);
  const ordered = byId(items);

  const keys = [...new Set(ordered.map((item) => item.key))].sort();
  // Grouped by scanning once per key rather than by building a Map, because the key list is already
  // materialised and a second index of the same facts is a second thing that can disagree.
  const groups = keys.map((key) => ordered.filter((item) => item.key === key));
  const quotas = allocate(
    groups.map((group) => group.length),
    options.size,
  );

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  const chosen: T[] = [];
  const strata: StratumReport[] = [];

  for (const [position, key] of keys.entries()) {
    const group = groups[position] ?? [];
    const quota = quotas[position] ?? 0;
    chosen.push(...draw(group, quota, next));
    strata.push({ key, population: group.length, selected: quota });
  }

  return { items: byId(chosen), strata };
}

/**
 * The subset covering the most of the value space, chosen greedily.
 *
 * Each `(position, key)` pair is one thing worth covering, so this is maximum coverage, which is
 * NP-hard. Greedy max-coverage is the standard answer: repeatedly take the item that adds the most
 * uncovered pairs. It is within a factor of `1 - 1/e` of optimal, and at these sizes the optimal is
 * not worth a search.
 *
 * Ties go to the first item in id order, which makes the result a function of the population alone.
 * There is no seed: a maximum is a maximum, and accepting one would imply the result could vary.
 *
 * **It can return fewer than `size`.** Once every pair is covered, further items add nothing, and
 * padding the sample with items that contribute no spread would be reporting a diverse sample where
 * the value space had simply run out. The caller's coverage line already states how many were shown.
 */
export function diverseSample<T extends SignedItem>(
  items: readonly T[],
  options: SampleOptions,
): readonly T[] {
  assertSize(options.size);
  const ordered = byId(items);
  if (options.size >= ordered.length) return ordered;

  // Every distinct `(position, key)` gets an integer, so coverage is set arithmetic over numbers
  // rather than string keys a value could collide with.
  const pairs = new Map<number, Map<string, number>>();
  let nextPair = 0;
  const signatures = ordered.map((item) =>
    item.keys.map((key, position) => {
      let byKey = pairs.get(position);
      if (byKey === undefined) {
        byKey = new Map<string, number>();
        pairs.set(position, byKey);
      }
      let pair = byKey.get(key);
      if (pair === undefined) {
        pair = nextPair;
        nextPair += 1;
        byKey.set(key, pair);
      }
      return pair;
    }),
  );

  const covered = new Set<number>();
  const taken = new Set<number>();
  const chosen: T[] = [];

  while (chosen.length < options.size) {
    let best = -1;
    let bestGain = 0;

    for (const [index, signature] of signatures.entries()) {
      if (taken.has(index)) continue;
      let gain = 0;
      for (const pair of signature) if (!covered.has(pair)) gain += 1;
      if (gain > bestGain) {
        bestGain = gain;
        best = index;
      }
    }

    // Nothing left to cover: the value space is exhausted, and the sample is what covers it.
    if (best < 0) break;

    taken.add(best);
    for (const pair of signatures[best] ?? []) covered.add(pair);
    const item = ordered[best];
    if (item === undefined) throw new Error('sample: diverse index out of range');
    chosen.push(item);
  }

  return byId(chosen);
}

/**
 * The entries least like the rest, scored by how rare their values are.
 *
 * An entry's score is the sum, over the keys in its signature, of `-log(share of the population
 * holding that key)`. Rare keys contribute a lot; a key half the corpus holds contributes almost
 * nothing; a position only ever took one key contributes exactly nothing for everyone, so a
 * constant property cannot tilt the ranking. A not-measured key is scored like any other -- it is a
 * real stratum of the population, and on this corpus it is often the rare one.
 *
 * Deterministic, and for the same reason as `diverse`: this is an ordering, not a draw. Ties go to
 * the first item in id order.
 */
export function outlierSample<T extends SignedItem>(
  items: readonly T[],
  options: SampleOptions,
): readonly T[] {
  assertSize(options.size);
  const ordered = byId(items);
  if (options.size >= ordered.length) return ordered;

  const counts = new Map<number, Map<string, number>>();
  for (const item of ordered) {
    for (const [position, key] of item.keys.entries()) {
      let byKey = counts.get(position);
      if (byKey === undefined) {
        byKey = new Map<string, number>();
        counts.set(position, byKey);
      }
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
  }

  const total = ordered.length;
  const ranked = ordered
    .map((item, index) => ({
      index,
      score: item.keys.reduce((sum, key, position) => {
        const held = counts.get(position)?.get(key) ?? 0;
        return held === 0 ? sum : sum - Math.log(held / total);
      }, 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, options.size)
    .flatMap((entry) => {
      const item = ordered[entry.index];
      return item === undefined ? [] : [item];
    });

  return byId(ranked);
}
