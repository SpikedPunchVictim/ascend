import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hashWatched,
  watchIdentity,
  watchedChanges,
  watchedPaths,
  type WatchedPath,
} from '../src/watched.js';

/**
 * The watched set: which files a session is shaped by, what they hash to, and what moved
 * (`asc-09wx.8.2`).
 *
 * **The interesting assertions here are the ones about what is NOT watched and what is NOT a
 * change.** The set is a policy, and a policy's failure mode is a false row -- an entry claiming six
 * files moved on a date when what moved was ascend's own watch list. Every refusal below is a guard
 * against that direction, because a missed change costs one observation and a spurious one is
 * permanent (`watched-hashes.ts` states the same asymmetry for the baseline).
 *
 * The display-path spellings get their own block, because they are what lands in a git-tracked,
 * shared entry: an absolute path into one machine's home directory would be a row nobody else can
 * read, which is exactly what moved `ingest-cursor.ts` out of the tree in the first place.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// `tsc -b` because `watched.ts` is imported from source here, and the CLI suites run the compiled
// binary -- a stale `dist/` is the difference between what this file tests and what ships.
beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-watched-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The absolute path of one display path, for a fixture whose home and project are the same. */
function at(dir: string, display: string): string {
  return join(dir, display);
}

function write(dir: string, display: string, text: string): void {
  const path = at(dir, display);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

const displays = (paths: readonly WatchedPath[]): readonly string[] =>
  paths.map((path) => path.display);

describe('watchedPaths: what a session is shaped by', () => {
  it('names the instruction files and the Claude Code settings at both levels', () => {
    const dir = scratch();
    const paths = watchedPaths(dir, dir);

    // Six, not four: with `home` equal to `root` the home level's names resolve to
    // `<root>/.claude/CLAUDE.md` and `<root>/.claude/MEMORY.md`, which are different files from
    // `<root>/CLAUDE.md` and must stay in the set. Their display spelling drops the `~` because the
    // project is what they are under -- see the `displayPath` order in `watched.ts`.
    expect(displays(paths)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/MEMORY.md',
      '.claude/settings.json',
      '.claude/settings.local.json',
      'CLAUDE.md',
      'MEMORY.md',
    ]);
  });

  it('spells a home-level file under ~ when the project is not the home directory', () => {
    const dir = scratch();
    const paths = watchedPaths(join(dir, 'project'), dir);

    expect(displays(paths)).toContain('~/.claude/CLAUDE.md');
    expect(displays(paths)).toContain('~/.claude/MEMORY.md');
    // The project-level name is relative to the project wherever the project is, so it stays
    // `CLAUDE.md` -- and it is a different file from `~/.claude/CLAUDE.md` however the two are
    // spelled.
    expect(displays(paths)).toContain('CLAUDE.md');
    expect(paths.length).toBe(6);
  });

  it('carries each path once when the project IS the home directory', () => {
    // The one collapse that does happen: `.claude/skills` is one directory under both names, so a
    // skill would otherwise be watched twice, under two spellings, and one change to it would land
    // in the digest twice.
    const dir = scratch();
    write(dir, '.claude/skills/bug-hunt/SKILL.md', '# bug hunt');

    const paths = displays(watchedPaths(dir, dir));
    expect(paths.filter((display) => display.endsWith('SKILL.md'))).toEqual([
      '.claude/skills/bug-hunt/SKILL.md',
    ]);
  });

  it('finds hook scripts directly under .claude/, by the extensions a hook may carry', () => {
    const dir = scratch();
    write(dir, '.claude/settings.json', '{}');
    write(dir, '.claude/ascend-hook.sh', '# hook');
    write(dir, '.claude/bd-prime-hook.mjs', '// hook');
    write(dir, '.claude/notes.md', 'not a hook');
    write(dir, '.claude/nested/deep.sh', '# not a direct child');

    const paths = displays(watchedPaths(dir, dir));
    expect(paths).toContain('.claude/ascend-hook.sh');
    expect(paths).toContain('.claude/bd-prime-hook.mjs');
    expect(paths).not.toContain('.claude/notes.md');
    expect(paths).not.toContain('.claude/nested/deep.sh');
  });

  it('finds the installed skills as files rather than as a digest of their names', () => {
    // As files, so that adding a skill is a path that APPEARED and removing one is a path that
    // VANISHED, each with a hash beside it. A single hash over the list would say only that the list
    // moved, which is the weaker half of the same fact.
    const dir = scratch();
    write(dir, '.claude/skills/bug-hunt/SKILL.md', '# bug hunt');
    write(dir, '.claude/skills/bug-hunt/reference.md', 'not watched');

    const paths = displays(watchedPaths(dir, dir));
    expect(paths).toContain('.claude/skills/bug-hunt/SKILL.md');
    expect(paths).not.toContain('.claude/skills/bug-hunt/reference.md');
  });

  it('is sorted and carries each path once, whatever the directory listing returns', () => {
    const dir = scratch();
    for (const name of ['z.sh', 'a.sh', 'm.mjs']) write(dir, `.claude/${name}`, '#');

    const paths = displays(watchedPaths(dir, dir));
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('watches nothing under the project that is not one of the four named classes', () => {
    // The negative half of the policy, asserted rather than described: a source file is not an
    // instruction, and a watch list that swept the repository would put a row in the ledger every
    // time anybody saved a test.
    const dir = scratch();
    write(dir, 'src/index.ts', 'export {};');
    write(dir, '.claude/agents/x.md', 'agent');

    expect(displays(watchedPaths(dir, dir))).not.toContain('src/index.ts');
    expect(displays(watchedPaths(dir, dir))).not.toContain('.claude/agents/x.md');
  });
});

describe('watchIdentity: what makes two baselines comparable', () => {
  it('is independent of the order the paths were discovered in', () => {
    const dir = scratch();
    const paths = watchedPaths(dir, dir);
    expect(watchIdentity(paths)).toBe(watchIdentity([...paths].reverse()));
  });

  it('changes when one path joins the watched set', () => {
    // The reason an identity exists at all. Without it, adding one path to the set -- which this
    // policy will do, it is a first version -- makes every already-watched file look newly appeared,
    // and the first session after the change writes the all-changed row the mechanism forbids.
    const dir = scratch();
    const before = watchIdentity(watchedPaths(dir, dir));
    write(dir, '.claude/new-hook.sh', '#');
    expect(watchIdentity(watchedPaths(dir, dir))).not.toBe(before);
  });

  it('does not change when the CONTENT of a watched file changes', () => {
    const dir = scratch();
    write(dir, 'CLAUDE.md', 'one');
    const before = watchIdentity(watchedPaths(dir, dir));
    write(dir, 'CLAUDE.md', 'two');
    expect(watchIdentity(watchedPaths(dir, dir))).toBe(before);
  });
});

describe('hashWatched: what is there, what is not, and what cannot be read', () => {
  it('hashes whole bytes, so a file restored byte-for-byte hashes the same', () => {
    const dir = scratch();
    write(dir, 'CLAUDE.md', 'a\n');
    const paths = watchedPaths(dir, dir);
    const first = hashWatched(paths);
    write(dir, 'CLAUDE.md', 'b\n');
    write(dir, 'CLAUDE.md', 'a\n');

    expect(first.kind).toBe('ok');
    expect(hashWatched(paths)).toEqual(first);
  });

  it('omits a file that is not there rather than hashing a sentinel for it', () => {
    // Absence from the map is how "does not exist" is spelled. That keeps a deleted file's
    // disappearance a diff the caller can see, rather than a hash nobody computed standing in for
    // one that no longer exists.
    const dir = scratch();
    write(dir, 'CLAUDE.md', 'x');
    const observation = hashWatched(watchedPaths(dir, dir));

    expect(observation.kind).toBe('ok');
    if (observation.kind !== 'ok') return;
    expect(Object.keys(observation.files)).toEqual(['CLAUDE.md']);
  });

  it('hashes nothing at all for a project with none of the watched files', () => {
    const dir = scratch();
    expect(hashWatched(watchedPaths(dir, dir))).toEqual({ kind: 'ok', files: {} });
  });

  it('reports a directory where a watched file should be as incomplete, naming it', () => {
    // The third state, and the one that must not be rounded to either neighbour. Hashing it as
    // "gone" would write a false row claiming the file was deleted; guessing a hash for it would
    // invent one. A directory does not depend on permission bits, which a test running as root
    // could not set anyway.
    const dir = scratch();
    mkdirSync(at(dir, '.claude/settings.json'), { recursive: true });

    const observation = hashWatched(watchedPaths(dir, dir));
    expect(observation.kind).toBe('incomplete');
    if (observation.kind !== 'incomplete') return;
    expect(observation.path).toBe('.claude/settings.json');
    expect(observation.detail).not.toBe('');
  });

  it('reports a symlink pointing nowhere as incomplete, and a missing file as absent', () => {
    // Both are "there is no content at this path", and they are different facts: the dangling link
    // IS there -- `lstatSync` sees it -- so the honest answer is that this observation cannot say
    // what it holds, where a plain missing file is an ordinary absence the diff can act on.
    const dir = scratch();
    write(dir, 'CLAUDE.md', 'x');
    symlinkSync(at(dir, 'gone.md'), at(dir, 'MEMORY.md'));

    const observation = hashWatched(watchedPaths(dir, dir));
    expect(observation.kind).toBe('incomplete');
    if (observation.kind !== 'incomplete') return;
    expect(observation.path).toBe('MEMORY.md');
  });
});

describe('watchedChanges: a symmetric diff, and only over what moved', () => {
  const HASH_A = '0'.repeat(64);
  const HASH_B = '1'.repeat(64);
  const HASH_C = '2'.repeat(64);

  it('reports a changed file with both hashes', () => {
    expect(watchedChanges({ 'a.md': HASH_A }, { 'a.md': HASH_B })).toEqual([
      { path: 'a.md', before_sha256: HASH_A, after_sha256: HASH_B },
    ]);
  });

  it('reports a file that appeared with only the hash it now has', () => {
    expect(watchedChanges({}, { 'a.md': HASH_B })).toEqual([
      { path: 'a.md', after_sha256: HASH_B },
    ]);
  });

  it('reports a file that vanished with only the hash it had', () => {
    // The half an asymmetric diff forgets, and the half a session feels: a `CLAUDE.md` that was
    // deleted changes every session after it exactly as much as one that was edited.
    expect(watchedChanges({ 'a.md': HASH_A }, {})).toEqual([
      { path: 'a.md', before_sha256: HASH_A },
    ]);
  });

  it('reports nothing when the two observations agree, including when both are empty', () => {
    expect(watchedChanges({ 'a.md': HASH_A }, { 'a.md': HASH_A })).toEqual([]);
    expect(watchedChanges({}, {})).toEqual([]);
  });

  it('returns the changes in display-path order, whatever order the maps hold', () => {
    const before = { 'z.md': HASH_A, 'a.md': HASH_A };
    const after = { 'z.md': HASH_C, 'a.md': HASH_B };
    expect(watchedChanges(before, after).map((change) => change.path)).toEqual(['a.md', 'z.md']);
  });

  it('reports every file that moved and no file that did not', () => {
    const before = { 'a.md': HASH_A, 'b.md': HASH_A, 'c.md': HASH_A };
    const after = { 'a.md': HASH_A, 'b.md': HASH_B, 'd.md': HASH_C };

    expect(watchedChanges(before, after)).toEqual([
      { path: 'b.md', before_sha256: HASH_A, after_sha256: HASH_B },
      { path: 'c.md', before_sha256: HASH_A },
      { path: 'd.md', after_sha256: HASH_C },
    ]);
  });
});
