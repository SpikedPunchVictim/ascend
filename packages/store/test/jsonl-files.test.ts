import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GITATTRIBUTES_BODY,
  MAX_RECORDS_PER_FILE,
  openRecordWriter,
  readRecordTree,
  readRecordTreeAndFingerprint,
  serializeCorpus,
  treeFingerprint,
  writeGitattributes,
  type AnnotationLine,
  type CorpusLine,
  type EntryLine,
  type SchemeLine,
  type TypeLine,
} from '../src/index.js';

/**
 * The record layer's file half: where a record lands, when a file rolls over, and what order a
 * tree reads back in.
 *
 * **No SQLite anywhere in this file, deliberately** -- the bead's acceptance criterion says the
 * record layer is standalone, and a test that reached the store for its fixtures would make this
 * layer's correctness depend on the thing E12.4 is going to replace. Lines are built as literals
 * and the format is exercised through `serializeCorpus`/`parseCorpus`, which is also what makes a
 * failure here a failure of the LAYER rather than of the format.
 *
 * The scenario shapes are the spike's (`spike/git-layout/run.mjs`, S1-S4). The generator is not
 * re-run and not re-implemented: the spike measured how GIT merges these trees, and a second copy
 * of its fixtures in this package would be a second definition of them, which is the same defect
 * one level up from a second definition of the format. What is reproduced here is the STRUCTURE
 * each scenario exposes the reader to -- disjoint ids, shared derived ids, one id with two
 * contents, and records that arrive out of timestamp order.
 */

let roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-jsonl-files-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** UUIDv7-shaped, and monotone in `n` -- so a lexicographic id order is also a numeric one and a
 *  test that depended on the other would be caught rather than accidentally passing. */
