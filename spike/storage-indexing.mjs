// EV-4 phase 3: can shape A recover shape C's speed WITHOUT giving up its
// defining property -- that registering a type emits no DDL that scales with
// the number of existing types.
//
// Phase 2 showed A is 20-38x slower and superlinear, because json_extract is
// evaluated per row over a non-covering index. SQLite can index an expression,
// so the question is whether an index emitted FROM THE REGISTRY closes the gap.
//
// Three variants of A, same data, same query:
//   A0  plain view over json_extract            (the architecture's shape)
//   A1  A0 + expression index on the property    (index emitted from registry)
//   A2  A1 + STORED generated columns            (if ADD COLUMN permits STORED)
// and C as the ceiling.

import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TMP = 'spike/tmp';
mkdirSync(TMP, { recursive: true });

const src = new DatabaseSync('spike/corpus.db');
const real = src.prepare(`
  SELECT COALESCE(denial_kind,'') AS denial_kind, COALESCE(tool_name,'') AS tool_name,
         COALESCE(project,'') AS project
  FROM events WHERE kind = 'tool-denial'
`).all();
src.close();

const N = 250000;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(db, sql, iters = 9) {
  db.prepare(sql).all();
  const s = [];
  for (let i = 0; i < iters; i++) { const t = performance.now(); db.prepare(sql).all(); s.push(performance.now() - t); }
  return median(s);
}

function build(variant) {
  const path = `${TMP}/idx-${variant}.db`;
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT)');
  db.exec('CREATE INDEX idx_entries_type ON entries(type_name)');
  db.exec(`CREATE VIEW v_tool_denial AS SELECT id,
             json_extract(properties_json,'$.denial_kind') AS denial_kind,
             json_extract(properties_json,'$.tool_name')   AS tool_name,
             json_extract(properties_json,'$.project')     AS project
           FROM entries WHERE type_name = 'tool-denial'`);
  db.exec('CREATE TABLE td (id INTEGER PRIMARY KEY, denial_kind TEXT, tool_name TEXT, project TEXT)');
  db.exec('CREATE INDEX idx_td_kind ON td(denial_kind)');

  // A2's generated columns must be declared at CREATE TABLE time if STORED is
  // unavailable via ALTER. Test the ALTER path first; fall back and report.
  let generatedNote = 'n/a';
  if (variant === 'A2') {
    db.exec('DROP TABLE entries');
    db.exec(`CREATE TABLE entries (
               id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT,
               g_denial_kind TEXT GENERATED ALWAYS AS (json_extract(properties_json,'$.denial_kind')) STORED,
               g_tool_name   TEXT GENERATED ALWAYS AS (json_extract(properties_json,'$.tool_name'))   STORED,
               g_project     TEXT GENERATED ALWAYS AS (json_extract(properties_json,'$.project'))     STORED)`);
    db.exec('CREATE INDEX idx_entries_type ON entries(type_name)');
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN g_extra TEXT
               GENERATED ALWAYS AS (json_extract(properties_json,'$.recorded_at')) STORED`);
      generatedNote = 'ALTER TABLE ADD COLUMN ... STORED is ACCEPTED at runtime';
    } catch (e) {
      generatedNote = `ALTER ADD STORED rejected: ${e.message}`;
      // VIRTUAL is the fallback that ALTER does allow.
      try {
        db.exec(`ALTER TABLE entries ADD COLUMN g_extra TEXT
                 GENERATED ALWAYS AS (json_extract(properties_json,'$.recorded_at')) VIRTUAL`);
        generatedNote += ' | but VIRTUAL is accepted';
      } catch (e2) { generatedNote += ` | VIRTUAL also rejected: ${e2.message}`; }
    }
  }

  const insE = db.prepare(`INSERT INTO entries (type_name, properties_json) VALUES (?,?)`);
  const insT = db.prepare('INSERT INTO td (denial_kind, tool_name, project) VALUES (?,?,?)');
  const t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    const r = real[i % real.length];
    insE.run('tool-denial', JSON.stringify(r));
    insT.run(r.denial_kind, r.tool_name, r.project);
  }
  db.exec('COMMIT');
  const insertMs = performance.now() - t0;

  if (variant === 'A1' || variant === 'A2') {
    const t1 = performance.now();
    db.exec(`CREATE INDEX idx_denial_kind ON entries(json_extract(properties_json,'$.denial_kind'))`);
    db.exec(`CREATE INDEX idx_tool_name   ON entries(json_extract(properties_json,'$.tool_name'))`);
    const indexMs = performance.now() - t1;
    db.exec('ANALYZE');
    return { db, insertMs, indexMs, generatedNote };
  }
  db.exec('ANALYZE');
  return { db, insertMs, indexMs: 0, generatedNote };
}

const QUERIES = {
  'count by one categorical': {
    A: `SELECT denial_kind, COUNT(*) n FROM v_tool_denial GROUP BY 1 ORDER BY n DESC`,
    C: `SELECT denial_kind, COUNT(*) n FROM td GROUP BY 1 ORDER BY n DESC`,
  },
  'top-10 values': {
    A: `SELECT tool_name, COUNT(*) n FROM v_tool_denial GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    C: `SELECT tool_name, COUNT(*) n FROM td GROUP BY 1 ORDER BY n DESC LIMIT 10`,
  },
  'filter two properties ANDed': {
    A: `SELECT COUNT(*) FROM v_tool_denial WHERE denial_kind='permission-rule' AND tool_name='Bash'`,
    C: `SELECT COUNT(*) FROM td WHERE denial_kind='permission-rule' AND tool_name='Bash'`,
  },
  'crosstab of two properties': {
    A: `SELECT denial_kind, tool_name, COUNT(*) n FROM v_tool_denial GROUP BY 1,2 ORDER BY n DESC`,
    C: `SELECT denial_kind, tool_name, COUNT(*) n FROM td GROUP BY 1,2 ORDER BY n DESC`,
  },
};

