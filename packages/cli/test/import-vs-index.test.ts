import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildIndex,
  documentSpec,
  INDEX_FILE,
  openRecordWriter,
  parseCorpus,
  schemeHash,
  serializeCorpus,
  specHash,
  type CorpusLine,
  type TypeDocument,
} from '@ascend/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc import` and `buildIndex` must produce the SAME store from the SAME corpus.
 *
 * **Two drivers, one format, and nothing else checks that they agree.** `asc import` rehydrates the
 * SQLite store from an `asc export` stream; `buildIndex` rehydrates the derived index from a JSONL
 * tree. They are separate code because the import driver carries refusals about a pre-existing target
 * store that a fresh index build can never hit -- so they cannot simply be one function. What they
 * CAN share is every answer about what a line means, and they do: `entryFromLine`,
 * `typeRegistrationOptions` and `annotationPassGroups` all live in `@ascend/store` and both call them.
 *
 * This file is the check that the sharing is real. The failure it exists for is the one `dogfood/0032`
 * names -- "two halves measured, the join assumed" -- and its shape here is not a crash: it is two
 * stores that both report success, hold different rows, and disagree about `asc kappa` while every
 * count still looks plausible. No other test has this subject, because each driver has a suite of its
 * own and each is green on its own.
 *
 * **The comparison is on observable ROWS, not on reports.** Both arms are asked what they wrote by
 * reading the database back, so a divergence in a column neither driver prints can still surface.
 *
 * **`entry_types.created_at` is excluded by name.** It comes from the caller (`registerType` takes it)
 * and is carried by no `TypeLine`, so an import stamps the moment of the import and an index build
 * stamps the moment of the build. That difference is real, expected, and not a divergence in any
 * record -- which is exactly why it is named rather than dropped quietly, since a column excluded in
 * silence is where a real one would hide.
 *
 * **The import arm drives the real binary**, in a real project, so the comparison is against what
 * `asc import` actually does rather than against a second call to the same helper.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

const dirs: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ID = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/**
 * A type document WITH its `type_hash`, because a corpus line always carries one.
 *
 * `asc import` refuses a type line without it -- "a type definition with no type_hash, and a corpus
 * line always carries one" -- so a fixture that omitted it would spell a document no export could
 * produce, and the import arm would fail on the fixture rather than on anything under test. The hash
 * is over `documentSpec`, which is the identity-bearing part; prose is deliberately outside it.
 */
function type(document: TypeDocument): TypeDocument {
  return { ...document, type_hash: specHash(documentSpec(document)) };
}

const NOTE: TypeDocument = type({
  name: 'note',
  properties: [{ name: 'body', type: 'text' }],
  description: 'a note',
});

const TODO: TypeDocument = type({
  name: 'todo',
  properties: [
    { name: 'body', type: 'text' },
    { name: 'due', type: 'timestamp' },
  ],
});

const REVIEW_SPEC = { labels: ['good', 'bad'], rules: [] };

/**
 * A corpus with every kind in it, built through the same line builders `asc export` uses.
 *
 * Hand-built rather than exported from a store, because the two arms must start from ONE artifact:
 * exporting first would make the import arm's own output the input to the index arm, and a divergence
 * introduced on the way out would be invisible to both.
 *
 * The shapes are not arbitrary. Two types with overlapping property names, an entry of each, and two
 * ANNOTATION PASSES under one scheme version with different timestamps -- because the pass is the unit
 * `annotationPassGroups` folds on, and a corpus with one pass cannot tell a correct grouping from one
 * that collapses every pass a scheme ever ran into a single call.
 */
function corpus(): readonly CorpusLine[] {
  const noteHash = specHash(documentSpec(NOTE));
  const todoHash = specHash(documentSpec(TODO));

  const entry = (
    n: number,
    typeName: string,
    typeHash: string,
    properties: Record<string, unknown>,
    extra: { readonly na?: readonly string[]; readonly evidence_text?: string | null } = {},
  ): CorpusLine => ({
    kind: 'entry',
    id: ID(n),
    type_name: typeName,
    type_version: 1,
    type_hash: typeHash,
    recorded_at: `2026-09-02T1${String(n)}:00:00.000Z`,
    source: 'self',
    run_id: null,
    workflow: null,
    actor: null,
    cwd: '.',
    repo: null,
    git_sha: null,
    branch: null,
    properties,
    na: extra.na ?? [],
    evidence_text: extra.evidence_text ?? null,
    ascend_version: '0.1.0',
    schema_version: 1,
  });

  const annotation = (
    n: number,
    entryId: string,
    label: string,
    createdAt: string,
  ): CorpusLine => ({
    kind: 'annotation',
    id: ID(100 + n),
    entry_id: entryId,
    scheme: 'review',
    scheme_version: 1,
    label,
    // Three different absences, because "omit" and "null" are different on the way back in and a
    // corpus that spells them all one way cannot tell the two drivers apart.
    confidence: n === 1 ? 0.9 : null,
    note: n === 2 ? 'looks wrong' : null,
    created_by: n === 3 ? 'bob' : 'ann',
    created_at: createdAt,
  });

  return [
    { kind: 'type', document: NOTE },
    { kind: 'type', document: TODO },
    {
      kind: 'scheme',
      name: 'review',
      version: 1,
      created_at: '2026-09-01T00:00:00.000Z',
      spec: REVIEW_SPEC,
      scheme_hash: schemeHash(REVIEW_SPEC),
    },
    entry(1, 'note', noteHash, { body: 'first' }),
    // An `na` and an evidence string, so the columns that are easy to carry on one path and drop on
    // the other are populated. `body` is N/A and NOT also measured, which is the store's own rule:
    // "a property cannot be both measured and listed as not applicable". The fixture has to be a
    // store ascend would accept, or the import arm fails on the fixture rather than on the subject.
    entry(2, 'note', noteHash, {}, { na: ['body'], evidence_text: 'the evidence' }),
    entry(3, 'todo', todoHash, { body: 'third', due: '2026-09-09T00:00:00.000Z' }),
    annotation(1, ID(1), 'good', '2026-09-03T09:00:00.000Z'),
    annotation(2, ID(2), 'bad', '2026-09-03T09:00:00.000Z'),
    annotation(3, ID(3), 'good', '2026-09-04T09:00:00.000Z'),
  ];
}

