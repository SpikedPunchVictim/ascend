import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerTask as Task, RunnerTestFile as File } from 'vitest';
import type { Reporter } from 'vitest/reporters';

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
 * Written on every run, red or green: collection is unaffected by failures, so a red run's count is
 * still a true count. `.testcount/scan.json` is gitignored -- evidence about one machine's run, the
 * same reason `.align/last-scan.json` is.
 */
const SCAN = new URL('./.testcount/scan.json', import.meta.url);

/** Depth-first collection: every task of type `test`, at any nesting. */
function tests(tasks: readonly Task[]): Task[] {
  return tasks.flatMap((task) =>
    task.type === 'test' ? [task] : 'tasks' in task ? tests(task.tasks) : [],
  );
}

export default class TestCount implements Reporter {
  onFinished(files: File[] = []): void {
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

    const path = fileURLToPath(SCAN);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(scan, null, 2)}\n`, 'utf8');
  }
}
