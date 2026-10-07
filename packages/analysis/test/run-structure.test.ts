import { describe, expect, it } from 'vitest';
import {
  PSEUDOREPLICATION_AT,
  RunStructureError,
  runStructure,
  type RunStructure,
} from '../src/index.js';

/**
 * `run-structure.ts` -- the pseudoreplication check E7's third control requires (asc-qt6r).
 *
 * EVERY EXPECTED VALUE BELOW IS COMPUTED BY HAND from the two quantities the module reports, and
 * the arithmetic is written beside each case so a reader can check it rather than check the
 * implementation against itself. The two are not the same instrument and the tests say so:
 *
 *   runs / expectedRuns   -- does the ORDER carry structure the marginals do not? `1` means no.
 *   rows / runs           -- how many rows carry one observation's worth of information.
 *
 * The case that matters most is the one where they DISAGREE, and it is the first one: a column
 * constant within every partition has `expectedRuns == runs` exactly (ratio 1 -- the marginals
 * already predict the run structure, so this ratio sees nothing), while `rowsPerRun` is maximal. That
 * is a real column on the live store -- `project` in `tool_denial` is 777 rows over 41 sessions,
 * 41 runs, ratio 1.000 -- and an instrument that reported only the ratio would call the most
 * clustered column in the store independent.
 */

/** `n` copies of one value -- the smallest thing that is a run. */
function repeat(value: string, n: number): string[] {
  return Array.from({ length: n }, () => value);
}

/** One partition label per value. */
function one(key: string, n: number): string[] {
  return Array.from({ length: n }, () => key);
}

function structure(
  values: readonly (string | null)[],
  partitions: readonly (string | null)[],
): RunStructure {
  return runStructure(values, partitions);
}

describe('runStructure', () => {
  it('counts one run per value when no two neighbours agree', () => {
    // ['a','b','c','d'] in one session: 4 runs, and the marginals predict
    // 1 + (4-1) * (1 - 4*(1/4)^2) = 1 + 3 * 0.75 = 3.25.
    const measured = structure(['a', 'b', 'c', 'd'], one('s', 4));

    expect(measured.runs).toBe(4);
    expect(measured.expectedRuns).toBeCloseTo(3.25, 10);
  });

  it('reports rowsPerRun 1 (nothing collapsed) when no neighbour agrees', () => {
    const measured = structure(['a', 'b', 'c', 'd'], one('s', 4));

    expect(measured.rowsPerRun).toBe(1);
  });

  it('is not stateLike when every row is its own observation', () => {
    const measured = structure(['a', 'b', 'c', 'd'], one('s', 4));

    expect(measured.stateLike).toBe(false);
  });

  it('is stateLike for a column constant within its partition, even though runsPerExpected is exactly 1', () => {
    // ['a','a','a','a'] in one session: the marginals predict 1 + 3 * (1 - 1^2) = 1 run, and one run
    // is what happens -- so the ratio is 1 and it can see nothing. Four rows carry one observation.
    const measured = structure(repeat('a', 4), one('s', 4));

    expect(measured.runs).toBe(1);
    expect(measured.runsPerExpected).toBe(1);
    expect(measured.rowsPerRun).toBe(4);
    expect(measured.stateLike).toBe(true);
  });

  it('breaks a run at a partition boundary rather than carrying it across', () => {
    // Four 'a' in one session is one run of 4. The same four values interleaved across two sessions
    // are two runs of 2 each -- so the boundary is doing work, not being ignored.
    const whole = structure(repeat('a', 4), one('s', 4));
    const split = structure(repeat('a', 4), ['s1', 's2', 's1', 's2']);

    expect(whole.runs).toBe(1);
    expect(whole.longestRun).toBe(4);
    expect(split.partitions).toBe(2);
    expect(split.runs).toBe(2);
    expect(split.longestRun).toBe(2);
  });

  it('reports runsPerExpected below 1 when a long run hides behind margins that predict many runs', () => {
    // Ten 'x' then one 'y' in one session: 2 runs. The marginals predict
    // 1 + 10 * (1 - ((10/11)^2 + (1/11)^2)) = 1 + 10 * (1 - 0.8347107438016529) = 2.652892561983471.
    const measured = structure([...repeat('x', 10), 'y'], one('s', 11));

    expect(measured.runs).toBe(2);
    expect(measured.expectedRuns).toBeCloseTo(2.652892561983471, 10);
    expect(measured.runsPerExpected).toBeLessThan(1);
  });

  it('reports the longest single run of one value within one partition', () => {
    const measured = structure(['a', 'b', 'b', 'b', 'a'], one('s', 5));

    expect(measured.longestRun).toBe(3);
  });

  it('excludes a null value from rows rather than treating it as its own value', () => {
    // Only 'a', 'a' and 'b' count -- 3 rows, and ['a','a','b'] is 2 runs.
    const measured = structure(['a', null, 'a', null, 'b'], one('s', 5));

    expect(measured.rows).toBe(3);
    expect(measured.runs).toBe(2);
  });

  it('excludes a null partition rather than dropping it into a neighbouring one', () => {
    // The 'x' sits in no partition, so it belongs to no run: s1 holds ['a','a'] and reads 1 run.
    // Had it been in s1 the column would read ['a','x','a'] and 3.
    const measured = structure(['a', 'x', 'a'], ['s1', null, 's1']);

    expect(measured.rows).toBe(2);
    expect(measured.runs).toBe(1);
  });

  it('reports zeroes for an empty column rather than dividing by zero runs', () => {
    const measured = structure([null, null], one('s', 2));

    expect(measured.rows).toBe(0);
    expect(measured.runs).toBe(0);
    expect(measured.rowsPerRun).toBe(0);
    expect(measured.stateLike).toBe(false);
  });

  it('refuses values and partitions of different lengths', () => {
    expect(() => structure(['a', 'b'], ['s'])).toThrow(RunStructureError);
  });
});

describe('PSEUDOREPLICATION_AT', () => {
  it('is 2, the smallest average run at which half the rows are repetitions', () => {
    expect(PSEUDOREPLICATION_AT).toBe(2);
  });

  it('is the boundary the stateLike flag turns on, inclusively', () => {
    // Two rows per run: ['a','a'] is exactly at the threshold and must flag.
    expect(structure(repeat('a', 2), one('s', 2)).stateLike).toBe(true);
  });
});
