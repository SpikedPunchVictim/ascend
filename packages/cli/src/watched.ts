/**
 * The watched set: which files a session is shaped by, what they hash to, and what moved since the
 * last look (asc-09wx.8.2).
 *
 * **Why this exists at all.** `EV-16` measured 0 of 15 sessions running `asc record` in any form, so
 * a ledger that depends on somebody choosing to write down a change depends on a mechanism measured
 * not to fire. Hand recording is the thing this replaces; the row it writes is the *unexplained*
 * one -- a date, a digest, and no `reason` -- which is a worse row than a person would write and an
 * infinitely better one than nothing.
 *
 * **The set is a POLICY, and its first version is deliberately small.** Per `asc-09wx.8`'s D4: the
 * Claude Code settings a project carries, the instruction files a session loads at both levels, the
 * hook scripts under `.claude/`, and the installed skill list. What is NOT here is anything inside a
 * repository's own source -- a `CLAUDE.md` is an instruction and a `src/foo.ts` is not.
 *
 * **And the second source does not add it back.** `asc ingest file-changed` (`asc-09wx.8.6`) matches
 * each `file.changed` event against THIS SET and counts the rest as outside it, so a `src/foo.ts`
 * edit is a row from neither mechanism. What that source buys is a DATE, not a wider scope: it dates
 * a change to the tool call that made it where this one can only date it to the next session start,
 * and it can see an edit made and reverted inside a single session where a start-to-start diff
 * cannot. The two sets are deliberately one set; a second definition of "watched" would be the
 * second place this policy could drift.
 *
 * **The set is also why a baseline needs an identity.** Every path here is a policy choice that will
 * change, and a diff taken across a change of policy reads every newly-watched file as newly
 * appeared. `watchIdentity` is the sha256 of the list, the state file carries it, and a mismatch is
 * a first run -- see `watched-hashes.ts`, and `asc-09wx.8.2`'s own "a missed row is recoverable; a
 * spurious row is not".
 *
 * **Paths are spelled for a reader, not for `open(2)`.** A file under the project is relative to it
 * (`CLAUDE.md`, `.claude/settings.json`) and a file under the home directory is `~`-prefixed, so the
 * digest an entry carries names something a reader can find without a machine's home directory in
 * it -- the tree is git-tracked and shared, and `ingest-cursor.ts` had to be moved out of it for
 * exactly this reason. The absolute path is kept beside the display one so the two cannot drift.
 *
 * **Unreadable is not the same as absent, and the difference is a row.** A watched path that is not
 * there is an ordinary state -- most projects have no `MEMORY.md` -- and when one disappears it is a
 * real change. A path that IS there and cannot be read is neither: hashing it as "gone" would write
 * a false row, and guessing a hash for it would invent one. So it stops the whole observation, and
 * `hashWatched` says which path it was.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Hex } from '@ascend/core';

/**
 * The extensions a hook script may carry, for the ones discovered under `.claude/`.
 *
 * `.mjs` is not padding: this project's own `.claude/bd-prime-hook.mjs` is the file that replaced
 * `bd prime --hook-json` on SessionStart, and a list that could not see it would miss the change
 * `EV-55` exists to grade.
 */
export const HOOK_SCRIPT_EXTENSIONS: readonly string[] = ['.sh', '.mjs', '.cjs', '.js'];

/** One watched file: how the digest spells it, and where it actually is. */
export interface WatchedPath {
  /** `CLAUDE.md` under the project, `~/.claude/CLAUDE.md` under the home directory. */
  readonly display: string;
  readonly absolute: string;
}

/** One file whose content differs between two observations, or which is only in one of them. */
export interface WatchedChange {
  readonly path: string;
  /** Absent when the file is new: there was no earlier content to hash. */
  readonly before_sha256?: string;
  /** Absent when the file is gone: there is no later content to hash. */
  readonly after_sha256?: string;
}

/**
 * What one look at the watched set found.
 *
 * `incomplete` is the third state and the one that must not be rounded to either neighbour: the
 * path is there and could not be read, so this observation cannot say what changed, and the caller
 * must write nothing and leave the baseline alone rather than diff against a map with a hole in it.
 */
export type WatchedObservation =
  | { readonly kind: 'ok'; readonly files: Readonly<Record<string, string>> }
  | { readonly kind: 'incomplete'; readonly path: string; readonly detail: string };

/**
 * The watched set for a project at `root` whose user's home directory is `home`.
 *
 * **Sorted by code unit, NOT by `localeCompare`.** Both the `digest` this feeds and the
 * `watchIdentity` hashed over it are shared: an entry is git-tracked and read on another machine.
 * `localeCompare` consults ICU, so the same set of paths would order differently under a different
 * `LANG` -- and `watchIdentity` compares by equality, so two developers with the same files would
 * re-baseline each other's store on every run. The order is an implementation detail of a hash and
 * must not depend on the host.
 *
 * **Duplicates are removed by resolved absolute path.** The one case that fires today is the skills
 * directory: with `home` equal to `root` -- this repository, and every CLI suite -- the project's
 * `.claude/skills` and the home's are one directory, so every skill would otherwise be watched twice
 * under two names.
 */
