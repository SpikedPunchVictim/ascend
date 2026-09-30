import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  corpusLines,
  GITATTRIBUTES_BODY,
  GITATTRIBUTES_NAME,
  migrateStoreToTree,
  openRecordWriter,
  openStore,
  readRecordTree,
  recordAnnotations,
  recordEntry,
  recordInvalidation,
  registerScheme,
  registerType,
  serializeCorpus,
  STORE_FILE,
  type CorpusLine,
} from '../src/index.js';
import { LEGACY_INGEST_CURSOR_DDL } from './legacy-store.js';

/**
 * The migration: a store's corpus becomes a tree, and the store is moved aside.
 *
 * **The invariant is the one `EV-34` measured on the real corpus**, and it is stated as two counts
 * rather than one: every line the store holds is written (`out`), and the tree reads back as all of
 * them (`back`). A migration is the one operation here that both reads and destroys -- it moves the
 * only other copy -- so a line lost on the way out is lost for good, and the archive is what makes
 * that recoverable rather than the read-back being what makes it safe.
 *
 * **The store's own writers build almost all of the fixture.** It is built through them
 * (`registerType`, `recordEntry`, `recordAnnotations`, `recordInvalidation`), so the migration is
 * exercised against a store that ascend would actually have produced. **The exception is the two
 * things the corpus cannot carry**, `ingest_cursor` and the `meta` keys: they are written with raw
 * SQL, because no writer for them exists any more (`asc-i5tj.14`) and a store being migrated holds
 * them as rows from before the cutover. What is under test is whether the migration NOTICES them,
 * and standing the legacy table up is now part of building the fixture rather than something the
 * schema does for it -- `LEGACY_INGEST_CURSOR_DDL` (`./legacy-store.js`) is where that shape lives.
 *
 * The one thing this file cannot exercise is the `-wal`/`-shm` half of the archive. A cleanly closed
 * database has neither -- `close()` checkpoints and removes them -- so the branch that moves them is
 * defensive, and it is stated here as untested rather than implied to be covered.
 */

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-migrate-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const AT = '2026-09-29T10:00:00.000Z';

const uuid = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A store holding every kind, one invalidation, and the two things no corpus line can carry. */
function seeded(): { readonly dir: string; readonly lines: readonly CorpusLine[] } {
  const dir = scratch();
  const store = openStore({ dir, ascendVersion: '0.1.0' });

  try {
    registerType(
      store.db,
      { name: 'note', properties: [{ name: 'body', type: 'text' }] },
      { registeredAt: AT },
    );
    // A rule, not `rules: []`. With no rules this fixture migrated cleanly while the real store did
    // not: the store hands back `spec_json` as registered, `parseSchemeRule` rebuilds each rule in
    // its own key order, and the read-back comparison in `verify` sees two spellings of one line.
    // Measured on the real store at 10,386 lines: *"3 missing and 3 that should not be there"*, the
    // 3 rule-bearing schemes and none of the rule-less ones (`dogfood/0040`). A fixture whose scheme
    // has no rules cannot be wrong in that way, which is exactly why it was.
    registerScheme(
      store.db,
      'review',
      { labels: ['good', 'bad'], rules: [{ label: 'good', kind: 'sql', query: '1=1' }] },
      { createdAt: AT },
    );
    recordEntry(
      store.db,
      { type: 'note' },
      { id: uuid(1), recordedAt: AT, ascendVersion: '0.1.0' },
    );
    recordAnnotations(
      store.db,
      {
        scheme: 'review',
        schemeVersion: 1,
        annotations: [{ id: uuid(100), entryId: uuid(1), label: 'good' }],
      },
      { createdAt: AT },
    );
    // An invalidation, because it is the one thing the corpus cannot express as a KIND: it rides as
    // a scheme line under the reserved name plus an annotation under it. A fixture without one
    // would leave the reserved scheme's whole path unwritten while every count still looked right.
    recordInvalidation(store.db, {
      entryId: uuid(1),
      label: 'wrong_value',
      reason: 'the body was measured against the wrong revision',
      createdAt: AT,
    });

    // The two gaps, and they are written through RAW SQL rather than through a writer, which the
    // header above says this fixture does everywhere else. That is the change: since 2026-09-29
    // (`asc-i5tj.14`) no code path in the product writes either of these -- the ingest cursor is a
    // JSON file beside the tree -- so a writer to call no longer exists. What a real store being
    // migrated still holds is exactly this: rows from before the cutover, which is the fact the
    // report below has to name. A fixture built through a writer would be testing a path that is
    // gone. `openStore` above no longer creates `ingest_cursor` either -- migration 4 was deleted
    // with the const (`asc-i5tj.14`) -- so the fixture stands the retired shape up itself, from the
    // one spelling of it both this file and `ingest-cursor.test.ts` share.
    store.db.exec(LEGACY_INGEST_CURSOR_DDL);
    store.db
      .prepare('INSERT INTO ingest_cursor (path, mtime_ms, size, ingested_at) VALUES (?, ?, ?, ?)')
      .run('/home/someone/transcripts/session.jsonl', 1_000, 42, AT);
    store.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('ingest.applied_handlers', '["abc123"]');

    return { dir, lines: corpusLines(store.db) };
  } finally {
    store.close();
  }
}

/** The canonical text of each line, sorted -- the comparison `readRecordTree`'s own order forces. */
const canonical = (lines: readonly CorpusLine[]): readonly string[] =>
  lines.map((line) => serializeCorpus([line])).sort();

