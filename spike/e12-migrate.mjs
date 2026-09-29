/**
 * THROWAWAY SPIKE -- E12.4's first question, asked before anything is built on the answer.
 *
 * "Does this repo's own corpus survive the JSONL tree faithfully?" A migration that loses a record, a
 * type_hash or an invalidation is the failure that E12.4 cannot recover from, because the SQLite store
 * it came from is archived in the same change. Design rounds cannot answer this; only the real corpus
 * can, and it is the one corpus in the world that has 17 types, 7 schemes and four months of derived
 * entries in it.
 *
 * The method is `import-vs-index.test.ts` generalised from a 9-line fixture to 10,316 real lines:
 * export the live store, lay the same lines out as a tree, build the index, and compare every
 * observable row of the index against the store it came from. Nothing touches `.ascend/ascend.db` --
 * it is only ever opened read-only, and the tree is built in a scratch directory.
 *
 * What it deliberately also asks, and what no equivalence check over the corpus format could:
 * **which tables does the corpus format have no way to carry?** A comparison over the four kinds the
 * format defines is green by construction for anything the format never mentions. So the last section
 * lists the tables the source store has that the tree cannot reproduce, which is where a migration
 * plan either accounts for a table or admits it is dropped.
 *
 * Run: node spike/e12-migrate.mjs [treeDir]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildIndex,
  INDEX_FILE,
  listInvalidations,
  openRecordWriter,
  parseCorpus,
  readRecordTree,
  serializeCorpus,
  STORE_FILE,
  treeFingerprint,
  writeGitattributes,
} from '../packages/store/dist/index.js';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const liveFile = join(root, '.ascend', STORE_FILE);
const tree = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'e12-migrate-'));

const say = (message) => console.log(message);
const clock = () => process.hrtime.bigint();
const seconds = (from) => `${(Number(clock() - from) / 1e9).toFixed(2)} s`;

/** The four tables a corpus writes, dumped canonically. `entry_types.created_at` is dropped by name:
 *  it comes from the caller, not from any `TypeLine`, so a build stamps its own moment. */
function observable(db) {
  const dump = (table, drop = []) => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    return rows
      .map((row) => {
        const kept = {};
        for (const key of Object.keys(row).sort()) if (!drop.includes(key)) kept[key] = row[key];
        return JSON.stringify(kept);
      })
      .sort();
  };
  return {
    entry_types: dump('entry_types', ['created_at']),
    entries: dump('entries'),
    annotation_schemes: dump('annotation_schemes'),
    annotations: dump('annotations'),
  };
}

function diff(name, left, right) {
  const onlyLeft = left.filter((row) => !right.includes(row));
  const onlyRight = right.filter((row) => !left.includes(row));
  const ok = onlyLeft.length === 0 && onlyRight.length === 0;
  say(
    `${ok ? 'EQUAL  ' : 'DIFFERS'} ${name.padEnd(20)} store=${String(left.length).padStart(6)} ` +
      `index=${String(right.length).padStart(6)}` +
      (ok ? '' : `  only-in-store=${onlyLeft.length} only-in-index=${onlyRight.length}`),
  );
  for (const row of onlyLeft.slice(0, 2)) say(`         only in store: ${row.slice(0, 300)}`);
  for (const row of onlyRight.slice(0, 2)) say(`         only in index: ${row.slice(0, 300)}`);
  return ok;
}

// --- 1. Export the live store, through the real command, without writing to it -------------------
say(`live store   ${liveFile}  (${statSync(liveFile).size} B)`);
const exportFile = join(tmpdir(), 'e12-migrate-export.jsonl');
const exporting = clock();
writeFileSync(exportFile, execFileSync(process.execPath, [join(root, 'packages/cli/dist/bin.js'), 'export'], { cwd: root, maxBuffer: 1 << 30 }));
const exportSeconds = seconds(exporting);
const text = readFileSync(exportFile, 'utf8');
const lines = parseCorpus(text, exportFile).map((parsed) => parsed.line);
const kinds = lines.reduce((counts, line) => ({ ...counts, [line.kind]: (counts[line.kind] ?? 0) + 1 }), {});
say(`export       ${lines.length} lines, ${statSync(exportFile).size} B  ${JSON.stringify(kinds)}  (${exportSeconds} as a subprocess)`);