export function watchedPaths(root: string, home: string): readonly WatchedPath[] {
  const named = [
    join(root, 'CLAUDE.md'),
    join(root, 'MEMORY.md'),
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
    join(home, '.claude', 'CLAUDE.md'),
    join(home, '.claude', 'MEMORY.md'),
  ];

  const discovered = [
    ...scriptsIn(join(root, '.claude')),
    ...skillsIn(join(root, '.claude', 'skills')),
    ...skillsIn(join(home, '.claude', 'skills')),
  ];

  const byAbsolute = new Map<string, WatchedPath>();
  for (const absolute of [...named, ...discovered]) {
    const key = resolve(absolute);
    if (byAbsolute.has(key)) continue;
    byAbsolute.set(key, { display: displayPath(key, root, home), absolute: key });
  }

  return [...byAbsolute.values()].sort((left, right) =>
    left.display < right.display ? -1 : left.display > right.display ? 1 : 0,
  );
}

/**
 * The identity of a watched LIST -- its display paths, sorted.
 *
 * **Sorted here rather than trusted from the caller.** `watchedPaths` already returns a sorted list,
 * but the identity's whole job is to be equal for two runs that watched the same set, and an array
 * hash is order-sensitive -- so a caller that built its list a different way would re-baseline a
 * store on every run, silently, and the symptom would be a ledger that reports nothing forever.
 * `canonicalJson` sorts an object's keys and cannot sort an array's elements; this is that sort.
 *
 * Deliberately over the display paths and not the absolute ones: two clones of one repository
 * watched from different directories are watching the same files, and a baseline is per-store
 * anyway, so nothing is gained by making the identity a machine's own directory names.
 */
export function watchIdentity(paths: readonly WatchedPath[]): string {
  return sha256Hex(canonicalJson(paths.map((path) => path.display).sort()));
}

/**
 * The content hash of every watched file that is there, keyed by display path.
 *
 * Whole bytes, not text: a settings file is UTF-8, and the point of "the hashes are content, not
 * metadata" is that a byte-for-byte restore is not a change -- which is only true if nothing
 * decoded the bytes first.
 */
export function hashWatched(paths: readonly WatchedPath[]): WatchedObservation {
  const files: Record<string, string> = {};
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.absolute);
    } catch (error) {
      if (!isThere(path.absolute)) continue;
      return {
        kind: 'incomplete',
        path: path.display,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    files[path.display] = createHash('sha256').update(bytes).digest('hex');
  }
  return { kind: 'ok', files };
}

/**
 * What changed between two observations, in display-path order.
 *
 * Symmetric on purpose. A file that appeared and a file that vanished are both changes to what a
 * session loads, and the second is the one an asymmetric diff forgets: a `CLAUDE.md` that was
 * deleted changes every session after it exactly as much as one that was edited.
 *
 * A path whose hash is the same in both is not here at all -- "a file restored byte-for-byte was not
 * changed, and produces no row", which is what `intervention.digest` promises a reader.
 */
export function watchedChanges(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): readonly WatchedChange[] {
  const changes: WatchedChange[] = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = before[path];
    const is = after[path];
    if (was === is) continue;
    changes.push({
      path,
      ...(was === undefined ? {} : { before_sha256: was }),
      ...(is === undefined ? {} : { after_sha256: is }),
    });
  }
  return changes;
}

/**
 * Every regular file directly in `dir` whose name ends in one of `HOOK_SCRIPT_EXTENSIONS`.
 *
 * Direct children only, and a directory that is not there is an empty list: `.claude/` is optional,
 * and a recursive walk would sweep in `.claude/skills/`, which has its own entry in the set and
 * would then be watched twice under two names.
 */
function scriptsIn(dir: string): readonly string[] {
  return entriesIn(dir)
    .filter((name) => HOOK_SCRIPT_EXTENSIONS.some((extension) => name.endsWith(extension)))
    .map((name) => join(dir, name));
}

/**
 * Every `SKILL.md` one level under a skills directory -- "the installed skill list", as files.
 *
 * As files rather than as a digest of the names, so that adding a skill is a path that APPEARED and
 * removing one is a path that VANISHED, each with a hash beside it. A single hash over the list
 * would say only that the list moved, which is the weaker half of the same fact.
 */
function skillsIn(dir: string): readonly string[] {
  return entriesIn(dir).map((name) => join(dir, name, 'SKILL.md'));
}

/** The names directly in `dir`, or none when it does not exist or cannot be listed. */
function entriesIn(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Whether `path` is there at all, whatever kind of thing it is. */
function isThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * How `absolute` is spelled in a digest: relative to the project, `~`-prefixed under the home
 * directory, and absolute otherwise.
 *
 * The order matters and is the project first: a project checked out under the home directory is the
 * ordinary case (this one is), and `CLAUDE.md` is a more useful name for it than
 * `~/projects/ascend/CLAUDE.md` would be.
 *
 * The fallback is not dead code even though every path this module currently builds is under one of
 * the two: it is what keeps a future addition to the set from silently writing a machine's absolute
 * path into a shared, tracked entry.
 */
function displayPath(absolute: string, root: string, home: string): string {
  const fromRoot = under(absolute, root);
  if (fromRoot !== undefined) return fromRoot;
  const fromHome = under(absolute, home);
  if (fromHome !== undefined) return `~/${fromHome}`;
  return absolute;
}

/** `path`'s path relative to `base`, `/`-separated, or `undefined` when it is not under `base`. */
function under(path: string, base: string): string | undefined {
  const rel = relative(resolve(base), path);
  if (rel.startsWith('..') || rel === '') return undefined;
  return rel.split(sep).join('/');
}
