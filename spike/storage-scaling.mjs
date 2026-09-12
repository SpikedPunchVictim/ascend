// EV-4 phase 2: does shape A's json_extract view degrade as the corpus grows,
// and as more types coexist in the same table?
//
// Phase 1 compared shapes at one size holding one type. That is the flattering
// case for shape A. The real corpus holds dozens of types side by side and
// keeps growing, so the question that decides the design is the SCALING CURVE,
// not the single-point latency.

import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TMP = 'spike/tmp';
mkdirSync(TMP, { recursive: true });

const src = new DatabaseSync('spike/corpus.db');
const real = src.prepare(`
  SELECT COALESCE(denial_kind,'') AS denial_kind, COALESCE(tool_name,'') AS tool_name,
         COALESCE(project,'') AS project, COALESCE(git_branch,'') AS git_branch,
         COALESCE(recorded_at,'') AS recorded_at
  FROM events WHERE kind = 'tool-denial'
`).all();
src.close();

// N_TYPES types share one entries table. Only one of them is 'tool-denial';
// the rest are filler with the same shape under different names, which is what
// a real registry looks like after a few weeks of agent use.
function build(n, nTypes) {
  const path = `${TMP}/scale-${n}-${nTypes}.db`;
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT);
           CREATE INDEX idx_entries_type ON entries(type_name);`);
  db.exec(`CREATE VIEW v_tool_denial AS
           SELECT id,
                  json_extract(properties_json,'$.denial_kind') AS denial_kind,
                  json_extract(properties_json,'$.tool_name')   AS tool_name,
                  json_extract(properties_json,'$.project')     AS project
           FROM entries WHERE type_name = 'tool-denial';`);
  db.exec(`CREATE TABLE td (id INTEGER PRIMARY KEY, denial_kind TEXT, tool_name TEXT, project TEXT);
           CREATE INDEX idx_td_kind ON td(denial_kind);`);
  const insE = db.prepare('INSERT INTO entries (type_name, properties_json) VALUES (?,?)');
  const insT = db.prepare('INSERT INTO td (denial_kind, tool_name, project) VALUES (?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const r = real[i % real.length];
    const isTarget = i % nTypes === 0;
    insE.run(isTarget ? 'tool-denial' : `filler-${i % nTypes}`, JSON.stringify(r));
    if (isTarget) insT.run(r.denial_kind, r.tool_name, r.project);
  }
  db.exec('COMMIT');
  db.exec('ANALYZE');
  return db;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(db, sql, iters = 9) {
  db.prepare(sql).all();
  const s = [];
  for (let i = 0; i < iters; i++) { const t = performance.now(); db.prepare(sql).all(); s.push(performance.now() - t); }
  return median(s);
}

const QA = `SELECT denial_kind, COUNT(*) n FROM v_tool_denial GROUP BY 1 ORDER BY n DESC`;
const QC = `SELECT denial_kind, COUNT(*) n FROM td GROUP BY 1 ORDER BY n DESC`;

console.log('corpus growth, one type (the flattering case for A)\n');
console.log(`${'rows'.padStart(8)} ${'A json+views'.padStart(14)} ${'C per-type'.padStart(14)}   ratio`);
console.log('-'.repeat(58));
for (const n of [10000, 50000, 100000, 250000]) {
  const db = build(n, 1);
  const a = time(db, QA); const c = time(db, QC);
  console.log(`${String(n).padStart(8)} ${`${a.toFixed(2)}ms`.padStart(14)} ${`${c.toFixed(2)}ms`.padStart(14)}   ${(a / c).toFixed(2)}x`);
  db.close();
  rmSync(`${TMP}/scale-${n}-1.db`, { force: true });
}

console.log('\ntypes coexisting in one table, 100000 rows total\n');
console.log(`${'types'.padStart(8)} ${'target rows'.padStart(12)} ${'A json+views'.padStart(14)} ${'C per-type'.padStart(14)}   ratio`);
console.log('-'.repeat(70));
for (const nt of [1, 5, 20, 50]) {
  const db = build(100000, nt);
  const targetRows = Math.ceil(100000 / nt);
  const a = time(db, QA); const c = time(db, QC);
  console.log(`${String(nt).padStart(8)} ${String(targetRows).padStart(12)} ${`${a.toFixed(2)}ms`.padStart(14)} ${`${c.toFixed(2)}ms`.padStart(14)}   ${(a / c).toFixed(2)}x`);
  db.close();
  rmSync(`${TMP}/scale-100000-${nt}.db`, { force: true });
}

console.log('\nDoes the type index actually get used? (EXPLAIN QUERY PLAN)');
const db = build(100000, 20);
for (const [label, sql] of [['A: view scan', QA], ['C: table scan', QC]]) {
  console.log(`  ${label}: ${db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ')}`);
}
db.close();
rmSync(`${TMP}/scale-100000-20.db`, { force: true });
