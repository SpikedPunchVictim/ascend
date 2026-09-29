import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  documentSpec,
  INDEX_FILE,
  openIndex,
  openRecordWriter,
  specHash,
  STORE_DIR,
  treeFingerprint,
  type CorpusLine,
  type TypeDocument,
} from '@ascend/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc index build`, driven as the real binary in a real project -- the only way an index gets built
 * (`asc-i5tj.3.1`).
 *
 * **This file is what makes the command's wiring tested rather than merely exercised once by hand.**
 * The command does three things no unit test of `buildIndex` covers: it resolves the project root by
 * walking up from the working directory, it joins that root to `STORE_DIR`/`INDEX_FILE` to point the
 * build at `<root>/.ascend/index.db`, and it reports what it did. A wrong join in either half would
 * produce a command that exits 0, prints a plausible path, and builds nothing anyone will read --
 * and the store's own suite would stay green, because it never passes a project root at all.
 *
 * **The tree is laid out with `openRecordWriter`, the same layer that will write real ones**, so this
 * is not a fixture format invented for the test. The store is opened read-only to read the result
 * back (`openIndex`), which also asserts the fingerprint the command's report printed is the one the
 * tree hashes to -- the report is the only place that value is published, and a report nobody
 * compares against anything is a number the caller has to take on faith.
 *
 * **The second test is the guard, at the boundary where it matters.** `asc-63v` refuses a file ascend
 * did not create, and `buildIndex` publishes by `renameSync` -- so the command is the one thing that
 * could replace a stranger's database at `index.db`, and it must not. Asserted by BYTES, because the
 * harm is a write and a refusal that still wrote would pass every message assertion here.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The `--json` report, named rather than left as `Record<string, unknown>`.
 *
 * The three fields are what the command publishes and nothing reads them back from anywhere else,
 * so the report is the only place they exist. Declaring them means a rename in the command fails
 * here as an undefined value rather than silently passing a bracket lookup.
 */
interface Report {
  readonly rows: readonly {
    readonly index: string;
    readonly records: number;
    readonly fingerprint: string;
  }[];
}

/**
 * The binary, run in `dir`, with `HOME` redirected.
 *
 * The same shape `import-vs-index.test.ts` and `foreign-cli.test.ts` use, and for the same reason: an
 * inherited `HOME` would let a walk find a project outside the scratch directory and make the test's
 * result depend on where the suite was started.
 */
const child = (dir: string, args: readonly string[]): Run =>
  spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_CACHE_HOME: join(dir, '.cache') },
  });

const ID = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// Typed rather than inferred, as `import-vs-index.test.ts` does: without the annotation `type: 'text'`
// widens to `string` and stops being a `PropertySpec`.
const NOTE: TypeDocument = {
  name: 'note',
  properties: [{ name: 'body', type: 'text' }],
  description: 'a note',
};

/** Three entries of one type, plus the type line they name -- a corpus with something to replay. */
function corpus(): readonly CorpusLine[] {
  const typeHash = specHash(documentSpec(NOTE));
  return [
    { kind: 'type', document: NOTE },
    ...[1, 2, 3].map((n): CorpusLine => ({
      kind: 'entry',
      id: ID(n),
      type_name: 'note',
      type_version: 1,
      type_hash: typeHash,
      recorded_at: `2026-09-29T12:00:0${String(n)}.000Z`,
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
    })),
  ];
}

/** A project directory holding a laid-out tree and nothing else. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-index-build-cli-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  const writer = openRecordWriter(join(dir, STORE_DIR));
  for (const line of corpus()) writer.append(line);
  return dir;
}

/** The index file's bytes, or `null` when there is no index. */
function indexBytes(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'latin1') : null;
}

describe('asc index build', () => {
  it('builds the index where the layout says, and reports what it replayed', () => {
    const dir = project();
    const file = join(dir, STORE_DIR, INDEX_FILE);
    expect(existsSync(file)).toBe(false);

    const run = child(dir, ['index', 'build', '--json']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as Report;
    expect(report.rows).toHaveLength(1);
    // RESOLVED, not the string the fixture built the path from: the command reports the path it
    // actually wrote, and on macOS a `/var/folders/...` temp path comes back as `/private/var/...`.
    // The two name the same file, which the read-back below is what proves -- asserted rather than
    // normalised away, because a report that printed a path the caller cannot open would be worse
    // than one that prints a longer one.
    expect(report.rows[0]?.index).toBe(join(realpathSync(dir), STORE_DIR, INDEX_FILE));
    // The corpus the fixture wrote: one type line and three entries.
    expect(report.rows[0]?.records).toBe(4);
    expect(report.rows[0]?.fingerprint).toBe(treeFingerprint(join(dir, STORE_DIR)));

    // Read back through the store, which is the only reader that exists -- and it compares the
    // fingerprint itself, so this also asserts the report's value is the tree's.
    const store = openIndex(join(dir, STORE_DIR), file);
    try {
      expect((store.db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n).toBe(
        3,
      );
    } finally {
      store.db.close();
    }
  });

  it('is idempotent: a second build over an unchanged tree reports the same fingerprint', () => {
    // The index is derived wholesale, so a rebuild of an unchanged tree is the same index. Asserted
    // on the fingerprint rather than on the rows, because the fingerprint is what a reader will use
    // to decide whether to rebuild at all -- and two builds that disagreed here would mean the tree
    // hash depended on something other than the tree.
    const dir = project();
    const first = child(dir, ['index', 'build', '--json']);
    const second = child(dir, ['index', 'build', '--json']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const fingerprintOf = (run: Run): unknown =>
      (JSON.parse(run.stdout) as Report).rows[0]?.fingerprint;
    expect(fingerprintOf(second)).toBe(fingerprintOf(first));
    expect(readdirSync(join(dir, STORE_DIR)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to replace a database ascend did not create, and leaves it byte-identical', () => {
    const dir = project();
    const file = join(dir, STORE_DIR, INDEX_FILE);
    const foreign = new DatabaseSync(file);
    foreign.exec('CREATE TABLE theirs (x TEXT)');
    foreign.close();
    const before = indexBytes(file);

    const run = child(dir, ['index', 'build']);

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.replace(/\s+/g, '')).toContain(file);
    expect(indexBytes(file)).toBe(before);
  });

  it('refuses where there is no project, rather than building beside the working directory', () => {
    // The walk up from the working directory is how the command finds `root`, and its failure has to
    // be a refusal rather than a fallback: a build that used the working directory when no project was
    // found would create `.ascend/` somewhere that is not a project -- which is `asc init`'s job, and
    // a derived index is the wrong thing to be the first file in a directory.
    const dir = mkdtempSync(join(tmpdir(), 'asc-index-build-noproject-'));
    dirs.push(dir);

    const run = child(dir, ['index', 'build']);

    expect(run.status).not.toBe(0);
    expect(existsSync(join(dir, STORE_DIR))).toBe(false);
  });
});
