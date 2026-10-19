/**
 * `asc-rzhr`: what a gate run judged, and which commits no run has judged.
 *
 * THE DEFECT THIS FILE EXISTS FOR is a run record that answers "what did that verdict cover?" with
 * the checkout's HEAD. Under `but commit` -- which runs no hook at all -- that question had no answer,
 * so a commit carrying a failure the gate would have caught could sit in the stack and surface days
 * later on someone else's full run (`dogfood/0095`). The tests here pin the two ways a wrong answer
 * would make that worse rather than better: a commit reported COVERED that no run read, and a
 * coverage rule so strict that the commits the gate demonstrably did read all report uncovered.
 *
 * WHY THE FIXTURES ARE REAL GIT REPOSITORIES, for the reason `scripts/gate-memo.test.ts` gives at its
 * own: the quantities under test are `git write-tree` and `git diff-tree`. A fixture that faked a
 * tree would be asserting about a hash git never produced.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changedOf, covers, parseRows, treeMap, ungated, worktreeOf } from './gate-coverage.mjs';
import { treeOf } from './gate-memo.mjs';

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A git environment this fixture owns, for the reason `gate-memo.test.ts` gives at its own copy. */
function gitEnv(): Record<string, string> {
  /** @type {Record<string, string>} */
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'ascend fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'ascend fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  };
}

