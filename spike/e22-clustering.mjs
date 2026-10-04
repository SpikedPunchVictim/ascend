/**
 * The clustering measurement behind Stage E22 (asc-0hys), kept as the regression check.
 *
 * Run: node spike/e22-clustering.mjs        (needs `pnpm build`, it drives the real binary)
 *
 * WHAT IT MEASURES. How much information this store's entries actually carry, once the fact that a
 * session contributes many of them is accounted for. Two tables:
 *
 *   1. the size-only bound, n_eff = N^2 / sum_i m_i^2 -- what the effective N would be if the outcome
 *      were PERFECTLY clustered (rho = 1). This needs no outcome and is the floor.
 *   2. the estimated intraclass correlation and design effect for a few real binary outcomes, via the
 *      one-way ANOVA estimator the shipped `design-effect.ts` uses.
 *
 * THREE PROBES BEFORE THIS ONE WERE WRONG, and each looked plausible -- which is why every quantity
 * below is asserted against an invariant rather than printed on trust:
 *
 *   - `sum(c*c)` over the window subquery summed c^2 PER ROW, and each row carried its session's
 *     size, so it computed sum m_i^3 rather than sum m_i^2: off by one power.
 *   - `case when verdict then 1 else 0 end` returns 0 for 'passed'. SQLite converts text to a NUMBER
 *     for a boolean test and 'passed' casts to 0, so the probe was measuring an all-zero outcome and
 *     would have reported rho = 0 for everything. Every outcome here is encoded explicitly.
 *   - the design effect used the ANOVA sum-of-squares helper `A = sum s_i^2/m_i` where the SIZE FACTOR
 *     `sum m_i^2` was needed, giving `deff = 0.9` -- below 1, which is impossible.
 *
 * The invariant that catches all three: `deff >= 1`, `n_eff <= N`, and at rho = 1 also `n_eff <= k`.
 * A probe that cannot state what it must never print is a probe that will one day print it.
 */

import { execFileSync } from 'node:child_process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const BIN = `${root}/packages/cli/dist/bin.js`;

const q = (sql) =>
  JSON.parse(
    execFileSync(process.execPath, [BIN, 'query', sql, '--json'], {
      encoding: 'utf8',
      maxBuffer: 128e6,
    }),
  ).rows;

// Explicit 0/1 encodings only -- see the `case when` note above.
const CANDIDATES = [
  ['v_verification_run_v2', "verdict = 'passed'", 'verdict=passed'],
  ['v_context_compaction_v1', "trigger = 'auto'", 'trigger=auto'],
  ['v_tool_denial_v1', "tool_name = 'Bash'", 'tool=Bash'],
  ['v_skill_activation_v1', "skill = 'bug-hunt'", 'skill=bug-hunt'],
  ['v_review_finding_v1', "verdict = 'CONFIRMED'", 'verdict=CONFIRMED'],
];

const Z = 1.96;
const wilsonHalfWidth = (p, n) =>
  (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / (1 + (Z * Z) / n);

function assert(name, ok, detail) {
  if (!ok) throw new Error(`${name}: ${detail}`);
}

console.log('\n1. The size-only bound (rho = 1), by view -- how bad it could be\n');
console.log(
  'view'.padEnd(26),
  'N'.padStart(5),
  'k'.padStart(4),
  'largest'.padStart(8),
  'n_eff(rho=1)'.padStart(12),
  'N/n_eff'.padStart(8),
);

const views = q("select name from sqlite_master where type='view' order by name").map((r) => r.name);
for (const view of views) {
  const columns = q(`select name from pragma_table_info('${view}')`).map((r) => r.name);
  if (!columns.includes('session_id')) continue;
  // One row per ENTRY, each carrying its session's size m. So count(*) = N, max(m) = largest cluster,
  // and sum(m) = sum_i m_i^2. (NOT sum(m*m): that would be sum m_i^3.)
  const [row] = q(
    `select count(*) as n, count(distinct session_id) as k, max(m) as largest, sum(m) as sizeFactor
     from (select session_id, count(*) over (partition by session_id) as m from ${view})`,
  );
  const n = Number(row.n);
  const k = Number(row.k);
  const sizeFactor = Number(row.sizeFactor);
  const nEff = (n * n) / sizeFactor;
  assert(view, nEff >= 1 && nEff <= n + 1e-9, `n_eff ${nEff} outside [1, N=${n}]`);
  assert(view, nEff <= k + 1e-9, `n_eff ${nEff} above its ceiling k=${k} at rho=1`);
  console.log(
    view.padEnd(26),
    String(n).padStart(5),
    String(k).padStart(4),
    String(Number(row.largest)).padStart(8),
    nEff.toFixed(1).padStart(12),
    (n / nEff).toFixed(1).padStart(8),
  );
}

console.log('\n2. The estimated correction, for real binary outcomes\n');
console.log(
  'outcome'.padEnd(22),
  'k'.padStart(4),
  'N'.padStart(5),
  'p'.padStart(6),
  'rho'.padStart(7),
  'deff'.padStart(6),
  'n_eff'.padStart(7),
  ' 95% half-width: naive -> corrected',
);

for (const [view, predicate, label] of CANDIDATES) {
  // A = sum_i s_i^2/m_i (the ANOVA helper); M2 = sum_i m_i^2 (the SIZE FACTOR). Conflating them is
  // the third bug named above: the first is bounded by S, the second by N^2.
  const [row] = q(
    `with e as (select session_id as s, case when ${predicate} then 1 else 0 end as y from ${view}),
          g as (select s, count(*) as m, sum(y) as sy from e group by s)
     select (select count(*) from e) as N, (select count(*) from g) as k,
            (select sum(y) from e) as S, (select sum(sy * 1.0 * sy / m) from g) as A,
            (select sum(m * m) from g) as M2`,
  );
  const N = Number(row.N);
  const k = Number(row.k);
  const S = Number(row.S);
  const A = Number(row.A);
  const M2 = Number(row.M2);
  const p = S / N;

  const msb = (A - (S * S) / N) / (k - 1);
  const msw = (S - A) / (N - k);
  const m0 = (N - M2 / N) / (k - 1);
  const den = msb + (m0 - 1) * msw;
  const rho = den === 0 ? 0 : Math.min(1, Math.max(0, (msb - msw) / den));
  const deff = 1 + (M2 / N - 1) * rho;
  const nEff = N / deff;

  assert(label, deff >= 1 - 1e-12, `deff ${deff} below 1`);
  assert(label, nEff <= N + 1e-9 && nEff >= 1, `n_eff ${nEff} outside [1, N=${N}]`);
  console.log(
    label.padEnd(22),
    String(k).padStart(4),
    String(N).padStart(5),
    p.toFixed(3).padStart(6),
    rho.toFixed(4).padStart(7),
    deff.toFixed(2).padStart(6),
    nEff.toFixed(0).padStart(7),
    `  ${(wilsonHalfWidth(p, N) * 200).toFixed(1)}pp -> ${(wilsonHalfWidth(p, nEff) * 200).toFixed(1)}pp`,
  );
}

console.log('\nEvery invariant held. 9 of 16 views have no session_id column and are not listed:');
const withoutKey = views.filter(
  (view) => !q(`select name from pragma_table_info('${view}')`).map((r) => r.name).includes('session_id'),
);
console.log(`  ${withoutKey.join(', ')}`);
