import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunnerTestFile as File } from 'vitest';
import FailureLog from '../vitest.failure-log.js';
import { FULL_SCOPE, TEST_SCOPE_ENV } from './gate-scope.mjs';

/**
 * What the failure log says about the run a red happened in (`asc-5swk`).
 *
 * **The log's problem was that it could not tell a deliberate red from an accidental one.** A
 * killer test fails ON PURPOSE, by design, and the mutation runner produces hundreds of those in
 * bursts; measured 2026-10-09, 248 of 278 red runs were single-file killer runs and 89.2% of red
 * RUNS were mutant kills. The one full-suite red the log exists for then sat among 2078 lines,
 * findable only by knowing the `run_tests <= 200` threshold.
 *
 * The fix is to STATE the fact instead of leaving it to be inferred: `scripts/mutate.mjs` marks
 * the vitest it spawns with `ASCEND_MUTATION=1`, and the reporter writes `mutant` and `scope` on
 * every line. The filter a reader then applies is
 * `jq 'select(.mutant != true and .scope != "subset")'` -- and the test below is the assertion
 * that both fields are actually written, because a mark nobody records would leave the log exactly
 * as it was.
 *
 * The log path is redirected through `ASCEND_FAILURE_LOG`, for the reason
 * `test-count-reporter.test.ts` gives about its scan: asserting into the real artifact would write
 * into a file another session's suite may be appending to at that moment.
 */

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * One run of the reporter, and the lines it appended.
 *
 * `env` is applied for the call only and the keys it touches are restored by name afterwards, so
 * the two cases below cannot leak into each other or into the rest of the suite.
 */
function linesFrom(env: Readonly<Record<string, string | undefined>>): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), 'asc-failure-log-'));
  made.push(dir);
  const log = join(dir, 'test-failures.log');

  // `delete process.env[key]` is refused by `@typescript-eslint/no-dynamic-delete`, which is right
  // about the hazard in general: this is the same operation spelled as a call, and the keys it can
  // receive are exactly the three the fixture names.
  const drop = (key: string): void => {
    Reflect.deleteProperty(process.env, key);
  };

  const saved: Record<string, string | undefined> = {};
  for (const key of ['ASCEND_FAILURE_LOG', 'ASCEND_MUTATION', TEST_SCOPE_ENV]) {
    saved[key] = process.env[key];
  }
  try {
    process.env['ASCEND_FAILURE_LOG'] = log;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) drop(key);
      else process.env[key] = value;
    }
    const reporter = new FailureLog();
    reporter.onFinished([fakeFile()]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) drop(key);
      else process.env[key] = value;
    }
  }

  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A file with one failing test, in the shape `fullName` and the failed-filter read. */
function fakeFile(): File {
  const file = { name: 'packages/cli/test/example.test.ts', tasks: [] as unknown[] };
  file.tasks.push({
    type: 'test',
    name: 'reds under load',
    file,
    result: { state: 'fail', duration: 12, errors: [{ message: 'boom\nthe trace' }] },
  });
  return file as unknown as File;
}

describe('the failure log names the kind of run a red came from', () => {
  it('marks a mutation run, and says a single-file run is a subset', () => {
    const [line] = linesFrom({ ASCEND_MUTATION: '1', [TEST_SCOPE_ENV]: undefined });
    expect(line).toMatchObject({ mutant: true, scope: 'subset' });
    // The reason the marking matters: the killer's red is real but EXPECTED, and the line says so
    // rather than leaving a reader to infer it from the test count.
    expect(line?.['file']).toBe('packages/cli/test/example.test.ts');
    expect(line?.['test']).toBe('reds under load');
  });

  it('does not mark an ordinary full-suite run, which is the line the log exists for', () => {
    const [line] = linesFrom({ ASCEND_MUTATION: undefined, [TEST_SCOPE_ENV]: FULL_SCOPE });
    expect(line).toMatchObject({ mutant: false, scope: 'full' });
  });
});
