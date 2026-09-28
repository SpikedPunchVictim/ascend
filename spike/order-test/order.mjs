// asc-ks5 (a): does a derived entry's type depend on the type before it, within a session, beyond
// that session's own type mix? Pre-registered in the asc-ks5 notes (2026-09-28) before this ran.
//
// Reads the store only through `asc query`. Prints counts, never entry text.
//
//   node spike/order-test/order.mjs [permutations]

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mulberry32, seedOf } from '../../packages/analysis/dist/random.js';
import { benjaminiHochberg } from '../../packages/analysis/dist/association.js';

const MIN_N = 20;
const N = Number(process.argv[2] ?? 10000);
const repo = join(import.meta.dirname, '../..');

const SQL = `
select type_name as type,
       json_extract(properties_json, '$.session_id') as session,
       json_extract(properties_json, '$.occurred_at') as at,
       id
from entries e
where source = 'derived:claude-code'
  and not exists (select 1 from annotations a where a.entry_id = e.id and a.scheme = 'invalidation')
order by session, at, id`;

const out = JSON.parse(
  execFileSync(process.execPath, [join(repo, 'packages/cli/dist/bin.js'), 'query', SQL, '--json'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }),
);
if (out.coverage.has_more) throw new Error(`query truncated: ${JSON.stringify(out.coverage)}`);

const types = [...new Set(out.rows.map((row) => row.type))].sort();
const K = types.length;
const index = new Map(types.map((type, i) => [type, i]));

// Per session: the label sequence and a mask of adjacent pairs that count (distinct occurred_at).
const sessions = new Map();
let missing = 0;
for (const row of out.rows) {
  if (row.session == null || row.at == null) {
    missing += 1;
    continue;
  }
  let s = sessions.get(row.session);
  if (s === undefined) sessions.set(row.session, (s = { labels: [], at: [] }));
  s.labels.push(index.get(row.type));
  s.at.push(row.at);
}
const seqs = [...sessions.values()].map((s) => ({
  labels: s.labels,
  counted: s.labels.slice(1).map((_, i) => s.at[i] !== s.at[i + 1]),
}));

function count(labelsOf) {
  const c = new Float64Array(K * K);
  for (const seq of seqs) {
    const labels = labelsOf(seq);
    for (let i = 0; i < seq.counted.length; i += 1)
      if (seq.counted[i]) c[labels[i] * K + labels[i + 1]] += 1;
  }
  return c;
}

const observed = count((seq) => seq.labels);
const random = mulberry32(seedOf('ascend'));
const shuffle = (labels) => {
  const a = labels.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const perms = [];
const mean = new Float64Array(K * K);
for (let p = 0; p < N; p += 1) {
  const c = count((seq) => shuffle(seq.labels));
  perms.push(c);
  for (let k = 0; k < K * K; k += 1) mean[k] += c[k] / N;
}

const diagonal = (k) => Math.floor(k / K) === k % K;
const stat = (c, keep) => {
  let g = 0;
  for (let k = 0; k < K * K; k += 1)
    if (keep(k) && mean[k] > 0) g += (c[k] - mean[k]) ** 2 / mean[k];
  return g;
};
const pOf = (keep) => {
  const g = stat(observed, keep);
  const beyond = perms.filter((c) => stat(c, keep) >= g).length;
  return { g, p: (1 + beyond) / (1 + N) };
};

const all = pOf(() => true);
const off = pOf((k) => !diagonal(k));
const diagShare = stat(observed, diagonal) / all.g;

// Per-cell two-sided permutation p: how often a permutation lands at least as far from the mean.
const cells = [];
for (let k = 0; k < K * K; k += 1) {
  const d = Math.abs(observed[k] - mean[k]);
  const beyond = perms.filter((c) => Math.abs(c[k] - mean[k]) >= d).length;
  cells.push({ k, p: (1 + beyond) / (1 + N) });
}
const q = benjaminiHochberg(cells.map((cell) => cell.p));

const pairs = observed.reduce((a, b) => a + b, 0);
const ties = seqs.reduce((a, s) => a + s.counted.filter((x) => !x).length, 0);
console.log(`entries ${out.rows.length}, without session or time ${missing}`);
console.log(`sessions ${seqs.length}, sessions with >=2 entries ${seqs.filter((s) => s.labels.length >= 2).length}`);
console.log(`adjacent pairs counted ${pairs}, excluded as ties ${ties}`);
console.log(`permutations ${N}, seed 'ascend'`);
console.log(`G ${all.g.toFixed(2)} p ${all.p.toFixed(5)}`);
console.log(`G_off ${off.g.toFixed(2)} p ${off.p.toFixed(5)}`);
console.log(`diagonal share of G ${(100 * diagShare).toFixed(1)}%`);
const offCells = cells.filter((cell) => !diagonal(cell.k));
console.log(`off-diagonal cells with E >= ${MIN_N}: ${offCells.filter((c) => mean[c.k] >= MIN_N).length} of ${offCells.length}`);
console.log('from -> to | observed | E (null mean) | ratio | p | BH q | E>=MIN_N');
for (const cell of cells) {
  const from = types[Math.floor(cell.k / K)];
  const to = types[cell.k % K];
  const e = mean[cell.k];
  console.log(
    [
      `${from} -> ${to}`,
      observed[cell.k],
      e.toFixed(2),
      e > 0 ? (observed[cell.k] / e).toFixed(2) : '-',
      cell.p.toFixed(5),
      q[cell.k].toFixed(5),
      e >= MIN_N ? 'yes' : 'anecdote',
    ].join(' | '),
  );
}
