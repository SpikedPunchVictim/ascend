import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerTask as Task, RunnerTestFile as File } from 'vitest';
import type { Reporter } from 'vitest/reporters';
import { recordsWholeSuite } from './scripts/gate-scope.mjs';

/**
 * Writes what the run COLLECTED into `.testcount/scan.json`, so a later step can compare it
 * against a baseline (asc-049w).
 *
 * WHY THE RUNNER HAS TO BE THE ONE THAT COUNTS. `dogfood/0061` is a green gate over a file whose 55
 * tests had become 5. The fix needs a number to compare, and the obvious source -- `grep -c "it("`
 * over the test files -- was wrong **twice** while that finding was being measured: it misses
 * `it.each` expansion and a double-quoted name, and both misses are in the direction the check is
 * supposed to detect. So the count is not derived from the files at all; it is whatever vitest
 * actually collected, written by the process that collected it.
 *
 * WHY NOT PARSE `pnpm test`'s TERMINAL OUTPUT. The summary lines (`Tests 3036 passed | 2 skipped
 * (3038)`) carry a total and nothing else -- no per-file breakdown, so a failure could not name the
 * file it is about, and a number scraped out of another program's stdout changes shape when that
 * program's presentation does. `vitest.failure-log.ts` already established the shape here: a
 * reporter, registered in `vitest.config.ts`, writing an artifact about one run.
 *
 * WHAT IT IS NOT. It does not fail the run; it records. The comparison lives in
 * `scripts/test-baseline.mjs`, which the gate runs *after* the suite, because only the gate knows
 * the run it just watched was the full one.
 *
 * WHICH IS WHY IT ASKS, AND WHY SILENCE IS NOT AN ANSWER (`asc-19x2`). The gate narrows the suite to
 * the packages a commit's staged paths can reach (`scripts/gate-scope.mjs`, `asc-09wx.14`) and sets
 * `ASCEND_TEST_SCOPE=subset` on that step; a subset run writes NO scan, because its count is a true
 * count of the files it collected and a lie about the suite. But "absent means full" also covered
 * `pnpm vitest run <one file>`, which is not the suite either: measured 2026-10-13, it wrote a
 * 1-file scan and the baseline check read that as 3,026 tests below the floor. So the word has to be
 * said -- `ASCEND_TEST_SCOPE=full` -- by `pnpm test` and by the gate's own full-suite step.
 *
 * Written on every FULL run, red or green: collection is unaffected by failures, so a red run's
 * count is still a true count. `.testcount/scan.json` is gitignored -- evidence about one machine's
 * run, the same reason `.align/last-scan.json` is.
 *
 * WHERE IT WRITES. `ASCEND_TEST_SCAN` names the file, and its absence means `.testcount/scan.json`
 * beside this module. The override is a TEST seam, and it follows `scripts/test-baseline.mjs`, which
 * takes `--scan` for exactly this reason: a test that had to write the real artifact in order to
 * observe this reporter would be asserting into -- and then restoring -- a file another session's
 * run may be writing at the same moment. It is read inside `onFinished` rather than at import, so a
 * test can set it.
 */
const DEFAULT_SCAN = fileURLToPath(new URL('./.testcount/scan.json', import.meta.url));

/** The file this run's counts go to: `ASCEND_TEST_SCAN`, or the default above. */
function scanPath(): string {
  const override = process.env['ASCEND_TEST_SCAN'];
  return override === undefined || override === '' ? DEFAULT_SCAN : override;
}

/** Depth-first collection: every task of type `test`, at any nesting. */
function tests(tasks: readonly Task[]): Task[] {
  return tasks.flatMap((task) =>
    task.type === 'test' ? [task] : 'tasks' in task ? tests(task.tasks) : [],
  );
}

export default class TestCount implements Reporter {
  onFinished(files: File[] = []): void {
    // The narrowed run, which must not leave a scan behind. Said out loud rather than done
    // silently: a reader who wonders why the baseline check was skipped should find the skip in the
    // suite's own output, not have to infer it from a file's timestamp.
    if (!recordsWholeSuite(process.env)) {
      console.log(
        '[test-count] this run did not say it collected the whole suite ' +
          '(ASCEND_TEST_SCOPE=full), so it did not write the scan -- the baseline check still ' +
          'reads the last full run',
      );
      return;
    }

    const byFile: Record<string, number> = {};
    let collected = 0;
    let passed = 0;

    for (const file of files) {
      const inFile = tests(file.tasks);
      byFile[file.name] = inFile.length;
      collected += inFile.length;
      passed += inFile.filter((task) => task.result?.state === 'pass').length;
    }

    const scan = {
      at: new Date().toISOString(),
      files: files.length,
      tests: collected,
      passed,
      byFile,
    };

    const path = scanPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(scan, null, 2)}\n`, 'utf8');
  }
}
