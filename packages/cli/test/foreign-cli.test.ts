import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A foreign store file, driven through the real binary.
 *
 * asc-63v was found by driving the binary, so it is closed the same way. `foreign.test.ts` asserts
 * the guard where it is a function; this file asserts that every command actually reaches it -- and,
 * critically, that the three open shapes a command can take all refuse rather than the writable one
 * refusing while the read-only one reports something else.
 *
 * **Three shapes, because the defect had a different face in each.** Before the guard: `asc types
 * list` adopted and migrated the file (exit 0); `asc query`, which opens read-only, reached
 * `StaleStoreError` and would have told the caller ascend expects a newer schema; and `asc init` --
 * the command whose whole job is creating a store -- would have written one into someone else's
 * file. Those are not three copies of one test, they are three different wrong answers.
 *
 * The byte comparison is the assertion that matters. The bead's harm is a WRITE, and a refusal that
 * still wrote would pass every message assertion here.
 *
 * Assertions compare squashed text on both sides for the reason `driver-errors-cli.test.ts` sets out
 * at length: oclif wraps mid-token, so a wrap marker inside a searched-for phrase would make
 * `not.toContain` pass on text that still contains it.
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

function squashed(text: string): string {
  return text.replace(/[\s›]+/g, '');
}

/**
 * A project directory whose store file is a database ascend did not create.
 *
 * `.git` is a plain directory for the same reason the other suites make one: it is what the project
 * walk looks for, and a test that relied on being inside this repository instead would pass or fail
 * with the working directory.
 */
function foreignProject(): { readonly dir: string; readonly file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asc-foreign-cli-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.ascend'));
  const file = join(dir, '.ascend', 'ascend.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE mine (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
  } finally {
    db.close();
  }
  return { dir, file };
}

/** The tables SQLite reports, through a connection that is not the one under test. */
const tablesIn = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as unknown as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
};

describe('every command refuses a store file ascend did not create', () => {
  it.each([
    { command: 'types list', args: ['types', 'list'], opens: 'writable' },
    { command: 'query', args: ['query', 'SELECT 1 AS n'], opens: 'read-only' },
    { command: 'init', args: ['init'], opens: 'writable' },
  ])(
    '$command refuses it, and $opens is the open it takes',
    ({ args }: { readonly args: readonly string[] }) => {
      const { dir, file } = foreignProject();
      const before = readFileSync(file);

      const run = asc(args, dir);

      expect(run.status).toBe(1);
      // Rule 1: the error is not data. A script piping stdout must get nothing to parse.
      expect(run.stdout).toBe('');
      const rendered = squashed(run.stderr);
      expect(rendered).toContain(squashed('is a SQLite database, and it is not an ascend store'));
      expect(rendered).toContain('mine');
      expect(rendered).toContain('other');
      expect(rendered).toContain(squashed('Move that file aside'));

      // The harm. Nothing was migrated, nothing was written, not even the header.
      expect(tablesIn(file)).toEqual(['mine', 'other']);
      expect(readFileSync(file).equals(before)).toBe(true);
    },
  );

  it('does not report a foreign file as a store that is behind, which is what query used to say', () => {
    // The read-only arm's old answer, asserted as absent. A foreign file is at `user_version` 0, so
    // it looks "behind" to a read-only open that cannot migrate it -- and the message that produces
    // tells the caller ascend expects a newer schema and to run another command to bring it up to
    // date. That is a false statement about a file no ascend ever wrote, and it sends the caller to
    // fix a schema problem they do not have.
    const { dir } = foreignProject();

    const rendered = squashed(asc(['query', 'SELECT 1 AS n'], dir).stderr);

    expect(rendered).not.toContain(squashed('schema version'));
    expect(rendered).not.toContain(squashed('cannot migrate'));
    // Nor the pragma complaint that a guard placed after `verifyPragmas` produced instead.
    expect(rendered).not.toContain(squashed('journal_mode'));
  });
});

describe('what must still work', () => {
  it('creates a store in a project that has none', () => {
    // The ordinary case, and the one an over-broad guard would break: every `asc init` opens a file
    // that does not exist yet.
    const dir = mkdtempSync(join(tmpdir(), 'asc-foreign-fresh-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));

    expect(asc(['init'], dir).status).toBe(0);
    expect(tablesIn(join(dir, '.ascend', 'ascend.db'))).toContain('entries');
  });

  it('keeps working in a project ascend set up itself', () => {
    // A second command against a store ascend created -- the case every guard of this kind risks
    // breaking, since the file now exists and has content.
    const dir = mkdtempSync(join(tmpdir(), 'asc-foreign-own-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));
    expect(asc(['init'], dir).status).toBe(0);

    const run = asc(['types', 'list'], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('decision');
  });
});
