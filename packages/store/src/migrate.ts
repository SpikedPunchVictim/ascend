/**
 * The migration: a SQLite store becomes a record tree, and the store is moved aside.
 *
 * `asc-i5tj.4` — one half of the cutover. E12.4 makes the JSONL tree the store and the derived index
 * a rebuildable cache, which leaves exactly one question this module answers: what happens to a
 * checkout whose corpus is still in `.ascend/ascend.db`.
 *
 * **It reads the lines through `corpusLines` and writes them through `openRecordWriter`** — the same
 * two functions `asc export` and the index build use, in that order. That is the whole correctness
 * claim, and it is why neither is re-implemented here: a migration with its own spelling of the
 * format would produce a tree the project's own export does not reproduce, and both paths would
 * report success. `EV-34` measured the real corpus against this pairing -- 10,316 lines out, 10,316
 * read back, 0 lost and 0 gained.
 *
 * **It verifies by reading the tree back before it moves anything**, which is the check `EV-34`
 * performed by hand, promoted to something every migration does. The comparison is over canonical
 * per-line text as a SET, not as a sequence: `readRecordTree` imposes its own total order on entries
 * and annotations (`jsonl-files.ts`'s ORDER), which is not the order a corpus is written in and is
 * not meant to be, so comparing sequences would report a difference where there is none.
 *
 * **Nothing is destroyed.** The store's files are MOVED into `archiveDir`, all of them together --
 * `-wal` and `-shm` are part of the database, and archiving `ascend.db` alone would leave an
 * archived copy that is missing whatever the write-ahead log had not yet checkpointed. The caller
 * deletes the archive if it wants to; this module never does.
 *
 * **The report names what the corpus cannot carry.** A corpus line accounts for four tables and the
 * store holds more, so every other table holding rows is listed with its count. The list is DERIVED
 * from `sqlite_master` rather than written down here, because a hardcoded list of gaps is a list
 * that stops being true the next time the schema grows -- and the growth is exactly when a silently
 * dropped table would appear. `EV-34` found the two this repo has: 1,070 `ingest_cursor` rows and
 * two `meta` keys (`created_by_ascend_version`, `ingest.applied_handlers`).
 *
 * **A table's row VALUES are never printed, with one deliberate exception.** `meta`'s rows are
 * named configuration, so its keys are listed; the rule is a `key` column and not a table name.
 * Nothing else qualifies, and that is not incidental: the other table's identity column is `path`,
 * holding 1,070 absolute directories under a home directory. Naming those in a report would put on
 * a terminal -- and into a log -- exactly the disclosure `asc-i5tj.14` exists to keep out of a
 * git-tracked record.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { corpusLines } from './corpus-lines.js';
import { openStore, STORE_FILE, type Store } from './db.js';
import { openRecordWriter, readRecordTree, writeGitattributes } from './jsonl-files.js';
import { serializeCorpus, type CorpusLine } from './jsonl.js';
import type { SqlDatabase } from './sql-port.js';

/**
 * The four tables a corpus line stream can account for.
 *
 * `entries_fts` and its shadow tables are absent on purpose rather than by oversight: they are a
 * function of `entries`, rebuilt by the schema itself, so a tree that restores `entries` restores
 * them. Listing them as dropped would be a false report of a gap that does not exist, which
 * `EV-34` states as the reason it checks both sides as ROWS rather than asking whether a table is
 * present.
 */
const CORPUS_TABLES: readonly string[] = [
  'annotation_schemes',
  'annotations',
  'entries',
  'entry_types',
];

/** One table holding rows the corpus has no line for. */
export interface DroppedTable {
  readonly table: string;
  readonly rows: number;
  /**
   * The table's `key` column values, when it has a column of exactly that name. Empty otherwise --
   * see this module's doc for why no other column is read.
   */
  readonly keys: readonly string[];
}

/** What a migration did, and what it could not carry. */
export interface MigrationReport {
  /** Corpus lines written, which is the count `EV-34` compares both ways. */
  readonly lines: number;
  /**
   * The path each record landed at, in write order -- one entry per record, so a path REPEATS when
   * a file holds several. `types/` and `schemes/` are flat, so two scheme versions share one file;
   * the repetition is what makes the partition visible rather than a defect to be deduplicated.
   */
  readonly files: readonly string[];
  /** Absolute paths moved out of the store's directory, in the order they were moved. */
  readonly archive: readonly string[];
  /** Tables holding rows no line can restore, sorted by name. Empty is the ordinary case. */
  readonly dropped: readonly DroppedTable[];
}

