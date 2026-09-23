/**
 * The verdict a check's OUTPUT gives, for a run whose exit status is not the check's own.
 *
 * Output is usually filtered -- `| tail`, `| head`, `| grep` -- and a filter can remove lines
 * but cannot invent them. So the two directions carry different weight:
 *
 *   - any FAILURE line proves the run failed, whatever was cut around it;
 *   - a PASS needs an aggregate line, one that speaks for the whole run. A per-unit `ok` line
 *     does not: cargo prints one `test result:` per test binary, and `cargo test | head` shows
 *     the early `ok` lines of a run whose `FAILED` it cut. Measured: 270 of the 715 ok-only cargo
 *     outputs in masked runs went through head/grep/sed/awk.
 *
 * So cargo, tsc and eslint can fail a run and never pass one. The formats are the ones measured
 * in masked check runs on the frozen corpus (spike/verdict); jest, pytest and mocha appeared 0
 * times and go printed no failure line, so none of them is parsed.
 */
export type OutputVerdict = 'passed' | 'failed';

const FAILED: readonly RegExp[] = [
  // vitest: `Test Files  1 failed | 1 passed (2)`. It omits zero counts: 0 of the corpus's
  // 4,181 Test Files lines say `0 failed`.
  /^\s*Test Files\s[^\n]*\b\d+ failed/m,
  // cargo, per test binary
  /^test result: FAILED\./m,
  /\berror TS\d+:/,
  // eslint counts warnings too, and exits 0 on warnings alone
  /^✖ \d+ problems? \([1-9]\d* errors?,/m,
  /^\[warn\] Code style issues found/m,
  /^verdict: red\b/m,
  // node:test
  /^ℹ fail [1-9]\d*$/m,
];

const PASSED: readonly RegExp[] = [
  // vitest's run-wide summary; a failed file would have matched FAILED first
  /^\s*Test Files\s+\d+ passed \(\d+\)\s*$/m,
  /^All matched files use Prettier code style!/m,
  /^verdict: green\b/m,
  /^ℹ fail 0$/m,
];

/** The output's own verdict, or `undefined` when it holds no line that can settle one. */
export function outputVerdict(text: string): OutputVerdict | undefined {
  if (FAILED.some((pattern) => pattern.test(text))) return 'failed';
  if (PASSED.some((pattern) => pattern.test(text))) return 'passed';
  return undefined;
}
