import type { TypeSpec } from '@ascend/core';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIndex,
  ForeignStoreError,
  INDEX_FILE,
  IndexStaleError,
  openIndex,
  openRecordWriter,
  previewProducedLines,
  readRecordTree,
  treeFingerprint,
  typeVersions,
  writeProducedLines,
  type TypeLine,
} from '../src/index.js';

/**
 * The fused write path: one lock across produce, append and replay, or a refusal.
 *
 * **The question this file answers is not "does it write" but "what does it do when the index is not
 * current", and EV-35 is why.** `writeLines` takes lines its caller already had, so a stale index
 * costs it only the index's maintenance. `writeProducedLines` COMPUTES the lines by running the real
 * writers against that index, so a stale index makes the lines themselves untrue. Measured
 * (`EV-35`, n=1, scheme productions): an index holding `screening` v1 beside a tree holding v1 and v2
 * minted a well-formed line claiming **version 2** with a spec the tree's version 2 does not carry --
 * a duplicate in a `merge=union` file, which nothing ever collapses. It does not fail, and the store
 * would not reject the line.
 *
 * So the two tests that carry the decision are:
 *
 *   - **The honest-version test.** The tree is put one version ahead of the index by a hand append --
 *     a checkout, a merge or an edit -- and the next production must mint v3, not a second v2. This
 *     is the EV-35 defect as a regression test, and it fails if the index is not made current before
 *     the probe reads it.
 *   - **The lock test.** A second connection is driven against `index.db` from INSIDE the body, and
 *     it must lose. That is the asc-q4p requirement (`annotate.ts`'s read-produce-append) stated as
 *     something a test can see: the body runs in the transaction, not beside it, which is only
 *     possible because `withRollback` nests as a savepoint (`db.ts`, committed 2026-09-29).
 *
 * **What is NOT covered here, and cannot be by a deterministic in-process test:** the currency check
 * made *inside* the lock, after the pre-lock build. Reaching it needs the tree to move in the window
 * between the pre-lock check and `BEGIN IMMEDIATE`, which requires a second process and a timing
 * handshake this file does not attempt. It is a window guard, verified by construction and not by
 * measurement -- stated rather than implied, because a guard whose falsification has not been run is
 * a guard whose value is a guess.
 *
 * The index is never written directly: it is built through `buildIndex` and maintained through
 * `writeProducedLines`, so what is under test is the pair of paths a real caller uses. `DatabaseSync`
 * appears only to construct the foreign file that must be refused and the lock the body must hold.
 */

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-produced-write-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

const OPTS = { now: '2026-09-29T00:00:00.000Z' } as const;
const AT = '2026-09-29T00:00:00.000Z';

const BODY = { name: 'body', type: 'text' } as const;
const TITLE = { name: 'title', type: 'text' } as const;
const PINNED = { name: 'pinned', type: 'text' } as const;

/** Three shapes of one type, each a real change to the previous, so a version number is the measure. */
const V1: TypeSpec = { name: 'note', properties: [BODY] };
const V2: TypeSpec = { name: 'note', properties: [BODY, TITLE] };
const V3: TypeSpec = { name: 'note', properties: [BODY, TITLE, PINNED] };

/**
 * The v2 shape as a LINE, for the one fixture that cannot be made through the write path.
 *
 * This is the same bytes the write path would append for v2 -- including the `version` the line
 * states (asc-i5tj.6) -- which is what makes the hand append a faithful stand-in for the tree-only
 * edit a checkout, a merge or a hand edit leaves behind.
 */
const V2_LINE: TypeLine = {
  kind: 'type',
  document: { name: 'note', version: 2, properties: [BODY, TITLE] },
};

/** A tree holding `note` v1, with a current index built for it. */
function built(): { readonly root: string; readonly dbPath: string } {
  const root = scratch();
  const dbPath = join(root, INDEX_FILE);

  writeProducedLines(root, dbPath, OPTS, (produce) => produce.type(V1, { registeredAt: AT }));

  return { root, dbPath };
}

/** Every version of `note` an index holds, oldest first. */
function versions(root: string, dbPath: string): readonly number[] {
  return typeVersions(openIndex(root, dbPath).db, 'note').map((row) => row.version);
}

