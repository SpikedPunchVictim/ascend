import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import TestCount from '../vitest.test-count.js';
import { FULL_SCOPE, SUBSET_SCOPE, TEST_SCOPE_ENV } from './gate-scope.mjs';

/**
 * What the test-count reporter writes, and what it must not.
 *
 * WHY THE REPORTER NEEDS ITS OWN TEST. `asc-09wx.14`'s third cut narrows the suite on commit to the
 * packages the staged paths can reach, and this reporter rewrites `.testcount/scan.json` on every
 * run. A narrowed run that wrote its own scan would shrink it to a handful of files, and
 * `scripts/test-baseline.mjs` -- which compares that scan against the tracked baseline -- would then
 * report a breach on EVERY commit: a false red blamed on the tests rather than on the cut. The seam
 * is the one the reporter's docblock names: *"only the gate knows the run it just watched was the
 * full one."*
 *
 * The predicate itself is covered by `gate-scope.test.ts` (`recordsWholeSuite`). What only this file
 * can cover is that the reporter USES it -- a guard that is asserted but unwired is the shape
 * `dogfood/0061` records, where a check that was present and a check that was never called produced
 * the same green.
 *
 * WHY A TEMP PATH AND NOT THE REAL ONE. The reporter takes `ASCEND_TEST_SCAN` for the same reason
 * `scripts/test-baseline.mjs` takes `--scan`: a test that had to write the real artifact to observe
 * this behaviour would be asserting into -- and then restoring -- a file another session's suite may
 * be writing at that moment. Both directions below are held to a file this test made.
 */

/** Every directory this file made, so the suite can remove exactly those and nothing else. */
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the reporter once with the scan pointed at a fresh file, and reports whether that file exists
 * afterwards.
 *
 * `env` is applied for the call only, so neither direction can leak into the other. What is saved
 * and put back is the two keys this fixture touches, by name -- not a snapshot of the whole
 * environment: the fixture cannot change any other key, and putting a whole-environment diff back
 * would mean deleting whatever the call added, which needs a computed key.
 */
function runReporter(env: Record<string, string>): { written: boolean; scan: unknown } {
  const dir = mkdtempSync(join(tmpdir(), 'asc-test-count-'));
  made.push(dir);
  const scan = join(dir, 'scan.json');

  const before = new Map([
    ['ASCEND_TEST_SCAN', process.env['ASCEND_TEST_SCAN']],
    [TEST_SCOPE_ENV, process.env[TEST_SCOPE_ENV]],
  ]);
  try {
    process.env['ASCEND_TEST_SCAN'] = scan;
    // Cleared, not merely unset by the caller: the case under test must be the only thing setting
    // it, whatever environment this suite happens to be running under.
    Reflect.deleteProperty(process.env, TEST_SCOPE_ENV);
    Object.assign(process.env, env);
    // No files, because this is about whether anything is written at all. A run that collected
    // nothing is still a run whose counts are a true count of what it collected.
    new TestCount().onFinished([]);
  } finally {
    for (const [key, value] of before) restoreEnv(key, value);
  }

  return {
    written: existsSync(scan),
    scan: existsSync(scan) ? JSON.parse(readFileSync(scan, 'utf8')) : null,
  };
}

/**
 * Puts one environment key back the way it was, including "it was not set at all".
 *
 * A computed key cannot be `delete`d here, and `process.env[key] = undefined` is not the same thing:
 * Node stores the string `"undefined"`, leaving the key PRESENT -- which reads as set to every
 * `in` test and to `!== undefined` comparisons downstream.
 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('the scan a narrowed run must not write', () => {
  it('writes the scan for a run that says it collected the suite, so the guard is not "never write"', () => {
    // The direction that makes the other one mean something: a reporter that returned early always
    // would pass the test below and break the baseline check for every full run.
    const { written, scan } = runReporter({ [TEST_SCOPE_ENV]: FULL_SCOPE });

    expect(written).toBe(true);
    expect(scan).toMatchObject({ files: 0, tests: 0, passed: 0, byFile: {} });
  });

  it('writes nothing when the run was narrowed to the packages a commit reaches', () => {
    // The whole point. The file is left as the last FULL run wrote it, which is what keeps
    // `scripts/test-baseline.mjs` from reading a subset as a breached floor.
    const { written } = runReporter({ [TEST_SCOPE_ENV]: SUBSET_SCOPE });

    expect(written).toBe(false);
  });

  it('writes nothing for any value that is not the word (`asc-19x2`)', () => {
    // An equality on the whole word, not a truthiness test and not a suffix match: silence is what
    // `pnpm vitest run <one file>` sets, and that is not the suite either.
    for (const value of ['', '0', 'subsetted', 'FULL', 'subset']) {
      expect(runReporter({ [TEST_SCOPE_ENV]: value }).written, value).toBe(false);
    }
    expect(runReporter({}).written).toBe(false);
  });
});
