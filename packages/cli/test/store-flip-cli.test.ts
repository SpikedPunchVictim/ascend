import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, recordEntry, registerType } from '@ascend/store';

/**
 * The flip, end to end, as the real binary: the JSONL tree is the store and the index is a cache
 * that can be deleted.
 *
 * **This is the only test that asserts the epic's claim rather than a slice of it.** Every other
 * suite proves a piece -- `index-build-cli` that a build lands where the layout says,
 * `jsonl-index` that a rebuild reproduces a tree, `query` that a stale index is refused. The claim
 * the epic actually makes is a LOOP: record, read, delete the derived file, read again and get the
 * same answer. Each link can be green while the loop is broken, and one of them was (finding 4:
 * `asc index build` reached the project through `withProject`, which after the flip opened the
 * index and threw on a stale one -- so the one remedy for a stale index refused to run). A test of
 * the pieces would not have caught that. This one runs the pieces in the order a person does.
 *
 * **Hermetic**: every run gets its own temp directory as `cwd` and as `HOME`, so nothing here can
 * read the operator's transcripts or their real store.
 *
 * **The fresh-clone case is the point of the epic, not a bonus.** A checkout has the tree and not
 * the index, because `.gitignore` says so. So the assertion that a read REFUSES in a tree with no
 * index is the assertion that the first thing a colleague does after `git clone` is not a silent
 * lie -- and that the remedy it names is a command that exists and works (`asc index build`).
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

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stderr as one line, so a substring assertion means what it reads like. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A project: a directory with a `.git` marker and an `asc init` run in it. */
function project(prefix = 'asc-flip-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  const init = asc(['init'], dir);
  expect(init.status, init.stderr).toBe(0);
  return dir;
}

/** One decision entry, which is valid against the starter type `asc init` installs. */
function record(dir: string, chosen: string): Run {
  return asc(
    ['record', 'decision', '--prop', `chosen=${chosen}`, '--prop', 'rationale=driven by the suite'],
    dir,
  );
}

/** The entry count `asc query` reports, through the index it is allowed to open. */
function count(dir: string): number {
  const run = asc(['query', 'SELECT count(*) AS n FROM entries', '--json'], dir);
  expect(run.status, run.stderr).toBe(0);
  const rows = (JSON.parse(run.stdout) as { rows: { n: number }[] }).rows;
  return rows[0]?.n ?? -1;
}

const indexFile = (dir: string): string => join(dir, '.ascend', 'index.db');

describe('the store is the tree, and the index is a cache', () => {
  it('records into the tree, reads it back, and survives deleting the index', () => {
    const dir = project();

    // `asc init` leaves a store a read can open, which is not free: it installs the starter types
    // through a fused write, and that write is what builds the index a read requires.
    expect(existsSync(indexFile(dir))).toBe(true);
    expect(readFileSync(join(dir, '.ascend', 'types', '0001.jsonl'), 'utf8')).toContain('decision');
    // And the index is ignored, because it is derived -- the half that makes a checkout small.
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.ascend/index.db');

    expect(record(dir, 'the tree is the store').status).toBe(0);
    expect(count(dir)).toBe(1);

    // The record is a LINE. This is the assertion the whole epic rests on: what a write produces is
    // a record in the tree, and the index is a reading of it rather than a second place it lives.
    const lines = readFileSync(
      join(dir, '.ascend', 'entries', entryDir(dir), '0001.jsonl'),
      'utf8',
    );
    expect(lines.trim().split('\n')).toHaveLength(1);
    expect(lines).toContain('the tree is the store');

    // `asc index build` over a CURRENT index. Finding 4 predicted this was refused -- the command
    // reached its project through the opening that checks currency, so the remedy for a stale index
    // could not run. Measured: it builds, and says so. Run here rather than asserted in prose because
    // a prediction falsified by a test is the cheaper kind.
    const built = asc(['index', 'build'], dir);
    expect(built.status, built.stderr).toBe(0);
    expect(flatten(built.stdout)).toContain('index.db');

    // The loop. Delete the derived file, and the read REFUSES rather than building one -- a rebuild
    // is measured in tens of seconds on a real corpus (`EV-33`), so it must be asked for.
    rmSync(indexFile(dir));
    const refused = asc(['query', 'SELECT count(*) AS n FROM entries'], dir);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    const rendered = flatten(refused.stderr);
    expect(rendered).toContain('index.db');
    expect(rendered).toContain('a read does not build one');
    expect(rendered).toContain('asc index build');

    // The remedy, and the SAME answer it gave before the file was deleted. That equality is the
    // claim: nothing was lost, because nothing that mattered was in the file that went away.
    expect(asc(['index', 'build'], dir).status).toBe(0);
    expect(count(dir)).toBe(1);
  });

  it('refuses in a fresh clone, and a build there reproduces every record', () => {
    // What a colleague gets from `git clone`: the tree, and no `index.db` in it, because `.gitignore`
    // says so. Copied rather than re-created, and copied WITHOUT the index -- a fixture that carried
    // one over would be testing the case that never happens.
    const origin = project('asc-flip-origin-');
    expect(record(origin, 'first').status).toBe(0);
    expect(record(origin, 'second').status).toBe(0);
    expect(count(origin)).toBe(2);

    const clone = mkdtempSync(join(tmpdir(), 'asc-flip-clone-'));
    dirs.push(clone);
    mkdirSync(join(clone, '.git'));
    cpSync(join(origin, '.ascend'), join(clone, '.ascend'), { recursive: true });
    rmSync(indexFile(clone));
    expect(existsSync(indexFile(clone))).toBe(false);

    const refused = asc(['query', 'SELECT count(*) AS n FROM entries'], clone);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(flatten(refused.stderr)).toContain('there is no index there');

    // The build, and then the claim: the clone answers exactly what the origin does, from the tree
    // alone. `entry_types.created_at` is excluded from the comparison for the reason
    // `import-vs-index.test.ts` names -- it is stamped by the registration call and is carried by no
    // line -- so the comparison is over the records rather than over a column no tree can determine.
    expect(asc(['index', 'build'], clone).status).toBe(0);
    expect(count(clone)).toBe(2);
    const rows = (dir: string): unknown =>
      JSON.parse(
        asc(
          ['query', 'SELECT id, type_name, properties_json FROM entries ORDER BY id', '--json'],
          dir,
        ).stdout,
      );
    expect(rows(clone)).toEqual(rows(origin));
  });
});

