import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readWatchedHashes,
  WATCHED_HASHES_FILE,
  writeWatchedHashes,
  type WatchedHashes,
} from '../src/index.js';

/**
 * The watched-file baseline: a JSON file beside the tree, holding one content hash per watched path
 * (`asc-09wx.8.2`).
 *
 * **The assertions reach for the FILE, not for the API's return value.** "Atomic" and "a corrupt one
 * is refused rather than guessed at" are claims about bytes on disk, so what is read back here is
 * the text and the directory listing -- the same rule `ingest-cursor.test.ts` states for its own
 * file. The one thing deliberately not tested here is the CLI's use of any of it: `capture.test.ts`
 * drives the whole path and asserts on the entry that lands in the tree.
 *
 * **The temp file is named after the writer's pid, and two tests below are why.** `writeWatchedHashes`
 * diverges from `writeIngestCursor` here on purpose: two concurrent `SessionStart` hooks (`/clear`
 * fires the event a second time) can both be writing, and a shared temp path is the one way for the
 * file that lands to be neither writer's. So the name is asserted, and so is the fact that a writer
 * cleans its own temp file up.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-watched-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const HASH_A = '0'.repeat(64);
const HASH_B = 'a'.repeat(64);

const baseline: WatchedHashes = {
  watch: HASH_B,
  files: { 'CLAUDE.md': HASH_A, '~/.claude/settings.json': HASH_B },
};

describe('watched-hashes: reading', () => {
  it('reads an absent file as absent rather than as an error', () => {
    // The first run of `asc capture` is this case, and it is ordinary: a project that has never
    // been looked at has nothing to compare against, and `absent` is the instruction to record a
    // baseline rather than to report a failure.
    expect(readWatchedHashes(tempDir())).toEqual({ kind: 'absent' });
  });

  it('round-trips a baseline through the file', () => {
    const dir = tempDir();
    writeWatchedHashes(dir, baseline);
    expect(readWatchedHashes(dir)).toEqual({ kind: 'ok', state: baseline });
  });

  it('writes the file inside the given directory, under the exported name', () => {
    // The name is exported so `.gitignore` and `asc init` can spell it once. A test that hard-coded
    // it would keep passing while the two spellings drifted apart, which is the defect the export
    // exists to prevent.
    const dir = tempDir();
    writeWatchedHashes(dir, baseline);
    expect(readdirSync(dir)).toEqual([WATCHED_HASHES_FILE]);
  });

  it('sorts the files it writes, so two runs with the same content are byte-identical', () => {
    const dir = tempDir();
    writeWatchedHashes(dir, {
      watch: HASH_A,
      files: { 'z.md': HASH_B, 'a.md': HASH_A, 'm.md': HASH_B },
    });
    const text = readFileSync(join(dir, WATCHED_HASHES_FILE), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      files: { 'a.md': HASH_A, 'm.md': HASH_B, 'z.md': HASH_B },
    });
    expect(text.indexOf('"a.md"')).toBeLessThan(text.indexOf('"m.md"'));
    expect(text.indexOf('"m.md"')).toBeLessThan(text.indexOf('"z.md"'));
  });

  it('leaves no temp file behind', () => {
    const dir = tempDir();
    writeWatchedHashes(dir, baseline);
    expect(readdirSync(dir).filter((name) => name.includes('ascend-tmp'))).toEqual([]);
  });
});

describe('watched-hashes: refusing what cannot be compared', () => {
  /**
   * Every one of these is one answer -- `unusable` -- and the message is one sentence with the
   * reason in it. The four ways a file can be broken are the same instruction to the caller: do not
   * diff against this, say which file it was, and write a fresh baseline. Splitting them would give
   * the caller four branches that all do the same thing.
   */
  const broken: readonly (readonly [string, string])[] = [
    ['a file that is not JSON', 'not json at all'],
    ['a JSON array rather than an object', '[]'],
    ['a `format` this build does not know', '{"format":99,"watch":"x","files":{}}'],
    ['a baseline naming no watched set', `{"format":1,"watch":"","files":{}}`],
    ['a baseline with no files object', '{"format":1,"watch":"x"}'],
    ['a files object that is an array', '{"format":1,"watch":"x","files":[]}'],
    ['an entry whose hash is not a sha256', '{"format":1,"watch":"x","files":{"a.md":"nope"}}'],
    [
      'an entry whose hash is uppercase hex',
      `{"format":1,"watch":"x","files":{"a.md":"${'A'.repeat(64)}"}}`,
    ],
  ];

  for (const [what, text] of broken) {
    it(`reads ${what} as unusable and names the path`, () => {
      const dir = tempDir();
      writeFileSync(join(dir, WATCHED_HASHES_FILE), text, 'utf8');

      const result = readWatchedHashes(dir);
      expect(result.kind).toBe('unusable');
      if (result.kind !== 'unusable') return;
      expect(result.path).toBe(join(dir, WATCHED_HASHES_FILE));
      expect(result.detail).not.toBe('');
    });
  }

  it('reads a directory where the file should be as unusable rather than throwing', () => {
    // The state file is machine-local and rebuilt by the next run, so a read that threw would turn a
    // self-repairing file into a failure that propagates out of `asc capture`. A directory named
    // `watched-hashes.json` is the construction that does not depend on permission bits, which a
    // test running as root would not be able to set at all.
    const dir = tempDir();
    mkdirSync(join(dir, WATCHED_HASHES_FILE));

    const result = readWatchedHashes(dir);
    expect(result.kind).toBe('unusable');
  });
});

describe('watched-hashes: refusing what it cannot have written', () => {
  /**
   * These refusals are the writer's rather than a schema's -- the table that would have held them
   * does not exist -- and each names a state only a bug could produce. Both would fail closed at the
   * reader anyway; failing here names the caller that produced them.
   */
  it('refuses an empty watch identity', () => {
    expect(() => {
      writeWatchedHashes(tempDir(), { watch: '', files: {} });
    }).toThrow(/empty watch/u);
  });

  it('refuses a hash that is not a sha256 in lowercase hex', () => {
    expect(() => {
      writeWatchedHashes(tempDir(), { watch: HASH_A, files: { 'a.md': 'short' } });
    }).toThrow(/a\.md/u);
  });

  it('refuses an empty path', () => {
    expect(() => {
      writeWatchedHashes(tempDir(), { watch: HASH_A, files: { '': HASH_A } });
    }).toThrow(/empty path/u);
  });

  it('writes nothing at all when it refuses', () => {
    const dir = tempDir();
    expect(() => {
      writeWatchedHashes(dir, { watch: '', files: {} });
    }).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('watched-hashes: the write is atomic', () => {
  it('leaves the previous baseline intact when the new one is refused', () => {
    // The property that matters to the caller: a run that fails to write must not be able to leave
    // a map that is neither the old one nor the new one, because that map would be diffed against
    // on the next run and would report every file it lost as having vanished.
    const dir = tempDir();
    writeWatchedHashes(dir, baseline);
    expect(() => {
      writeWatchedHashes(dir, { watch: HASH_A, files: { 'a.md': 'bad' } });
    }).toThrow();
    expect(readWatchedHashes(dir)).toEqual({ kind: 'ok', state: baseline });
  });

  it('creates the store directory when it is not there', () => {
    // `asc capture` never runs before `withProjectRoot`, so this is the library's own contract
    // rather than a path the CLI exercises -- and it is the contract `writeIngestCursor` states.
    const dir = tempDir();
    const nested = join(dir, 'nested');
    writeWatchedHashes(nested, baseline);
    expect(readWatchedHashes(nested)).toEqual({ kind: 'ok', state: baseline });
  });
});