describe('a produced write keeps the tree and the index in step', () => {
  it('produces, appends and replays, so the read immediately after is a cache hit', () => {
    const { root, dbPath } = built();

    const out = writeProducedLines(root, dbPath, OPTS, (produce) =>
      produce.type(V2, { registeredAt: AT }),
    );

    expect(out.result).toMatchObject({ name: 'note', version: 2, outcome: 'created' });
    expect(out.lines).toBe(1);
    // The stamp the read compares is the one the write wrote, and it is the tree's AFTER the append.
    expect(out.fingerprint).toBe(treeFingerprint(root));

    // A read, not a rebuild: `openIndex` refuses a not-current index, so not throwing IS the answer.
    expect(versions(root, dbPath)).toEqual([1, 2]);
  });

  it('builds an index that is not there at all, then produces against it', () => {
    const root = scratch();
    const dbPath = join(root, INDEX_FILE);
    openRecordWriter(root).append({
      kind: 'type',
      document: { name: 'note', version: 1, properties: [BODY] },
    });

    const out = writeProducedLines(root, dbPath, OPTS, (produce) =>
      produce.type(V2, { registeredAt: AT }),
    );

    expect(out.result.version).toBe(2);
    expect(versions(root, dbPath)).toEqual([1, 2]);
  });

  it('leaves the tree and the index alone when the body throws', () => {
    const { root, dbPath } = built();
    const before = treeFingerprint(root);
    const indexBefore = typeVersions(openIndex(root, dbPath).db, 'note');

    expect(() =>
      writeProducedLines(root, dbPath, OPTS, (produce) => {
        produce.type(V2, { registeredAt: AT });
        throw new Error('the body gave up');
      }),
    ).toThrow('the body gave up');

    // The preview wrote nothing (it rolled back), and the append never ran because the body threw.
    expect(treeFingerprint(root)).toBe(before);
    expect(typeVersions(openIndex(root, dbPath).db, 'note')).toEqual(indexBefore);
  });

  it('refuses when the index it committed into was replaced while the write held it (asc-tyl7)', () => {
    // `buildIndex` takes no lock and publishes by `renameSync`, so a build can replace `index.db`
    // between this write's open and its commit. On POSIX the open handle survives the rename, so the
    // whole replay -- and the stamp with it -- goes into an inode nothing is at, while the file left
    // at `dbPath` is the build's. EV-38 measured the sibling shape on `writeLines`, which reported
    // `stale: false` for a replay it had just discarded; `writeProducedLines` has no such field, so
    // its honest report is the refusal it already uses everywhere else.
    //
    // The race is made deterministic rather than simulated: the body runs INSIDE the transaction,
    // with the write's handle already open, so replacing the path from there is exactly the moment a
    // concurrent build's rename arrives at.
    const { root, dbPath } = built();

    expect(() =>
      writeProducedLines(root, dbPath, OPTS, (produce) => {
        produce.type(V2, { registeredAt: AT });
        // The REAL publication, not a hand-written rename: a build of this same tree, run while this
        // write holds the index open. Its stamp is the tree BEFORE the append above lands, so it is
        // the same shape a build that read the tree a moment ago produces.
        buildIndex(root, dbPath, OPTS);
        return undefined;
      }),
    ).toThrow(IndexStaleError);

    // The records ARE in the tree -- the write happened, and nothing may pretend otherwise -- and the
    // index at the path does not carry them, which is what the refusal says.
    expect(
      readRecordTree(root).some((line) => line.kind === 'type' && line.document.version === 2),
    ).toBe(true);
    expect(() => openIndex(root, dbPath)).toThrow(IndexStaleError);

    // And the remedy the refusal names is the remedy: a rebuild makes it whole.
    buildIndex(root, dbPath, OPTS);
    expect(versions(root, dbPath)).toEqual([1, 2]);
  });

  it('refuses a database ascend did not create, before it appends anything', () => {
    const root = scratch();
    const dbPath = join(root, INDEX_FILE);
    openRecordWriter(root).append({
      kind: 'type',
      document: { name: 'note', version: 1, properties: [BODY] },
    });

    const stranger = new DatabaseSync(dbPath);
    stranger.exec('CREATE TABLE theirs (x TEXT)');
    stranger.close();

    const before = treeFingerprint(root);
    expect(() =>
      writeProducedLines(root, dbPath, OPTS, (produce) => produce.type(V2, { registeredAt: AT })),
    ).toThrow(ForeignStoreError);
    expect(treeFingerprint(root)).toBe(before);
  });
});

