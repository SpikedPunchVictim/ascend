/**
 * Stage E22 / Stage 3 (asc-0hys): does a PER-ROW clustering correction move anything, and what
 * would it cost to compute?
 *
 * Run: node spike/e22-row-clusters.mjs        (needs `pnpm build`, it drives the real binary)
 *
 * WHY THIS SPIKE EXISTS. Stage 2 corrected ONE number per `wilson` call site, and the plan's measured
 * table showed the type-level correction is large (deff 5.2 for `verdict=passed`). Stage 3's plan says
 * `asc explore <type> --cluster <column>` corrects EVERY Wilson row it prints -- and every one of
 * those rows is a DIFFERENT outcome over a DIFFERENT population, over the SAME entries. rho is
 * outcome-specific, so the design must be recomputed per row. That is a design no one has measured.
 *
 * THE QUESTIONS, NAMED BEFORE MEASURING.
 *
 *   Q1  Is the per-row correction large enough to be worth a flag? A row whose deff is ~1 everywhere
 *       corrects nothing, and the renderer only prints a correction when `deff > 1` -- so the feature
 *       would be invisible on the rows that dominate the output.
 *   Q2  How many rows does it push below `MIN_N = 20`, reclassifying them as anecdotes?
 *   Q3  Does it hold the invariants the shipped estimator guarantees (`deff >= 1`, `n_eff <= N`, and
 *       `n_eff <= k` at rho = 1) on EVERY row, not just on the five hand-picked ones?
 *   Q4  How many SQL statements does the correction cost, per property and per row family?
 *
 * The arithmetic is the shipped estimator, spelled out here rather than imported: this probe's job is
 * to check the DESIGN, and an estimator that imported itself could not disagree with itself.
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

const Z = 1.96;
const halfWidth = (p, n) =>
  n <= 1 ? 0.5 : (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / (1 + (Z * Z) / n);
const pp = (p, n) => (halfWidth(p, n) * 200).toFixed(1);

function assert(name, ok, detail) {
  if (!ok) throw new Error(`${name}: ${detail}`);
}

/**
 * The shipped one-way ANOVA estimator, over `(m_i, s_i)` pairs -- the only shape any of these
 * queries can produce, and the shape a grouped entry point to `design-effect.ts` would take.
 */
function design(groups) {
  const N = groups.reduce((sum, g) => sum + g.m, 0);
  const k = groups.length;
  const S = groups.reduce((sum, g) => sum + g.s, 0);
  const A = groups.reduce((sum, g) => sum + (g.s * g.s) / g.m, 0);
  const M2 = groups.reduce((sum, g) => sum + g.m * g.m, 0);

  let rho;
  let rhoSource;
  if (k < 2) {
    rho = 1;
    rhoSource = 'assumed-perfect';
  } else if (N === k) {
    rho = 0;
    rhoSource = 'inapplicable';
  } else {
    const msb = (A - (S * S) / N) / (k - 1);
    const msw = (S - A) / (N - k);
    const m0 = (N - M2 / N) / (k - 1);
    const den = msb + (m0 - 1) * msw;
    rho = den === 0 ? 0 : Math.min(1, Math.max(0, (msb - msw) / den));
    rhoSource = 'estimated';
  }
  const deff = 1 + (M2 / N - 1) * rho;
  return { N, k, p: S / N, rho, rhoSource, deff, nEff: N / deff };
}

/** One grouped query: per-cluster (size, successes) for one binary outcome over one population. */
function tallies(view, cluster, outcome, population) {
  const rows = q(
    `select ${cluster} as k, count(*) as m, sum(case when ${outcome} then 1 else 0 end) as sy
       from ${view} where ${cluster} is not null and ${population}
      group by ${cluster}`,
  );
  return rows.map((r) => ({ key: r.k, m: Number(r.m), s: Number(r.sy) }));
}

const TYPE = 'tool_denial';
const VIEW = 'v_tool_denial_v1';
const CLUSTER = 'session_id';

console.log(`\nQ1/Q3. Every Wilson row \`asc explore ${TYPE} --cluster ${CLUSTER}\` would print\n`);

console.log(
  [
    'row'.padEnd(32),
    'k'.padStart(4),
    'N'.padStart(5),
    'p'.padStart(6),
    'rho'.padStart(7),
    'deff'.padStart(6),
    'n_eff'.padStart(6),
    'half-width'.padStart(14),
    'flag'.padStart(6),
  ].join(' '),
);

const flagged = [];
const moved = [];
let checked = 0;

