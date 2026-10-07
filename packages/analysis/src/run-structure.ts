/**
 * The pseudoreplication check E7's third control requires (asc-qt6r).
 *
 * WHY THIS EXISTS. `packages/analysis` reports significance at N, and N is a count of ROWS. When a
 * column's values are echoes of a session state rather than independent events, the rows are not
 * independent draws and N is not a sample size. `docs/evidence/EV-patterns.md` measured the shape on
 * the transcript corpus: 4,668 records carry `attributionSkill`, and they collapse into 45 runs --
 * one skill stays attributed for a median 55 records. The independent count is 45, not 4,668, and
 * every chi-square tail computed over those rows is computed against a null that shares the defect.
 *
 * WHY NO EXISTING CONTROL CATCHES IT. The shuffled-label control holds each column's marginal
 * distribution fixed and destroys only the pairing. Dwell weighting lives IN the marginals -- the
 * long run is what made one skill's count large in the first place -- so the control re-draws a null
 * with the same dwell in it and cannot object. That is the design's load-bearing methodological bet
 * with a blind spot exactly where its second profile lives, which is why this is a separate
 * instrument rather than another option on the same one.
 *
 * TWO STATISTICS, AND NEITHER ALONE IS ENOUGH. `runs` is the independent count: a maximal stretch of
 * equal consecutive values within one partition is one observation, however many rows it spans.
 *
 *   `rowsPerRun`  = rows / runs
 *       How many rows carry one observation's worth of information. THIS is the inflation, and it is
 *       the number a caller has to be told: `runs` is the N a significance claim may be computed at.
 *       It is the only one of the two that sees a column CONSTANT within its partition.
 *
 *   `runsPerExpected` = runs / expectedRuns
 *       Whether the ORDER carries structure the marginals do not. `expectedRuns` is the exact
 *       expectation for a random arrangement of the same multiset, summed over partitions,
 *       `sum_p [1 + (m_p - 1) (1 - sum_i (c_ip / m_p)^2)]` -- no simulation, no seed, no constant. A
 *       ratio of 1 means the counts alone already predict the run structure; below 1 means the order
 *       is doing something the counts cannot explain.
 *
 * THE CASE WHERE THEY DISAGREE IS THE ONE THAT DECIDES THE DESIGN, and it is measured rather than
 * argued. `project` in the live store's `tool_denial` is 777 rows over 41 sessions, 41 runs, ratio
 * exactly 1.000 -- because a session happens in one project, every partition is constant and the
 * marginals predict its run structure exactly. The ratio sees nothing. `rowsPerRun` is 19.0 and the
 * column is the most clustered thing in the store. An instrument reporting only the ratio would call
 * it independent, so both are reported and `stateLike` turns on `rowsPerRun`.
 *
 * THE PARTITION AND THE ORDER ARE THE CALLER'S, ALWAYS. `packages/analysis` is pure and
 * harness-neutral: the strings `session_id`, `agent_id` and `occurred_at` appear nowhere in this
 * package, and they must not. A partition here is an opaque label compared only for equality, and
 * the order is the order the arrays arrive in -- this module sorts nothing. WHICH ORDER is not
 * cosmetic and is not this module's decision: measured on the live store, `skill` in
 * `skill_activation` reads ratio 0.722 ordered by the event's own time and 0.980 ordered by
 * `recorded_at`, which is when ascend INGESTED the entry and is scrambled by any backfill. A caller
 * that hands over a stored row order rather than an event order will manufacture a finding here.
 *
 * WHAT TO DO ABOUT IT, and this module does not do either. Collapse to activations -- the way the
 * claude-code adapter already does at ingest -- or compute the claim at the clustered design's
 * effective N, which `design-effect.ts` exists to produce. Reporting `stateLike` is the trigger to
 * reach for one of those, not a replacement for it.
 *
 * This file is pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `packages/core/test/purity-enforcement.test.ts`).
 */

/**
 * The average run length at which a column is called state-like.
 *
 * `2` is not a tuned constant and it is not arbitrary: it is the smallest value at which the
 * statement "half these rows repeat the row before them" is true, which is the weakest form of the
 * claim this check exists to make. A threshold below it would flag a column with no repetition at
 * all; a higher one would let a majority of rows be echoes without saying so.
 *
 * Measured against it on the live store (2026-10-07): `project` in `tool_denial` is 19.0,
 * `tool_name` in `tool_denial` is 7.0, the corpus's `attributionSkill` is 103.7, and a column with no
 * repetition at all is exactly 1.0. Nothing observed sits between 1.0 and 2.4.
 */
export const PSEUDOREPLICATION_AT = 2;