/**
 * Everything a reader can observe, as canonical text, with `entry_types.created_at` dropped.
 *
 * `SELECT *` rather than a column list: a column added to a table by a later migration should appear
 * in this comparison without anyone remembering to add it here, since a divergence that shows up only
 * in a new column is exactly the kind this file is for.
 */
/** The four tables a corpus writes, so the comparison is named rather than open-ended. */
interface Observable {
  readonly entry_types: readonly string[];
  readonly entries: readonly string[];
  readonly annotation_schemes: readonly string[];
  readonly annotations: readonly string[];
}

function observable(db: DatabaseSync): Observable {
  const dump = (table: string, drop: readonly string[] = []): readonly string[] => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[];
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
    entry_types: dump('entry_types', ['created_at']),
    entries: dump('entries'),
    annotation_schemes: dump('annotation_schemes'),
    annotations: dump('annotations'),
  };
}

/**
 * The binary, run in `dir`.
 *
 * Typed explicitly rather than left as `ReturnType<typeof spawnSync>`: with `encoding: 'utf8'` the
 * output is a `string`, but the generic return type keeps `NonSharedBuffer` in the union, and both
 * the template literals below and any `.includes` on stderr would then need a cast to compile.
 */
interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const child = (dir: string, args: readonly string[]): Run =>
  spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_CACHE_HOME: join(dir, '.cache') },
  });

/**
 * A project directory with NO store, so both arms start from the same nothing.
 *
 * Deliberately not `asc init`. `init` registers the four starter types, which land in
 * `entry_types` on the import arm and not on the index arm -- the index arm builds from a tree that
 * holds only this corpus -- so an `init`ed target would make the two dumps differ by four rows that
 * have nothing to do with the question. `asc import` creates the store it needs, which
 * `corpus.test.ts` already relies on. Measured while writing this: a seeded project gives 6
 * `entry_types` where the corpus names 2, and the assertion below caught it.
 */
function project(): string {
  const dir = scratch('asc-import-vs-index-');
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.ascend'));
  return dir;
}

function importCorpus(dir: string, text: string): void {
  const file = join(dir, 'corpus.jsonl');
  writeFileSync(file, text);
  const result = child(dir, ['import', file]);
  if (result.status !== 0) throw new Error(`asc import failed: ${result.stderr}`);
}

describe('asc import and buildIndex agree about what a corpus means', () => {
  it('writes the same rows, from the same corpus, through both drivers', () => {
    const lines = corpus();
    const flat = `${serializeCorpus(lines)}\n`;

    // Arm A: the real `asc import`, in a real project, driven as a subprocess.
    const projectDir = project();
    importCorpus(projectDir, flat);
    const imported = new DatabaseSync(join(projectDir, '.ascend', 'ascend.db'), { readOnly: true });

    // Arm B: the index build, over a tree laid out from the SAME lines.
    const treeDir = scratch('asc-import-vs-index-tree-');
    const writer = openRecordWriter(treeDir);
    for (const line of lines) writer.append(line);
    buildIndex(treeDir, join(treeDir, INDEX_FILE), { now: '2026-09-29T00:00:00.000Z' });
    const indexed = new DatabaseSync(join(treeDir, INDEX_FILE), { readOnly: true });

    // A non-empty comparison, so two empty dumps cannot pass this by being equal.
    const expected = observable(imported);
    expect(expected.entries).toHaveLength(3);
    expect(expected.annotations).toHaveLength(3);
    expect(expected.entry_types).toHaveLength(2);
    expect(expected.annotation_schemes).toHaveLength(1);

    expect(observable(indexed)).toEqual(expected);

    imported.close();
    indexed.close();
  });

  it('round-trips the corpus through the codec the tree layout uses', () => {
    // Both arms read the SAME bytes, and the bytes are `serializeCorpus`'s. That matters more than it
    // looks: a type line is NESTED in memory (`document: {...}`) and FLAT on the wire, so a caller
    // reaching for `JSON.stringify` over parsed lines produces a stream `asc import` refuses with
    // "has no such field 'document'". Measured while writing the EV-33 spike -- it looked exactly like
    // a product bug. This asserts the codec is the identity so the arms cannot differ over the format.
    const lines = corpus();
    const text = `${serializeCorpus(lines)}\n`;

    const round = parseCorpus(text, 'corpus.jsonl').map((parsed) => parsed.line);

    expect(round).toEqual(lines);
    expect(serializeCorpus(round)).toBe(serializeCorpus(lines));
  });
});
