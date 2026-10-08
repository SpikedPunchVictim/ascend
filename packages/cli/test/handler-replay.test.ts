import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeProjectDir, replayHandlers } from '../src/handler-replay.js';

/**
 * `replayHandlers`' horizon, at the unit level, because that is where the number is built.
 *
 * `handlers-check.test.ts` drives the real binary and is the right place for "the flags are
 * wired"; this is the right place for "the count over a corpus is the count of what was read",
 * which needs a corpus the binary's own flags cannot produce -- one directory the walk may not
 * descend into.
 *
 * `SkipReason`'s contract is the thing under test (`reader.ts:86-90`): "A path the sweep
 * deliberately did not read. **Never silent -- always reported.**" The reader records it and
 * `asc ingest` reports it (`claude-code.ts:933`); the horizon is the third reader, and it is the
 * one that could report a clean sweep over a corpus it did not finish reading.
 */

const canVandalize = process.getuid === undefined || process.getuid() !== 0;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-replay-'));
  dirs.push(dir);
  return dir;
}

/**
 * The fixture project's encoded directory name, from the same function the command uses, so a
 * change to the encoding moves this fixture with it rather than silently emptying it.
 */
const PROJECT = encodeProjectDir('/Users/me/scratch');

/** One valid transcript record. The horizon's `files` comes from the walk, not from events. */
const line = (session: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId: session,
    uuid: `${session}-u1`,
    timestamp: '2026-01-02T03:04:05.000Z',
    cwd: '/Users/me/scratch',
    gitBranch: 'main',
    message: { content: [{ type: 'text', text: 'hello' }] },
  })}\n`;

/** A corpus with one project directory holding the given files. */
function corpus(files: readonly string[]): string {
  const root = scratch();
  const project = join(root, PROJECT);
  mkdirSync(project, { recursive: true });
  for (const name of files) {
    const path = join(project, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, line(name.replace(/\W+/gu, '-')));
  }
  return root;
}

describe('replayHandlers: the horizon over transcripts', () => {
  it('counts a directory it could not descend into, rather than reporting a clean sweep', async () => {
    // Before this, `unreadable` was `totals.failures.length` -- per-FILE incomplete reads -- and a
    // directory the walk may not enter was counted nowhere. `asc ingest` reports the same events
    // and the replay did not, so the two readers of one corpus disagreed about whether anything
    // had been left out.
    if (!canVandalize) return;
    const root = corpus(['s-1.jsonl']);
    const locked = join(root, PROJECT, 'nested');
    mkdirSync(locked);
    writeFileSync(join(locked, 's-2.jsonl'), line('s-2'));
    chmodSync(locked, 0o000);

    try {
      const result = await replayHandlers([], { source: 'transcripts', root, projects: 'all' });
      expect(result.horizon.unreadable).toBe(1);
      // The readable file is still read: one directory the user cannot read must not cost them the
      // rest of the corpus. `reader.ts`'s rule for the walk, and asserting it here is what proves
      // the number above came from recording a skip rather than from the replay stopping early.
      expect(result.horizon.files).toBe(1);
    } finally {
      // Restored in a `finally`: `rmSync(recursive)` cannot list a directory it may not read, so a
      // failed assertion above would otherwise leave the teardown failing ENOTEMPTY and hide it.
      chmodSync(locked, 0o700);
    }
  });

  it('does not count a symlink, because not following it is the decision being made', async () => {
    // `reader.ts` skips symlinks deliberately -- following one could leave the root or loop
    // forever, and the root is a boundary ascend respects. A corpus holding one is not a corpus
    // that could not be read, so counting it would put a permanent non-zero on a healthy sweep:
    // the same false report the ENOENT rule avoids on the log side.
    const root = corpus(['s-1.jsonl']);
    symlinkSync(join(root, PROJECT, 's-1.jsonl'), join(root, PROJECT, 'link.jsonl'));

    const result = await replayHandlers([], { source: 'transcripts', root, projects: 'all' });
    expect(result.horizon.unreadable).toBe(0);
    // Two entries seen, one followed -- so the symlink was reached and deliberately not read,
    // rather than never having been reached at all.
    expect(result.horizon.files).toBe(1);
  });
});
