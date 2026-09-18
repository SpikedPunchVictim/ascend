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
 *   - `crosstab` / `chiSquare` / `cramerV` -- DONE, `association.ts` (asc-0tw). Ported, then extended
 *     into the RANKING the bead actually asked for: forty-five pairs need effect-size ordering,
 *     Bergsma bias correction and Benjamini-Hochberg FDR control before a top-5 means anything.
 *   - Cohen's kappa -- DONE, `agreement.ts` (asc-8ju), written rather than ported: the spike never
 *     implemented it (`spike/FINDINGS.md` records it as entirely unexercised), so it arrived with
 *     hand-computed anchors instead of ported ones. It reports kappa and the two numbers behind it
 *     but NO interval -- see that file for why Wilson's is the wrong variance for it.
 *   - Rule back-testing -- DONE, `backtest.ts` (asc-3o9). Grades a proposed rule against a
 *     hand-labelled ground truth: precision and recall per label, both `wilson()` proportions rather
 *     than bare ratios, and neither is kappa -- see that file for why a symmetric agreement statistic
 *     is the wrong tool for grading an asymmetric predictor.
 *   - association rules -- DONE, `rules.ts` (asc-p4g). FP-growth, with the three filters that
 *     decide whether the output is readable: confidence is a `Proportion` and never a bare ratio,
 *     `informative` tests the interval's LOWER bound against the consequent's base rate, and only
 *     productive rules survive -- one that merely matches a shorter rule is that rule with a
 *     decoration attached.
 *   - changepoint detection -- DONE, `changepoint.ts` (asc-08y). Pettitt (rank-based, closed-form
 *     approximation) and CUSUM (magnitude-based, seeded bootstrap) side by side rather than one
 *     chosen for the caller: they fail differently, and two tests agreeing is a much stronger claim
 *     than either alone. Both find a break in pure noise every time, so the p is the finding and the
 *     index never is.
 *   - distinctive terms per group -- DONE, `distinctive.ts` (asc-iyd), written rather than ported:
 *     the spike never attempted it. Monroe/Colaresi/Quinn's log-odds with an informative Dirichlet
 *     prior, reported as a z-score, with the vocabulary treated as the multiple-comparison family
 *     it is. It reuses `chiSquarePValue` for the two-sided normal tail rather than introducing a
 *     second approximation: P(|Z| > z) is P(X^2 > z^2) at one degree of freedom.
 *   - near-duplicate collapse -- DONE, `neardup.ts` (asc-yce). MinHash with banding, but the index
 *     only PROPOSES pairs: every proposed pair is scored by exact Jaccard before anything merges, so
 *     a signature collision can never cause a false merge and the only sources left are the
 *     threshold and chaining -- both of which the report prices, the second through each group's
 *     `minSimilarity`. Empty documents are held out rather than collapsed together, because most
 *     entries in this store carry no `evidence_text` and Jaccard's empty-set convention would report
 *     that silence as the largest finding in the data.
 *   - lexical clustering -- DONE, `cluster.ts` (asc-h7d). TF-IDF cosine with agglomerative
 *     linkage, NO EMBEDDINGS, because `mast` deleted its vector leg and there is no model to call.
 *     The problem it is built around is that agglomerative clustering ALWAYS returns clusters, so
 *     every cluster carries a silhouette and `permutationNull` gives the mean one a null to be
 *     disbelieved against -- a shuffle that preserves the vocabulary, every term's frequency and
 *     every document's length, and destroys only co-occurrence. Average linkage is the default;
 *     single and complete ship beside it because they lose differently, and which one lost on this
 *     corpus is a measurement rather than an opinion.
 *   - the seeded permutation control -- DONE, `association.ts` (asc-0tw), and it was built the way
 *     this note asked: `sample.ts`'s generator moved to `random.ts` and both now draw from it, so
 *     one store has one notion of a seed rather than two identical ones that agree by coincidence.
 */

export { DEFAULT_SEED, mulberry32, seedOf } from './random.js';

export {
  allocate,
  diverseSample,
  outlierSample,
  randomSample,
  SampleSizeError,
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

export {
  AssociationError,
  benjaminiHochberg,
  chiSquare,
  chiSquarePValue,
  crosstab,
  mutualInformation,
  permutationNull,
  rankAssociations,
  type AssociationColumn,
  type AssociationOptions,
  type AssociationReport,
  type ChiSquareResult,
  type Crosstab,
  type MutualInformationResult,
  type PairAssociation,
  type PermutationNull,
} from './association.js';

export {
  ChangepointError,
  cusum,
  pettitt,
  rankChangepoints,
  type ChangepointOptions,
  type ChangepointReport,
  type ChangepointResult,
  type CusumOptions,
  type NamedSeries,
  type RankedChangepoint,
  type Segment,
  type SeriesPoint,
} from './changepoint.js';

export {
  distinctiveTerms,
  DistinctiveError,
  type DistinctiveGroup,
  type DistinctiveGroupReport,
  type DistinctiveOptions,
  type DistinctiveReport,
  type DistinctiveTerm,
} from './distinctive.js';

export {
  associationRules,
  RuleError,
  type AssociationRule,
  type FrequentItemset,
  type RuleOptions,
  type RuleReport,
} from './rules.js';

export {
  cluster,
  ClusterError,
  cosine,
  permutationNull as clusterPermutationNull,
  sweepThreshold,
  tfidf,
  type Cluster,
  type ClusterDocument,
  type ClusterNull,
  type ClusterOptions,
  type ClusterReport,
  type ClusterTerm,
  type DocumentVector,
  type Linkage,
  type ThresholdSweepPoint,
  type Vectorisation,
} from './cluster.js';

export {
  collapseNearDuplicates,
  jaccard,
  minHashSignature,
  NearDuplicateError,
  shingle,
  type DuplicateCandidate,
  type NearDuplicateGroup,
  type NearDuplicateOptions,
  type NearDuplicateReport,
} from './neardup.js';

export {
  backtest,
  BacktestError,
  type BacktestLabelMeasure,
  type BacktestReport,
} from './backtest.js';