describe('the lock spans the probe, which is the whole reason it is a fused function', () => {
  it('holds the index write lock while the body runs', () => {
    const { root, dbPath } = built();
    let lost: unknown;

    writeProducedLines(root, dbPath, OPTS, (produce) => {
      // A second connection, from inside the body. It must lose the lock -- which it only does if
      // the body is running inside `BEGIN IMMEDIATE` rather than before it.
      const other = new DatabaseSync(dbPath, { timeout: 0 });
      try {
        try {
          other.exec('BEGIN IMMEDIATE');
        } catch (error) {
          lost = error;
        }
      } finally {
        other.close();
      }
      return produce.type(V2, { registeredAt: AT });
    });

    expect(lost).toBeDefined();
    expect((lost as { errcode?: number }).errcode).toBe(5);
    expect((lost as Error).message).toBe('database is locked');
  });
});

describe('a probe against a tree the index does not describe', () => {
  it('mints the honest next version rather than repeating one the tree already holds', () => {
    const { root, dbPath } = built();

    // EV-35's exact state, built the way it was measured: the TREE holds v1 and v2, the index holds
    // v1. What a checkout, a merge or a hand edit leaves behind.
    openRecordWriter(root).append(V2_LINE);

    // The write path's own answer. Without making the index current first, the probe would read the
    // index's `note` v1 and mint a SECOND v2 -- a version number the tree already carries, in a file
    // where `merge=union` will never collapse it.
    const out = writeProducedLines(root, dbPath, OPTS, (produce) =>
      produce.type(V3, { registeredAt: AT }),
    );

    expect(out.result).toMatchObject({ version: 3, outcome: 'created' });
    expect(versions(root, dbPath)).toEqual([1, 2, 3]);
  });
});

describe('the body reads through the transaction, which is the shape asc-q4p asked for', () => {
  /** How many `note` lines the TREE holds -- the thing the index is a function of. */
  const treeTypeLines = (root: string): number =>
    [...readRecordTree(root)].filter((line) => line.kind === 'type').length;

  it('sees a production it just made, and sees it BEFORE the tree does', () => {
    const { root, dbPath } = built();

    const counts = writeProducedLines(root, dbPath, OPTS, (produce, db) => {
      produce.type(V2, { registeredAt: AT });

      // The read that decides what to write next -- `annotate.ts`'s `listSchemes`, `import.ts`'s
      // `versionsByHash`. Through the handle the transaction holds it sees the production above,
      // which is only possible because the production is in this transaction and not beside it.
      const seen = typeVersions(db, 'note').map((row) => row.version);
      // And the tree does not have it yet: the append happens after the body returns. A site that
      // read the TREE here instead would be reading the store one step behind its own write.
      return { seen, inTree: treeTypeLines(root) };
    });

    expect(counts.result).toEqual({ seen: [1, 2], inTree: 1 });
    // The append did happen, afterwards -- so the two answers above are an ordering and not a bug.
    expect(treeTypeLines(root)).toBe(2);
    expect(versions(root, dbPath)).toEqual([1, 2]);
  });
});