export interface MigrationOptions {
  /** The `.ascend` directory: it holds `ascend.db` now and the record tree afterwards. */
  readonly dir: string;
  /** Where the store's database files are moved. Must not be inside `dir`. */
  readonly archiveDir: string;
}

/**
 * Turn the store in `options.dir` into a record tree there, moving the store's files to
 * `options.archiveDir`.
 *
 * Refusals come before any write, and each names the state it found rather than the one it wanted:
 *
 * - **No store.** Opening a directory with no database CREATES one (`openStore`), so a migration
 *   that did not check first would write an empty tree, archive a database it had just made, and
 *   report success -- a migration that migrated nothing. Checked here, because the false green is
 *   the defect and not the missing file.
 * - **A tree already present.** `openRecordWriter` appends to whatever it finds, so migrating into a
 *   directory that already holds records would interleave two corpora into one tree with nothing
 *   reporting the join. This covers a re-run after a failed verification as well, which is why the
 *   message names the way forward rather than only the problem.
 * - **An archive inside `dir`.** The archived database must not sit in the directory the tree
 *   occupies: the layout's own `.gitignore` work un-ignores the record subtree inside `.ascend/`,
 *   and a second database in that directory is one `git add` from being tracked.
 */
export function migrateStoreToTree(options: MigrationOptions): MigrationReport {
  const dir = resolve(options.dir);
  const archiveDir = resolve(options.archiveDir);

  if (archiveDir === dir || archiveDir.startsWith(dir + sep)) {
    throw new Error(
      `the archive directory ${archiveDir} is inside the record directory ${dir}. The tree ` +
        `occupies that directory after the migration, and the archived store must not sit in it: ` +
        `the record subtree is un-ignored in git, so a database left there is a database that ` +
        `gets committed. Put the archive beside the project's store directory instead.`,
    );
  }

  const storeFile = join(dir, STORE_FILE);
  if (!existsSync(storeFile)) {
    throw new Error(
      `there is no store at ${storeFile}, so there is nothing to migrate. This is refused rather ` +
        `than performed because opening that path would CREATE an empty store, and the migration ` +
        `would then write an empty tree and report success.`,
    );
  }

  const existing = readRecordTree(dir);
  if (existing.length > 0) {
    throw new Error(
      `${dir} already holds a record tree (${String(existing.length)} line(s)). This migration ` +
        `writes a tree and never appends to one, because a writer that appended would interleave ` +
        `two corpora into a single tree with nothing reporting the join. Move the tree aside and ` +
        `run this again, or leave the store as it is.`,
    );
  }

  // The archive destination is checked HERE, with the other refusals, and checked again at the move
  // (`archiveStore`). Checked here so that the ordinary case -- an archive directory that already
  // holds a store -- leaves NOTHING behind: discovered at the move, it would strand a written tree
  // next to an unmigrated store, which is the state this migration exists to end. Checked there too
  // because the two are seconds apart and a file can appear between them.
  const archived = join(archiveDir, STORE_FILE);
  if (existsSync(archived)) {
    throw new Error(
      `${archived} already exists, and an archive directory holds one store. Nothing was written. ` +
        `Archiving over a previous store is the one step in this migration that re-running cannot ` +
        `undo, so it is refused rather than performed. Move that file aside, or name a different ` +
        `archive directory.`,
    );
  }

  // Read through an open store that is CLOSED before anything is written, and specifically before
  // the files are moved: `close()` checkpoints the write-ahead log, so a handle held across the move
  // would write to a path that is no longer the database.
  const { lines, dropped } = readStore(openStore({ dir }));

  const writer = openRecordWriter(dir);
  for (const line of lines) writer.append(line);
  writeGitattributes(dir);

  verify(dir, lines);

  const archive = archiveStore(storeFile, archiveDir);

  return { lines: lines.length, files: writer.written, archive, dropped };
}

/** The lines, and the gaps, from a store that is closed here and never handed back open. */
function readStore(store: Store): {
  readonly lines: readonly CorpusLine[];
  readonly dropped: readonly DroppedTable[];
} {
  try {
    return { lines: corpusLines(store.db), dropped: droppedTables(store.db) };
  } finally {
    store.close();
  }
}

