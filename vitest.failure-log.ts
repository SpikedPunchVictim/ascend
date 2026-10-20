import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { RunnerTask as Task, RunnerTestFile as File } from 'vitest';
import type { Reporter } from 'vitest/reporters';
import { recordsWholeSuite } from './scripts/gate-scope.mjs';

/**
 * Appends every failed test to `test-failures.log`, and never overwrites it (asc-9ac).
 *
 * One full-suite run in three went red on 2026-09-20, and the failing test was never named: the
 * terminal output scrolled away and the next run was green. A red run is rare and does not
 * reproduce on demand -- it is contention, measured -- so the only way to name it is to have
 * written it down when it happened. Appending, not replacing, is the point: a later green run
 * must not erase the one red run anyone would want to read.
 *
 * Each line carries the load average and the run's summed test time, because asc-9ac's whole
 * question is load against growth, and a failure without the load it failed under cannot answer
 * it. Ignored by `*.log` in .gitignore: it is evidence about this machine, not the product.
 *
 * **`mutant` and `scope` exist because the log filled up with deliberate reds (`asc-5swk`).**
 * Measured 2026-10-09: 2078 lines across 278 red runs, 248 of them single-file runs -- mostly the
 * mutation runner's killer files, which fail on purpose, seconds apart -- and 89.2% of red RUNS
 * were deliberate kills. A reader then had to know the `run_tests <= 200` threshold to find the
 * one line the log exists for. `mutant` is set by `scripts/mutate.mjs` on the vitest it spawns, so
 * the distinction is stated rather than inferred, and `scope` says whether the run collected the
 * whole suite (`recordsWholeSuite`, the same predicate `vitest.test-count.ts` uses). The filter a
 * reader now applies is `jq 'select(.mutant != true and .scope != "subset")'`.
 *
 * Lines written before these fields existed do not carry them; absence means "not stated", not
 * `false`, so that filter KEEPS them -- a `scope == "full"` filter would silently drop every red
 * this log recorded before 2026-10-20, including the one timeout it exists for.
 */
const DEFAULT_LOG = new URL('./test-failures.log', import.meta.url);

/** Where a run appends. Overridable so a test can watch the file without writing the real one. */
const logPath = (): string => process.env['ASCEND_FAILURE_LOG'] ?? fileURLToPath(DEFAULT_LOG);

function tests(tasks: readonly Task[]): Task[] {
  return tasks.flatMap((task) =>
    task.type === 'test' ? [task] : 'tasks' in task ? tests(task.tasks) : [],
  );
}

/** `describe > ... > test`. The file is `file`, and is left out whether or not it is a `suite`. */
function fullName(task: Task): string {
  const names: string[] = [];
  for (let at: Task | undefined = task; at !== undefined; at = at.suite) {
    if (at !== task.file) names.unshift(at.name);
  }
  return names.join(' > ');
}

export default class FailureLog implements Reporter {
  onFinished(files: File[] = []): void {
    const all = tests(files);
    const failed = all.filter((task) => task.result?.state === 'fail');
    if (failed.length === 0) return;
    const summed = all.reduce((sum, task) => sum + (task.result?.duration ?? 0), 0);
    const at = new Date().toISOString();
    const load = loadavg()
      .map((one) => one.toFixed(2))
      .join(' ');
    // Read once per run rather than per line: both are facts about the RUN, and a reader
    // filtering for the reds that matter must see the same answer on every line it produced.
    const mutant = process.env['ASCEND_MUTATION'] === '1';
    const scope = recordsWholeSuite(process.env) ? 'full' : 'subset';
    const lines = failed.map((task) =>
      JSON.stringify({
        at,
        file: task.file.name,
        test: fullName(task),
        duration_ms: Math.round(task.result?.duration ?? 0),
        error: task.result?.errors?.[0]?.message.split('\n')[0],
        loadavg: load,
        run_tests: all.length,
        run_summed_ms: Math.round(summed),
        mutant,
        scope,
      }),
    );
    appendFileSync(logPath(), `${lines.join('\n')}\n`);
  }
}