function gitIn(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** A repository with one commit holding `files`. */
function repo(files: Record<string, string>): string {
  const dir = tempDir('asc-gate-coverage-');
  gitIn(dir, ['init', '-q']);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-qm', 'one']);
  return dir;
}

/** One more commit, returning its sha. */
function commit(dir: string, files: Record<string, string>, message = 'next'): string {
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-qm', message]);
  return gitIn(dir, ['rev-parse', 'HEAD']).trim();
}

function headTree(dir: string): string {
  return gitIn(dir, ['rev-parse', 'HEAD^{tree}']).trim();
}

/** A row as the gate writes one, with only the fields these tests read. */
function row(tree: string | null, work: string | null, outcome = 'ok'): Record<string, unknown> {
  return { outcome, tree, work };
}

function mapOfFor(dir: string) {
  return (tree: string) => treeMap(dir, tree);
}

describe('the two trees a run records', () => {
  it('hashes a clean checkout to the tree it has checked out', () => {
    const dir = repo({ 'a.txt': 'one' });
    expect(worktreeOf(dir)).toBe(headTree(dir));
    expect(treeOf(dir)).toBe(headTree(dir));
  });

  it('moves the working-tree hash for an unstaged edit and leaves the index hash alone', () => {
    // The two fields are not one field written twice: the test and lint steps read what is on disk,
    // and `store verify --staged` reads the index. A run in a dirty checkout judged the former only.
    const dir = repo({ 'a.txt': 'one' });
    const before = headTree(dir);
    write(dir, 'a.txt', 'edited but not staged');

    expect(worktreeOf(dir)).not.toBe(before);
    expect(treeOf(dir)).toBe(before);
  });

  it('hashes an unborn HEAD, which is every fixture and every first commit', () => {
    const dir = tempDir('asc-gate-coverage-');
    gitIn(dir, ['init', '-q']);
    write(dir, 'a.txt', 'one');
    gitIn(dir, ['add', '-A']);
    expect(worktreeOf(dir)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('what counts as covered', () => {
  it('covers a path-limited commit from a run that read a superset tree', () => {
    // `but commit ... <files>` is most commits here. Whole-tree equality would report every one of
    // them uncovered even though the gate read exactly the content they introduce.
    const dir = repo({ 'a.txt': 'one' });
    const first = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    commit(dir, { 'b.txt': 'two' });
    const superset = headTree(dir);

    const changed = changedOf(dir, first);
    expect(changed?.paths.map((entry) => entry.path)).toEqual(['a.txt']);
    expect(covers(row(superset, superset), changed!, mapOfFor(dir))).toEqual({
      covered: true,
      why: '',
    });
  });

  it('does not cover a commit whose path the run read as different content', () => {
    const dir = repo({ 'a.txt': 'one' });
    const first = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    commit(dir, { 'a.txt': 'two' });
    const later = headTree(dir);

    const verdict = covers(row(later, later), changedOf(dir, first)!, mapOfFor(dir));
    expect(verdict.covered).toBe(false);
    expect(verdict.why).toContain('differs at a.txt');
  });

  it('says which of the two trees disagreed, so a dirty checkout is not read as a stale index', () => {
    const dir = repo({ 'a.txt': 'one' });
    const first = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    write(dir, 'a.txt', 'unstaged');
    const work = worktreeOf(dir)!;
    const index = treeOf(dir)!;

    expect(covers(row(index, work), changedOf(dir, first)!, mapOfFor(dir)).why).toContain(
      'working tree',
    );
    expect(covers(row(work, index), changedOf(dir, first)!, mapOfFor(dir)).why).toContain('index');
  });

  it('does not cover from a row that recorded no tree', () => {
    const dir = repo({ 'a.txt': 'one' });
    const changed = changedOf(dir, gitIn(dir, ['rev-parse', 'HEAD']).trim())!;
    expect(covers(row(null, null), changed, mapOfFor(dir))).toEqual({
      covered: false,
      why: 'the run recorded no tree (it predates the field)',
    });
    // A JUDGED run records its index tree and no working tree, because it ran no step. Reporting
    // that as "predates the field" would hide a memo hit behind the wording for an old row.
    expect(covers(row(headTree(dir), null), changed, mapOfFor(dir)).why).toBe(
      'the run judged nothing (the memo answered it)',
    );
  });

  it('does not cover from a run that did not pass', () => {
    const dir = repo({ 'a.txt': 'one' });
    const tree = headTree(dir);
    const changed = changedOf(dir, gitIn(dir, ['rev-parse', 'HEAD']).trim())!;
    expect(covers(row(tree, tree, 'blocked'), changed, mapOfFor(dir)).why).toBe(
      'the run did not pass',
    );
  });

  it('does not cover a deletion with a tree that still holds the file', () => {
    // The content a deletion introduces is absence; a tree that still has the file read something
    // else, and reading that as "covered" would hide exactly the revert-shaped commit.
    const dir = repo({ 'a.txt': 'one', 'b.txt': 'two' });
    const before = headTree(dir);
    gitIn(dir, ['rm', '-q', 'a.txt']);
    gitIn(dir, ['commit', '-qm', 'drop a']);
    const deletion = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    const after = headTree(dir);

    expect(changedOf(dir, deletion)?.paths).toEqual([{ path: 'a.txt', blob: null }]);
    expect(covers(row(before, before), changedOf(dir, deletion)!, mapOfFor(dir)).covered).toBe(
      false,
    );
    expect(covers(row(after, after), changedOf(dir, deletion)!, mapOfFor(dir)).covered).toBe(true);
  });
});

describe('the query', () => {
  it('names what is uncovered and why, using the newest passing row', () => {
    const dir = repo({ 'a.txt': 'one' });
    const first = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    const tree = headTree(dir);
    write(dir, 'a.txt', 'unstaged');
    const dirty = worktreeOf(dir)!;

    const report = ungated([row(tree, tree), row(tree, dirty)], { root: dir, shas: [first] });
    expect(report.covered).toEqual([first]);
    expect(report.uncovered).toEqual([]);

    const stale = ungated([row(tree, dirty)], { root: dir, shas: [first] });
    expect(stale.uncovered).toEqual([
      { sha: first, why: 'the working tree that run read differs at a.txt' },
    ]);
  });

  it('says so when no passing run is recorded at all', () => {
    const dir = repo({ 'a.txt': 'one' });
    const first = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    expect(ungated([], { root: dir, shas: [first] }).uncovered[0]?.why).toBe(
      'no passing gate run is recorded on this checkout',
    );
  });

  it('does not ask a merge commit to be covered, and counts it rather than dropping it', () => {
    const dir = repo({ 'a.txt': 'one' });
    gitIn(dir, ['checkout', '-qb', 'side']);
    commit(dir, { 'b.txt': 'two' }, 'side');
    gitIn(dir, ['checkout', '-q', '-']);
    commit(dir, { 'c.txt': 'three' }, 'main');
    gitIn(dir, ['merge', '--no-ff', '-m', 'merge', 'side']);
    const merge = gitIn(dir, ['rev-parse', 'HEAD']).trim();

    expect(changedOf(dir, merge)?.merge).toBe(true);
    expect(ungated([], { root: dir, shas: [merge] })).toEqual({
      covered: [],
      uncovered: [],
      skipped: [{ sha: merge, why: 'a merge commit introduces no content of its own' }],
    });
  });

  it('reports two commits that change the same path, because the merged tree is neither of them', () => {
    const dir = repo({ 'a.txt': 'one' });
    const base = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    gitIn(dir, ['checkout', '-qb', 'one']);
    const left = commit(dir, { 'a.txt': 'left' }, 'left');
    gitIn(dir, ['checkout', '-q', base]);
    gitIn(dir, ['checkout', '-qb', 'two']);
    const right = commit(dir, { 'a.txt': 'right' }, 'right');

    // A run on either branch's tree read one of them; neither covers the other.
    const report = ungated([row(headTree(dir), headTree(dir))], {
      root: dir,
      shas: [left, right],
    });
    expect(report.covered).toEqual([right]);
    expect(report.uncovered[0]?.sha).toBe(left);
  });

  it('skips a torn line rather than throwing or treating it as a row', () => {
    expect(parseRows('{"outcome":"ok"}\nnot json\n\n[1,2]\n')).toEqual([{ outcome: 'ok' }]);
  });
});
