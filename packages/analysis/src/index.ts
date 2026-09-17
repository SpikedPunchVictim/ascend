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
 * THE SPIKE IS BEING PORTED, BY BEAD, NOT REWRITTEN. The Stage 0 spike validated
 * `wilson`, `chiSquare`, `cramerV` and the seeded permutation control against
 * hand-computed anchors, with 10 passing tests, in `spike/lib/stats.mjs` +
 * `spike/lib/stats.test.mjs`. That work is validated and is the intended starting
 * point, and the anchors (chi2=3.841458820694124 @ df=1 -> p=0.05; Wilson 25/100 ->
 * (0.1754534, 0.3430444)) exist so the port can be checked, not just trusted.
 *
 *   - `wilson` + the minimum-N rule -- DONE, `proportion.ts` (asc-bmf). It departed
 *     from the spike twice on purpose; both departures and their reasons are in that
 *     file's comment, and the anchors are carried into `test/proportion.test.ts`.
 *   - `crosstab` / `chiSquare` / `cramerV` -- still to port (asc-0tw).
 *   - Cohen's kappa -- DONE, `agreement.ts` (asc-8ju), written rather than ported: the spike never
 *     implemented it (`spike/FINDINGS.md` records it as entirely unexercised), so it arrived with
 *     hand-computed anchors instead of ported ones. It reports kappa and the two numbers behind it
 *     but NO interval -- see that file for why Wilson's is the wrong variance for it.
 *   - the seeded permutation control -- still to port, and it is the same problem
 *     `sample.ts` solves below. `sample.ts` is the answer that landed first: build it
 *     on that generator rather than beside it, so one store has one notion of a seed.
 */

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

export {
  isSmallGroup,
  MIN_N,
  ProportionError,
  wilson,
  type ConfidenceLevel,
  type Proportion,
} from './proportion.js';

export {
  AgreementError,
  cohenKappa,
  type Agreement,
  type AgreementMeasure,
  type LabelMarginal,
  type Labelled,
} from './agreement.js';