// --- 2. Lay the same lines out as a tree ---------------------------------------------------------
const writer = openRecordWriter(tree);
const writing = clock();
for (const line of lines) writer.append(line);
writeGitattributes(tree);
const treeSeconds = seconds(writing);
say(`tree         ${tree}`);
say(
  `             ${writer.written.length} records appended into ` +
    `${new Set(writer.written).size} files in ${treeSeconds}, fingerprint ${treeFingerprint(tree)}`,
);

// --- 3. Read the tree back and check the codec is the identity ------------------------------------
const reread = readRecordTree(tree);
const asText = (set) => set.map((line) => serializeCorpus([line])).sort();
const lost = asText(lines).filter((t) => !asText(reread).includes(t));
const gained = asText(reread).filter((t) => !asText(lines).includes(t));
say(
  `\n${lost.length === 0 && gained.length === 0 ? 'EQUAL  ' : 'DIFFERS'} tree round-trip     ` +
    `exported=${lines.length} reread=${reread.length} lost=${lost.length} gained=${gained.length}`,
);
for (const t of lost.slice(0, 3)) say(`         lost:   ${t.slice(0, 300)}`);
for (const t of gained.slice(0, 3)) say(`         gained: ${t.slice(0, 300)}`);

// --- 4. Build the index over the tree, and compare it to the store it came from --------------------
const indexFile = join(tree, INDEX_FILE);
const building = clock();
const built = buildIndex(tree, indexFile, { now: new Date().toISOString() });
const buildSeconds = seconds(building);
say(
  `index        ${built.records} records replayed in ${buildSeconds}, ` +
    `${statSync(indexFile).size} B at ${indexFile}`,
);

const store = new DatabaseSync(liveFile, { readOnly: true });
const index = new DatabaseSync(indexFile, { readOnly: true });

say('\n--- every observable row of the four kinds the corpus format defines ---');
const source = observable(store);
const migrated = observable(index);
let allEqual = true;
for (const table of Object.keys(source)) allEqual = diff(table, source[table], migrated[table]) && allEqual;

// --- 5. Invalidations ride as a scheme line plus annotations, so they are checked by NAME ----------
const invalidationAnnotations = (db) =>
  db
    .prepare(`SELECT * FROM annotations WHERE scheme = 'invalidation' ORDER BY id`)
    .all()
    .map((row) => JSON.stringify(row));
say('\n--- invalidations, which the corpus format carries as a scheme plus annotations ---');
allEqual = diff('invalidation rows', invalidationAnnotations(store), invalidationAnnotations(index)) && allEqual;

const liveInvalidation = (db, id) => JSON.stringify(listInvalidations(db, id).map((row) => row.label).sort());
const struck = store
  .prepare(`SELECT DISTINCT entry_id FROM annotations WHERE scheme = 'invalidation' ORDER BY entry_id`)
  .all()
  .map((row) => row.entry_id);
let strikesEqual = true;
for (const id of struck) {
  if (liveInvalidation(store, id) !== liveInvalidation(index, id)) {
    strikesEqual = false;
    say(`DIFFERS invalidation on ${id}: store=${liveInvalidation(store, id)} index=${liveInvalidation(index, id)}`);
  }
}
say(
  `${strikesEqual ? 'EQUAL  ' : 'DIFFERS'} live invalidation    ${struck.length} entries have a live ` +
    `invalidation, checked one by one through listInvalidations()`,
);

