import { validateEntry } from '@ascend/core';
import { describe, expect, it } from 'vitest';
import {
  COMMIT_LOG_ARGS,
  COMMIT_SIZE_TYPE,
  commitSizeProperties,
  SIZE_MIN_COMMITS,
  SIZE_WINDOW_DAYS,
  isSource,
  measureCommits,
  parseCommitLog,
  type CommitStat,
} from '../src/commit-size.js';

/** The size signal `asc ingest git` records per commit (asc-09wx.9; EV-61, EV-63). */

const DAY = 86_400;

/** One commit as `git log -z --numstat --format=%x1e%H%x1f%ct%x1f` prints it. */
function logRecord(sha: string, at: number, numstat: readonly string[]): string {
  return `\u001e${sha}\u001f${String(at)}\u001f\0\n${numstat.map((one) => `${one}\0`).join('')}`;
}

function commit(sha: string, at: number, added: number, path = 'src/a.ts'): CommitStat {
  return { sha, committedAt: at, files: [{ path, added, removed: 0 }] };
}

/** `count` eligible commits, one a day ending the day before `end`, adding 1..count lines. */
function history(count: number, end: number): CommitStat[] {
  return Array.from({ length: count }, (_, index) =>
    commit(`h${String(index)}`, end - (count - index) * DAY, index + 1),
  );
}

describe('COMMIT_LOG_ARGS', () => {
  // THE ASK, PINNED. The module exports its arguments so that "the text this module parses and the
  // command that produces it cannot drift apart", and until this test only the reading half of that
  // sentence was checked -- the parser's behaviour, never the ask. Dropping `--no-renames` from the
  // list leaves every other test in this file green, and it is not a cosmetic loss: the flag is the
  // definition `EV-63` was measured with, and replaying that log's 367 commits gives the same added
  // source lines on all 367 with it and on 365 without it. Whoever removes it is changing what the
  // recorder measures and should have to say so in this diff.
  it('asks git log for the exact shape parseCommitLog reads', () => {
    expect(COMMIT_LOG_ARGS).toStrictEqual([
      'log',
      '--no-merges',
      '--no-renames',
      '-z',
      '--numstat',
      '--format=%x1e%H%x1f%ct%x1f',
    ]);
  });
});

describe('isSource', () => {
  it.each([
    'packages/cli/src/commit-size.ts',
    'scripts/mutate.mjs',
    'handlers/beads-recall.yaml',
    'spike/beads-recall/grade.py',
  ])('counts %s', (path) => {
    expect(isSource(path)).toBe(true);
  });

  it.each([
    'pnpm-lock.yaml',
    'packages/cli/package.json',
    'CHANGELOG.md',
    'docs/evidence/EV-63.md',
    'packages/cli/test/__snapshots__/a.snap',
    '.ascend/entries/note-e8cd1a80204d/0001.jsonl',
    '.beads/hooks/pre-commit',
    'data/commits.CSV',
  ])('does not count %s', (path) => {
    expect(isSource(path)).toBe(false);
  });
});

describe('parseCommitLog', () => {
  it('reads the sha, the commit time and each file of every commit', () => {
    const text =
      logRecord('aaa', 1_700_000_000, ['6\t2\tsrc/a.ts', '114\t0\tdocs/EV-64.md']) +
      logRecord('bbb', 1_700_000_500, ['1\t1\tsrc/b.ts']);
    expect(parseCommitLog(text)).toStrictEqual([
      {
        sha: 'aaa',
        committedAt: 1_700_000_000,
        files: [
          { path: 'src/a.ts', added: 6, removed: 2 },
          { path: 'docs/EV-64.md', added: 114, removed: 0 },
        ],
      },
      {
        sha: 'bbb',
        committedAt: 1_700_000_500,
        files: [{ path: 'src/b.ts', added: 1, removed: 1 }],
      },
    ]);
  });

  it('refuses a rename record, which the log is asked not to produce', () => {
    const text = logRecord('aaa', 1_700_000_000, ['3\t1\t', 'docs/old.md', 'src/new.ts']);
    expect(() => parseCommitLog(text)).toThrow(/aaa.*no path/);
  });

  it('keeps a binary file as a file with no line counts', () => {
    const text = logRecord('aaa', 1_700_000_000, ['-\t-\tsrc/logo.bin']);
    expect(parseCommitLog(text)[0]?.files).toStrictEqual([
      { path: 'src/logo.bin', added: undefined, removed: undefined },
    ]);
  });

  it('keeps a commit that changed no file', () => {
    expect(parseCommitLog('\u001eaaa\u001f1700000000\u001f')).toStrictEqual([
      { sha: 'aaa', committedAt: 1_700_000_000, files: [] },
    ]);
  });

  it('refuses a record whose commit time is not a number', () => {
    expect(() => parseCommitLog('\u001eaaa\u001fyesterday\u001f')).toThrow(/aaa/);
  });
});

