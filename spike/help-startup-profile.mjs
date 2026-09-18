/**
 * asc-baj.1: where does `asc --help`'s 171 ms actually go?
 *
 * The bead filed a wall-clock gap (p50 171.414 ms against a published target of <100) and said
 * explicitly what would make it actionable: "A profile of the first 100 ms (--cpu-prof on asc
 * --help) to see how much is oclif's plugin manifest and argument parsing versus ascend's own
 * imports. If most of it is oclif's command manifest, the fix may be a generated static manifest
 * rather than lazy imports, and the bead should say so with the number attached before anyone
 * starts cutting."
 *
 * So this attributes SELF time, not wall clock. A V8 CPU profile carries `nodes` (call frames),
 * `samples` (which node was on top at each tick) and `timeDeltas` (microseconds between ticks);
 * summing the deltas per sampled node gives self time, and the call frame's `url` says which layer
 * the frame belongs to. Four buckets, chosen to answer the bead's question and no more:
 *
 *   node-internal   node: builtins -- the interpreter's own startup, module loader, fs
 *   oclif           node_modules/@oclif/** -- dispatch, manifest, argument parsing
 *   dependency      any other node_modules
 *   ascend          packages/**\/dist/** -- this project's own imports
 *
 * Two caveats stated rather than buried. (1) --cpu-prof itself costs something, so the wall clock
 * here is NOT comparable to the bead's 171.414 ms; the shares are the finding, not the total.
 * (2) A sampling profiler misses work finer than its interval, which at default 1000us is most
 * individual requires -- so this says where the mass is, not what any one import cost.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = join(process.cwd(), 'packages/cli/dist/bin.js');
const N = Number(process.argv[2] ?? 10);

function bucket(url) {
  if (!url || url.startsWith('node:') || url === '') return 'node-internal';
  if (url.includes('/node_modules/@oclif/')) return 'oclif';
  if (url.includes('/node_modules/')) return 'dependency';
  if (url.includes('/packages/')) return 'ascend';
  return 'other';
}

/** Self time per bucket, in ms, from one .cpuprofile. */
function attribute(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    const b = node ? bucket(node.callFrame.url) : 'other';
    totals.set(b, (totals.get(b) ?? 0) + (timeDeltas[i] ?? 0));
  }
  const out = {};
  for (const [k, us] of totals) out[k] = us / 1000;
  return out;
}

const runs = [];
for (let i = 0; i < N; i++) {
  const dir = mkdtempSync(join(tmpdir(), 'asc-help-prof-'));
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ['--cpu-prof', '--cpu-prof-dir', dir, bin, '--help'], {
    encoding: 'utf8',
  });
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.status !== 0) throw new Error(`asc --help failed (${r.status}): ${r.stderr}`);
  const file = readdirSync(dir).find((f) => f.endsWith('.cpuprofile'));
  if (!file) throw new Error('no .cpuprofile written');
  const shares = attribute(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  runs.push({ wallMs, shares });
  rmSync(dir, { recursive: true, force: true });
}

const p = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const buckets = ['node-internal', 'oclif', 'dependency', 'ascend', 'other'];
const sampled = runs.map((r) => Object.values(r.shares).reduce((a, b) => a + b, 0));

console.log(`n = ${N}, node ${process.version}`);
console.log(`wall clock WITH --cpu-prof (not comparable to the bead's 171.414 ms):`);
console.log(`  p50 ${p(runs.map((r) => r.wallMs), 0.5).toFixed(3)} ms   p95 ${p(runs.map((r) => r.wallMs), 0.95).toFixed(3)} ms`);
console.log(`profiled (sampled) CPU time: p50 ${p(sampled, 0.5).toFixed(3)} ms`);
console.log('');
console.log('self time by layer, p50 across runs:');
const medTotal = p(sampled, 0.5);
for (const b of buckets) {
  const xs = runs.map((r) => r.shares[b] ?? 0);
  const med = p(xs, 0.5);
  if (med === 0 && b === 'other') continue;
  console.log(`  ${b.padEnd(14)} ${med.toFixed(3).padStart(8)} ms   ${((med / medTotal) * 100).toFixed(1).padStart(5)} %`);
}
