/**
 * asc-baj.1, second half: the CPU profile says 80.7% of `asc --help` is "node-internal", but that
 * bucket contains the MODULE LOADER as well as the interpreter's own boot -- so it cannot, by
 * itself, separate "Node is slow to start" from "Node is slow to load what oclif drags in". These
 * rungs do separate them, because each adds exactly one layer:
 *
 *   node -e 0                      the interpreter alone
 *   node -e import('@oclif/core')  + oclif's module graph, nothing else
 *   asc --help                     + ascend's own entry point and command manifest
 *
 * The gaps are the finding. Same n and same percentile treatment as EV-18's arms so the numbers
 * are comparable to the 171.414 ms already recorded on the bead.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const bin = join(process.cwd(), 'packages/cli/dist/bin.js');
const oclif = join(process.cwd(), 'node_modules/@oclif/core/lib/index.js');
const N = Number(process.argv[2] ?? 20);

function timed(argv) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, status: r.status, stderr: r.stderr };
}

const rungs = [
  ['node -e 0', ['-e', '0']],
  ["import('@oclif/core')", ['-e', `import(${JSON.stringify(oclif)}).then(()=>{})`]],
  ['asc --help', [bin, '--help']],
];

const p = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

console.log(`n = ${N} per rung, node ${process.version}, fresh process each time\n`);
console.log('rung                      p50          p95        gap over previous (p50)');
console.log('------------------------|------------|------------|----------------------');
let prev = null;
for (const [label, argv] of rungs) {
  const runs = [];
  for (let i = 0; i < N; i++) {
    const t = timed(argv);
    if (t.status !== 0) throw new Error(`${label} exited ${t.status}: ${t.stderr.slice(0, 200)}`);
    runs.push(t.ms);
  }
  const p50 = p(runs, 0.5), p95 = p(runs, 0.95);
  const gap = prev === null ? '' : `+${(p50 - prev).toFixed(3)} ms`;
  console.log(`${label.padEnd(24)}| ${p50.toFixed(3).padStart(9)} ms | ${p95.toFixed(3).padStart(9)} ms | ${gap}`);
  prev = p50;
}
