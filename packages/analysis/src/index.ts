/**
 * @ascend/analysis -- pure statistics over plain arrays.
 *
 * Purity contract (ARCHITECTURE.md; enforced by `asc-core-purity` and `align check`):
 * zero `fs`, zero `Date.now()`, zero network. Pure functions over plain data, so
 * every method is testable against known fixtures with no database involved.
 *
 * Sampling lands at E6, because `asc explore --sample` needs it and a CLI cannot
 * sample from a corpus it has not been taught to choose from. The statistical
 * layer lands at E7 -- see beads `asc-analysis-*`.
 *
 * NOTE FOR E7: the Stage 0 spike validated `wilson`, `chiSquare`, `cramerV` and
 * the seeded permutation control against hand-computed anchors, with 10 passing
 * tests, in `spike/lib/stats.mjs` + `spike/lib/stats.test.mjs`. That work is
 * validated and is the intended starting point -- port it rather than rewriting.
 * The anchors (chi2=3.841458820694124 @ df=1 -> p=0.05; Wilson 25/100 ->
 * (0.1754534, 0.3430444)) exist so the port can be checked, not just trusted.
 * The seeded permutation control there is the same problem `sample.ts` solves
 * below, and `sample.ts` is the answer that landed first: port the statistics to
 * its generator rather than beside it, so one store has one notion of a seed.
 */

/** Minimum group size below which a proportion is an anecdote, not an estimate. */
export const MIN_N = 20;

export {
  allocate,
  DEFAULT_SEED,
  diverseSample,
  outlierSample,
  randomSample,
  SampleSizeError,
  seedOf,
  stratifiedSample,
  type SampleOptions,
  type Samplable,
  type SignedItem,
  type StratifiedItem,
  type StratifiedSample,
  type StratumReport,
} from './sample.js';
