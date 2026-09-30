import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  annotationRows,
  buildIndex,
  documentSpec,
  entryIds,
  ForeignStoreError,
  INDEX_FILE,
  IndexStaleError,
  listSchemes,
  listTypes,
  openIndex,
  openRecordWriter,
  parseCorpus,
  readRecordTree,
  recordFiles,
  schemeHash,
  serializeCorpus,
  specHash,
  STORE_FILE,
  treeFingerprint,
  type AnnotationLine,
  type CorpusLine,
  type EntryLine,
  type SchemeLine,
  type SchemeSpec,
  type Store,
  type TypeLine,
} from '../src/index.js';

/**
 * The derived index: built from a JSONL tree, wholesale, and never a source of truth.
 *
 * **The invariant this file exists for is that the index is a FUNCTION of the tree.** Every test
 * below is a way of asking the same question -- can the index come to hold something the tree does
 * not, or fail to hold something it does? -- because an index that disagrees with its source is not
 * a slow store, it is a store that returns wrong answers while reporting that it is current. That
 * is the false-green class, and it is severity-zero here for the same reason it is everywhere else:
 * it destroys trust in every other signal the tool emits.
 *
 * **`entry_types.created_at` is excluded from every comparison here, by name, and that is a
 * deliberate exception rather than a convenience.** A `TypeLine` carries no registration timestamp
 * (`documentFromRow` drops it), so `registerType` takes it from the caller and a rebuild stamps the
 * moment of the build. Two indexes built a second apart therefore differ in exactly that column and
 * nowhere else. It does not weaken the invariant -- a timestamp is not a record the JSONL is
 * missing -- but comparing it would make this file fail for a reason that is not a defect, and
 * silently dropping it would hide a real divergence in the same table. So it is dropped where a
 * reader can see it being dropped, next to this paragraph.
 *
 * No SQLite is used to WRITE the fixtures: the tree is written through `openRecordWriter`, so the
 * index is exercised against a tree produced by the layer that will produce real ones. SQLite
 * appears only to construct the two files that must be refused or replaced.
 */

let roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-jsonl-index-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function uuid(n: number): string {
  return `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function at(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  const rest = String(seconds % 60).padStart(2, '0');
  return `2026-09-29T12:${minutes}:${rest}.000Z`;
}

/**
 * The clock the build is given, FIXED.
 *
 * A literal rather than `new Date()`, for two reasons that agree here. The store reads no clock --
 * `recorder.test.ts` asserts that across every module, and it is why `IndexOptions.now` exists at all
 * -- so supplying the real clock would test a shape no real caller has. And a fixed value is what
 * lets the equivalence tests compare two builds at all: `entry_types.created_at` comes from this
 * reading, so two builds a second apart differ in a column `observable()` has to drop by name. One
 * instant for the whole file keeps that drop a deliberate exclusion rather than a load-bearing one.
 */
const OPTS = { now: '2026-09-29T00:00:00.000Z' } as const;

function entry(n: number, typeName = 'note'): EntryLine {
  return {
    kind: 'entry',
    id: uuid(n),
    type_name: typeName,
    type_version: 1,
    type_hash: typeName === 'todo' ? TODO_HASH : NOTE_HASH,
    recorded_at: at(n),
    source: 'self',
    run_id: null,
    workflow: null,
    actor: null,
    cwd: '.',
    repo: null,
    git_sha: null,
    branch: null,
    properties: { body: `note ${String(n)}` },
    na: [],
    evidence_text: null,
    ascend_version: '0.1.0',
    schema_version: 1,
  };
}

function annotation(n: number): AnnotationLine {
  return {
    kind: 'annotation',
    id: uuid(1_000 + n),
    entry_id: uuid(n),
    scheme: 'review',
    scheme_version: 1,
    label: 'good',
    confidence: null,
    note: null,
    created_by: null,
    created_at: at(n),
  };
}

const NOTE: TypeLine = {
  kind: 'type',
  document: {
    name: 'note',
    version: 1,
    properties: [{ name: 'body', type: 'text' }],
    description: 'a note',
  },
};

const TODO: TypeLine = {
  kind: 'type',
  document: {
    name: 'todo',
    version: 1,
    properties: [{ name: 'body', type: 'text' }],
  },
};

const REVIEW_SPEC: SchemeSpec = { labels: ['good', 'bad'], rules: [] };

/** Recomputed by `registerScheme` from `spec`; the index checks the claim against its own answer. */
const REVIEW_HASH = schemeHash(REVIEW_SPEC);

const REVIEW: SchemeLine = {
  kind: 'scheme',
  name: 'review',
  version: 1,
  created_at: at(0),
  spec: REVIEW_SPEC,
  scheme_hash: REVIEW_HASH,
};

/**
 * The fixture's hashes are REAL, computed from the definitions below, not filler.
 *
 * `jsonl-files.test.ts` can use `'a'.repeat(64)` because its reader does not verify a hash -- the
 * line is a column dump and the layer's job is to move it. This file's reader is the store, which
 * does verify: an entry's `type_hash` has to be the hash of the definition it was recorded against
 * or the replay is refused. That refusal is the point -- it is what stops the index from quietly
 * holding the store's hash where the tree named a different one -- so the fixture has to spell a
 * tree that ascend would actually have written.
 */
const NOTE_HASH = specHash(documentSpec(NOTE.document));
const TODO_HASH = specHash(documentSpec(TODO.document));

/** Write a corpus into a fresh tree and hand back its root. */
function tree(lines: readonly CorpusLine[], root = scratch()): string {
  const writer = openRecordWriter(root);
  for (const line of lines) writer.append(line);
  return root;
}

/**
 * Build the index for `root`, which every test now has to ask for by name.
 *
 * It is a helper rather than a call to `openIndex` because that is the whole of `asc-i5tj.3.1`: a read
 * does not build, so a test that wants an index built says so -- and the shape of this suite changed
 * when the API did, which is the settlement being visible in the place that would otherwise hide it.
 */
function build(root: string): ReturnType<typeof buildIndex> {
  return buildIndex(root, join(root, INDEX_FILE), OPTS);
}

const WHOLE_CORPUS: readonly CorpusLine[] = [
  NOTE,
  TODO,
  REVIEW,
  entry(1),
  entry(2),
  entry(3, 'todo'),
  annotation(1),
  annotation(2),
];

/**
 * Everything a reader can observe in a store, as canonical text.
 *
 * `SELECT *` rather than a column list on purpose: a column added to a table by a later migration
 * should appear in this comparison without anyone remembering to add it here, since a divergence
 * that only shows up in a new column is exactly the kind this file is meant to catch.
 */
function observable(store: Store): Record<string, readonly string[]> {
  const dump = (table: string, drop: readonly string[] = []): readonly string[] => {
    const rows = store.db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<
      string,
      unknown
    >[];
    return rows
      .map((row) => {
        const kept: Record<string, unknown> = {};
        for (const key of Object.keys(row).sort()) {
          if (!drop.includes(key)) kept[key] = row[key];
        }
        return JSON.stringify(kept);
      })
      .sort();
  };

  return {
    // `created_at` dropped by name -- see the module comment above.
    entry_types: dump('entry_types', ['created_at']),
    entries: dump('entries'),
    annotation_schemes: dump('annotation_schemes'),
    annotations: dump('annotations'),
  };
}

/**
 * The record file holding `needle`, found by CONTENT rather than by reconstructing the layout.
 *
 * The partitions are named after the type (`entries/<type_name>/0001.jsonl`), so a test that guesses
 * `entries/<name>` has to be updated whenever the layout moves -- and worse, a guess that is merely
 * wrong edits a file that does not hold the record, leaving the tree byte-identical and the test
 * green for a reason it did not intend.
 */
function fileHolding(root: string, needle: string): string {
  for (const { relative } of recordFiles(root)) {
    const file = join(root, relative);
    if (readFileSync(file, 'utf8').includes(needle)) return file;
  }
  throw new Error(`no record file under ${root} holds ${needle}`);
}

/** The index file's own bytes, or `null` when there is no index. */
function indexBytes(root: string): string | null {
  const file = join(root, INDEX_FILE);
  return existsSync(file) ? readFileSync(file, 'latin1') : null;
}

describe('the index is a function of the tree', () => {
  it('holds every record the tree holds', () => {
    const root = tree(WHOLE_CORPUS);
    build(root);
    const store = openIndex(root, join(root, INDEX_FILE));

    expect(listTypes(store.db).map((type) => type.name)).toEqual(['note', 'todo']);
    expect(entryIds(store.db, 'note')).toHaveLength(2);
    expect(entryIds(store.db, 'todo')).toHaveLength(1);
    expect(listSchemes(store.db).map((scheme) => scheme.name)).toEqual(['review']);
    expect(annotationRows(store.db, { scheme: 'review' })).toHaveLength(2);
  });

  it('builds from an empty index path, and reports what it replayed', () => {
    const root = tree(WHOLE_CORPUS);
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);

    const built = buildIndex(root, join(root, INDEX_FILE), OPTS);

    // `records` is the count the command's report is built on, so it is asserted against the corpus
    // the fixture wrote rather than against a number that happens to look plausible.
    expect(built.records).toBe(WHOLE_CORPUS.length);
    expect(built.fingerprint).toBe(treeFingerprint(root));
  });

  it('serves the same index twice without touching the file the second time', () => {
    const root = tree(WHOLE_CORPUS);
    build(root);

    const before = indexBytes(root);
    const again = openIndex(root, join(root, INDEX_FILE));

    expect(entryIds(again.db, 'note')).toHaveLength(2);
    // Byte-identical, not merely "opens". Before `asc-i5tj.3.1` this test asserted
    // `rebuilt === false`, which was a claim the function made about itself; the file's bytes are the
    // claim a caller can check, and they are what would change if a read started rebuilding again.
    expect(indexBytes(root)).toBe(before);
  });

  it('DROPS a record the tree no longer holds, instead of keeping it', () => {
    // The dangerous direction of the invariant. A rebuild that merged into the existing index rather
    // than replacing it would leave this record behind -- and every count downstream would be wrong
    // in a way no test of the tree could see.
    const root = tree(WHOLE_CORPUS);
    build(root);
    expect(entryIds(openIndex(root, join(root, INDEX_FILE)).db, 'note')).toHaveLength(2);

    // Rewrite the file that holds the record, exactly as a checkout of an older revision would
    // leave it: the file is shorter, the fingerprint differs, the set is smaller.
    const file = fileHolding(root, uuid(3));
    const kept = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.includes(uuid(3)));
    writeFileSync(file, `${kept.join('\n')}\n`);

    build(root);
    const again = openIndex(root, join(root, INDEX_FILE));

    // The dropped record is the `todo` one, so the notes are all still there -- and the type that
    // held exactly one record now holds none, which is the case a merge would leave behind.
    expect(entryIds(again.db, 'note')).toHaveLength(2);
    expect(entryIds(again.db, 'todo')).toEqual([]);
  });

  it('builds the same index when deleted and rebuilt', () => {
    const root = tree(WHOLE_CORPUS);
    build(root);
    const first = openIndex(root, join(root, INDEX_FILE));

    rmSync(join(root, INDEX_FILE));
    build(root);
    const rebuilt = openIndex(root, join(root, INDEX_FILE));

    expect(observable(rebuilt)).toEqual(observable(first));
  });

  it('matches a from-scratch build after a sequence of appends to the tree', () => {
    // The property the whole stage is stated over: whatever the tree has been through, the index
    // served for it is the index a rebuild would produce. Anything that reached the index without
    // reaching the tree -- or the reverse -- separates these two.
    const root = tree(WHOLE_CORPUS);
    for (const n of [4, 5, 6]) {
      openRecordWriter(root).append(entry(n));
      build(root);
    }

    const live = openIndex(root, join(root, INDEX_FILE));

    const elsewhere = scratch();
    for (const line of readRecordTree(root)) openRecordWriter(elsewhere).append(line);
    build(elsewhere);
    const fromScratch = openIndex(elsewhere, join(elsewhere, INDEX_FILE));

    expect(observable(live)).toEqual(observable(fromScratch));
  });
});

describe('no write can land in the index that is not first in the tree', () => {
  it('opens read-only, so the handle itself refuses', () => {
    // Structural rather than conventional: the bead's invariant holds because there is no writable
    // handle to violate it with, not because callers were asked to behave. If this ever stops
    // throwing, the invariant has become a convention and every other test here is weaker.
    const root = tree(WHOLE_CORPUS);
    build(root);
    const store = openIndex(root, join(root, INDEX_FILE));

    expect(() => {
      store.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('probe', 'probe');
    }).toThrow(/readonly database/i);
  });
});

describe('a build is published whole, or not at all', () => {
  it('leaves no write-ahead log beside the index', () => {
    // A published index whose `-wal` was left behind is an index missing its last writes -- and it
    // would look perfectly healthy, because the file itself opens. `node:sqlite`'s close()
    // checkpoints and removes the sidecar (probed before this was written), and this is what
    // notices if that ever stops being true.
    const root = tree(WHOLE_CORPUS);
    buildIndex(root, join(root, INDEX_FILE), OPTS);

    expect(
      readdirSync(root).filter((name) => name.includes('-wal') || name.includes('-shm')),
    ).toEqual([]);
  });

  it('replaces the write-ahead log a previous writer left, rather than replaying it', () => {
    // The test above builds into a root where no `-wal` ever existed, so "no residue" is true of
    // the handle it just closed and says nothing about the file the rename REPLACES. A writer that
    // commits and then dies before its own close() leaves a different state: committed frames on
    // disk, describing the database that is about to be overwritten. SQLite recovers a `-wal` onto
    // whatever file sits beside it, so those frames land on the freshly renamed index and restore
    // the fingerprint of the database that was just replaced -- while the build exits 0 reporting
    // the new one. Measured end to end, with the refusal loop it produces, in `dogfood/0044`.
    const root = tree(WHOLE_CORPUS);
    build(root);

    const index = join(root, INDEX_FILE);
    const abandoned = new DatabaseSync(index);
    abandoned.exec('BEGIN IMMEDIATE');
    abandoned
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('index_fingerprint', 'a-fingerprint-the-tree-does-not-have');
    abandoned
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('abandoned_writer', 'yes');
    abandoned.exec('COMMIT');
    // Saved out from under the closing handle and put back. close() is what checkpoints and removes
    // these, and the writer that died never got that far -- so this is its on-disk state, not a
    // simulation of it.
    const wal = readFileSync(`${index}-wal`);
    const shm = readFileSync(`${index}-shm`);
    abandoned.close();
    writeFileSync(`${index}-wal`, wal);
    writeFileSync(`${index}-shm`, shm);

    openRecordWriter(root).append(entry(4));
    build(root);

    // The build's own report is not the evidence -- the read is, and it is what the report is about.
    // `openIndex` refuses unless the file carries the tree's fingerprint, which is the property
    // `buildIndex` claims; in `dogfood/0044` it claimed it four times running while the file held
    // something else, and the remedy the refusal named changed nothing.
    const store = openIndex(root, index);
    expect(
      store.db.prepare('SELECT value FROM meta WHERE key = ?').get('abandoned_writer'),
    ).toBeUndefined();
  });

  it('leaves the previous index untouched when the tree cannot be read', () => {
    const root = tree(WHOLE_CORPUS);
    build(root);
    const before = indexBytes(root);

    // An unreadable line, of the shape a truncated write or a hand-edit leaves.
    const partition = readdirSync(join(root, 'entries'))[0] ?? '';
    appendFileSync(join(root, 'entries', partition, '0001.jsonl'), '{"kind":"entry"}\n');

    expect(() => buildIndex(root, join(root, INDEX_FILE), OPTS)).toThrow();

    // Byte-identical, not merely "opens": a rebuild that wrote into the live index and then failed
    // would leave a file that opens and is wrong.
    expect(indexBytes(root)).toBe(before);
  });

  it('does not answer with a stale index when the tree cannot be indexed', () => {
    // The severity-zero case, stated directly. The fingerprint HAS changed, so the only honest
    // outcomes are a refusal or an error -- and since `asc-i5tj.3.1` it can no longer be a rebuild.
    // Returning the old index here would be a store that says "current" while holding last hour's
    // records, which is the failure this whole file exists to make unreachable.
    const root = tree(WHOLE_CORPUS);
    build(root);
    const before = indexBytes(root);

    const partition = readdirSync(join(root, 'entries'))[0] ?? '';
    appendFileSync(join(root, 'entries', partition, '0001.jsonl'), '{"kind":"entry"}\n');

    expect(() => openIndex(root, join(root, INDEX_FILE))).toThrow(IndexStaleError);
    expect(indexBytes(root)).toBe(before);
  });

  it('leaves no temp file behind after a successful build', () => {
    const root = tree(WHOLE_CORPUS);
    buildIndex(root, join(root, INDEX_FILE), OPTS);

    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the fingerprint is a content hash of the record files', () => {
  it('changes when a record changes', () => {
    const root = tree(WHOLE_CORPUS);
    const before = treeFingerprint(root);

    openRecordWriter(root).append(entry(9));

    expect(treeFingerprint(root)).not.toBe(before);
  });

  it('does NOT change when the files are only touched', () => {
    // EV-32's reason for a content hash over mtime, as a test: `git checkout` stamps files with the
    // current time even when content returns to a state the index already holds, so an mtime-based
    // check forces a multi-second rebuild on every branch switch. A content hash answers the same
    // case for 50 ms.
    const root = tree(WHOLE_CORPUS);
    const before = treeFingerprint(root);
    build(root);

    const partition = readdirSync(join(root, 'entries'))[0] ?? '';
    const file = join(root, 'entries', partition, '0001.jsonl');
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);

    expect(treeFingerprint(root)).toBe(before);
    // Unchanged fingerprint means the read finds the index it already had. Before `asc-i5tj.3.1` this
    // asserted `rebuilt === false`; now the equivalent statement is that a read SUCCEEDS, because the
    // only other thing it could have done is rebuild -- and it cannot.
    expect(() => openIndex(root, join(root, INDEX_FILE))).not.toThrow();
  });

  it('does not depend on the order the partitions were created in', () => {
    // Directory listing order is not something this layer controls, and a hash that changed with it
    // would rebuild on machines whose readdir happens to differ.
    const forwards = tree([NOTE, entry(1, 'note'), entry(2, 'todo'), entry(3, 'zeta')]);
    const backwards = tree([NOTE, entry(3, 'zeta'), entry(2, 'todo'), entry(1, 'note')]);

    expect(treeFingerprint(forwards)).toBe(treeFingerprint(backwards));
  });
});

describe('a file ascend did not create is refused, never replaced', () => {
  /** A SQLite file of someone else's, at the index path, with its bytes handed back for comparison. */
  function foreignIndex(root: string): { file: string; before: string | null } {
    const file = join(root, INDEX_FILE);
    const foreign = new DatabaseSync(file);
    foreign.exec('CREATE TABLE theirs (x TEXT)');
    foreign.close();
    return { file, before: indexBytes(root) };
  }

  it('refuses to READ through a foreign SQLite file at the index path', () => {
    // The same guard `openStore` carries (asc-63v), applied where it matters most: the index path
    // is gitignored and documented as safe to delete, which is exactly why blindly rebuilding over
    // whatever is there would be the tempting mistake.
    const root = tree(WHOLE_CORPUS);
    const { file, before } = foreignIndex(root);

    expect(() => openIndex(root, file)).toThrow(ForeignStoreError);
    expect(indexBytes(root)).toBe(before);
  });

  it('refuses to BUILD over a foreign SQLite file, and says nothing about its tables', () => {
    // **The half that moved here with the build.** Until `asc-i5tj.3.1`, `openIndex` was the only code
    // that could replace the file, so the read path's refusal was the whole guard. Now `buildIndex` is
    // the only writer, and it publishes by `renameSync` -- so without this check a stranger's database
    // would be replaced wholesale, leaving no file to recover and no error to explain it. Asserted by
    // bytes rather than by a message, because the failure would be a file that is simply gone.
    const root = tree(WHOLE_CORPUS);
    const { file, before } = foreignIndex(root);

    expect(() => buildIndex(root, file, OPTS)).toThrow(ForeignStoreError);
    expect(indexBytes(root)).toBe(before);
    // And no temp file left over from the attempt -- the refusal happens before the staging store is
    // created, which is what makes a refused build cost the caller nothing.
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a file that is not a database, then replaces it when asked to build', () => {
    // Derived means disposable: a truncated or corrupted index is not evidence of anything, and
    // rebuilding it is the whole point of the design. Only a file that is *someone else's* is
    // refused, which is the line the tests above draw. Both halves are asserted here because the
    // settlement split them across two functions -- a read refuses, a build replaces.
    const root = tree(WHOLE_CORPUS);
    const file = join(root, INDEX_FILE);
    writeFileSync(file, 'not a database');
    const before = indexBytes(root);

    expect(() => openIndex(root, file)).toThrow(IndexStaleError);
    expect(indexBytes(root)).toBe(before);

    const built = buildIndex(root, file, OPTS);
    expect(built.records).toBe(WHOLE_CORPUS.length);
    expect(entryIds(openIndex(root, file).db, 'note')).toHaveLength(2);
  });
});

describe('a legacy store beside the tree is refused, never built over', () => {
  /**
   * The measured defect this closes: a build reads the TREE, so at a half-flipped project it
   * published an index of the tree alone and reported success while a 3,585-entry `ascend.db` sat
   * beside it unread. See `assertNoLegacyStore`.
   *
   * The fixture is deliberately NOT a valid store -- `STORE_FILE`'s name is all the guard reads,
   * because reading further would cost every build in a migrated project a database open to
   * re-establish a fact the file's absence already carries. Which is also why the test can write the
   * marker with `writeFileSync` and still be testing the real path.
   */
  it('refuses to build while a store of the old name is there, and writes nothing', () => {
    const root = tree(WHOLE_CORPUS);
    writeFileSync(join(root, STORE_FILE), 'a store from before the flip');

    expect(() => build(root)).toThrow(/ascend\.db/);
    // The tree, the message and the filesystem: a refusal that happened after the `.tmp` removal or
    // after the `renameSync` would leave an index that is current for the WRONG store, which is the
    // failure and not a detail of it.
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('names the migration and where the store is archived, rather than a deletion', () => {
    const root = tree(WHOLE_CORPUS);
    writeFileSync(join(root, STORE_FILE), 'a store from before the flip');

    // `asc init` is the command that owns this transition, and it ARCHIVES. A refusal that said
    // "delete it" would be inviting exactly the loss it exists to prevent, so both halves of the
    // remedy are asserted here rather than left to whoever rewrites the message next.
    expect(() => build(root)).toThrow(/asc init[\s\S]*ascend-archived/);
  });

  it('builds the same tree once the store is gone, so the guard refuses one file and not the layout', () => {
    // The control. A guard that refused every tree -- or that keyed on something other than the
    // legacy file -- would pass both tests above and break the whole product.
    const root = tree(WHOLE_CORPUS);
    writeFileSync(join(root, STORE_FILE), 'a store from before the flip');
    expect(() => build(root)).toThrow();

    rmSync(join(root, STORE_FILE));
    build(root);
    expect(entryIds(openIndex(root, join(root, INDEX_FILE)).db, 'note')).toHaveLength(2);
  });
});

describe('a read never builds the index', () => {
  // `asc-i5tj.3.1`, and the behavioural half of its guard -- see this file's module comment for what
  // the other half covers and why neither is sufficient. The shape of every test below is the same:
  // make the index not current in some way, then require `openIndex` to REFUSE and to leave the
  // filesystem exactly as it found it. A silent ~75-second rebuild (EV-33, at 63,870 entries) fails
  // these by succeeding.
  //
  // `IndexStaleError` is asserted BY TYPE rather than by message, because a test that matched the
  // message would pass while the reason was wrong -- and the reason is the part a caller reads.

  it('refuses when there is no index at all, and creates nothing', () => {
    const root = tree(WHOLE_CORPUS);
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);

    expect(() => openIndex(root, join(root, INDEX_FILE))).toThrow(IndexStaleError);

    // The assertion the settlement is FOR: no build happened as a side effect. A rebuild would leave
    // a 22 MB file here, and before `asc-i5tj.3.1` it did.
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses when the tree has changed, and leaves the old index byte-identical', () => {
    const root = tree(WHOLE_CORPUS);
    build(root);
    const before = indexBytes(root);

    openRecordWriter(root).append(entry(4));

    expect(() => openIndex(root, join(root, INDEX_FILE))).toThrow(IndexStaleError);
    // Not merely "did not fix it": the bytes are unchanged, so the index the next build will publish
    // over is still the one the last build published.
    expect(indexBytes(root)).toBe(before);
  });

  it('refuses an unreadable index rather than replacing it', () => {
    const root = tree(WHOLE_CORPUS);
    const file = join(root, INDEX_FILE);
    writeFileSync(file, 'not a database');
    const before = indexBytes(root);

    expect(() => openIndex(root, file)).toThrow(IndexStaleError);
    expect(indexBytes(root)).toBe(before);
  });

  it('says which of the three ways it is stale, and names the command that fixes it', () => {
    // The message is the whole interface for the person who meets this -- there is no code to branch
    // on in a shell -- so the two things it has to carry are asserted: what is wrong, and what to run.
    // Three cases, three reasons, and none of them is a code the reader has to look up.
    const root = tree(WHOLE_CORPUS);
    const file = join(root, INDEX_FILE);

    /** The reason from the refusal `openIndex` is required to raise. */
    const reason = (): string => {
      try {
        openIndex(root, file);
      } catch (error) {
        return (error as IndexStaleError).reason;
      }
      throw new Error('openIndex returned instead of refusing, so there is no reason to read');
    };

    expect(reason()).toBe('there is no index there');
    expect(() => openIndex(root, file)).toThrow(/asc index build/);

    build(root);
    // Current, so no refusal at all -- and asserted here rather than in its own test because the
    // reason-for-a-refusal helper above is only meaningful if this state produces none.
    expect(() => openIndex(root, file)).not.toThrow();

    openRecordWriter(root).append(entry(4));
    expect(reason()).toBe('the tree has changed since it was built');

    rmSync(file);
    writeFileSync(file, 'not a database');
    expect(reason()).toBe('the file there is not an index ascend can read');
  });

  it('refuses by TYPE, so a caller can tell it apart from a broken index it may not replace', () => {
    // The distinction the CLI needs and the reason `IndexStaleError` is a class rather than a bare
    // `Error`: a stale index is one a build command will fix, and a foreign file is one nothing will.
    const root = tree(WHOLE_CORPUS);
    const stale = (): unknown => {
      try {
        openIndex(root, join(root, INDEX_FILE));
        return undefined;
      } catch (error) {
        return error;
      }
    };

    expect(stale()).toBeInstanceOf(IndexStaleError);
    expect(stale()).not.toBeInstanceOf(ForeignStoreError);
  });
});

describe('a line whose claim the store would reinterpret is refused, not restored', () => {
  /**
   * Rewrite a tree by transforming its LINES, through the corpus's own codec.
   *
   * Not a string replacement, and the difference is the point. A `text.replace` on `"version":1`
   * would have to guess at the serialised spelling, and would silently do nothing -- leaving the
   * test green for the wrong reason -- the day `orderedLine` reorders a key or `serializeCorpus`
   * stops emitting a space. Parsing to a `CorpusLine`, changing one field, and serialising back is
   * the same path a hand-edit takes, so a test that says "this line cannot be restored" is
   * exercising a line the reader can actually produce.
   */
  function rewrite(root: string, change: (line: CorpusLine) => CorpusLine): void {
    for (const { relative } of recordFiles(root)) {
      const file = join(root, relative);
      const lines = parseCorpus(readFileSync(file, 'utf8'), relative).map((parsed) =>
        change(parsed.line),
      );
      writeFileSync(file, `${serializeCorpus(lines)}\n`);
    }
  }

  it('refuses an entry whose type_hash is not the one the type registered', () => {
    const root = tree(WHOLE_CORPUS);
    rewrite(root, (line) =>
      line.kind === 'entry' ? { ...line, type_hash: 'c'.repeat(64) } : line,
    );

    expect(() => buildIndex(root, join(root, INDEX_FILE), OPTS)).toThrow(/type_hash/);
  });

  it('refuses a scheme line claiming a version the store does not mint', () => {
    const root = tree(WHOLE_CORPUS);
    // The scheme registers as version 1; the line is made to claim 2.
    rewrite(root, (line) => (line.kind === 'scheme' ? { ...line, version: 2 } : line));

    expect(() => buildIndex(root, join(root, INDEX_FILE), OPTS)).toThrow(/version/);
  });

  it('refuses a scheme line whose scheme_hash is not the hash of its own spec', () => {
    // A different claim from the version above, and a different silent outcome: the spec is real
    // and the store would register it happily, so nothing but this check notices that the hash
    // beside it names a spec the line does not carry. Left alone, the index would answer "which
    // spec was this pass run against" with the store's computed hash -- not the tree's.
    const root = tree(WHOLE_CORPUS);
    rewrite(root, (line) =>
      line.kind === 'scheme' ? { ...line, scheme_hash: 'd'.repeat(64) } : line,
    );

    expect(() => buildIndex(root, join(root, INDEX_FILE), OPTS)).toThrow(/scheme_hash/);
  });
});

describe('the index is filed where the layout says', () => {
  it('names the file the plan names, and reports it on the store', () => {
    const root = tree(WHOLE_CORPUS);
    build(root);
    const store = openIndex(root, join(root, INDEX_FILE));

    expect(INDEX_FILE).toBe('index.db');
    expect(basename(store.file)).toBe('index.db');
    expect(store.file).toBe(join(root, INDEX_FILE));
  });
});
