import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import type { RunnerTask as Task, RunnerTestFile as File } from 'vitest';
import type { Reporter } from 'vitest/reporters';

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
 */
const LOG = new URL('./test-failures.log', import.meta.url);

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
      }),
    );
    appendFileSync(LOG, `${lines.join('\n')}\n`);
  }
}