// --- 6. What the corpus format has no way to carry ------------------------------------------------
//
// Reported as ROW COUNTS on both sides, not as "does the table exist". Every table `migrate()` creates
// exists in the index whether or not anything ever populates it -- `ingest_cursor` is created and left
// empty -- so a table-existence check reports "carried" for exactly the tables that are not.
say('\n--- every table the SOURCE store has: rows in the store against rows in the index ---');
const tableNames = (db) =>
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((row) => row.name);
const rowsIn = (db, table) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  } catch {
    return null;
  }
};
// FTS5's own shadow tables are excluded by name and by measurement, not by taste: `entries_fts_data`
// and `entries_fts_idx` are the two whose row counts move (70->69, 68->67) and they hold b-tree
// segments, not documents, so a count there compares the allocator rather than the corpus. What the
// FTS index actually answers is checked by document below, which is the check that can fail for a real
// reason. `entries_fts`, `_content`, `_docsize` and `_config` DO agree and are left in.
const SHADOW = ['entries_fts_data', 'entries_fts_idx'];
const indexTables = tableNames(index);
const carried = [];
const dropped = [];
for (const table of tableNames(store)) {
  const inIndex = indexTables.includes(table);
  const from = rowsIn(store, table);
  const to = inIndex ? rowsIn(index, table) : null;
  const shadow = SHADOW.includes(table);
  const verdict = shadow
    ? 'FTS5 bookkeeping, excluded by name'
    : !inIndex || to === null
      ? 'NOT CARRIED (no such table)'
      : to === from
        ? 'carried'
        : `NOT CARRIED (${to} rows)`;
  if (!shadow) {
    if (to === from && inIndex) carried.push(table);
    else dropped.push(`${table} (${from} rows -> ${verdict})`);
  }
  say(`  ${table.padEnd(24)} store=${String(from).padStart(6)}  index=${String(to ?? '-').padStart(6)}  ${verdict}`);
}
say(`\n  carried whole: ${carried.length} table(s)`);
for (const entry of dropped) say(`  NOT carried:   ${entry}`);

// `meta` is compared as KEYS, since its values are the store's identity rather than a record.
const metaKeys = (db) =>
  db
    .prepare(`SELECT key FROM meta ORDER BY key`)
    .all()
    .map((row) => row.key);
say(`\n  meta keys: store=${JSON.stringify(metaKeys(store))}`);
say(`             index=${JSON.stringify(metaKeys(index))}`);

// --- 7. Search parity, because `entries_fts` is built by triggers rather than by replay -------------
//
// Compared by the `entry_id` COLUMN a hit carries, never by `entries_fts.rowid` and never by joining
// through `entries.rowid`. Measured: `entries_fts` is a standalone `fts5(evidence_text, entry_id
// UNINDEXED, tokenize='trigram')`, so its rowid is assigned in insertion order and its own -- the two
// stores assign them differently while indexing identical documents. A rowid comparison reported five
// probes as DIFFERS, all with identical hit counts, before this was corrected; the join through
// `entries.rowid` was wrong for the same reason, twice over.
say('\n--- search parity: the FTS index is built by triggers, not by the replay loop ---');
const probes = ['the', 'claude', 'error', 'timeout', 'review'];
let searchEqual = true;
for (const probe of probes) {
  const ids = (db) => {
    try {
      return db
        .prepare(`SELECT entry_id FROM entries_fts WHERE entries_fts MATCH ? ORDER BY entry_id`)
        .all(probe)
        .map((row) => row.entry_id);
    } catch (error) {
      return [`<refused: ${error.message}>`];
    }
  };
  const from = ids(store);
  const to = ids(index);
  const same = JSON.stringify(from) === JSON.stringify(to);
  if (!same) {
    searchEqual = false;
    const missing = from.filter((id) => !to.includes(id)).slice(0, 3);
    if (missing.length > 0) say(`         only in store: ${missing.join(', ')}`);
  }
  say(
    `  ${same ? 'EQUAL  ' : 'DIFFERS'} MATCH ${JSON.stringify(probe).padEnd(12)} ` +
      `store hits=${from.length} index hits=${to.length}${same ? ', the same entry_ids' : ''}`,
  );
}

say(
  `\nVERDICT: ${
    allEqual && strikesEqual && searchEqual && lost.length === 0 && gained.length === 0
      ? 'the corpus migrates faithfully'
      : 'NOT faithful -- see the DIFFERS lines above'
  }`,
);
say(`tree left at ${tree} for inspection`);
store.close();
index.close();
