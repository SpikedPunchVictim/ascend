// EV-4: JSON + generated views, EAV, or per-type tables?
//
// Three physical shapes, one logical dataset, five identical analysis
// questions. ARCHITECTURE.md proposes shape A; this run either confirms it or
// overturns it with numbers.
//
// Data: the real 409 tool-denial rows from spike/corpus.db, expanded to 10,000
// by deterministic permutation of the categorical fields. Repeating real value
// combinations (rather than inventing values) keeps the cardinalities honest.

import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const N_TARGET = 10000;
const TMP = 'spike/tmp';
mkdirSync(TMP, { recursive: true });

// ---- load real rows -------------------------------------------------------
const src = new DatabaseSync('spike/corpus.db');
const real = src.prepare(`
  SELECT COALESCE(denial_kind,'') AS denial_kind,
         COALESCE(tool_name,'')   AS tool_name,
         COALESCE(project,'')     AS project,
         COALESCE(git_branch,'')  AS git_branch,
         COALESCE(recorded_at,'') AS recorded_at
  FROM events WHERE kind = 'tool-denial'
`).all();
src.close();

// Deterministic expansion: cycle real rows, offsetting categorical fields by
// the cycle index so the data is not a pure copy, but every value is a real one.
const rows = [];
for (let i = 0; i < N_TARGET; i++) {
  const r = real[i % real.length];
  const cycle = Math.floor(i / real.length);
  rows.push({
    denial_kind: r.denial_kind,
    tool_name: cycle % 3 === 0 ? r.tool_name : real[(i + cycle) % real.length].tool_name,
    project: real[(i * 7 + cycle) % real.length].project,
    git_branch: r.git_branch,
    recorded_at: r.recorded_at,
  });
}

// ---- the three shapes -----------------------------------------------------
const SHAPES = {
  'A: json+views': {
    ddl: `
      CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT);
      CREATE INDEX idx_entries_type ON entries(type_name);
    `,
    // The generated view is the whole point of shape A: it is emitted from the
    // registry, never hand-written.
    views: [`
      CREATE VIEW v_tool_denial AS
      SELECT id,
             json_extract(properties_json,'$.denial_kind') AS denial_kind,
             json_extract(properties_json,'$.tool_name')   AS tool_name,
             json_extract(properties_json,'$.project')     AS project,
             json_extract(properties_json,'$.git_branch')  AS git_branch,
             json_extract(properties_json,'$.recorded_at') AS recorded_at
      FROM entries WHERE type_name = 'tool-denial';
    `],
    insert: (db, r) => db.prepare('INSERT INTO entries (type_name, properties_json) VALUES (?,?)').run(
      'tool-denial', JSON.stringify(r)),
    // Add an optional property: no DDL change at all, the view is regenerated.
    addProperty: () => 'regenerate the view (one generated statement; no table rewrite, no backfill)',
  },

  'B: eav': {
    ddl: `
      CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT);
      CREATE TABLE entry_properties (entry_id INTEGER NOT NULL REFERENCES entries(id),
                                     name TEXT NOT NULL, value TEXT);
      CREATE INDEX idx_ep_name_value ON entry_properties(name, value);
      CREATE INDEX idx_ep_entry ON entry_properties(entry_id);
    `,
    views: [],
    insert: (db, r) => {
      const { lastInsertRowid } = db.prepare('INSERT INTO entries (type_name) VALUES (?)').run('tool-denial');
      const ins = db.prepare('INSERT INTO entry_properties (entry_id,name,value) VALUES (?,?,?)');
      for (const [k, v] of Object.entries(r)) ins.run(lastInsertRowid, k, v);
    },
    addProperty: () => 'insert rows with the new name (no DDL, but no type checking and no view)',
  },

  'C: per-type table': {
    ddl: `
      CREATE TABLE tool_denial (id INTEGER PRIMARY KEY, denial_kind TEXT, tool_name TEXT,
                                project TEXT, git_branch TEXT, recorded_at TEXT);
      CREATE INDEX idx_td_kind ON tool_denial(denial_kind);
    `,
    views: [],
    insert: (db, r) => db.prepare(
      'INSERT INTO tool_denial (denial_kind,tool_name,project,git_branch,recorded_at) VALUES (?,?,?,?,?)',
    ).run(r.denial_kind, r.tool_name, r.project, r.git_branch, r.recorded_at),
    addProperty: () => 'ALTER TABLE ADD COLUMN + a migration for every existing per-type table',
  },
};

