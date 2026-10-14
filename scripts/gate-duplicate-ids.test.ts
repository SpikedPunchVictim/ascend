import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { duplicateIds, readStaged, readTree, refusal } from './gate-duplicate-ids.mjs';

/**
 * The pre-commit refusal of an entry id that appears twice in the tree a commit would hold.
 *
 * `buildIndex` refuses such a tree, and on 2026-10-14 one reached the repository: two ingests on two
 * branch lines derived the same 70 events and a rebase combined their appends, leaving 70 ids twice,
 * each pair differing only in `recorded_at` (`asc-jijx`, `dogfood/0098`). Every index rebuild then
 * failed. The fourth case below is that shape. Two layers: the pure scan over `path -> text`, and the
 * same scan driven against a real git repository, because "the tree as it will be committed" is the
 * index and not the working directory, and only a real index can tell the two apart.
 */

const SCRIPT = fileURLToPath(new URL('./gate-duplicate-ids.mjs', import.meta.url));

const entry = (id: string, recordedAt = '2026-10-13T07:14:41.409Z'): string =>
  JSON.stringify({ kind: 'entry', id, type_name: 'note', recorded_at: recordedAt, properties: {} });

const file = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('duplicateIds', () => {
  it('passes a tree in which every entry id appears once', () => {
    const files = new Map([
      ['.ascend/entries/note-a/0001.jsonl', file(entry('a'), entry('b'))],
      ['.ascend/entries/note-b/0001.jsonl', file(entry('c'))],
    ]);
    expect(duplicateIds(files)).toEqual([]);
  });

  it('refuses one id on two lines of one file, naming both lines', () => {
    const path = '.ascend/entries/note-a/0001.jsonl';
    const files = new Map([[path, file(entry('a'), entry('b'), entry('a'))]]);
    expect(duplicateIds(files)).toEqual([
      {
        id: 'a',
        locations: [
          { path, line: 1 },
          { path, line: 3 },
        ],
      },
    ]);
  });

  it('refuses one id across two files, naming both files', () => {
    const one = '.ascend/entries/note-a/0001.jsonl';
    const two = '.ascend/entries/note-a/0002.jsonl';
    const files = new Map([
      [one, file(entry('a'))],
      [two, file(entry('x'), entry('a'))],
    ]);
    expect(duplicateIds(files)).toEqual([
      {
        id: 'a',
        locations: [
          { path: one, line: 1 },
          { path: two, line: 2 },
        ],
      },
    ]);
  });

  it('refuses a pair that differs only in recorded_at, the shape a rebase of two ingests leaves', () => {
    const path = '.ascend/entries/context_compaction-x/0001.jsonl';
    const files = new Map([
      [path, file(entry('a', '2026-10-13T07:14:41.409Z'), entry('a', '2026-10-14T06:45:10.230Z'))],
    ]);
    expect(duplicateIds(files).map((found) => found.id)).toEqual(['a']);
  });

  it('refuses a byte-identical pair too, since the index counts a record once and the file twice', () => {
    const files = new Map([['.ascend/entries/note-a/0001.jsonl', file(entry('a'), entry('a'))]]);
    expect(duplicateIds(files)).toHaveLength(1);
  });

  it('lists a three-way duplicate once, with all three locations', () => {
    const files = new Map([
      ['.ascend/entries/note-a/0001.jsonl', file(entry('a'), entry('a'), entry('a'))],
    ]);
    const found = duplicateIds(files);
    expect(found).toHaveLength(1);
    expect(found[0]?.locations).toHaveLength(3);
  });

  it('does not count an annotation line that shares an entry id', () => {
    const files = new Map([
      ['.ascend/entries/note-a/0001.jsonl', file(entry('a'))],
      ['.ascend/annotations/x/0001.jsonl', file(JSON.stringify({ kind: 'annotation', id: 'a' }))],
    ]);
    expect(duplicateIds(files)).toEqual([]);
  });
});

describe('refusal', () => {
  it('names the id, both locations and the remedy', () => {
    const message = refusal([
      {
        id: 'derived:x:1',
        locations: [
          { path: 'p/0001.jsonl', line: 4 },
          { path: 'p/0001.jsonl', line: 9 },
        ],
      },
    ]);
    expect(message).toContain('derived:x:1');
    expect(message).toContain('p/0001.jsonl:4');
    expect(message).toContain('p/0001.jsonl:9');
    expect(message).toMatch(/keep the line recorded earlier/i);
  });
});

const made: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dup-ids-'));
  made.push(dir);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  git('init', '-q');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git('add', '-A');
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('the tree as it will be committed', () => {
  const path = '.ascend/entries/note-a/0001.jsonl';

  it('reads the index, not the working directory', () => {
    const dir = repo({ [path]: file(entry('a'), entry('a', '2026-10-14T00:00:00.000Z')) });
    // The working copy is repaired after staging; the commit would still hold the duplicate.
    writeFileSync(join(dir, path), file(entry('a')));
    expect(duplicateIds(readStaged(dir))).toHaveLength(1);
  });

  it('reads a committed tree by revision', () => {
    const dir = repo({ [path]: file(entry('a'), entry('a', '2026-10-14T00:00:00.000Z')) });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], {
      cwd: dir,
    });
    expect(duplicateIds(readTree(dir, 'HEAD'))).toHaveLength(1);
  });

  it('ignores the sides of an unresolved conflict, which a commit cannot hold', () => {
    const dir = repo({ [path]: file(entry('a')) });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: dir,
      encoding: 'utf8',
      input: file(entry('a'), entry('a')),
    }).trim();
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: dir,
      input: `0 ${'0'.repeat(40)}\t${path}\n100644 ${blob} 2\t${path}\n`,
    });
    expect(duplicateIds(readStaged(dir))).toEqual([]);
  });

  it('exits 1 and prints the id and both locations for a staged duplicate', () => {
    const dir = repo({ [path]: file(entry('dup'), entry('dup', '2026-10-14T00:00:00.000Z')) });
    const ran = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('dup');
    expect(ran.stderr).toContain(`${path}:1`);
    expect(ran.stderr).toContain(`${path}:2`);
  });

  it('exits 0 for a clean staged tree', () => {
    const dir = repo({ [path]: file(entry('a'), entry('b')) });
    const ran = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' });
    expect(ran.status).toBe(0);
  });

  it('exits 2, not 0, when asked about a revision that does not exist', () => {
    const dir = repo({ [path]: file(entry('a')) });
    const ran = spawnSync('node', [SCRIPT, '--rev', 'no-such-rev'], { cwd: dir, encoding: 'utf8' });
    expect(ran.status).toBe(2);
  });
});
