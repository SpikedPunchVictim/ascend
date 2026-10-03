import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORE_DIR } from '@ascend/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc store verify`, driven as the real binary against real git repositories.
 *
 * The fixture drives an actual three-way merge rather than hand-writing a tree, because the defect
 * this guard exists for was measured on one: `docs/evidence/EV-31.md` and `spike/git-layout/
 * FINDINGS.md` W3 recorded a resolution that reports success and drops a record, leaving
 * well-formed JSONL behind. A fixture that wrote the "after" state directly would prove the guard
 * reads a tree; only a real merge proves it refuses the thing that goes wrong in practice.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

const RECORDS = `${STORE_DIR}/entries/note-1a2b/0001.jsonl`;

let built = false;

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'ignore',
  });
  built = true;
}, 240_000);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

/** A git repo whose store is a real `.ascend/` tree. No index.db: verify reads git, not the store. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-verify-'));
  dirs.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  mkdirSync(join(dir, STORE_DIR, 'entries', 'note-1a2b'), { recursive: true });
  writeFileSync(join(dir, STORE_DIR, '.gitattributes'), '*.jsonl merge=union\n');
  return dir;
}

function entry(id: string): string {
  return `{"kind":"entry","id":"${id}"}\n`;
}

/** Write the whole record file and commit it. */
function commitRecords(dir: string, ids: readonly string[], message: string): void {
  writeFileSync(join(dir, RECORDS), ids.map(entry).join(''));
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
}

interface Result {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function verify(dir: string, args: readonly string[] = []): Result {
  const run = spawnSync(process.execPath, [bin, 'store', 'verify', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

describe('asc store verify', () => {
  it('passes a clean merge=union merge — both sides’ records present', () => {
    const dir = repo();
    commitRecords(dir, ['r0'], 'base');
    git(['checkout', '-q', '-b', 'other'], dir);
    commitRecords(dir, ['r0', 'rb0'], 'other appends rb0');
    git(['checkout', '-q', 'main'], dir);
    commitRecords(dir, ['r0', 'ra0'], 'main appends ra0');
    git(['merge', '-q', 'other'], dir); // union driver: clean, both appends kept

    const after = git(['show', 'HEAD:' + RECORDS], dir);
    expect(after).toContain('"rb0"');
    expect(after).toContain('"ra0"');

    const result = verify(dir);
    expect(result.stderr).toContain('no lost record ids');
    expect(result.status).toBe(0);
    // Zero problem rows. The table header is still rendered on success, which is the same shape
    // `asc doctor` emits for a clean store -- so the assertion is "no problem rows", not "no bytes".
    expect(result.stdout).not.toContain('lost-id');
    expect(result.stdout).not.toContain('unreadable-line');
  });

  it('refuses a one-side resolution that keeps well-formed JSONL (the EV-31 case)', () => {
    const dir = repo();
    commitRecords(dir, ['r0'], 'base');
    git(['checkout', '-q', '-b', 'other'], dir);
    commitRecords(dir, ['r0', 'rb0'], 'other appends rb0');
    git(['checkout', '-q', '-b', 'ours', 'main'], dir);
    commitRecords(dir, ['r0', 'ra0'], 'ours appends ra0');

    // Force a real conflict by dropping the union driver, then resolve by taking OUR side only.
    writeFileSync(join(dir, STORE_DIR, '.gitattributes'), '');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'no union'], dir);
    const merge = spawnSync('git', ['merge', 'other'], { cwd: dir, encoding: 'utf8' });
    expect(merge.status).not.toBe(0); // conflicted, as intended

    git(['checkout', '--ours', '--', RECORDS], dir);
    git(['add', '-A'], dir);

    const staged = verify(dir, ['--staged', '--json']);
    expect(staged.status).toBe(1);

    const report = JSON.parse(staged.stdout) as { rows: { problem: string; where: string }[] };
    const lost = report.rows.filter((row) => row.problem === 'lost-id');
    expect(lost.map((row) => row.where)).toContain('rb0');
    expect(staged.stderr).toContain('rb0');
    expect(staged.stderr).toContain('MERGE_HEAD');
  });

  it('refuses conflict markers left in a staged record file', () => {
    const dir = repo();
    commitRecords(dir, ['r0'], 'base');
    writeFileSync(
      join(dir, RECORDS),
      [
        '<<<<<<< HEAD',
        entry('r0').trimEnd(),
        '=======',
        entry('r1').trimEnd(),
        '>>>>>>> other',
        '',
      ].join('\n'),
    );
    git(['add', '-A'], dir);

    const result = verify(dir, ['--staged']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unreadable-line');
    expect(result.stderr).toContain('conflict marker');
  });

  it('refuses a line the reader would reject', () => {
    const dir = repo();
    commitRecords(dir, ['r0'], 'base');
    writeFileSync(join(dir, RECORDS), entry('r0') + '{ this is not json\n');
    git(['add', '-A'], dir);

    const result = verify(dir, ['--staged']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.stderr).toContain(RECORDS + ':2');
  });

  it('--against names a baseline a record must not disappear relative to', () => {
    const dir = repo();
    commitRecords(dir, ['r0', 'rb0'], 'base with rb0');
    git(['branch', 'base'], dir);
    commitRecords(dir, ['r0'], 'main drops rb0');

    const result = verify(dir, ['--against', 'base']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rb0');
    expect(result.stderr).toContain('base');
  });

  it('a --against ref that does not resolve is refused, never silently skipped', () => {
    const dir = repo();
    commitRecords(dir, ['r0'], 'base');

    const result = verify(dir, ['--against', 'origin/nope']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not name a commit');
  });

  it('refuses to run outside a git working tree, with the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-verify-nogit-'));
    dirs.push(dir);
    mkdirSync(join(dir, STORE_DIR), { recursive: true });

    const result = verify(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not inside one');
  });

  it('prints no git “fatal:” on a clean run, including --staged with no merge in progress', () => {
    // Regression for a defect found by RUNNING the command, not by a fixture: `execFileSync`
    // inherits the child's stderr, so `git rev-parse --verify MERGE_HEAD` finding no merge printed
    // `fatal: Needed a single revision` before an otherwise clean result. A `fatal:` on success is a
    // false alarm in any CI log that greps for one.
    const dir = repo();
    commitRecords(dir, ['r0'], 'base');
    for (const args of [[], ['--staged']]) {
      const result = verify(dir, args);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('fatal');
      expect(result.stderr).not.toContain('Needed a single revision');
    }
  });

  it('is in --help with a runnable example', () => {
    const run = spawnSync(process.execPath, [bin, 'store', 'verify', '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--staged');
    expect(run.stdout).toContain('--against');
    expect(built).toBe(true);
  });
});