describe('measureCommits', () => {
  const now = 1_800_000_000;

  it('sums added and removed lines over source files only', () => {
    const [measured] = measureCommits([
      {
        sha: 'aaa',
        committedAt: now,
        files: [
          { path: 'src/a.ts', added: 10, removed: 4 },
          { path: 'src/b.ts', added: 5, removed: 1 },
          { path: 'docs/a.md', added: 900, removed: 300 },
          { path: 'src/logo.bin', added: undefined, removed: undefined },
        ],
      },
    ]);
    expect(measured).toMatchObject({
      sha: 'aaa',
      files: 4,
      sourceFiles: 2,
      addedSourceLines: 15,
      removedSourceLines: 5,
      eligible: true,
    });
  });

  it('does not grade a commit that adds no source line', () => {
    const [measured] = measureCommits([
      ...history(SIZE_MIN_COMMITS, now),
      { sha: 'aaa', committedAt: now, files: [{ path: 'src/a.ts', added: 0, removed: 40 }] },
    ]).slice(-1);
    expect(measured).toMatchObject({ eligible: false, removedSourceLines: 40 });
    expect(measured?.sizeTopDecile).toBeUndefined();
  });

  it('does not grade a commit of more than 30 files', () => {
    const files = Array.from({ length: 31 }, (_, index) => ({
      path: `src/f${String(index)}.ts`,
      added: 100,
      removed: 0,
    }));
    const [measured] = measureCommits([
      ...history(SIZE_MIN_COMMITS, now),
      { sha: 'aaa', committedAt: now, files },
    ]).slice(-1);
    expect(measured).toMatchObject({ eligible: false, addedSourceLines: 3100 });
    expect(measured?.sizeTopDecile).toBeUndefined();
  });

  it('gives no threshold until 50 eligible commits precede the commit', () => {
    const [measured] = measureCommits([
      ...history(SIZE_MIN_COMMITS - 1, now),
      commit('aaa', now, 10_000),
    ]).slice(-1);
    expect(measured?.threshold).toBeUndefined();
    expect(measured?.sizeTopDecile).toBeUndefined();
  });

  it('takes the threshold as the 90th percentile of the eligible commits before it', () => {
    // 50 commits adding 1..50 lines: sorted[int(0.9 * 50)] is the 46th value.
    const [measured] = measureCommits([...history(50, now), commit('aaa', now, 47)]).slice(-1);
    expect(measured?.threshold).toStrictEqual({ p90AddedSourceLines: 46, commits: 50 });
  });

  it('flags a commit above the threshold', () => {
    const [measured] = measureCommits([...history(50, now), commit('aaa', now, 47)]).slice(-1);
    expect(measured?.sizeTopDecile).toBe(true);
  });

  it('does not flag a commit at the threshold', () => {
    const [measured] = measureCommits([...history(50, now), commit('aaa', now, 46)]).slice(-1);
    expect(measured?.sizeTopDecile).toBe(false);
  });

  it('leaves commits older than the window out of the threshold', () => {
    const old = history(50, now - SIZE_WINDOW_DAYS * DAY);
    const [measured] = measureCommits([...old, commit('aaa', now, 10_000)]).slice(-1);
    expect(measured?.threshold).toBeUndefined();
  });

  it('leaves ineligible commits out of the threshold', () => {
    const docs = Array.from({ length: 10 }, (_, index) =>
      commit(`d${String(index)}`, now - (index + 1) * DAY, 5000, 'docs/a.md'),
    );
    const [measured] = measureCommits([...history(50, now), ...docs, commit('aaa', now, 47)]).slice(
      -1,
    );
    expect(measured?.threshold).toStrictEqual({ p90AddedSourceLines: 46, commits: 50 });
  });

  it('does not count a commit toward its own threshold, or a later one', () => {
    const later = commit('zzz', now + DAY, 99_999);
    const measured = measureCommits([...history(50, now), commit('aaa', now, 47), later]);
    expect(measured.find((one) => one.sha === 'aaa')?.threshold).toStrictEqual({
      p90AddedSourceLines: 46,
      commits: 50,
    });
  });

  it('gives the same answer whatever order the commits arrive in', () => {
    const stats = [...history(60, now), commit('aaa', now, 47)];
    const forward = measureCommits(stats);
    const backward = measureCommits([...stats].reverse());
    expect(backward).toStrictEqual(forward);
  });
});

describe('commitSizeProperties', () => {
  const now = 1_800_000_000;

  it('gives properties the commit_size type accepts, with the threshold', () => {
    const [graded] = measureCommits([...history(50, now), commit('aaa', now, 47)]).slice(-1);
    const properties = commitSizeProperties(graded!);
    expect(properties).toMatchObject({
      p90_added_source_lines: 46,
      threshold_commits: 50,
      size_top_decile: true,
    });
    expect(validateEntry(COMMIT_SIZE_TYPE, { properties }).errors).toStrictEqual([]);
  });

  it('leaves all three threshold properties out of an ungraded commit', () => {
    const [ungraded] = measureCommits([commit('aaa', now, 47)]);
    const properties = commitSizeProperties(ungraded!);
    expect(Object.keys(properties).sort()).toStrictEqual([
      'added_source_lines',
      'committed_at',
      'eligible',
      'files',
      'removed_source_lines',
      'source_files',
    ]);
    expect(validateEntry(COMMIT_SIZE_TYPE, { properties }).errors).toStrictEqual([]);
  });

  it('gives the commit time as a UTC timestamp with milliseconds', () => {
    const [one] = measureCommits([commit('aaa', now, 1)]);
    expect(commitSizeProperties(one!)['committed_at']).toBe('2027-01-15T08:00:00.000Z');
  });
});