// ---- the five questions ---------------------------------------------------
// Each query is written the way a human or LLM would naturally write it for
// that shape, and its line count is part of the measurement.
const QUERIES = [
  {
    name: 'count by one categorical',
    A: `SELECT denial_kind, COUNT(*) n FROM v_tool_denial GROUP BY 1 ORDER BY n DESC`,
    B: `SELECT p.value, COUNT(*) n FROM entry_properties p JOIN entries e ON e.id=p.entry_id
        WHERE e.type_name='tool-denial' AND p.name='denial_kind' GROUP BY 1 ORDER BY n DESC`,
    C: `SELECT denial_kind, COUNT(*) n FROM tool_denial GROUP BY 1 ORDER BY n DESC`,
  },
  {
    name: 'top-10 values with counts',
    A: `SELECT tool_name, COUNT(*) n FROM v_tool_denial GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    B: `SELECT p.value, COUNT(*) n FROM entry_properties p JOIN entries e ON e.id=p.entry_id
        WHERE e.type_name='tool-denial' AND p.name='tool_name' GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    C: `SELECT tool_name, COUNT(*) n FROM tool_denial GROUP BY 1 ORDER BY n DESC LIMIT 10`,
  },
  {
    name: 'filter on two properties ANDed',
    A: `SELECT COUNT(*) FROM v_tool_denial WHERE denial_kind='permission-rule' AND tool_name='Bash'`,
    B: `SELECT COUNT(*) FROM entry_properties p1
        JOIN entry_properties p2 ON p1.entry_id=p2.entry_id
        JOIN entries e ON e.id=p1.entry_id
        WHERE e.type_name='tool-denial' AND p1.name='denial_kind' AND p1.value='permission-rule'
          AND p2.name='tool_name' AND p2.value='Bash'`,
    C: `SELECT COUNT(*) FROM tool_denial WHERE denial_kind='permission-rule' AND tool_name='Bash'`,
  },
  {
    name: 'crosstab of two properties',
    A: `SELECT denial_kind, tool_name, COUNT(*) n FROM v_tool_denial GROUP BY 1,2 ORDER BY n DESC`,
    B: `SELECT pk.value denial_kind, pt.value tool_name, COUNT(*) n FROM entry_properties pk
        JOIN entry_properties pt ON pk.entry_id=pt.entry_id
        JOIN entries e ON e.id=pk.entry_id
        WHERE e.type_name='tool-denial' AND pk.name='denial_kind' AND pt.name='tool_name'
        GROUP BY 1,2 ORDER BY n DESC`,
    C: `SELECT denial_kind, tool_name, COUNT(*) n FROM tool_denial GROUP BY 1,2 ORDER BY n DESC`,
  },
  {
    name: 'property value within a date range',
    A: `SELECT denial_kind, COUNT(*) n FROM v_tool_denial
        WHERE recorded_at BETWEEN '2026-09-01' AND '2026-09-12' GROUP BY 1`,
    B: `SELECT pk.value, COUNT(*) n FROM entry_properties pk
        JOIN entry_properties pd ON pk.entry_id=pd.entry_id
        JOIN entries e ON e.id=pk.entry_id
        WHERE e.type_name='tool-denial' AND pk.name='denial_kind' AND pd.name='recorded_at'
          AND pd.value BETWEEN '2026-09-01' AND '2026-09-12' GROUP BY 1`,
    C: `SELECT denial_kind, COUNT(*) n FROM tool_denial
        WHERE recorded_at BETWEEN '2026-09-01' AND '2026-09-12' GROUP BY 1`,
  },
];

// ---- build & measure ------------------------------------------------------
const built = {};
for (const [name, shape] of Object.entries(SHAPES)) {
  const path = `${TMP}/shape-${name[0]}.db`;
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(shape.ddl);
  db.exec('BEGIN');
  for (const r of rows) shape.insert(db, r);
  db.exec('COMMIT');
  for (const v of shape.views) db.exec(v);
  db.exec('ANALYZE');
  built[name] = db;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`dataset: ${rows.length} entries (409 real expanded deterministically)\n`);
console.log(`${'query'.padEnd(34)} ${'A json+views'.padStart(14)} ${'B eav'.padStart(14)} ${'C per-type'.padStart(14)}`);
console.log('-'.repeat(80));

const totals = {};
for (const q of QUERIES) {
  const cells = [];
  for (const key of ['A', 'B', 'C']) {
    const shapeName = Object.keys(SHAPES).find((s) => s.startsWith(key));
    const db = built[shapeName];
    const sql = q[key];
    db.prepare(sql).all(); // warm
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      db.prepare(sql).all();
      samples.push(performance.now() - t0);
    }
    const ms = median(samples);
    totals[key] = (totals[key] ?? 0) + ms;
    cells.push(`${ms.toFixed(2)}ms`.padStart(14));
  }
  console.log(`${q.name.padEnd(34)} ${cells.join(' ')}`);
}
console.log('-'.repeat(80));
console.log(`${'TOTAL (median per query)'.padEnd(34)} ${`${totals.A.toFixed(2)}ms`.padStart(14)} ${`${totals.B.toFixed(2)}ms`.padStart(14)} ${`${totals.C.toFixed(2)}ms`.padStart(14)}`);

console.log(`\nSQL line count per query (what a human/LLM must write):`);
const locOf = (s) => s.split('\n').length;
let locTotals = { A: 0, B: 0, C: 0 };
for (const q of QUERIES) {
  const a = locOf(q.A); const b = locOf(q.B); const c = locOf(q.C);
  locTotals = { A: locTotals.A + a, B: locTotals.B + b, C: locTotals.C + c };
  console.log(`  ${q.name.padEnd(34)} A:${String(a).padStart(2)}  B:${String(b).padStart(2)}  C:${String(c).padStart(2)}`);
}
console.log(`  ${'TOTAL'.padEnd(34)} A:${String(locTotals.A).padStart(2)}  B:${String(locTotals.B).padStart(2)}  C:${String(locTotals.C).padStart(2)}   (lower is better)`);

console.log(`\nschema-change cost (adding an optional property):`);
for (const [name, shape] of Object.entries(SHAPES)) {
  console.log(`  ${name.padEnd(18)} ${shape.addProperty()}`);
}

for (const db of Object.values(built)) db.close();