function emit(label, groups) {
  const d = design(groups);
  checked += 1;
  assert(label, d.deff >= 1 - 1e-12, `deff ${d.deff} below 1`);
  assert(label, d.nEff <= d.N + 1e-9 && d.nEff >= 1, `n_eff ${d.nEff} outside [1, ${d.N}]`);
  assert(label, d.rho < 1 || d.nEff <= d.k + 1e-9, `n_eff ${d.nEff} above its ceiling k=${d.k}`);

  const belowMin = d.nEff < 20 && d.N >= 20;
  if (d.deff > 1) moved.push(label);
  if (belowMin) flagged.push(`${label} (n_eff ${d.nEff.toFixed(1)}, was ${d.N})`);
  console.log(
    [
      label.padEnd(32),
      String(d.k).padStart(4),
      String(d.N).padStart(5),
      d.p.toFixed(3).padStart(6),
      d.rho.toFixed(4).padStart(7),
      d.deff.toFixed(2).padStart(6),
      d.nEff.toFixed(1).padStart(6),
      `${pp(d.p, d.N)} -> ${pp(d.p, d.nEff)}`.padStart(14),
      (belowMin ? 'ANECD' : '').padStart(6),
    ].join(' '),
  );
}

// The aggregate `invalidated` row (asc-k6p.1): outcome = has ANY invalidation label, population =
// every entry in scope, denominator `count`. The view's own `invalidated` column IS that predicate.
emit('invalidated (any label)', tallies(VIEW, CLUSTER, 'invalidated is not null', '1 = 1'));

// The declared properties, read off the view's own `_state` columns rather than assumed.
const properties = q(`select name from pragma_table_info('${VIEW}')`)
  .map((r) => r.name)
  .filter((n) => n.endsWith('_state'))
  .map((n) => n.slice(0, -'_state'.length));

console.log(`\n  (properties in ${VIEW}: ${properties.join(', ')})\n`);

// Q4: one query per top value, one query per property's state rows.
let statements = 1; // the aggregate invalidated row above
for (const property of properties) {
  // Top-value rows: population = measured, outcome = this value, one query per value shown.
  const values = q(
    `select ${property} as v, count(*) as n from ${VIEW}
      where ${property} is not null group by v order by n desc, v asc limit 6`,
  );
  statements += values.length;
  for (const { v: value } of values) {
    emit(
      `${property}=${String(value).slice(0, 16)}`,
      tallies(
        VIEW,
        CLUSTER,
        `${property} = '${String(value).replace(/'/g, "''")}'`,
        `${property} is not null`,
      ),
    );
  }

  // State rows: outcome = this state, population = declared (everything but not_declared), one
  // query per property covers all three declared states at once -- hence 1, not 3.
  statements += 1;
  const rows = q(
    `select ${property}_state as st, ${CLUSTER} as k, count(*) as m,
            sum(case when ${property}_state = 'measured' then 1 else 0 end) as sy
       from ${VIEW} where ${CLUSTER} is not null and ${property}_state <> 'not_declared'
      group by st, ${CLUSTER}`,
  );
  const byState = new Map();
  for (const r of rows) {
    const list = byState.get(r.st) ?? [];
    list.push({ key: r.k, m: Number(r.m), s: Number(r.sy) });
    byState.set(r.st, list);
  }
  for (const [state, groups] of byState) emit(`${property} state=${state}`, groups);
}

console.log(`\n  ${checked} rows checked; every invariant held on every one.`);
console.log(`\nQ1. Rows the correction would move (deff > 1): ${moved.length} of ${checked}`);
console.log(`Q2. Rows pushed below MIN_N=20, where the naive n was >= 20:`);
if (flagged.length === 0) console.log('    none');
for (const row of flagged) console.log(`    ${row}`);
console.log(`\nQ4. SQL statements the correction costs for this type: ${statements}`);
console.log(
  `    (1 aggregate invalidated + 1 state query per property + 1 query per top value shown;\n` +
    `     ${properties.length} properties, so the count grows with the top-K, not with the row count.)`,
);

// ---------------------------------------------------------------------------------------------
// PART 2: can ONE query per property serve every row that property produces?
//
// Part 1 cost 42 statements because it asked one query per printed row. But every top-value row of
// a property shares its population (`measured`) and differs only in which value counts as a success
// -- so `GROUP BY value, cluster` returns all of them at once. And because `json_extract` is NULL
// exactly when the state is not `measured`, a single `GROUP BY state, value, cluster` covers the
// state rows AND the top-value rows together: `(measured, V, c)` is a top-value cell, and
// `(na|nm, NULL, c)` is a declared count.
//
// A claim about SQL is exactly the kind of claim that should be measured, not reasoned -- and the
// check that matters is that the collapsed query agrees with the per-row one, cell for cell.
// ---------------------------------------------------------------------------------------------

console.log('\n\nQ4b. One query per property, and whether it agrees with the per-row version\n');

function designOf(groups) {
  const d = design(groups);
  assert('collapsed', d.deff >= 1 - 1e-12, `deff ${d.deff} below 1`);
  return d;
}

let collapsedStatements = 1; // the invalidated query, below
let compared = 0;
const disagreements = [];