/**
 * A project from BEFORE the flip: `.ascend/ascend.db` holding records, and no tree beside it.
 *
 * Built through the store's OWN writers, so the fixture is a store ascend would actually have
 * produced rather than a database that merely has the file's name -- the guard under test does not
 * look inside, and a fixture that could not be a real store would not prove anything about one.
 */
function legacyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-flip-legacy-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));

  const store = openStore({ dir: join(dir, '.ascend'), ascendVersion: '0.1.0' });
  try {
    registerType(
      store.db,
      { name: 'note', properties: [{ name: 'body', type: 'text' }] },
      { registeredAt: AT },
    );
    for (const n of [1, 2]) {
      recordEntry(
        store.db,
        { type: 'note' },
        { id: uuid(n), recordedAt: AT, ascendVersion: '0.1.0' },
      );
    }
  } finally {
    store.close();
  }

  return dir;
}

const AT = '2026-09-29T10:00:00.000Z';
const uuid = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('a legacy store beside the tree is refused, never built over in silence', () => {
  /**
   * **The measured defect.** A build reads the TREE, and at a project still on the old store the
   * tree is empty -- so `asc index build` published an index of nothing and reported success.
   * Measured before this guard, on a real 3,585-entry store: *"0 records"*, exit 0, and every read
   * after it answering from a store that was missing all of them.
   *
   * The read below is asserted first because it is the honest half that was NOT enough: a read
   * against a project with no index refuses and names `asc index build`, which is the right answer
   * and which sends the caller straight at the command that would lose the records.
   */
  it('refuses the build, names the migration, and loses nothing when the migration runs', () => {
    const dir = legacyProject();
    expect(existsSync(join(dir, '.ascend', 'ascend.db'))).toBe(true);
    expect(existsSync(indexFile(dir))).toBe(false);

    const read = asc(['query', 'SELECT count(*) AS n FROM entries'], dir);
    expect(read.status).toBe(1);
    expect(flatten(read.stderr)).toContain('there is no index there');

    const built = asc(['index', 'build'], dir);
    expect(built.status).toBe(1);
    expect(built.stdout).toBe('');
    const rendered = flatten(built.stderr);
    // Both halves of what the caller needs: the file that is in the way, and the command that moves
    // it aside. A refusal naming only the file would leave someone deleting it by hand, and it holds
    // the two records asserted below.
    expect(rendered).toContain('ascend.db');
    expect(rendered).toContain('asc init');
    expect(existsSync(indexFile(dir))).toBe(false);

    // The remedy, run for real. `asc init` archives the store rather than discarding it -- the
    // message says so, so the claim is checked -- and the two records come through the migration,
    // which is what makes the refusal above a detour rather than a dead end.
    expect(asc(['init'], dir).status).toBe(0);
    expect(count(dir)).toBe(2);
    expect(existsSync(join(dir, '.ascend', 'ascend.db'))).toBe(false);
    const archived = readdirSync(join(dir, '.ascend-archived'));
    expect(archived).toHaveLength(1);
    expect(existsSync(join(dir, '.ascend-archived', String(archived[0]), 'ascend.db'))).toBe(true);
  });
});

/**
 * The name of the directory a `decision` entry's line lands in.
 *
 * Read from the filesystem rather than spelled out, because the partition name is
 * `<slug>-<hash of the name>` (`jsonl-files.ts`) -- and a test that re-derived that would be testing
 * its own copy of the rule rather than the writer's. There is exactly one entry kind here, so the
 * single directory is unambiguous.
 */
function entryDir(projectDir: string): string {
  const names = readdirSync(join(projectDir, '.ascend', 'entries'));
  expect(names).toHaveLength(1);
  return String(names[0]);
}