function uuid(n: number): string {
  return `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** `HH:MM:SS` on a fixed day, so a timestamp's printed order is its chronological order. */
function at(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  const rest = String(seconds % 60).padStart(2, '0');
  return `2026-09-29T12:${minutes}:${rest}.000Z`;
}

function entry(
  n: number,
  options: { id?: string; typeName?: string; seconds?: number } = {},
): EntryLine {
  return {
    kind: 'entry',
    id: options.id ?? uuid(n),
    type_name: options.typeName ?? 'note',
    type_version: 1,
    type_hash: 'a'.repeat(64),
    recorded_at: at(options.seconds ?? n),
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

function annotation(
  n: number,
  options: { scheme?: string; seconds?: number } = {},
): AnnotationLine {
  return {
    kind: 'annotation',
    id: uuid(1_000 + n),
    entry_id: uuid(n),
    scheme: options.scheme ?? 'review',
    scheme_version: 1,
    label: 'good',
    confidence: null,
    note: null,
    created_by: null,
    created_at: at(options.seconds ?? n),
  };
}

const TYPE: TypeLine = {
  kind: 'type',
  document: {
    name: 'note',
    version: 1,
    properties: [{ name: 'body', type: 'text' }],
    description: 'a note',
  },
};

const SCHEME: SchemeLine = {
  kind: 'scheme',
  name: 'review',
  version: 1,
  created_at: at(0),
  // A rule, and the rule is load-bearing rather than decoration: with `rules: []` this fixture could
  // not represent the nested object whose key order `parseSchemeRule` rebuilds, which is the shape
  // that made a real migration refuse to run (`dogfood/0040`, and the test below). A fixture that
  // cannot hold the case is how the defect stayed invisible here through every round trip.
  spec: { labels: ['good', 'bad'], rules: [{ kind: 'sql', label: 'good', query: '1=1' }] },
  scheme_hash: 'b'.repeat(64),
};

/** Write a set of lines and read the tree back. The round trip every test here is stated over. */
function roundTrip(
  root: string,
  lines: readonly CorpusLine[],
  options?: Parameters<typeof openRecordWriter>[1],
) {
  const writer = openRecordWriter(root, options);
  for (const line of lines) writer.append(line);
  return { written: writer.written, read: readRecordTree(root) };
}

/** The canonical order `readRecordTree` promises, applied to what was written. */
function canonical(expected: readonly CorpusLine[]): readonly CorpusLine[] {
  const order = (line: CorpusLine): number =>
    line.kind === 'type' ? 0 : line.kind === 'scheme' ? 1 : line.kind === 'entry' ? 2 : 3;
  const time = (line: CorpusLine): string =>
    line.kind === 'entry' ? line.recorded_at : line.kind === 'annotation' ? line.created_at : '';
  const id = (line: CorpusLine): string =>
    line.kind === 'entry' || line.kind === 'annotation' ? line.id : '';
  return [...expected].sort(
    (a, b) =>
      order(a) - order(b) ||
      (a.kind === 'entry' || a.kind === 'annotation'
        ? time(a).localeCompare(time(b)) || id(a).localeCompare(id(b))
        : 0) ||
      serializeCorpus([a]).localeCompare(serializeCorpus([b])),
  );
}

/**
 * `entries/note-ab12cd34ef56/0002.jsonl` -> `entries/<partition>/0002.jsonl`.
 *
 * Most tests here are about the FILE INDEX inside a partition -- when does a file roll over, does a
 * reopened writer continue on disk -- and the partition segment is not their subject. Blanking it
 * keeps those assertions about what they test, and keeps them from breaking every time the segment
 * encoding changes. The segment has tests of its own under "refuses what it cannot file".
 */
function fileShape(path: string): string {
  const [kind, , file] = path.split('/');
  return `${kind ?? ''}/<partition>/${file ?? ''}`;
}

/**
 * A type line states its own version (`asc-i5tj.6`).
 *
 * A type's version used to be read from LINE ORDER alone -- `registerType` mints `latest + 1`
 * (`registry.ts:584`) -- while `.ascend/.gitattributes` sets `merge=union`, which reorders lines.
 * So two clones could merge the same line SET in different ORDER and number the same content
 * differently, silently, wherever no entry referenced the moved version to catch it.
 *
 * These tests are the defect and its fix: that a version is READ OFF THE LINE, that a line without
 * one is refused rather than positionally guessed, and that a reordered file reads as an ordered
 * one.
 */
describe('a type line carries its own version', () => {
  it('round-trips the version rather than deriving it from position', () => {
    const root = scratch();
    const versioned: TypeLine = { kind: 'type', document: { ...TYPE.document, version: 7 } };
    const { read } = roundTrip(root, [versioned]);
    expect((read[0] as TypeLine).document.version).toBe(7);
  });

  it('refuses a type line with no version, and names the rewrite', () => {
    const root = scratch();
    mkdirSync(join(root, 'types'), { recursive: true });
    writeFileSync(
      join(root, 'types', '0001.jsonl'),
      `${JSON.stringify({
        kind: 'type',
        name: 'note',
        properties: [{ name: 'body', type: 'text' }],
        type_hash: 'a'.repeat(64),
      })}\n`,
    );
    // The message must NAME the remedy: a tree written before this field existed is exactly the
    // case this refusal will meet in the wild, and "no version" alone tells the reader nothing.
    expect(() => readRecordTree(root)).toThrow(/no version/);
    expect(() => readRecordTree(root)).toThrow(/asc store rewrite/);
  });
});

describe('the record layer writes one file per kind, partitioned by name', () => {
  it('files each kind where the layout says, and creates the directories it needs', () => {
    const root = scratch();
    const { written } = roundTrip(root, [
      TYPE,
      SCHEME,
      entry(1),
      entry(2, { typeName: 'todo' }),
      annotation(1),
    ]);

    expect(written).toEqual([
      'types/0001.jsonl',
      'schemes/0001.jsonl',
      expect.stringMatching(/^entries\/note-[0-9a-f]{12}\/0001\.jsonl$/),
      expect.stringMatching(/^entries\/todo-[0-9a-f]{12}\/0001\.jsonl$/),
      expect.stringMatching(/^annotations\/review-[0-9a-f]{12}\/0001\.jsonl$/),
    ]);
    expect(readdirSync(join(root, 'entries')).sort()).toEqual([
      expect.stringMatching(/^note-[0-9a-f]{12}$/),
      expect.stringMatching(/^todo-[0-9a-f]{12}$/),
    ]);
  });

  it('round-trips every kind line-for-line, in the canonical order', () => {
    const root = scratch();
    const lines = [TYPE, SCHEME, entry(2), entry(1), annotation(1)];
    const { read } = roundTrip(root, lines);

    expect(serializeCorpus(read)).toBe(serializeCorpus(canonical(lines)));
  });

  it('canonicalizes a nested scheme rule, so the key order it arrives in cannot change the bytes', () => {
    // The invariant, stated directly: one scheme spelled two ways is one line. `parseSchemeRule`
    // rebuilds each rule as `{ label, kind, query }` whatever order the JSON held, so a canonical
    // form that passed the spec through would serialize one scheme two ways -- and
    // `migrateStoreToTree` compares canonical text, so it read that as a migration refusing to run
    // on a real store. The two lines here differ ONLY in the order the rule's three keys were
    // written.
    const kindFirst: SchemeLine = {
      ...SCHEME,
      spec: { labels: ['good'], rules: [{ kind: 'sql', label: 'good', query: '1=1' }] },
    };
    const labelFirst: SchemeLine = {
      ...SCHEME,
      spec: { labels: ['good'], rules: [{ label: 'good', kind: 'sql', query: '1=1' }] },
    };

    expect(serializeCorpus([labelFirst])).toBe(serializeCorpus([kindFirst]));
    // And the canonical form is the one the store already reads back, so nothing on disk changes.
    expect(serializeCorpus([kindFirst])).toContain('{"kind":"sql","label":"good","query":"1=1"}');
  });

  it('appends to a file that already exists rather than starting a new one', () => {
    const root = scratch();
    roundTrip(root, [entry(1)]);
    const { written } = roundTrip(root, [entry(2)]);

    expect(written.map(fileShape)).toEqual(['entries/<partition>/0001.jsonl']);
    expect(readRecordTree(root)).toHaveLength(2);
  });
});

describe('read order is imposed, never inherited from the file', () => {
  it('orders entries by recorded_at even when they were written in the opposite order', () => {
    const root = scratch();
    const { read } = roundTrip(root, [
      entry(3, { seconds: 30 }),
      entry(1, { seconds: 10 }),
      entry(2, { seconds: 20 }),
    ]);

    expect(read.map((line) => line.kind === 'entry' && line.recorded_at)).toEqual([
      at(10),
      at(20),
      at(30),
    ]);
  });

  it('orders an annotation by created_at, for the reason entries are ordered', () => {
    const root = scratch();
    const { read } = roundTrip(root, [
      annotation(3, { seconds: 30 }),
      annotation(1, { seconds: 10 }),
    ]);

    expect(read.map((line) => line.kind === 'annotation' && line.created_at)).toEqual([
      at(10),
      at(30),
    ]);
  });

  it('orders two records that share an id by their text, so the order does not depend on the file', () => {
    // The spike's S3 shape: one derived id, two contents, and a union merge that may put them
    // either way round. Sorting on (recorded_at, id) alone would tie here and fall back to file
    // order, which is the clone-dependent thing being avoided.
    const first = entry(7, { id: 'derived:note:key-1' });
    const second: EntryLine = { ...first, properties: { body: 'a different note entirely' } };

    const ab = roundTrip(scratch(), [first, second]).read;
    const ba = roundTrip(scratch(), [second, first]).read;

    expect(ab.map((line) => serializeCorpus([line]))).toEqual(
      ba.map((line) => serializeCorpus([line])),
    );
    expect(ab).toHaveLength(2);
  });

  it('orders type and scheme lines by (name, version), so a reordered file reads as an ordered one', () => {
    // Both keys, both kinds: a second name covers the name key, a second version the version key.
    // No entries and no annotations, which is the window `asc-i5tj.6` measured -- with none present
    // the entry-level `type_hash` guard has nothing to catch, and before this sort the version came
    // from the line's POSITION alone.
    const todo: TypeLine = { kind: 'type', document: { ...TYPE.document, name: 'todo' } };
    const noteV2: TypeLine = { kind: 'type', document: { ...TYPE.document, version: 2 } };
    const schemeV2: SchemeLine = { ...SCHEME, version: 2, created_at: at(500) };

    const ordered = [TYPE, noteV2, todo, SCHEME, schemeV2];
    const reversed = [...ordered].reverse();

    // The invariant, before the spelling of it: the same lines read the same way whichever order the
    // file holds them in. A `merge=union` is free to produce either, and asks no one.
    expect(roundTrip(scratch(), reversed).read).toEqual(roundTrip(scratch(), ordered).read);

    const { read } = roundTrip(scratch(), reversed);
    const types = read.filter((line): line is TypeLine => line.kind === 'type');
    const schemes = read.filter((line): line is SchemeLine => line.kind === 'scheme');

    // The spelling, so that a reader which reversed BOTH orders consistently -- and would therefore
    // satisfy the invariant above -- is still caught.
    expect(types).toEqual([TYPE, noteV2, todo]);
    expect(schemes).toEqual([SCHEME, schemeV2]);
  });

  it('reads a tree whose files hold the wrong order as though they held the right one', () => {
    const root = scratch();
    const writer = openRecordWriter(root, { maxRecordsPerFile: 1 });
    // Wrong by FILE, deliberately: `0001.jsonl` holds v2 and `0002.jsonl` holds v1. A union merge
    // can leave exactly this, because it concatenates both sides and sorts neither.
    const first: SchemeLine = { ...SCHEME, version: 1 };
    const second: SchemeLine = { ...SCHEME, version: 2 };
    writer.append(second);
    writer.append(first);

    expect(writer.written).toEqual(['schemes/0001.jsonl', 'schemes/0002.jsonl']);
    const schemes = readRecordTree(root).filter(
      (line): line is SchemeLine => line.kind === 'scheme',
    );
    // The file walk still visits 0001 and then 0002 -- `0001` before `0002` is what `recordFiles`
    // promises, and the sort is applied in memory, never by rewriting the files (`ORDER`) -- but the
    // ANSWER is registration order regardless. Without the sort this reads `[second, first]`.
    expect(schemes).toEqual([first, second]);
  });
});

/**
 * What a `merge=union` actually produces, as opposed to what it produces on disjoint data.
 *
 * `merge=union` concatenates both sides and **does not dedupe identical lines** -- measured against
 * real git (two branches, one shared line, merge exits 0 with no conflict, and the merged file holds
 * that line twice). That is the common case rather than an edge: two clones ingesting the same
 * transcript derive the same content-addressed id, so the two sides of a merge are the SAME bytes.
 *
 * The reproduction is left to `spike/git-layout/`, which owns the real-git measurements. What is
 * reproduced here is the file a merge leaves behind, because that is the input the READER has to be
 * correct about -- and the reader is this module. A `git`-spawning test in this package would also
 * make the layer's suite depend on a binary the layer never calls.
 */
/**
 * The tree read and the tree's fingerprint, from ONE traversal.
 *
 * The defect these exist against is `asc-tyl7` (`EV-38`, 4.2% of races against a writer): a build
 * read the tree, then re-read the same files to hash them, so an append landing between the two was
 * absent from what was replayed and present in what was stamped -- an index certifying a tree it did
 * not contain, permanently, with a read that answers happily.
 *
 * **These tests pin the seam, and the interleave itself is not reachable from an in-process
 * suite.** Nothing in this file can put an append *between* two traversals of a build, so the race
 * is measured with two real processes in `EV-38` and the property is pinned here as the contract a
 * second traversal would break: the fingerprint belongs to the bytes the lines came from, and a
 * tree that moves afterwards does not move it.
 */
describe('the fingerprint belongs to the bytes the read read', () => {
  it('fingerprints what it read, not the tree that stands there afterwards', () => {
    const root = scratch();
    roundTrip(root, [TYPE, entry(1, { seconds: 10 })]);
    const asRead = treeFingerprint(root);

    const { lines, fingerprint } = readRecordTreeAndFingerprint(root);
    // The tree moves after the read -- a writer appending the way a real one does.
    openRecordWriter(root).append(entry(2, { seconds: 20 }));

    expect(fingerprint).toBe(asRead);
    expect(treeFingerprint(root)).not.toBe(asRead);
    expect(lines).toHaveLength(2);
  });

  it('holds the same value a separate fingerprint does, so no index is invalidated by reading this way', () => {
    const root = scratch();
    roundTrip(root, [TYPE, SCHEME, entry(1, { seconds: 10 }), entry(2, { seconds: 20 })]);

    expect(readRecordTreeAndFingerprint(root).fingerprint).toBe(treeFingerprint(root));
  });

  it('a read and a fingerprint taken separately describe two instants, which is the shape it replaces', () => {
    const root = scratch();
    roundTrip(root, [TYPE, entry(1, { seconds: 10 })]);
    const asRead = treeFingerprint(root);

    // Exactly the two calls `buildIndex` used to make, with an append between them.
    const lines = readRecordTree(root);
    openRecordWriter(root).append(entry(2, { seconds: 20 }));
    const asStamped = treeFingerprint(root);

    expect(lines).toHaveLength(2);
    expect(asStamped).not.toBe(asRead);
    expect(lines.some((line) => line.kind === 'entry' && line.id === uuid(2))).toBe(false);
  });
});

describe('a union merge duplicates a shared line, and the reader closes that', () => {
  it('reads a byte-identical duplicated record once, because identical bytes are one record', () => {
    const root = scratch();
    const shared = entry(1, { id: 'derived:claude-code:note:key-1' });
    const line = serializeCorpus([shared]);
    // Written through the layer, so the partition is wherever the layer puts it without this test
    // having to know -- and then the same bytes appended a second time by hand, which is exactly
    // the file a union merge leaves behind.
    const path = openRecordWriter(root).append(shared);
    appendFileSync(join(root, path), `${line}\n`);

    // Nothing is lost by collapsing these: a derived entry's id comes from its content, so the same
    // id AND the same bytes cannot be two recordings -- it is one record that a merge wrote twice.
    expect(readRecordTree(root)).toHaveLength(1);
  });

  it('keeps two hand entries with identical bodies, because their ids differ', () => {
    // The boundary of the rule above. A hand entry's id is fresh per recording, so two people
    // recording the same sentence produce two records -- and the canonical text, id included,
    // tells them apart. Deduping on the BODY instead would silently merge two people's work.
    const root = scratch();
    const first: EntryLine = { ...entry(1), properties: { body: 'same words' } };
    const second: EntryLine = { ...entry(2), properties: { body: 'same words' } };
    const { read } = roundTrip(root, [first, second]);

    expect(read).toHaveLength(2);
  });

  it('still keeps two identical type lines, because for a type a line is a registration', () => {
    // The other boundary, and the reason dedupe is applied to entries and annotations ONLY. For a
    // flat append-only kind, file order is meaning: two identical lines are two registrations, and
    // collapsing them would delete a version rather than remove a duplicate.
    const root = scratch();
    const writer = openRecordWriter(root);
    writer.append(TYPE);
    writer.append({ ...TYPE });

    expect(readRecordTree(root)).toHaveLength(2);
  });
});

describe('rollover', () => {
  it('starts a new file at the record threshold, keeping every record', () => {
    const root = scratch();
    const lines = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    const { written, read } = roundTrip(root, lines, { maxRecordsPerFile: 2 });

    expect(written.map(fileShape)).toEqual([
      'entries/<partition>/0001.jsonl',
      'entries/<partition>/0001.jsonl',
      'entries/<partition>/0002.jsonl',
      'entries/<partition>/0002.jsonl',
      'entries/<partition>/0003.jsonl',
    ]);
    expect(serializeCorpus(read)).toBe(serializeCorpus(canonical(lines)));
  });

  it('starts a new file at the byte cap', () => {
    const root = scratch();
    const one = serializeCorpus([entry(1)]).length + 1;
    // Room for two records and change, so the third rolls.
    const { written } = roundTrip(root, [entry(1), entry(2), entry(3)], {
      maxBytesPerFile: one * 2 + 10,
    });

    expect(fileShape(written[2] ?? '')).toBe('entries/<partition>/0002.jsonl');
  });

  it('writes a record larger than the cap instead of rolling forever', () => {
    const root = scratch();
    const huge: EntryLine = { ...entry(1), properties: { body: 'x'.repeat(5_000) } };
    const { written, read } = roundTrip(root, [huge], { maxBytesPerFile: 100 });

    expect(written.map(fileShape)).toEqual(['entries/<partition>/0001.jsonl']);
    expect(read).toHaveLength(1);
  });

  it('defaults to the measured thresholds', () => {
    const root = scratch();
    const writer = openRecordWriter(root);
    for (let n = 0; n < 3; n += 1) writer.append(entry(n));

    // The default is large enough that three records stay in one file -- asserted rather than
    // assumed, because a default of 1 would be a silent multiplication of file count.
    expect(new Set(writer.written).size).toBe(1);
    expect(MAX_RECORDS_PER_FILE).toBe(5_000);
  });

  it('derives the head count once, and does not re-read the file on later appends', () => {
    const root = scratch();
    const writer = openRecordWriter(root, { maxRecordsPerFile: 3 });
    writer.append(entry(1));

    // Grow the head file BEHIND the writer's back, so disk says three records and the writer, which
    // derived its count once, still holds one. A writer that recounted the file on every append
    // would see three and roll here; this one keeps its own state and appends in O(1), which is the
    // property. The staleness is the OBSERVATION, not the goal -- the goal is that the count is not
    // re-derived, because re-deriving it is O(n^2) at corpus scale (~4.1 MiB re-read per append).
    const head = writer.written[0];
    appendFileSync(
      join(root, head ?? ''),
      `${serializeCorpus([entry(2)])}\n${serializeCorpus([entry(3)])}\n`,
    );

    expect(fileShape(writer.append(entry(4)))).toBe('entries/<partition>/0001.jsonl');
  });

  it('derives the head count by reading the tail file once, not by recounting per append', () => {
    const root = scratch();
    const first = openRecordWriter(root, { maxRecordsPerFile: 2 });
    first.append(entry(1));
    first.append(entry(2));

    // Re-opening must continue from what is ON DISK, which is the property that says the count is
    // per-session state derived from the file rather than state the writer owns.
    const second = openRecordWriter(root, { maxRecordsPerFile: 2 });
    expect(fileShape(second.append(entry(3)))).toBe('entries/<partition>/0002.jsonl');
  });

  it('refuses a non-positive threshold instead of quietly starting at file 0002', () => {
    // `head.records >= maxRecords` is true before the first append when the threshold is 0, so a
    // FRESH tree rolled immediately: index 0001 was never created and the run began at 0002, with
    // no error. A caller deriving the threshold from a record size can land on 0 without meaning
    // to, and the symptom is a different on-disk layout rather than a failure.
    expect(() => openRecordWriter(scratch(), { maxRecordsPerFile: 0 })).toThrow(/positive/);
    expect(() => openRecordWriter(scratch(), { maxRecordsPerFile: -1 })).toThrow(/positive/);
    expect(() => openRecordWriter(scratch(), { maxBytesPerFile: 0 })).toThrow(/positive/);
  });

  it('ignores a stray non-record file in a record directory', () => {
    const root = scratch();
    roundTrip(root, [entry(1)]);
    writeFileSync(
      join(root, 'entries', readdirSync(join(root, 'entries'))[0] ?? '', 'README.md'),
      'not a record\n',
    );

    expect(readRecordTree(root)).toHaveLength(1);
  });

  it('reads a tree that has no annotations or entries yet', () => {
    const root = scratch();
    roundTrip(root, [TYPE]);

    expect(readRecordTree(root)).toEqual([TYPE]);
  });
});

describe('the layer refuses what it cannot file faithfully', () => {
  it('keeps every name inside one safe, traversal-free path segment', () => {
    // Every one of these is a name the STORE will accept today: `requireName` refuses only the
    // empty string and the reserved name, and the real corpus already holds `hand-denial`. So the
    // layer cannot refuse them -- it has to file them somewhere that is not above the root.
    const root = scratch();
    const writer = openRecordWriter(root);
    writer.append(entry(1, { typeName: '../../evil' }));
    writer.append(annotation(1, { scheme: 'a/b' }));
    writer.append(annotation(2, { scheme: '..' }));

    const partitions = writer.written.map((path) => path.split('/')[1] ?? '');
    // One segment each, never `.`/`..`, never a separator, never a case-folding surprise: the whole
    // safety property in one assertion, so a future encoding cannot quietly lose part of it.
    for (const partition of partitions) {
      expect(partition).toMatch(/^[a-z0-9_-]+$/);
      expect(partition).not.toBe('.');
      expect(partition).not.toBe('..');
    }
    expect(new Set(partitions).size).toBe(3);
    // The property that matters: nothing was written outside the root.
    expect(existsSync(join(root, '..', 'evil'))).toBe(false);
    expect(readRecordTree(root)).toHaveLength(3);
  });

  it('files two names that fold to one slug separately, and reads both back by name', () => {
    // The test above pins TRAVERSAL, not injectivity: `../../evil`, `a/b` and `..` fold to `evil`,
    // `a_b` and the empty string -- three DISTINCT slugs -- so its `new Set(partitions).size` would
    // still read 3 if the digest were deleted from `encodeSegment` and the bare slug returned. The
    // digest does have one test that needs it, `keeps two names that differ only in case`, which
    // measures that a collision is RESOLVED; nothing measured the two halves this one adds.
    //
    // First, that the read half is name-addressed. `a/b` and `a b` are names a caller may type that
    // fold to the same slug for a reason other than case -- punctuation, not capitalization -- and
    // one file each (`a_b-b941543fecce`, `a_b-faaee53168b5`, measured on a real store) only gets us
    // halfway: the name travels on every line and nothing is ever decoded from the directory, so
    // what has to hold is that BOTH names come back, neither lost to the other's fold. The case
    // test counts rows and cannot see a name that was mangled while the row survived.
    const root = scratch();
    const writer = openRecordWriter(root);
    writer.append(annotation(1, { scheme: 'a/b' }));
    writer.append(annotation(2, { scheme: 'a b' }));

    const partitions = writer.written.map((path) => path.split('/')[1] ?? '');
    expect(partitions).toHaveLength(2);
    expect(new Set(partitions).size).toBe(2);
    for (const partition of partitions) expect(partition).toMatch(/^[a-z0-9_-]+$/);

    const schemes = readRecordTree(root)
      .flatMap((line) => (line.kind === 'annotation' ? [line.scheme] : []))
      .sort();
    expect(schemes).toEqual(['a b', 'a/b']);
  });

  it('refuses a tree where a record directory is a file, rather than reading it as empty', () => {
    // `readdir` on a file raises ENOTDIR, and the catch was written for ENOENT but took everything,
    // so a malformed tree read as an EMPTY corpus -- the worst answer a store whose whole value is
    // counts can give, because it is indistinguishable from a correct answer of zero.
    const flat = scratch();
    writeFileSync(join(flat, 'types'), 'not a directory\n');
    expect(() => readRecordTree(flat)).toThrow();

    const partitioned = scratch();
    writeFileSync(join(partitioned, 'entries'), 'not a directory\n');
    expect(() => readRecordTree(partitioned)).toThrow();
  });

  it('does not silently skip a partition it cannot read', () => {
    // The same defect with the error the finding named. A partition whose permissions deny reading
    // is not an empty partition, and dropping it makes every count wrong without saying so.
    const root = scratch();
    roundTrip(root, [annotation(1)]);
    const partition = join(root, 'annotations', readdirSync(join(root, 'annotations'))[0] ?? '');
    chmodSync(partition, 0o000);
    try {
      let readable = true;
      try {
        readdirSync(partition);
      } catch {
        readable = false;
      }
      // Only meaningful as an unprivileged user; a root test process ignores the mode entirely.
      if (readable) return;
      expect(() => readRecordTree(root)).toThrow();
    } finally {
      chmodSync(partition, 0o700);
    }
  });

  it('keeps two names that differ only in case in two segments', () => {
    // APFS and NTFS compare directory names case-insensitively, so `Review` and `review` were ONE
    // directory on macOS and TWO on Linux: the same tree read on one machine and threw on the
    // other. A segment has to be distinct under case folding, not merely distinct as a string.
    const root = scratch();
    const writer = openRecordWriter(root);
    const upper = writer.append(annotation(1, { scheme: 'Review' }));
    const lower = writer.append(annotation(2, { scheme: 'review' }));

    expect(upper).not.toBe(lower);
    expect(readRecordTree(root)).toHaveLength(2);
  });

  it('keeps a long name inside NAME_MAX, so it cannot fail mid-write', () => {
    // 29 CJK characters are 87 bytes, which percent-encoding turned into a 261-character directory;
    // mkdir raised ENAMETOOLONG after part of the tree was already written. NAME_MAX is 255.
    const root = scratch();
    const writer = openRecordWriter(root);
    const written = writer.append(annotation(1, { scheme: '漢'.repeat(29) }));

    expect((written.split('/')[1] ?? '').length).toBeLessThanOrEqual(255);
    expect(readRecordTree(root)).toHaveLength(1);
  });

  it('keeps two names that encode to the same bytes in two segments', () => {
    // Percent-encoding was not injective: `Buffer.from` replaces an unpaired surrogate with U+FFFD,
    // so these two names produced identical bytes -- and the read-side guard re-applies the same
    // function, so it compared the name to itself and could not see the collision it had made.
    const root = scratch();
    const writer = openRecordWriter(root);
    const surrogate = writer.append(annotation(1, { scheme: '\uD800' }));
    const replacement = writer.append(annotation(2, { scheme: '�' }));

    expect(surrogate).not.toBe(replacement);
    expect(readRecordTree(root)).toHaveLength(2);
  });

  it('keeps a name that is already readable readable', () => {
    // The store is meant to be human-inspectable, so the segment carries the name rather than
    // replacing it with an opaque hash: `hand-denial` has to still read as `hand-denial`.
    const root = scratch();
    const { written } = roundTrip(root, [annotation(1, { scheme: 'hand-denial' })]);

    expect(written).toEqual([
      expect.stringMatching(/^annotations\/hand-denial-[0-9a-f]{12}\/0001\.jsonl$/),
    ]);
    expect(readRecordTree(root)).toHaveLength(1);
  });

  it('refuses an empty name rather than making a directory with no name', () => {
    expect(() => openRecordWriter(scratch()).append(annotation(1, { scheme: '' }))).toThrow(
      /empty/,
    );
  });

  it('refuses a record file sitting directly under a partitioned kind', () => {
    // `partitionNamesIn` descends only through DIRECTORIES, so a file at `entries/0001.jsonl` was
    // never opened and its records vanished with no error. It is the one wrong-place shape the
    // module's own two-direction guard cannot cover, because the guard runs per FILE and this file
    // is never reached -- the guard would have to be a third direction, over the directory itself.
    const entries = scratch();
    mkdirSync(join(entries, 'entries'), { recursive: true });
    writeFileSync(join(entries, 'entries', '0001.jsonl'), `${serializeCorpus([entry(1)])}\n`);
    expect(() => readRecordTree(entries)).toThrow(/directly under/);

    const annotations = scratch();
    mkdirSync(join(annotations, 'annotations'), { recursive: true });
    writeFileSync(
      join(annotations, 'annotations', '0001.jsonl'),
      `${serializeCorpus([annotation(1)])}\n`,
    );
    expect(() => readRecordTree(annotations)).toThrow(/directly under/);
  });

  it('refuses a line filed under a directory that holds another kind', () => {
    const root = scratch();
    mkdirSync(join(root, 'types'), { recursive: true });
    writeFileSync(join(root, 'types', '0001.jsonl'), `${serializeCorpus([entry(1)])}\n`);

    expect(() => readRecordTree(root)).toThrow(/filed under/);
  });

  it('refuses a line filed under a partition its own name does not encode to', () => {
    const root = scratch();
    mkdirSync(join(root, 'annotations', 'review'), { recursive: true });
    writeFileSync(
      join(root, 'annotations', 'review', '0001.jsonl'),
      `${serializeCorpus([annotation(1, { scheme: 'other' })])}\n`,
    );

    expect(() => readRecordTree(root)).toThrow(/the line names/);
  });
});

describe('gitattributes', () => {
  it('writes the union-merge rule for every record file at any depth', () => {
    const root = scratch();
    writeGitattributes(root);

    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES_BODY);
    expect(GITATTRIBUTES_BODY).toBe('*.jsonl merge=union\n');
  });

  it('is idempotent, so it can run on every init', () => {
    const root = scratch();
    writeGitattributes(root);
    writeGitattributes(root);

    expect(readdirSync(root).filter((name) => name === '.gitattributes')).toHaveLength(1);
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES_BODY);
  });
});

/**
 * The spike's four scenarios, as the reader is exposed to them.
 *
 * Each is stated as the STRUCTURE the scenario produces rather than as the merge that produced it:
 * S1 two branches appending to different types, S2 a shared derived set plus private records, S3 one
 * id carrying two contents, S4 records that arrive out of timestamp order.
 */
describe("the spike's S1-S4 shapes round-trip", () => {
  it('S1: two sides of disjoint hand entries all survive, in recorded order', () => {
    const root = scratch();
    const left = Array.from({ length: 20 }, (_, n) => entry(n, { typeName: 'note' }));
    const right = Array.from({ length: 20 }, (_, n) => entry(100 + n, { typeName: 'todo' }));
    const { read } = roundTrip(root, [...left, ...right]);

    expect(read).toHaveLength(40);
    expect(serializeCorpus(read)).toBe(serializeCorpus(canonical([...left, ...right])));
  });

  it('S2: a shared derived set is not duplicated and does not displace a private record', () => {
    const root = scratch();
    const shared = Array.from({ length: 30 }, (_, n) =>
      entry(n, { id: `derived:claude-code:spike_type:${String(n)}` }),
    );
    const ownLeft = Array.from({ length: 10 }, (_, n) =>
      entry(200 + n, { id: `hand:left:${String(n)}` }),
    );
    const ownRight = Array.from({ length: 10 }, (_, n) =>
      entry(300 + n, { id: `hand:right:${String(n)}` }),
    );
    const { read } = roundTrip(root, [...shared, ...ownLeft, ...ownRight]);

    expect(read).toHaveLength(50);
    expect(new Set(read.map((line) => line.kind === 'entry' && line.id)).size).toBe(50);
  });

  it('S3: one id with two contents keeps both, in one determined order', () => {
    const root = scratch();
    const mine: EntryLine = {
      ...entry(1, { id: 'derived:claude-code:spike_type:key-1' }),
      properties: { body: 'mine' },
    };
    const theirs: EntryLine = { ...mine, properties: { body: 'theirs' } };

    const { read } = roundTrip(root, [
      ...Array.from({ length: 5 }, (_, n) => entry(10 + n)),
      mine,
      theirs,
    ]);
    const bodies = read
      .filter((line): line is EntryLine => line.kind === 'entry' && line.id === mine.id)
      .map((line) => line.properties['body']);

    expect(bodies.sort()).toEqual(['mine', 'theirs']);
  });

  it('S4: a backdated record reads in timestamp order, not where it was written', () => {
    const root = scratch();
    const base = Array.from({ length: 10 }, (_, n) => entry(n, { seconds: n * 10 }));
    const backdated = Array.from({ length: 5 }, (_, n) => entry(500 + n, { seconds: 5 + n * 10 }));
    const appended = Array.from({ length: 5 }, (_, n) => entry(600 + n, { seconds: 1_000 + n }));
    const { read } = roundTrip(root, [...base, ...backdated, ...appended]);

    const times = read.map((line) => line.kind === 'entry' && line.recorded_at);
    expect(times).toEqual([...times].sort());
    expect(read).toHaveLength(20);
  });
});

describe('an invalidation states a reason, and the parser is where that is enforced', () => {
  // `asc-4wx6`, measured in `spike/e12-invalidation-reason.mjs`. `recordInvalidation` refuses a
  // reason that is empty or all whitespace, but it is not the only writer of the reserved scheme:
  // `asc import` restores it through `recordAnnotations`, whose only note gate is the EMPTY STRING.
  // So an absent reason became SQL NULL and a whitespace-only one was stored verbatim, both with
  // `asc import` exiting 0 -- and `listInvalidations` cast that column to `string`, so its own type
  // promised a reason the row did not have.
  //
  // The refusal goes in the corpus parser rather than in `recordAnnotations` because the parser is
  // the one door every path already goes through: `asc import` parses the file, `asc index build`
  // parses the tree. One rule, both writers. It sits beside the `type` branch's version refusal
  // (`jsonl.ts`), which is the same shape for the same reason.

  /** An invalidation annotation -- the reserved scheme, which is the only one that requires a reason. */
  const strike = (n: number, note: string | null): AnnotationLine => ({
    ...annotation(n, { scheme: 'invalidation' }),
    note,
  });

  it('refuses an invalidation whose reason is absent', () => {
    const root = scratch();
    openRecordWriter(root).append(strike(1, null));

    expect(() => readRecordTree(root)).toThrow(/reason/);
  });

  it('refuses an invalidation whose reason is only whitespace', () => {
    const root = scratch();
    openRecordWriter(root).append(strike(1, '   '));

    expect(() => readRecordTree(root)).toThrow(/reason/);
  });

  it('names the line and what to do about it, since nothing can repair the line automatically', () => {
    const root = scratch();
    openRecordWriter(root).append(strike(1, null));

    // The same coordinate the other refusals give, so an editor can jump to it -- and the two
    // remedies that exist, because a missing reason cannot be reconstructed by any automated pass:
    // `asc store rewrite` inherits this refusal and can only assign versions, never reasons.
    expect(() => readRecordTree(root)).toThrow(/line 1/);
    expect(() => readRecordTree(root)).toThrow(/asc invalidate/);
  });

  it('accepts an invalidation that states one, whitespace included in the middle', () => {
    const root = scratch();
    openRecordWriter(root).append(strike(1, 'superseded by a re-derived row'));

    expect(readRecordTree(root)).toHaveLength(1);
  });

  it('still reads an annotation under any other scheme with no note at all', () => {
    // The control arm, and it is load-bearing: `annotation()`'s default scheme is `review`, and
    // a no-note annotation under a user's scheme is ordinary and must keep round-tripping. A rule
    // keyed on `note === null` alone would refuse these, which is why the scheme is part of the
    // condition rather than the note being checked on its own.
    const root = scratch();
    roundTrip(root, [annotation(1), annotation(2, { scheme: 'hand-denial' })]);

    expect(readRecordTree(root)).toHaveLength(2);
    expect(
      readRecordTree(root).every((line) => line.kind !== 'annotation' || line.note === null),
    ).toBe(true);
  });
});