for (const property of properties) {
  collapsedStatements += 1;
  const cells = q(
    `select ${property}_state as st, ${property} as v, ${CLUSTER} as k, count(*) as m
       from ${VIEW} where ${CLUSTER} is not null group by st, v, ${CLUSTER}`,
  );

  // Per cluster, the declared population (everything but not_declared) and the measured population.
  const declaredByCluster = new Map();
  const measuredByCluster = new Map();
  const valueByCluster = new Map(); // `${value}\u0000${cluster}` -> count
  const stateByCluster = new Map();
  for (const c of cells) {
    const m = Number(c.m);
    if (c.st !== 'not_declared') {
      declaredByCluster.set(c.k, (declaredByCluster.get(c.k) ?? 0) + m);
    }
    if (c.st === 'measured') {
      measuredByCluster.set(c.k, (measuredByCluster.get(c.k) ?? 0) + m);
      valueByCluster.set(`${c.v}\u0000${c.k}`, m);
    }
    const key = `${c.st}\u0000${c.k}`;
    stateByCluster.set(key, (stateByCluster.get(key) ?? 0) + m);
  }

  // The state rows, rebuilt from the collapsed cells.
  for (const state of ['measured', 'not_applicable', 'not_measured']) {
    const clusters = new Set([...declaredByCluster.keys()]);
    const groups = [...clusters]
      .map((key) => ({ key, m: declaredByCluster.get(key), s: stateByCluster.get(`${state}\u0000${key}`) ?? 0 }))
      .filter((g) => g.m > 0);
    if (groups.length === 0) continue;
    const collapsed = designOf(groups);
    const direct = design(
      tallies(VIEW, CLUSTER, `${property}_state = '${state}'`, `${property}_state <> 'not_declared'`),
    );
    compared += 1;
    if (Math.abs(collapsed.deff - direct.deff) > 1e-9 || collapsed.N !== direct.N) {
      disagreements.push(`${property} state=${state}: ${collapsed.deff} vs ${direct.deff}`);
    }
  }

  // The top-value rows, rebuilt from the collapsed cells.
  const values = q(
    `select ${property} as v, count(*) as n from ${VIEW}
      where ${property} is not null group by v order by n desc, v asc limit 6`,
  );
  for (const { v: value } of values) {
    const clusters = new Set([...measuredByCluster.keys()]);
    const groups = [...clusters]
      .map((key) => ({ key, m: measuredByCluster.get(key), s: valueByCluster.get(`${value}\u0000${key}`) ?? 0 }))
      .filter((g) => g.m > 0);
    const collapsed = designOf(groups);
    const direct = design(
      tallies(VIEW, CLUSTER, `${property} = '${String(value).replace(/'/g, "''")}'`, `${property} is not null`),
    );
    compared += 1;
    if (Math.abs(collapsed.deff - direct.deff) > 1e-9 || collapsed.N !== direct.N) {
      disagreements.push(`${property}=${value}: ${collapsed.deff} vs ${direct.deff}`);
    }
  }
}

// The invalidated rows: one query for the aggregate row and every label row.
collapsedStatements += 1;
const labelCells = q(
  `select invalidated as label, ${CLUSTER} as k, count(*) as m
     from ${VIEW} where ${CLUSTER} is not null group by label, ${CLUSTER}`,
);
const popByCluster = new Map();
for (const c of labelCells) popByCluster.set(c.k, (popByCluster.get(c.k) ?? 0) + Number(c.m));
for (const label of [null, ...new Set(labelCells.map((c) => c.label).filter((l) => l !== null))]) {
  const groups = [...popByCluster.keys()]
    .map((key) => ({
      key,
      m: popByCluster.get(key),
      s: labelCells.filter((c) => c.k === key && c.label === label).reduce((sum, c) => sum + Number(c.m), 0),
    }))
    .filter((g) => g.m > 0);
  const collapsed = designOf(groups);
  // The aggregate row's outcome is `invalidated is not null`, NOT `1 = 1` -- the first draft of this
  // arm used the latter, which counts every entry as a success and reports deff 1 for a row whose
  // real design effect is 74. The collapsed arm was right and the "reference" arm was wrong, which
  // is only visible because the two are compared rather than one being trusted.
  const direct = design(
    tallies(VIEW, CLUSTER, label === null ? 'invalidated is not null' : `invalidated = '${label}'`, '1 = 1'),
  );
  compared += 1;
  const name = label === null ? 'invalidated (any label)' : `invalidated.${label}`;
  if (Math.abs(collapsed.deff - direct.deff) > 1e-9 || collapsed.N !== direct.N) {
    disagreements.push(`${name}: ${collapsed.deff} vs ${direct.deff}`);
  }
}

console.log(`  ${compared} rows compared cell-for-cell against the per-row query.`);
if (disagreements.length === 0) {
  console.log('  Every collapsed design matched the per-row design exactly.');
} else {
  for (const row of disagreements) console.log(`  DISAGREES ${row}`);
}
console.log(`\n  Statements: ${statements} (one per printed row) -> ${collapsedStatements} (one per property).`);