console.log(`n=${N.toLocaleString()} rows, all one type\n`);
const built = {};
for (const v of ['A0', 'A1', 'A2', 'C']) built[v] = build(v);

const names = Object.keys(QUERIES);
console.log(`${'query'.padEnd(30)} ${names.map(() => '').join('')}${'A0 plain'.padStart(10)} ${'A1 +idx'.padStart(10)} ${'A2 +gen'.padStart(10)} ${'C table'.padStart(10)}`);
console.log('-'.repeat(74));
const tot = { A0: 0, A1: 0, A2: 0, C: 0 };
for (const [name, q] of Object.entries(QUERIES)) {
  const cells = [];
  for (const v of ['A0', 'A1', 'A2', 'C']) {
    const ms = time(built[v].db, v === 'C' ? q.C : q.A);
    tot[v] += ms;
    cells.push(`${ms.toFixed(2)}ms`.padStart(10));
  }
  console.log(`${name.padEnd(30)} ${cells.join(' ')}`);
}
console.log('-'.repeat(74));
console.log(`${'TOTAL'.padEnd(30)} ${['A0','A1','A2','C'].map((v) => `${tot[v].toFixed(2)}ms`.padStart(10)).join(' ')}`);
console.log(`\nspeedup of A1 vs A0: ${(tot.A0 / tot.A1).toFixed(1)}x   A2 vs A0: ${(tot.A0 / tot.A2).toFixed(1)}x`);
console.log(`A1 as a multiple of C's cost: ${(tot.A1 / tot.C).toFixed(2)}x   (A0 was ${(tot.A0 / tot.C).toFixed(2)}x)`);

console.log('\nwrite-path cost of each variant:');
for (const v of ['A0', 'A1', 'A2', 'C']) {
  const b = built[v];
  const per = (b.insertMs / N) * 1000;
  console.log(`  ${v.padEnd(3)} insert ${b.insertMs.toFixed(0).padStart(5)}ms total (${per.toFixed(2)}us/row)  index-build ${b.indexMs.toFixed(0)}ms`);
}

console.log(`\nA2 generated-column note: ${built.A2.generatedNote}`);

console.log('\nplan for the indexed variant:');
console.log(`  A1: ${built.A1.db.prepare(`EXPLAIN QUERY PLAN ${QUERIES['count by one categorical'].A}`).all().map((r) => r.detail).join(' | ')}`);

// The critical registry question: what does adding a NEW type cost in A1?
console.log('\ncost of registering one more property on an existing corpus (the runtime-type requirement):');
for (const v of ['A1', 'A2', 'C']) {
  const db = built[v].db;
  const t = performance.now();
  if (v === 'C') {
    try { db.exec('ALTER TABLE td ADD COLUMN severity TEXT'); console.log(`  C   ALTER TABLE ADD COLUMN on one type: ${(performance.now() - t).toFixed(2)}ms (must be repeated for EVERY existing type)`); }
    catch (e) { console.log(`  C   failed: ${e.message}`); }
  } else if (v === 'A2') {
    try { db.exec(`ALTER TABLE entries ADD COLUMN g_severity TEXT GENERATED ALWAYS AS (json_extract(properties_json,'$.severity')) VIRTUAL`);
          console.log(`  A2  ALTER TABLE ADD COLUMN (VIRTUAL generated): ${(performance.now() - t).toFixed(2)}ms, once, type-agnostic`); }
    catch (e) { console.log(`  A2  failed: ${e.message}`); }
  } else {
    db.exec(`CREATE INDEX idx_severity ON entries(json_extract(properties_json,'$.severity'))`);
    console.log(`  A1  CREATE INDEX on new property: ${(performance.now() - t).toFixed(2)}ms, once, type-agnostic`);
  }
}

for (const v of ['A0', 'A1', 'A2', 'C']) built[v].db.close();