/**
 * Refuse a tree that does not read back as the lines that were written to it.
 *
 * Compared as SETS of canonical lines, for the ordering reason this module's doc gives. The counts
 * are compared as well, and separately, because a set comparison alone cannot see a line that was
 * DROPPED as a duplicate of another -- `readRecordTree` dedupes entry and annotation lines on their
 * canonical text, which is right for a union merge and wrong to do silently to a migration.
 */
function verify(dir: string, lines: readonly CorpusLine[]): void {
  const read = readRecordTree(dir);
  const written = lines.map((line) => serializeCorpus([line])).sort();
  const found = read.map((line) => serializeCorpus([line])).sort();

  if (written.length === found.length && written.every((line, at) => line === found[at])) return;

  const missing = written.filter((line) => !found.includes(line));
  const extra = found.filter((line) => !written.includes(line));
  throw new Error(
    `the tree at ${dir} does not read back as the corpus that was written to it: ` +
      `${String(written.length)} line(s) written, ${String(found.length)} read, ` +
      `${String(missing.length)} missing and ${String(extra.length)} that should not be there. ` +
      `Nothing has been archived -- the store is untouched -- but the tree above is incomplete ` +
      `and must not be built on. This is a defect in the write path rather than in the store.`,
  );
}

/**
 * Move the store's database files into `archiveDir`, as one unit, and report where they went.
 *
 * `-wal` and `-shm` move with the database or the archive is not the database: SQLite keeps
 * committed data in the write-ahead log until a checkpoint, so a lone `ascend.db` can be missing
 * every write since the last one. They are moved if present and not demanded -- a cleanly closed
 * database has neither.
 *
 * Each move refuses an existing destination. A second migration into one archive directory would
 * otherwise silently replace the first store with the second, which is the one operation here that
 * cannot be undone by re-running anything.
 */
function archiveStore(storeFile: string, archiveDir: string): readonly string[] {
  mkdirSync(archiveDir, { recursive: true });

  const moved: string[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${storeFile}${suffix}`;
    if (!existsSync(from)) continue;

    const to = join(archiveDir, `${STORE_FILE}${suffix}`);
    if (existsSync(to)) {
      throw new Error(
        `cannot archive ${from} to ${to}: something is already there. An archive directory holds ` +
          `one store, and overwriting one is the only step in this migration that re-running ` +
          `cannot undo.`,
      );
    }

    renameSync(from, to);
    moved.push(to);
  }

  return moved;
}

/**
 * Every table holding rows that no corpus line can carry.
 *
 * Derived from `sqlite_master`, never listed here: see this module's doc. The exclusions are
 * SQLite's own bookkeeping (`sqlite_%`) and derived tables, which are found by asking the schema
 * which tables are virtual and taking their shadow tables with them -- so the next FTS table is
 * excluded when it is added rather than when somebody remembers this function exists.
 *
 * Empty tables are left out. A table with no rows is not a gap this migration created, and listing
 * it would bury the ones that are.
 */
function droppedTables(db: SqlDatabase): readonly DroppedTable[] {
  const tables = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as unknown as { name: string; sql: string | null }[];

  const derived = new Set(
    tables
      .filter((table) => (table.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE'))
      .map((table) => table.name),
  );
  for (const base of [...derived]) {
    for (const table of tables) {
      if (table.name.startsWith(`${base}_`)) derived.add(table.name);
    }
  }

  const dropped: DroppedTable[] = [];
  for (const table of tables) {
    if (derived.has(table.name) || CORPUS_TABLES.includes(table.name)) continue;

    const count = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number };
    if (count.n === 0) continue;

    dropped.push({ table: table.name, rows: count.n, keys: keyValues(db, table.name) });
  }

  return dropped;
}

/**
 * A table's `key` column values, or nothing when it has no column of that name.
 *
 * A column name, not a table name: the question is whether a row has a name of its own, and `meta`
 * answers yes while every other table holds values rather than names. Reading any other column
 * would mean reading `ingest_cursor.path` -- see this module's doc.
 */
function keyValues(db: SqlDatabase, table: string): readonly string[] {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === 'key')) return [];

  const rows = db.prepare(`SELECT key FROM "${table}" ORDER BY key`).all() as unknown as {
    key: string;
  }[];
  return rows.map((row) => row.key);
}
