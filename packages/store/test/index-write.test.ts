import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIndex,
  documentSpec,
  ForeignStoreError,
  INDEX_FILE,
  IndexStaleError,
  listTypes,
  openIndex,
  openRecordWriter,
  readRecordTree,
  serializeCorpus,
  specHash,
  treeFingerprint,
  writeLines,
  type CorpusLine,
  type EntryLine,
  type Store,
  type TypeLine,
} from '../src/index.js';

/**
 * The write path: lines go to the tree, and the index is kept current when it was.
 *
 * **The invariant this file exists for is ORDER, not outcome.** `writeLines` appends to the tree
 * before it replays anything into the index, and stamps inside the same transaction as the replay.
 * Both halves of that are testable, and the tests below are chosen so that each fails if the order is
 * reversed rather than merely if the function is broken:
 *
 *   - The refused-replay test is the one that cannot pass by accident. A write whose line the index
 *     will not accept must still leave the tree WRITTEN and the index STALE, and it only does if the
 *     append came first. **Measured by mutation rather than argued**: reversing the two statements --
 *     replay in both branches, append after -- failed this test and only this test (`1 failed |
 *     7 passed`, 2026-09-29). A test whose falsification has not been run is a test whose value is
 *     a guess, and this is the one place in the file where the distinction matters.
 *   - The stamp test asserts the fingerprint is the tree's AFTER the append. Stamping the read-before
 *     value would be a one-character difference that leaves an index claiming to describe a tree it
 *     does not, which is the false-green class this package treats as severity-zero.
 *
 * **The negative control is the stale-index test**, and it is the one the plan asked for by name: a
 * write against an index that was already not current must leave it not current. The failure it
 * catches is a write that stamps whatever it finds, which would turn every read after an unrelated
 * tree edit into a confident wrong answer rather than a refusal.
 *
 * The index is never written directly here. It is built through `buildIndex` and then maintained
 * through `writeLines`, so what is under test is the pair of paths a real caller uses; `DatabaseSync`
 * appears only to construct the foreign file that must be refused.
 */

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-index-write-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function uuid(n: number): string {
  return `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** A fixed clock, for the reason `jsonl-index.test.ts` gives: the store reads none of its own. */
const OPTS = { now: '2026-09-29T00:00:00.000Z' } as const;

const NOTE: TypeLine = {
  kind: 'type',
  document: {
    name: 'note',
    version: 1,
    properties: [{ name: 'body', type: 'text' }],
    description: 'a note',
  },
};

/** Real, computed from the definition above: the index verifies a replay against its own answer. */
const NOTE_HASH = specHash(documentSpec(NOTE.document));

function entry(n: number): EntryLine {
  return {
    kind: 'entry',
    id: uuid(n),
    type_name: 'note',
    type_version: 1,
    type_hash: NOTE_HASH,
    recorded_at: `2026-09-29T00:00:${String(n).padStart(2, '0')}.000Z`,
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

/** A tree holding the type and one entry, with an index built for it. */
function built(): { readonly root: string; readonly dbPath: string } {
  const root = scratch();
  const writer = openRecordWriter(root);
  writer.append(NOTE);
  writer.append(entry(1));

  const dbPath = join(root, INDEX_FILE);
  buildIndex(root, dbPath, OPTS);

  return { root, dbPath };
}

/**
 * Every entry id an index holds, sorted.
 *
 * Read as rows rather than through `entryIds`, which answers for ONE type -- the question here is
 * about the whole table, and `SELECT id` is the same instrument `jsonl-index.test.ts` uses for its
 * `observable()` dump. Sorted so the comparison is over the SET, which is what the invariant is.
 */
function ids(store: Store): readonly string[] {
  const rows = store.db.prepare('SELECT id FROM entries').all() as unknown as { id: string }[];
  return rows.map((row) => row.id).sort();
}

/** The index's own bytes, for asserting that a stale one was left alone rather than rewritten. */
function bytes(dbPath: string): Buffer {
  return readFileSync(dbPath);
}

describe('a write keeps a current index current', () => {
  it('puts the line in the tree and the record in the index, and the read follows', () => {
    const { root, dbPath } = built();
    const report = writeLines(root, dbPath, [entry(2)], OPTS);

    expect(report).toMatchObject({ lines: 1, stale: false });

    const written = readRecordTree(root).map((line) => serializeCorpus([line]));
    expect(written).toContain(serializeCorpus([entry(2)]));

    // The read a caller performs immediately after: a cache hit, not a refusal and not a rebuild.
    const store = openIndex(root, dbPath);
    try {
      expect(ids(store)).toEqual([uuid(1), uuid(2)].sort());
    } finally {
      store.db.close();
    }
  });

  it('stamps the tree as it is AFTER the append, which is what makes the read pass', () => {
    const { root, dbPath } = built();
    const before = treeFingerprint(root);

    const report = writeLines(root, dbPath, [entry(2)], OPTS);

    // Both candidates are named, so this test fails for the right reason: the pre-append fingerprint
    // is a value the implementation has in hand and could stamp by mistake.
    expect(before).not.toBe(report.fingerprint);
    expect(report.fingerprint).toBe(treeFingerprint(root));

    // Which is the assertion that matters -- `openIndex` compares the stored value against the tree's
    // and refuses on any mismatch, so reaching the next line means the stored value was this one.
    openIndex(root, dbPath).db.close();
  });

  it('adds a record the tree holds even when the index has never seen the type before', () => {
    const { root, dbPath } = built();
    // A write that carries a definition and a record filed against it: `replay` orders them, so the
    // entry is not refused for naming a type the index has not registered yet.
    const todo: TypeLine = {
      kind: 'type',
      document: { name: 'todo', version: 1, properties: [{ name: 'body', type: 'text' }] },
    };
    const todoEntry: EntryLine = {
      ...entry(3),
      type_name: 'todo',
      type_hash: specHash(documentSpec(todo.document)),
      properties: { body: 'note 3' },
    };

    writeLines(root, dbPath, [todo, todoEntry], OPTS);

    const store = openIndex(root, dbPath);
    try {
      expect(listTypes(store.db).map((type) => type.name)).toContain('todo');
      expect(ids(store)).toContain(uuid(3));
    } finally {
      store.db.close();
    }
  });
});

describe('a write against an index that was already stale leaves it stale', () => {
  it('appends to the tree, refuses to touch the index, and the read still refuses', () => {
    const { root, dbPath } = built();

    // Someone else moved the tree -- an edit, a checkout, a union merge. Written through the layer
    // that writes real ones rather than by hand, so the tree is one a caller could actually produce.
    openRecordWriter(root).append(entry(9));
    const moved = bytes(dbPath);

    const report = writeLines(root, dbPath, [entry(2)], OPTS);

    expect(report.stale).toBe(true);
    // The lines reached the store, which is the JSONL. Only the cache declined to follow.
    expect(readRecordTree(root).map((line) => serializeCorpus([line]))).toContain(
      serializeCorpus([entry(2)]),
    );

    // Byte-identical rather than merely equal in row count: the failure this catches is a write that
    // quietly stamps what it found, and a rewrite that happened to hold the same records would still
    // carry a new fingerprint.
    expect(bytes(dbPath)).toEqual(moved);
    expect(() => openIndex(root, dbPath)).toThrow(IndexStaleError);
  });
});

describe('a write is ordered, and the tree is what survives a lost index', () => {
  it('leaves the tree written and the index stale when the replay refuses the line', () => {
    const { root, dbPath } = built();

    // An entry naming a type the tree never carried. `replayEntry` reaches `recordEntry`, which
    // resolves the definition and refuses -- so the replay throws INSIDE the transaction, which is
    // the deterministic stand-in for a process dying between the append and the commit.
    const orphan: EntryLine = { ...entry(4), type_name: 'never-registered' };

    expect(() => writeLines(root, dbPath, [orphan], OPTS)).toThrow();

    // The order, asserted: the line IS in the tree. An implementation that replayed first and
    // appended second leaves this empty, and passes every other test in this file.
    expect(readRecordTree(root).map((line) => serializeCorpus([line]))).toContain(
      serializeCorpus([orphan]),
    );

    // And the index did not half-commit: the rollback took the record with it, so no read can be
    // served an index that describes the tree as it was while the tree has moved on.
    expect(() => openIndex(root, dbPath)).toThrow(IndexStaleError);
  });

  it('holds nothing the tree does not, in either direction', () => {
    const { root, dbPath } = built();
    writeLines(root, dbPath, [entry(2)], OPTS);

    const inTree = readRecordTree(root)
      .filter((line): line is EntryLine => line.kind === 'entry')
      .map((line) => line.id)
      .sort();

    const store = openIndex(root, dbPath);
    try {
      // Equal as sets, which is the invariant stated as a reader would ask it: the index is a
      // function of the tree, so it can neither hold a record the tree lacks nor miss one it has.
      expect(ids(store)).toEqual(inTree);
    } finally {
      store.db.close();
    }
  });
});

describe('a write refuses a database ascend did not create', () => {
  it('propagates the foreign refusal and appends nothing to the tree', () => {
    const root = scratch();
    const writer = openRecordWriter(root);
    writer.append(NOTE);
    writer.append(entry(1));

    // A valid SQLite database that is not ascend's -- the asc-63v case, met on the WRITE path now.
    const dbPath = join(root, INDEX_FILE);
    const stranger = new DatabaseSync(dbPath);
    stranger.exec('CREATE TABLE theirs (x TEXT)');
    stranger.close();

    const before = readRecordTree(root).length;
    expect(() => writeLines(root, dbPath, [entry(2)], OPTS)).toThrow(ForeignStoreError);

    // Refused BEFORE the append: a tree written while the index cannot be touched would be records
    // no read of this project can see, which is worse than a write that did not happen.
    expect(readRecordTree(root)).toHaveLength(before);
    expect(readFileSync(dbPath).byteLength).toBeGreaterThan(0);
  });
});

describe('a write that changes nothing changes nothing', () => {
  it('stamps the same fingerprint when the lines are empty, and stays readable', () => {
    const { root, dbPath } = built();
    const before = treeFingerprint(root);

    // Not a use case to celebrate, but it is the boundary of the currency check: no lines means the
    // tree is unchanged, so the index was current and stays current with the identical stamp.
    const report = writeLines(root, dbPath, [] as readonly CorpusLine[], OPTS);

    expect(report).toMatchObject({ lines: 0, stale: false, fingerprint: before });
    openIndex(root, dbPath).db.close();
  });
});
