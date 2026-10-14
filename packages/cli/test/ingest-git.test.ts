import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findEntry, INDEX_FILE, openIndex, STORE_DIR, type RecordedEntry } from '@ascend/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIZE_MIN_COMMITS } from '../src/commit-size.js';
import { emptyStore, flatten } from './helpers.js';

/**
 * `asc ingest git` (asc-09wx.9): one `commit_size` entry per non-merge commit reachable from HEAD,
 * written through the real binary into a real repository. The measuring itself is
 * `commit-size.test.ts`; this is what reaches the store, and that a second run adds nothing.
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

const DAY = 86_400;
const START = 1_780_000_000;

function git(dir: string, args: readonly string[], at?: number): string {
  const date = at === undefined ? {} : { GIT_COMMITTER_DATE: `@${String(at)} +0000` };
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...date,
    },
  }).trim();
}

/** A project in a repository whose commit `n` (0-based) adds `n + 1` lines, one a day. */
function repository(commits: number): { readonly dir: string; readonly shas: readonly string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'asc-ingest-git-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  const shas: string[] = [];
  for (let index = 0; index < commits; index += 1) {
    const file = `src/f${String(index)}.ts`;
    execFileSync('mkdir', ['-p', join(dir, 'src')]);
    writeFileSync(join(dir, file), 'x\n'.repeat(index + 1));
    git(dir, ['add', file]);
    git(dir, ['commit', '-q', '-m', `commit ${String(index)}`], START + index * DAY);
    shas.push(git(dir, ['rev-parse', 'HEAD']));
  }
  emptyStore(dir);
  return { dir, shas };
}

function stored(dir: string, sha: string): RecordedEntry | undefined {
  const tree = join(dir, STORE_DIR);
  const store = openIndex(tree, join(tree, INDEX_FILE));
  try {
    return findEntry(store.db, `derived:git:commit_size:${sha}`);
  } finally {
    store.db.close();
  }
}

function counts(run: Run): Record<string, number> {
  expect(run.status, run.stderr).toBe(0);
  const { rows } = JSON.parse(run.stdout) as {
    rows: { readonly outcome: string; readonly commits: number }[];
  };
  return Object.fromEntries(rows.map((row) => [row.outcome, row.commits]));
}

describe('asc ingest git', () => {
  it('writes one commit_size entry per commit, sourced derived:git and keyed on the sha', () => {
    const { dir, shas } = repository(3);
    expect(counts(asc(['ingest', 'git', '--json'], dir))).toMatchObject({ written: 3 });

    const entry = stored(dir, shas[1] ?? '');
    expect(entry).toMatchObject({
      typeName: 'commit_size',
      source: 'derived:git',
      gitSha: shas[1],
      properties: {
        committed_at: new Date((START + DAY) * 1000).toISOString(),
        files: 1,
        source_files: 1,
        added_source_lines: 2,
        removed_source_lines: 0,
        eligible: true,
      },
    });
  });

  it('leaves the threshold out of a commit with too few commits before it', () => {
    const { dir, shas } = repository(3);
    asc(['ingest', 'git', '--json'], dir);
    expect(stored(dir, shas[2] ?? '')?.properties).not.toHaveProperty('size_top_decile');
  });

  it('records the threshold a commit was graded against, and whether it is above it', () => {
    const { dir, shas } = repository(SIZE_MIN_COMMITS + 1);
    asc(['ingest', 'git', '--json'], dir);
    // 50 commits adding 1..50 lines before it: the threshold is the 46th value.
    expect(stored(dir, shas[SIZE_MIN_COMMITS] ?? '')?.properties).toMatchObject({
      p90_added_source_lines: 46,
      threshold_commits: 50,
      size_top_decile: true,
    });
  });

  it('writes nothing on a second run over the same history', () => {
    const { dir } = repository(3);
    asc(['ingest', 'git', '--json'], dir);
    expect(counts(asc(['ingest', 'git', '--json'], dir))).toMatchObject({
      written: 0,
      present: 3,
    });
  });

  it('writes only the new commit after one more is made', () => {
    const { dir } = repository(3);
    asc(['ingest', 'git', '--json'], dir);
    writeFileSync(join(dir, 'src/new.ts'), 'y\n');
    git(dir, ['add', 'src/new.ts']);
    git(dir, ['commit', '-q', '-m', 'one more'], START + 10 * DAY);
    expect(counts(asc(['ingest', 'git', '--json'], dir))).toMatchObject({
      written: 1,
      present: 3,
    });
  });

  it('refuses a project that is not in a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-ingest-git-'));
    dirs.push(dir);
    emptyStore(dir);
    const run = asc(['ingest', 'git'], dir);
    expect(run.status).not.toBe(0);
    expect(flatten(run.stderr)).toContain('not in a git repository');
  });
});
