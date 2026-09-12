/**
 * @ascend/analysis -- pure statistics over plain arrays.
 *
 * Purity contract (ARCHITECTURE.md; enforced by `asc-core-purity` and `align check`):
 * zero `fs`, zero `Date.now()`, zero network. Pure functions over plain data, so
 * every method is testable against known fixtures with no database involved.
 *
 * Empty at E1 (repo foundation). The statistical layer lands in E7 -- see beads
 * `asc-analysis-*`.
 *
 * NOTE FOR E7: the Stage 0 spike validated `wilson`, `chiSquare`, `cramerV` and
 * the seeded permutation control against hand-computed anchors, with 10 passing
 * tests, in `spike/lib/stats.mjs` + `spike/lib/stats.test.mjs`. That work is
 * validated and is the intended starting point -- port it rather than rewriting.
 * The anchors (chi2=3.841458820694124 @ df=1 -> p=0.05; Wilson 25/100 ->
 * (0.1754534, 0.3430444)) exist so the port can be checked, not just trusted.
 */
/** Minimum group size below which a proportion is an anecdote, not an estimate. */
export const MIN_N = 20;
//# sourceMappingURL=index.js.map