/**
 * A caller asked for a run structure the arithmetic cannot produce.
 *
 * Thrown rather than repaired, in the style of `ClusterDesignError` and `ProportionError`. Values
 * and partitions describe the same rows, so pairing two lists of different lengths by index would
 * silently drop observations or read `undefined` -- and a dropped observation is a denominator that
 * quietly disagrees with the numerator above it, which is a wrong answer shaped exactly like a right
 * one.
 */
export class RunStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStructureError';
  }
}

/**
 * One column's run structure, and the two ratios that read it.
 *
 * Every field is present on every instance: an `effectiveN` with no visible derivation is a number a
 * reader has to take on trust, and this is a check whose whole value is that a reader can disagree
 * with it.
 */
export interface RunStructure {
  /** Rows carrying a value AND a partition. A row missing either is in no run and is not counted. */
  readonly rows: number;
  /** Distinct partition labels among those rows. The ceiling on `runs` when every partition is constant. */
  readonly partitions: number;
  /**
   * Maximal stretches of equal consecutive values, summed over partitions.
   *
   * THIS IS THE INDEPENDENT COUNT. It is the N a significance claim built on this column may be
   * computed at, and it is what `rows` should have been.
   */
  readonly runs: number;
  /** The longest single run of one value inside one partition. The extreme behind the average. */
  readonly longestRun: number;
  /**
   * Runs a RANDOM arrangement of the same values in the same partitions would produce, exactly:
   * `sum_p [1 + (m_p - 1) (1 - sum_i (c_ip / m_p)^2)]`.
   *
   * NOT a simulation: this is the closed-form expectation, so it needs no seed and two runs of the
   * same corpus cannot disagree about it.
   */
  readonly expectedRuns: number;
  /** `rows / runs`. How many rows carry one observation's worth of information. `0` when there are no runs. */
  readonly rowsPerRun: number;
  /** `runs / expectedRuns`. `1` means the marginals already explain the order; below `1` means they do not. */
  readonly runsPerExpected: number;
  /** True when `rowsPerRun` is at or above `PSEUDOREPLICATION_AT`. */
  readonly stateLike: boolean;
}

/**
 * The run structure of one column, over the partitions and in the order the caller supplies.
 *
 * `values[i]` and `partitions[i]` describe the same row, so the two must be the same length.
 * `values` is in the caller's intended order -- order by the EVENT's own time, not by the stored row
 * order -- and this module never reorders it. A partition holding one row contributes one run and
 * one to `expectedRuns`, so it is neutral: a row that is alone cannot be evidence of repetition.
 */
export function runStructure(
  values: readonly (string | null)[],
  partitions: readonly (string | null)[],
): RunStructure {
  if (values.length !== partitions.length) {
    throw new RunStructureError(
      `values (${String(values.length)}) and partitions (${String(partitions.length)}) must be the ` +
        `same length: they describe the same rows.`,
    );
  }

  // Grouped in input order, which is the order the caller put them in. A `Map` iterates in insertion
  // order, so the partitions come back in the order they were first seen -- stable, and the same on
  // every run.
  const byPartition = new Map<string, string[]>();
  for (let index = 0; index < values.length; index += 1) {
    const partition = partitions[index] ?? null;
    const value = values[index] ?? null;
    // A row missing either is in no partition and carries nothing to repeat, so it is in no run.
    if (partition === null || value === null) continue;
    const existing = byPartition.get(partition);
    if (existing === undefined) byPartition.set(partition, [value]);
    else existing.push(value);
  }

  let rows = 0;
  let runs = 0;
  let longestRun = 0;
  let expectedRuns = 0;

  for (const partition of byPartition.values()) {
    const size = partition.length;
    rows += size;

    const counts = new Map<string, number>();
    let runsHere = 0;
    let longestHere = 0;
    let current = 0;
    for (let index = 0; index < size; index += 1) {
      const value = partition[index] ?? '';
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (index === 0 || value !== partition[index - 1]) {
        runsHere += 1;
        current = 1;
      } else {
        current += 1;
      }
      if (current > longestHere) longestHere = current;
    }
    runs += runsHere;
    if (longestHere > longestRun) longestRun = longestHere;

    let sumSquares = 0;
    for (const count of counts.values()) sumSquares += (count / size) ** 2;
    expectedRuns += 1 + (size - 1) * (1 - sumSquares);
  }

  const rowsPerRun = runs === 0 ? 0 : rows / runs;
  // `1` rather than `NaN` when there is nothing to compare: an empty column is not evidence of
  // unexplained serial structure, and a `NaN` here would propagate into every comparison downstream.
  const runsPerExpected = expectedRuns === 0 ? 1 : runs / expectedRuns;

  return {
    rows,
    partitions: byPartition.size,
    runs,
    longestRun,
    expectedRuns,
    rowsPerRun,
    runsPerExpected,
    stateLike: rowsPerRun >= PSEUDOREPLICATION_AT,
  };
}
