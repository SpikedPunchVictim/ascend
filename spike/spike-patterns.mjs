// EV-3: at realistic single-user volume, does an actionable pattern actually
// emerge, or is it noise? (asc-spike-patterns) -- THE GO/NO-GO.
//
// Method, per TASKS.md:
//   profile the corpus; group by every available dimension; state any
//   concentration with a Wilson interval; compare against a shuffled-label
//   control -- if the "pattern" survives shuffling it is an artifact.
//
// Every proportion printed carries an interval and an n. Groups below MIN_N
// are flagged rather than printed as bare percentages.

import { DatabaseSync } from 'node:sqlite';
import { crosstab, chiSquare, formatProportion, permutationNull, wilson, minNFlag, MIN_N } from './lib/stats.mjs';

const db = new DatabaseSync('spike/corpus.db');
const all = (sql, ...params) => db.prepare(sql).all(...params);

/** Categorical dimensions available per entry type. */
const DIMENSIONS = {
  'tool-denial': ['denial_kind', 'tool_name', 'project', 'weekday', 'repo'],
  'skill-activation': ['skill_name', 'project', 'agent_name', 'weekday'],
  'verification-run': ['tool_name', 'project', 'has_stderr', 'weekday'],
  'context-compaction': ['project', 'trigger', 'weekday'],
  'user-correction': ['project', 'weekday'],
};

const COLUMN = {
  denial_kind: 'denial_kind',
  tool_name: 'tool_name',
  project: 'project',
  skill_name: 'skill_name',
  agent_name: 'agent_name',
  trigger: 'trigger',
  has_stderr: 'CAST(has_stderr AS TEXT)',
  weekday: "CASE CAST(strftime('%w', recorded_at) AS INTEGER) WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed' WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' ELSE 'Sat' END",
  repo: "COALESCE(git_branch, '(none)')",
};

function rowsFor(kind, dims) {
  const cols = dims.map((d) => `${COLUMN[d]} AS ${d}`).join(', ');
  // A dimension that is entirely NULL carries no information; keep it as
  // '(not measured)' so the three-state ratio stays visible rather than
  // silently collapsing to zero rows.
  return all(`SELECT ${cols} FROM events WHERE kind = ?`, kind);
}

function profile(kind) {
  const n = all('SELECT COUNT(*) c FROM events WHERE kind = ?', kind)[0].c;
  const span = all('SELECT MIN(recorded_at) a, MAX(recorded_at) b FROM events WHERE kind = ?', kind)[0];
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${kind.toUpperCase()}   N=${n}   ${String(span.a).slice(0, 10)} .. ${String(span.b).slice(0, 10)}`);
  console.log('='.repeat(78));

  const dims = DIMENSIONS[kind] ?? [];
  const rows = rowsFor(kind, dims);

  // --- per-dimension cardinality and top-K, every share with a Wilson CI ---
  for (const dim of dims) {
    const values = rows.map((r) => r[dim] ?? '(not measured)');
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const distinct = counts.size;
    const top = [...counts].sort((a, b) => b[1] - a[1]);
    const nulls = counts.get('(not measured)') ?? 0;
    console.log(`\n  ${dim}  (cardinality ${distinct}; not-measured ${nulls}/${n})`);
    for (const [value, count] of top.slice(0, 6)) {
      if (value === '(not measured)') continue;
      console.log(`     ${String(count).padStart(5)}  ${String(value).padEnd(38)} ${formatProportion(count, n)}${minNFlag(count)}`);
    }
    if (top.length > 6) console.log(`     … ${top.length - 6} more values`);
  }
  return { n, rows, dims };
}

function associations(kind, { rows, dims }) {
  console.log(`\n  --- association between dimension pairs (chi-square + shuffled control) ---`);
  console.log(`  ${'pair'.padEnd(34)} ${'chi2'.padStart(9)} ${'df'.padStart(3)} ${'p'.padStart(9)} ${'V'.padStart(6)} ${'shuffled p'.padStart(11)}  verdict`);
  const results = [];
  for (let i = 0; i < dims.length; i++) {
    for (let j = i + 1; j < dims.length; j++) {
      const a = rows.map((r) => r[dims[i]] ?? '(not measured)');
      const b = rows.map((r) => r[dims[j]] ?? '(not measured)');
      const table = crosstab(a, b);
      const stat = chiSquare(table);
      if (stat.df === 0) continue; // a constant dimension carries no association
      const nul = permutationNull(a, b, { iterations: 400, seed: 12345 });
      const pShuffled = nul.pValue(stat.chi2);
      // A finding is only real if it beats both the asymptotic test AND the
      // shuffled control. The control is the one that catches marginal-driven
      // artifacts, which is the dominant failure mode at this N.
      const real = pShuffled < 0.05 && stat.p < 0.05;
      const pair = `${dims[i]} × ${dims[j]}`;
      console.log(
        `  ${pair.padEnd(34)} ${stat.chi2.toFixed(2).padStart(9)} ${String(stat.df).padStart(3)} ` +
        `${stat.p.toExponential(2).padStart(9)} ${stat.cramersV.toFixed(3).padStart(6)} ` +
        `${pShuffled.toFixed(4).padStart(11)}  ${real ? 'SURVIVES' : 'ARTIFACT of marginals'}`,
      );
      results.push({ pair, stat, pShuffled, real });
    }
  }
  return results;
}

function threeState(kind, { n, dims }) {
  const cols = dims.filter((d) => d !== 'weekday');
  if (cols.length === 0) return;
  console.log(`\n  --- three-state ratios (measured / not-measured) ---`);
  for (const dim of cols) {
    const row = all(`SELECT COUNT(*) total, COUNT(${COLUMN[dim]}) present FROM events WHERE kind = ?`, kind)[0];
    const measured = row.present;
    const unmeasured = row.total - measured;
    console.log(
      `  ${dim.padEnd(18)} measured ${formatProportion(measured, row.total)}` +
      `   not-measured ${unmeasured}` + (measured === 0 ? '  [ENTIRELY ABSENT]' : ''),
    );
  }
}

const TARGETS = process.argv.slice(2);
const kinds = TARGETS.length ? TARGETS : ['tool-denial', 'skill-activation'];

const summary = [];
for (const kind of kinds) {
  const p = profile(kind);
  threeState(kind, p);
  const assoc = associations(kind, p);
  summary.push({ kind, n: p.n, assoc });
}

// --- explicit GO/NO-GO on the project's central premise ---
console.log(`\n${'='.repeat(78)}`);
console.log('CENTRAL PREMISE TEST');
console.log('='.repeat(78));
let survived = 0;
let tested = 0;
for (const { kind, n, assoc } of summary) {
  for (const a of assoc) {
    tested += 1;
    if (a.real) {
      survived += 1;
      console.log(`  SURVIVES both tests  ${kind} (n=${n}): ${a.pair}` +
        `  V=${a.stat.cramersV.toFixed(3)}, shuffled p=${a.pShuffled.toFixed(4)}`);
    }
  }
}
console.log(`\n  ${survived} of ${tested} candidate associations survive the shuffled control.`);
console.log(`  Every proportion above carries a Wilson CI and an n; groups under ${MIN_N} are flagged.`);
db.close();