describe('a preview of a produced write', () => {
  it('reports what the real write would do, and writes nothing at all', () => {
    const { root, dbPath } = built();
    const treeBefore = treeFingerprint(root);
    const indexBefore = typeVersions(openIndex(root, dbPath).db, 'note');

    const preview = previewProducedLines(root, dbPath, (produce) =>
      produce.type(V2, { registeredAt: AT }),
    );

    // The SAME answer the real write gives, which is the whole point: a preview computed by anything
    // but the writers is a preview of that thing.
    expect(preview).toMatchObject({ name: 'note', version: 2, outcome: 'created' });
    expect(treeFingerprint(root)).toBe(treeBefore);
    expect(typeVersions(openIndex(root, dbPath).db, 'note')).toEqual(indexBefore);
    // And the index still describes the tree, so the preview cannot have stamped one either.
    expect(() => openIndex(root, dbPath)).not.toThrow();
  });

  it('leaves nothing behind when the body throws, and reports the throw', () => {
    const { root, dbPath } = built();
    const treeBefore = treeFingerprint(root);

    expect(() =>
      previewProducedLines(root, dbPath, (produce) => {
        produce.type(V2, { registeredAt: AT });
        throw new Error('the preview body gave up');
      }),
    ).toThrow('the preview body gave up');

    expect(treeFingerprint(root)).toBe(treeBefore);
    expect(versions(root, dbPath)).toEqual([1]);
  });

  it('refuses a stale index instead of building one, naming asc index build', () => {
    const { root, dbPath } = built();
    openRecordWriter(root).append(V2_LINE);

    expect(() =>
      previewProducedLines(root, dbPath, (produce) => produce.type(V3, { registeredAt: AT })),
    ).toThrow(IndexStaleError);
    expect(() =>
      previewProducedLines(root, dbPath, (produce) => produce.type(V3, { registeredAt: AT })),
    ).toThrow(/asc index build/);

    // The contrast with the write path is the decision, so it is asserted rather than described:
    // `writeProducedLines` against this same tree makes the index current and succeeds.
    expect(
      writeProducedLines(root, dbPath, OPTS, (produce) => produce.type(V3, { registeredAt: AT }))
        .result.version,
    ).toBe(3);
  });

  it('refuses when there is no index at all, and does not create one', () => {
    const root = scratch();
    const dbPath = join(root, INDEX_FILE);
    openRecordWriter(root).append({
      kind: 'type',
      document: { name: 'note', version: 1, properties: [BODY] },
    });

    expect(() =>
      previewProducedLines(root, dbPath, (produce) => produce.type(V2, { registeredAt: AT })),
    ).toThrow(/there is no index there/);

    // The assertion the first check exists for: `openIndexWritable` runs the store's migrations on
    // the way in, so a preview that opened before it checked would leave a brand-new empty `index.db`
    // behind a `--dry-run` that reported writing nothing. That is a false green with a file attached.
    expect(existsSync(dbPath)).toBe(false);
  });

  it('refuses a database ascend did not create, rather than reading it', () => {
    const root = scratch();
    const dbPath = join(root, INDEX_FILE);
    openRecordWriter(root).append({
      kind: 'type',
      document: { name: 'note', version: 1, properties: [BODY] },
    });

    const stranger = new DatabaseSync(dbPath);
    stranger.exec('CREATE TABLE theirs (x TEXT)');
    stranger.close();

    expect(() =>
      previewProducedLines(root, dbPath, (produce) => produce.type(V2, { registeredAt: AT })),
    ).toThrow(ForeignStoreError);
  });
});

describe('a prose-only edit is a write, in the tree as well as in the store', () => {
  it('produces a line for it, then rebuilds the version from that line', () => {
    const root = scratch();
    const dbPath = join(root, INDEX_FILE);

    writeProducedLines(root, dbPath, OPTS, (produce) =>
      produce.type(V1, { registeredAt: AT, description: 'the first wording' }),
    );

    // A shape the store already holds, and prose that it does not: `registerType` answers
    // `unchanged`, which is the truth about the identity and a lie about the write.
    const edit = writeProducedLines(root, dbPath, OPTS, (produce) =>
      produce.type(V1, { registeredAt: AT, description: 'the second wording' }),
    );

    expect(edit.result).toMatchObject({ outcome: 'unchanged', proseUpdated: true });
    expect(edit.lines).toBe(1);
    expect(typeVersions(openIndex(root, dbPath).db, 'note')[0]?.description).toBe(
      'the second wording',
    );

    // **And the tree, which is the store, can rebuild it.** Replayed through `registerType` alone the
    // repeat is a no-op, so an index built from this tree would hold the FIRST wording -- an index
    // disagreeing with the tree it was built from, with nothing reporting it.
    buildIndex(root, dbPath, OPTS);
    expect(typeVersions(openIndex(root, dbPath).db, 'note')[0]?.description).toBe(
      'the second wording',
    );
  });

  it('produces nothing when the edit asks for prose the store already holds', () => {
    const root = scratch();
    const dbPath = join(root, INDEX_FILE);
    const options = { registeredAt: AT, description: 'one wording' };

    writeProducedLines(root, dbPath, OPTS, (produce) => produce.type(V1, options));
    const again = writeProducedLines(root, dbPath, OPTS, (produce) => produce.type(V1, options));

    // A line emitted for a no-op would be appended to a `merge=union` file on every run, and nothing
    // ever collapses one.
    expect(again.lines).toBe(0);
    expect(again.result.proseUpdated).toBe(false);
  });
});
