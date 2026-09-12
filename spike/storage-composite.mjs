// EV-4 phase 4: two loose ends phase 3 left, both of which decide the design.
//
// (1) A1's index was on the bare expression, so SQLite scanned the whole index
//     with no way to apply the type filter. The right index for a multi-type
//     table is COMPOSITE: (type_name, json_extract(...)). Untested so far.
//
// (2) ALTER TABLE ADD COLUMN ... STORED was ACCEPTED on a populated table.
//     If that is a silent full-table rewrite, A2's 0.26ms "registration cost"
//     (measured with VIRTUAL) is a false green and must be corrected.

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

const rowsFor = (i) => real[i % real.length];
function fill(db, table, n) {
  const ins = db.prepare(`INSERT INTO ${table} (type_name, properties_json) VALUES (?,?)`);
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) ins.run('tool-denial', JSON.stringify(rowsFor(i)));
  db.exec('COMMIT');
}

// ---------- (1) composite expression index ----------
console.log(`(1) composite expression index, n=${N.toLocaleString()}\n`);
const variants = {
  'A0 plain view': [],
  'A1 bare expr idx': [
    `CREATE INDEX i_dk ON entries(json_extract(properties_json,'$.denial_kind'))`,
    `CREATE INDEX i_tn ON entries(json_extract(properties_json,'$.tool_name'))`,
  ],
  'A3 composite idx': [
    `CREATE INDEX i_dk ON entries(type_name, json_extract(properties_json,'$.denial_kind'))`,
    `CREATE INDEX i_tn ON entries(type_name, json_extract(properties_json,'$.tool_name'))`,
  ],
  'A4 one wide idx': [
    `CREATE INDEX i_all ON entries(type_name,
       json_extract(properties_json,'$.denial_kind'),
       json_extract(properties_json,'$.tool_name'))`,
  ],
};

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

const results = {};
for (const [label, indexes] of Object.entries(variants)) {
  const path = `${TMP}/comp-${label.replace(/\W/g, '')}.db`;
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
  fill(db, 'entries', N);
  const insT = db.prepare('INSERT INTO td (denial_kind, tool_name, project) VALUES (?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < N; i++) { const r = rowsFor(i); insT.run(r.denial_kind, r.tool_name, r.project); }
  db.exec('COMMIT');
  const t0 = performance.now();
  for (const ix of indexes) db.exec(ix);
  const idxMs = performance.now() - t0;
  db.exec('ANALYZE');

  const per = {};
  for (const [name, q] of Object.entries(QUERIES)) per[name] = time(db, q.A);
  per.__total = Object.values(per).reduce((a, b) => a + b, 0);
  per.__idxMs = idxMs;
  per.__plan = db.prepare(`EXPLAIN QUERY PLAN ${QUERIES['count by one categorical'].A}`).all().map((r) => r.detail).join(' | ');
  results[label] = { per, db, path };
}

// ceiling: shape C
{
  const r = results['A4 one wide idx'];
  const per = {};
  for (const [name, q] of Object.entries(QUERIES)) per[name] = time(r.db, q.C);
  per.__total = Object.values(per).reduce((a, b) => a + b, 0);
  per.__idxMs = 0;
  per.__plan = 'n/a (shape C)';
  results['C per-type (ceiling)'] = { per, db: r.db, path: r.path };
}

const labels = Object.keys(results);
console.log(`${'query'.padEnd(30)}${labels.map((l) => l.split(' ')[0].padStart(11)).join('')}`);
console.log('-'.repeat(30 + 11 * labels.length));
for (const name of Object.keys(QUERIES)) {
  console.log(`${name.padEnd(30)}${labels.map((l) => `${results[l].per[name].toFixed(1)}ms`.padStart(11)).join('')}`);
}
console.log('-'.repeat(30 + 11 * labels.length));
console.log(`${'TOTAL'.padEnd(30)}${labels.map((l) => `${results[l].per.__total.toFixed(1)}ms`.padStart(11)).join('')}`);
console.log(`${'index build'.padEnd(30)}${labels.map((l) => `${results[l].per.__idxMs.toFixed(0)}ms`.padStart(11)).join('')}`);

console.log('\nquery plans (count by one categorical):');
for (const l of labels) console.log(`  ${l.padEnd(22)} ${results[l].per.__plan}`);

for (const l of labels) { results[l].db.close(); rmSync(results[l].path, { force: true }); }

// ---------- (2) what does STORED actually cost on a populated table? ----------
console.log('\n(2) ALTER TABLE ADD COLUMN on a populated table, n=' + N.toLocaleString() + '\n');
for (const kind of ['VIRTUAL', 'STORED']) {
  const path = `${TMP}/alter-${kind}.db`;
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT)');
  fill(db, 'entries', N);
  const sizeBefore = db.prepare('PRAGMA page_count').get().page_count;
  const t0 = performance.now();
  let err = null;
  try {
    db.exec(`ALTER TABLE entries ADD COLUMN g_sev TEXT
             GENERATED ALWAYS AS (json_extract(properties_json,'$.severity')) ${kind}`);
  } catch (e) { err = e.message; }
  const ms = performance.now() - t0;
  const sizeAfter = db.prepare('PRAGMA page_count').get().page_count;
  if (err) console.log(`  ${kind.padEnd(8)} REJECTED: ${err}`);
  else console.log(`  ${kind.padEnd(8)} accepted in ${ms.toFixed(1)}ms    pages ${sizeBefore} -> ${sizeAfter} (${((sizeAfter / sizeBefore - 1) * 100).toFixed(0)}% growth)`);
  db.close();
  rmSync(path, { force: true });
}

// and the same ALTER replayed against a 250k-row corpus that ALREADY has data,
// timed end to end including the write that follows it
console.log('\n  does a post-ALTER insert still work and cost the same?');
{
  const path = `${TMP}/alter-after.db`;
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT)');
  fill(db, 'entries', N);
  try {
    db.exec(`ALTER TABLE entries ADD COLUMN g_sev TEXT
             GENERATED ALWAYS AS (json_extract(properties_json,'$.severity')) STORED`);
    const t = performance.now();
    db.prepare('INSERT INTO entries (type_name, properties_json) VALUES (?,?)')
      .run('tool-denial', JSON.stringify({ denial_kind: 'x', severity: 'high' }));
    console.log(`    STORED: insert after ALTER ok, ${(performance.now() - t).toFixed(2)}ms`);
    const row = db.prepare(`SELECT g_sev FROM entries ORDER BY id DESC LIMIT 1`).get();
    console.log(`    STORED: generated value for the new row = ${JSON.stringify(row.g_sev)}`);
    const old = db.prepare(`SELECT COUNT(*) c FROM entries WHERE g_sev IS NOT NULL`).get();
    console.log(`    STORED: rows with a non-null generated value: ${old.c} of ${N + 1}`);
  } catch (e) { console.log(`    STORED path failed: ${e.message}`); }
  db.close();
  rmSync(path, { force: true });
}
