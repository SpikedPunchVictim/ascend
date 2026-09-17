/**
 * EV-18 arm A, second half: what does nothing cost?
 *
 * The first half measured a full `asc record` at p50 ~174 ms. That number is only interpretable
 * against a floor, and the floor is the finding: if a bare Node process already costs more than the
 * whole recording, then P1's "under 100 ms" was never reachable by any change to `asc record`, and
 * the thing to optimise -- if anything is -- is process start, not the write.
 *
 * Three rungs, so the gap between them says which layer the time is in:
 *
 *   node -e 0          the interpreter alone
 *   asc --version      the CLI with oclif's command dispatch, and no store opened
 *   asc query ...      the CLI with a store opened and a real query answered
 *
 * `asc record` sits between rungs 2 and 3. If rung 2 is already at the record's p50, the record's
 * own work -- validate, insert, index -- is inside the noise of starting the process at all, which
 * is what EV-8 said (0.150 ms) and what this makes legible.
 *
 * n=20 per rung, same as arm A, so the percentiles are comparable rather than merely both present.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const bin = join(root, 'packages/cli/dist/bin.js');
const N = 20;

const dir = mkdtempSync(join(tmpdir(), 'ev18-floor-'));
mkdirSync(join(dir, '.git'));
const init = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8' });
if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);

/** Time one spawn to exit. `node -e 0` is run through `process.execPath` for the same reason. */
function timed(file, argv, cwd) {
  const start = process.hrtime.bigint();
  const result = spawnSync(file, argv, { cwd, encoding: 'utf8' });
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, status: result.status };
}

const rungs = {
  'node -e 0': () => timed(process.execPath, ['-e', '0'], root),
  'asc --version': () => timed(process.execPath, [bin, '--version'], root),
  /**
   * `--help` gets its own rung because it is the one rung with a published target attached:
   * cli-best-practices, which this project adopted, says "target <100 ms to `--help`". Measuring
   * `--version` and reporting it as `--help` would be answering a different question than the one
   * the standard asks, so both are measured and both are reported.
   */
  'asc --help': () => timed(process.execPath, [bin, '--help'], root),
  'asc query': () =>
    timed(
      process.execPath,
      [bin, 'query', '--json', 'SELECT COUNT(*) AS n FROM entries'],
      dir,
    ),
};

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const summary = {};
for (const [name, run] of Object.entries(rungs)) {
  const runs = [];
  for (let i = 0; i < N; i += 1) runs.push(run());
  const bad = runs.filter((entry) => entry.status !== 0).length;
  const ms = runs.map((entry) => entry.ms);
  summary[name] = {
    n: runs.length,
    failed: bad,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    min: Math.min(...ms),
    max: Math.max(...ms),
  };
}

mkdirSync(join(root, 'spike', 'tmp'), { recursive: true });
const out = join(root, 'spike', 'tmp', 'ev18-floor.json');
writeFileSync(out, JSON.stringify({ n: N, summary }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`\nwrote ${out}`);
if (Object.values(summary).some((rung) => rung.failed > 0)) {
  throw new Error('a rung failed -- a failed spawn is fast and would lower the floor');
}