describe('a store becomes a tree, and the store is moved aside', () => {
  it('writes every line the store holds, and reads all of them back', () => {
    const { dir, lines } = seeded();
    const archiveDir = scratch();

    const report = migrateStoreToTree({ dir, archiveDir });

    // Six: one type, one entry, two scheme versions (review and the reserved name), and one
    // annotation under each. Asserted as a literal because a migration that dropped a kind would
    // otherwise pass this file by writing nothing and reading nothing back.
    expect(report.lines).toBe(6);
    expect(report.lines).toBe(lines.length);

    const written = canonical(lines);
    const found = canonical(readRecordTree(dir));
    expect(found).toHaveLength(6);
    expect(found).toEqual(written);
  });

  it('writes the union-merge attributes, through the writer the layout owns', () => {
    const { dir } = seeded();
    const archiveDir = scratch();

    migrateStoreToTree({ dir, archiveDir });

    // Without this the tree is the store on one machine only: a merge would conflict on every file
    // two branches touched, which is what `merge=union` exists to prevent.
    expect(readFileSync(join(dir, GITATTRIBUTES_NAME), 'utf8')).toBe(GITATTRIBUTES_BODY);
  });

  it('reports the tables no corpus line can carry, and not the derived ones', () => {
    const { dir } = seeded();
    const archiveDir = scratch();

    const report = migrateStoreToTree({ dir, archiveDir });

    // Exactly two, and the exclusions are the point of the assertion being exact: `entries_fts` and
    // its shadow tables are a function of `entries` and are rebuilt from it, so reporting them would
    // invent a gap. `EV-34` names both directions -- an invented difference between two identical
    // things is as corrosive as a hidden real one.
    expect(report.dropped).toEqual([
      { table: 'ingest_cursor', rows: 1, keys: [] },
      {
        table: 'meta',
        rows: 3,
        keys: ['created_by_ascend_version', 'cwd_convention', 'ingest.applied_handlers'],
      },
    ]);
  });

  it('moves the database into the archive and leaves none in the record directory', () => {
    const { dir } = seeded();
    const archiveDir = scratch();

    const report = migrateStoreToTree({ dir, archiveDir });

    expect(report.archive).toEqual([join(archiveDir, STORE_FILE)]);
    expect(existsSync(join(archiveDir, STORE_FILE))).toBe(true);
    // The plan's requirement, asserted: the old store is never left beside the new one. A database
    // still in `.ascend/` is a second source of truth by position, whether or not anything opens it.
    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
  });

  it('lays the tree out under the four directories, one file per kind here', () => {
    const { dir } = seeded();
    const archiveDir = scratch();

    const report = migrateStoreToTree({ dir, archiveDir });

    // One entry per RECORD, not per file, which is the writer's own contract and not a duplicate to
    // be tidied away: `types/` and `schemes/` are flat and append-only, so the two scheme versions
    // land in `schemes/0001.jsonl` and that path is reported twice.
    expect(report.files).toHaveLength(report.lines);

    const files = [...new Set(report.files)];
    // Five files for six lines, and the partition is the assertion: two `annotations/` directories
    // because the reserved scheme and `review` are different names, one `entries/` directory for
    // the one type. Which file a record lands in is `jsonl-files.ts`'s subject; this is what says
    // the migration went through that layer rather than writing one bespoke corpus file.
    expect(files).toHaveLength(5);
    expect(files.map((path) => path.split('/')[0]).sort()).toEqual([
      'annotations',
      'annotations',
      'entries',
      'schemes',
      'types',
    ]);
    for (const path of files) expect(existsSync(join(dir, path))).toBe(true);
  });
});

describe('a migration refuses the states it cannot migrate, before writing anything', () => {
  it('refuses a directory with no store, rather than creating one and reporting success', () => {
    const dir = scratch();
    const archiveDir = scratch();

    expect(() => migrateStoreToTree({ dir, archiveDir })).toThrow(/there is no store at/);

    // The refusal is worth more than a message: opening that path would have CREATED a store, and
    // the migration would then have written an empty tree, archived what it had just made, and
    // reported success. Asserted on the filesystem, because "it threw" alone cannot tell the two
    // apart -- an implementation that opened the store first and threw later would look identical.
    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
    expect(readRecordTree(dir)).toEqual([]);
  });

  it('refuses a directory that already holds a record tree', () => {
    const { dir } = seeded();
    const archiveDir = scratch();

    // A tree, but no migration: `openRecordWriter` appends to what it finds.
    openRecordWriter(dir).append({
      kind: 'type',
      document: { name: 'other', version: 1, properties: [] },
    });

    expect(() => migrateStoreToTree({ dir, archiveDir })).toThrow(/already holds a record tree/);
    expect(existsSync(join(archiveDir, STORE_FILE))).toBe(false);
  });

  it('refuses an archive that already holds a store, and writes no tree', () => {
    const { dir } = seeded();
    const archiveDir = scratch();
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, STORE_FILE), 'a previous store');

    expect(() => migrateStoreToTree({ dir, archiveDir })).toThrow(/already exists/);

    // Checked with the other refusals precisely so that this leaves nothing: found at the move
    // instead, it would strand a written tree next to an unmigrated store.
    expect(readRecordTree(dir)).toEqual([]);
    expect(readFileSync(join(archiveDir, STORE_FILE), 'utf8')).toBe('a previous store');
  });

  it('refuses an archive inside the record directory', () => {
    const { dir } = seeded();

    expect(() => migrateStoreToTree({ dir, archiveDir: join(dir, 'archived') })).toThrow(
      /is inside the record directory/,
    );
    expect(readRecordTree(dir)).toEqual([]);
  });
});
