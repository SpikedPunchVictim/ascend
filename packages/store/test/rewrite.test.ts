import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentSpec,
  openRecordWriter,
  readRecordTree,
  recordFiles,
  rewriteTree,
  specHash,
  type EntryLine,
  type SchemeLine,
  type TypeDocument,
  type TypeLine,
} from '../src/index.js';

/**
 * The one-time upgrade of a tree written before a type line carried its own `version` (`asc-i5tj.6`).
 *
 * Fixtures omit `version` on purpose: that omission IS the pre-change format, so a fixture that
 * spelled one would be testing the upgrade against input it will never meet. They DO carry
 * `type_hash`, because the pre-change format required that too -- a version-less line without a hash
 * is a line no version of the format ever wrote, and the upgrade refuses those separately (asserted
 * below) rather than numbering a line by a hash that does not describe it.
 */

let roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-rewrite-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const BODY = { name: 'body', type: 'text' } as const;
const TITLE = { name: 'title', type: 'text' } as const;

type TypeProperty = TypeDocument['properties'][number];

/** A type line as the pre-change format wrote it: a real hash, and no version. */
function legacyType(name: string, properties: readonly TypeProperty[]): TypeLine {
  const document: TypeDocument = { name, properties: [...properties] };
  return { kind: 'type', document: { ...document, type_hash: specHash(documentSpec(document)) } };
}

const SCHEME: SchemeLine = {
  kind: 'scheme',
  name: 'review',
  version: 1,
  created_at: '2026-09-29T00:00:00.000Z',
  spec: { labels: ['good', 'bad'], rules: [] },
  scheme_hash: 'b'.repeat(64),
};

function entry(n: number, typeName: string, typeHash: string): EntryLine {
  return {
    kind: 'entry',
    id: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    type_name: typeName,
    type_version: 1,
    type_hash: typeHash,
    recorded_at: `2026-09-29T00:00:${String(n).padStart(2, '0')}.000Z`,
    source: 'self',
    run_id: null,
    workflow: null,
    actor: null,
    cwd: null,
    repo: null,
    git_sha: null,
    branch: null,
    properties: {},
    na: [],
    evidence_text: null,
    ascend_version: '0.0.0',
    schema_version: 4,
  };
}

/** Every record file's exact bytes, keyed by its path -- so "left alone" means bytes, not meaning. */
function treeBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of recordFiles(root)) {
    out[file.relative] = readFileSync(join(root, ...file.relative.split('/')), 'utf8');
  }
  return out;
}

function versions(root: string): readonly string[] {
  return readRecordTree(root)
    .filter((line): line is TypeLine => line.kind === 'type')
    .map((line) => `${line.document.name} v${String(line.document.version)}`);
}

describe('rewriteTree adds the version a pre-change type line does not state', () => {
  it('numbers each name from one, in file order, and absorbs an identical repeat', () => {
    const root = scratch();
    const writer = openRecordWriter(root);
    const noteV1 = legacyType('note', [BODY]);
    const duplicate = legacyType('note', [BODY]);
    const noteV2 = legacyType('note', [BODY, TITLE]);
    const todo = legacyType('todo', [BODY]);

    // The duplicate is not decoration: it is what `merge=union` leaves for two branches that both
    // ingested the same definition, and it decides whether the numbering is `registerType`'s
    // arithmetic or a line counter. A counter would give `note` versions 1, 2, 3 and invent a
    // version the store never minted -- the very class this bead is about.
    writer.append(noteV1);
    writer.append(duplicate);
    writer.append(noteV2);
    writer.append(todo);

    const result = rewriteTree(root);

    expect(result).toEqual({ changed: [{ file: 'types/0001.jsonl', lines: 4 }], versioned: 4 });
    expect(versions(root)).toEqual(['note v1', 'note v1', 'note v2', 'todo v1']);
  });

  it('is idempotent in BYTES, so a second run changes no file at all', () => {
    const root = scratch();
    const type = legacyType('note', [BODY]);
    const writer = openRecordWriter(root);
    writer.append(type);
    writer.append(SCHEME);
    writer.append(entry(1, 'note', type.document.type_hash ?? ''));

    expect(rewriteTree(root).versioned).toBe(1);
    const afterFirst = treeBytes(root);
    // Three files, one per kind that holds a line. Named by shape rather than by the partition
    // directory's hash, which is the writer's to derive and not this test's to reconstruct.
    expect(Object.keys(afterFirst)).toHaveLength(3);
    expect(Object.keys(afterFirst).filter((path) => path.startsWith('types/'))).toEqual([
      'types/0001.jsonl',
    ]);

    const second = rewriteTree(root);

    expect(second).toEqual({ changed: [], versioned: 0 });
    expect(treeBytes(root)).toEqual(afterFirst);
  });

  it('leaves schemes, entries and annotations byte-identical', () => {
    const root = scratch();
    const type = legacyType('note', [BODY]);
    const writer = openRecordWriter(root);
    writer.append(type);
    writer.append(SCHEME);
    writer.append(entry(1, 'note', type.document.type_hash ?? ''));

    const before = treeBytes(root);
    rewriteTree(root);
    const after = treeBytes(root);

    // The blast radius is the thing being fixed. Re-serializing every line would be EXPECTED to be
    // the identity -- `serializeCorpus` is canonical -- and this is the assertion that declines to
    // rely on the expectation, comparing bytes rather than meaning.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [path, text] of Object.entries(before)) {
      if (path.startsWith('types/')) {
        expect(after[path]).not.toBe(text);
        continue;
      }
      expect(after[path]).toBe(text);
    }
  });

  it('refuses a type line with no type_hash, naming the field', () => {
    const root = scratch();
    openRecordWriter(root).append({
      kind: 'type',
      document: { name: 'note', properties: [BODY] },
    });

    // Neither a version nor a hash: not a tree written by an older format but a line no format ever
    // wrote. The upgrade cannot number it, and guessing a hash to number it by would be inventing
    // identity rather than reading it.
    expect(() => rewriteTree(root)).toThrow(/no type_hash/);
    expect(() => rewriteTree(root)).toThrow(/types\/0001\.jsonl line 1/);
  });

  it('refuses a line whose claimed hash is not its own contents, rather than numbering it by it', () => {
    const root = scratch();
    openRecordWriter(root).append({
      kind: 'type',
      document: { name: 'note', properties: [BODY], type_hash: 'a'.repeat(64) },
    });

    // The upgrade applies the READER's hash check, so it accepts exactly the trees the reader would
    // accept once versioned. Numbering a line by a hash that does not describe it would hand
    // `asc index build` a tree that refuses for a reason this command appeared to have fixed.
    expect(() => rewriteTree(root)).toThrow(/type_hash/);
  });
});
