/**
 * The git half of `asc store verify` -- read record files out of a ref or the index, and read the
 * refs a candidate must not lose records against.
 *
 * **This is the first place ascend runs the `git` binary, and the dependency is deliberate.** The
 * store is git-native but no code ever invoked git: `project.ts` finds the root by testing for a
 * `.git`, and every other read goes through the filesystem. The lost-id half of this guard cannot be
 * built that way, because the records a naive merge resolution drops exist only in the OTHER
 * commit's tree, which is a git object. So the guard reads git, read-only -- `rev-parse`, `ls-tree`,
 * `ls-files`, `cat-file`, `rev-list` -- and never writes: every call here produces a value or throws,
 * and nothing under this module stages, commits, or touches a ref.
 *
 * **The cost is bounded by the store's own rollover, not by its record count.** One `cat-file` runs
 * per record FILE, and `MAX_RECORDS_PER_FILE` is 5,000 (`jsonl-files.ts`), so a store of 10,000
 * records is two files per type -- a handful of subprocesses, not ten thousand. A `cat-file --batch`
 * would be faster if that ever stops being true; it is not worth the protocol handling today, and
 * saying so is cheaper than building it.
 *
 * **A missing `MERGE_HEAD` is a normal answer, not an error.** `git rev-parse --verify` exits 1 when
 * a ref is absent, so that one case is caught and turned into `undefined` rather than being allowed
 * to abort a non-merge commit.
 */

import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

/** A git command failed for a reason other than "the ref is absent". */
export class GitError extends Error {}

/**
 * Every git call captures stderr rather than inheriting it.
 *
 * **Measured, not defensive.** `execFileSync` writes the child's stderr to the PARENT's stderr by
 * default, so the ordinary case here -- `git rev-parse --verify MERGE_HEAD` finding no merge in
 * progress -- printed a bare `fatal: Needed a single revision` before a perfectly clean run. A
 * `fatal:` on a successful command is a false alarm in every CI log that greps for one, and it is
 * the reader's first impression of a guard whose whole job is to be trusted. Capturing stderr also
 * lets the caught error carry the real message into `GitError` instead of duplicating it.
 */
const GIT_STDIO: readonly ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

function git(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: [...GIT_STDIO],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const detail = typeof stderr === 'string' ? stderr : (stderr?.toString() ?? String(error));
    throw new GitError(`git ${args.join(' ')} failed: ${detail.trim()}`);
  }
}

/** The repository's root, or `undefined` when `cwd` is not in a working tree. */
export function gitRoot(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: [...GIT_STDIO],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The path the store's records live at, relative to the repository root, with `/` separators. */
export function storePathspec(repositoryRoot: string, storeAbsolute: string): string {
  return relative(repositoryRoot, storeAbsolute).split('\\').join('/');
}

/** Resolve a ref to its object name, or throw a `GitError` naming the ref. */
export function resolveRef(repositoryRoot: string, ref: string): string {
  return git(['rev-parse', '--verify', `${ref}^{commit}`], repositoryRoot).trim();
}

/** A commit's parents. Empty for a root commit. */
export function parentsOf(repositoryRoot: string, ref: string): readonly string[] {
  const line = git(['rev-list', '--parents', '-n', '1', ref], repositoryRoot).trim();
  return line.split(/\s+/).slice(1);
}

/**
 * The commit being merged into the current one, if a merge is in progress.
 *
 * `MERGE_HEAD` exists exactly while a conflicted merge is unresolved and being committed, which is
 * the moment this guard cares about -- so its absence is the ordinary case, not a failure.
 */
export function mergeHead(repositoryRoot: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: [...GIT_STDIO],
    }).trim();
  } catch {
    return undefined;
  }
}

function jsonlUnder(repositoryRoot: string, ref: string, pathspec: string): readonly string[] {
  const listing = git(
    ['ls-tree', '-r', '--name-only', `${ref}:`, '--', `${pathspec}/`],
    repositoryRoot,
  );
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.jsonl'));
}

/** Every `.jsonl` record file under the store at `ref`, as `path -> text`. */
export function recordFilesAt(
  repositoryRoot: string,
  ref: string,
  pathspec: string,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of jsonlUnder(repositoryRoot, ref, pathspec)) {
    // `git show <ref>:<path>` resolves the tree entry and prints the blob, which avoids a second
    // call to turn a path into an object name.
    files.set(path, git(['show', `${ref}:${path}`], repositoryRoot));
  }
  return files;
}

/** Every `.jsonl` record file in the index (stage 0), as `path -> text`. */
export function stagedRecordFiles(repositoryRoot: string, pathspec: string): Map<string, string> {
  const files = new Map<string, string>();
  // `-z` keeps paths verbatim; a record path never holds a newline, but the flag costs nothing and
  // removes the quoting question rather than answering it.
  const listing = git(['ls-files', '-s', '-z', '--', `${pathspec}/`], repositoryRoot);
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    // "<mode> <sha> <stage>\t<path>"
    const [meta, path] = entry.split('\t');
    if (path === undefined || !path.endsWith('.jsonl')) continue;
    const [, sha, stage] = (meta ?? '').split(' ');
    // Stage 0 is the merged result. Stages 1-3 are the three sides of an unresolved conflict, and a
    // commit cannot proceed with those in the index -- so they are skipped rather than read as if
    // they were the candidate.
    if (stage !== '0' || sha === undefined) continue;
    files.set(path, git(['cat-file', 'blob', sha], repositoryRoot));
  }
  return files;
}
