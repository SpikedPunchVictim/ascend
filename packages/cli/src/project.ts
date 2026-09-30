/**
 * Which project am I in, and where is its store?
 *
 * Every command except `asc init` needs a store, and every one of them needs the same
 * answer to "which store". This module is that answer, once, so no command re-derives it.
 *
 * **The root is found by walking up**, like git finds `.git`. The alternative -- "the
 * store is in the current directory" -- is wrong the first time anything `cd`s into a
 * subdirectory, which for this product is immediately: an agent working in
 * `packages/store/src` and recording a `stuck-event` is the normal case, not the edge
 * one. `asc query --across` already implies that the working directory is not the frame
 * of reference, so cwd-only would have been the odd choice.
 *
 * The walk stops at the filesystem root, and it does NOT stop at the git root: a store
 * above a repository is unusual but not wrong, and inventing a second boundary rule
 * would mean two different answers to "where is the store" depending on which rule
 * fired first. `asc doctor` should report the root it resolved, so the answer is always
 * visible rather than inferred from silence.
 *
 * **What a project's `store` is changed with E12.4c, and this module is where the change is
 * spelled.** `.ascend/` used to hold `ascend.db` -- the source of truth -- and discovery and
 * opening were one step. Now it holds a JSONL tree, which IS the store, beside an `index.db`
 * that is derived from it and can be deleted at any moment. So the two steps are separated
 * here:
 *
 *   - **Discovery finds the ROOT**, and says nothing about whether a readable index is there.
 *     `findProjectRoot` needs the directory; the tree inside it is the store, and a fresh clone
 *     has one with no index beside it.
 *   - **Opening goes through `openIndex`**, which is the currency check as well as the open. A
 *     handle from here is READ-ONLY and refuses when the index does not describe the tree it was
 *     built from (`IndexStaleError`, naming `asc index build`). That refusal is the point rather
 *     than a cost: before the flip, a read opened the source of truth and was therefore always
 *     current by construction. There is no such thing as a current-but-cheap open of a derived
 *     file, so a read is either current or refused, and it never builds one (`asc-i5tj.3.1`).
 *
 * **Writing is not reachable from here.** `writeProducedLines` takes a root and a path and does
 * its own locked open, so a command that writes calls `withProjectRoot` (`base.ts`) and hands the
 * root to the store. That is what keeps the read handle read-only as a property of the API rather
 * than a convention: there is no writable handle for a read path to have been handed.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { INDEX_FILE, openIndex, openStore, STORE_DIR, type Store } from '@ascend/store';

/**
 * Thrown when no `.ascend/` store is reachable.
 *
 * Names the directory it started from, because "no store found" without saying where it
 * looked is the error a user cannot act on.
 */
export class NoProjectError extends Error {
  constructor(readonly startDir: string) {
    super(
      `No ${STORE_DIR}/ store found in ${startDir} or any parent directory. ` +
        `Run 'asc init' to create one here.`,
    );
    this.name = 'NoProjectError';
  }
}

/**
 * Is this path a directory? Used only to recognise a store, so a plain file named
 * `.ascend` is not mistaken for one -- `openStore` would then fail deeper down with a
 * less legible error than the walk can produce.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // ENOENT for the common case (nothing named `.ascend` here), EACCES for a directory
    // we cannot stat. Both mean "not a store I can use", and the walk should continue
    // rather than abort: the store it is looking for may be one level up.
    return false;
  }
}

/**
 * The nearest ancestor of `startDir` (inclusive) that holds a `.ascend/` directory.
 *
 * Returns `undefined` rather than throwing, because "not in a project" is an ordinary
 * answer that each command phrases differently -- `asc init` acts on it, everything else
 * refuses.
 */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);

  for (;;) {
    if (isDirectory(join(dir, STORE_DIR))) return dir;

    const parent = dirname(dir);
    // `dirname('/') === '/'` is the terminating case: the walk has reached the root of
    // the filesystem and there is nowhere further up to look.
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The root of the project containing `startDir`, or `NoProjectError`.
 *
 * The throwing half of `findProjectRoot`, split out because the two callers want different things
 * from the same walk and the difference is not cosmetic: `openProject` needs a store and cannot
 * proceed without one, while `withProjectRoot` needs nothing but the path and would otherwise have
 * to open an index -- and be refused for a stale one -- to learn a directory it does not read.
 * `asc index build` is the caller that makes this concrete: it is the remedy for a stale index, so
 * a version of it that opened the index first would refuse the very command whose job is to fix
 * that (`finding 4`).
 */
export function requireProjectRoot(startDir: string): string {
  const root = findProjectRoot(startDir);
  if (root === undefined) throw new NoProjectError(resolve(startDir));
  return root;
}

/**
 * Where a project's tree and its derived index live, given the project root.
 *
 * **The tree is INSIDE `.ascend/`, and the two paths are computed here so that is spelled once.**
 * The store's own API takes the tree directory -- `readRecordTree(root)` looks for `root/types`,
 * `root/entries` and so on -- while a command is handed the PROJECT root, and the difference is one
 * `join(root, STORE_DIR)` that has to be made at every call. Made by hand at each site, it was made
 * wrong: the write path was handed the project root, so `treeFingerprint` hashed `<project>/types`
 * (which does not exist) and the fingerprint of every store was the hash of nothing at all. That is
 * a store that certifies any index as current.
 *
 * Returning the pair rather than the directory alone, because no caller wants the tree without the
 * index and two callers deriving the index from the tree is how the two drift.
 */
export function storePaths(root: string): { readonly tree: string; readonly index: string } {
  const tree = join(root, STORE_DIR);
  return { tree, index: join(tree, INDEX_FILE) };
}

export interface Project {
  /** The directory holding the store, not necessarily the working directory. */
  readonly root: string;
  /**
   * The project's index, READ-ONLY, current for the tree at `root` or a refusal.
   *
   * Named `store` rather than `index` because it is what a command reads the store through, and
   * every read command was written against that name. What it is not is the store: the JSONL tree
   * under `root` is, and this is a derived file that may be deleted and rebuilt at any moment.
   */
  readonly store: Store;
}

/**
 * The nearest ancestor of `startDir` (inclusive) that is a git working tree, if there is one.
 *
 * **The walk goes to the filesystem root and stops there**, which is what git itself does. The
 * defect this replaces asked a narrower question -- "is there a `.git` right here?" -- and so
 * answered "no repository" for every subdirectory of one, which is exactly where a monorepo package
 * is. Measured (`/tmp/probe-b6.mjs`): `asc init` in `packages/api` of a repository reported
 * `skipped: no .gitignore here and no git repository to apply one to`, wrote nothing, and left
 * `packages/api/.ascend/ascend.db` untracked -- one `git add -A` from being committed. The same
 * message is produced outside any repository at all, so the two cases were indistinguishable to the
 * command; that is the defect, and it is the detection rather than the write target, which was
 * already the store's own directory.
 *
 * `.git` is tested with `existsSync`, not `isDirectory`, because in a linked worktree or a
 * submodule it is a FILE holding `gitdir: ...` rather than a directory.
 *
 * **Deliberately not stopping at `$HOME`.** Git does not, and the case where it would matter -- a
 * store under `~/projects/x` in a tree whose `$HOME` is a dotfiles repository -- is one where the
 * ignore is genuinely needed. A ceiling at the home directory would silently skip it.
 */
export function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);

  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;

    // Same terminating case as `findProjectRoot` above: `dirname('/') === '/'`.
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A project for a read-only command, where there may not be one.
 *
 * A separate type from `Project` rather than `root?: string` on it, so that every command which
 * *does* need a project root keeps being handed a plain `string` and never has to consider the
 * case. Widening `Project` would make that case reachable in code that cannot act on it, which is
 * how a `?? process.cwd()` gets written somewhere it does not belong.
 */
export interface QueryProject {
  /** The project root, or `undefined` when there is no store here and none above. */
  readonly root: string | undefined;
  readonly store: Store;
}

/**
 * Open the index for the project containing `startDir`.
 *
 * **Read-only, and that is no longer a matter of what the caller asked for.** The handle
 * `openIndex` returns cannot be written through, which is what makes the epic's invariant -- *no
 * write may land in the index that is not first in the JSONL* -- structural on every read path at
 * once rather than a rule each command is trusted to keep. A command that writes does not come
 * here: it calls `withProjectRoot` and hands the root to `writeProducedLines`, which takes its own
 * locked writable handle for the duration of one production.
 *
 * **A stale index refuses, and a read never builds one.** `openIndex` throws `IndexStaleError`
 * naming `asc index build`; the alternative -- rebuilding here -- is a ~75 s cost a caller cannot
 * see coming (`EV-33`), and it was removed on purpose (`asc-i5tj.3.1`).
 *
 * **There is no `ascendVersion` parameter, and its absence is the flip made visible.** It used to
 * be stamped into the store by every open; a read that opens read-only writes no version row, and
 * an index is derived rather than labelled. The version a command needs is the one it stamps on
 * the records it writes, and those commands hold it themselves.
 */
export function openProject(startDir: string): Project {
  const root = requireProjectRoot(startDir);
  const { tree, index } = storePaths(root);
  return { root, store: openIndex(tree, index) };
}

/**
 * The project a read-only command runs against: the one containing `startDir`, or an empty store.
 *
 * **A local project is optional here, and only here.** Every other command refuses when it cannot
 * find a store (`NoProjectError`), because a command that records or defines something has to have
 * somewhere to put it. `asc query` does not: its input is a SQL string and, with `--across`, its
 * scope is the projects the caller named. Requiring a local project anyway would mean a corpus-wide
 * query could only be run from inside one of the projects it is querying -- which is the case
 * `--across` exists to cover, since the analysis is a corpus-wide question and the working
 * directory is an accident of where the shell is.
 *
 * **The fallback stays an in-memory store, and it is a fallback rather than a second kind of
 * project.** There is no tree to read when there is no `.ascend/`, so there is nothing an index
 * could be built from and `openIndex` has no meaning here; what the caller gets is a connection to
 * attach other projects to, and `root: undefined` is its signal that `main` is empty rather than a
 * project. It is opened read-only like any other: measured,
 * `new DatabaseSync(':memory:', { readOnly: true })` still refuses writes
 * (`attempt to write a readonly database`). That matters more than it looks, because the fallback
 * connection is the one that will `ATTACH` the projects a glob matched -- so a writable fallback
 * would have been a way to mutate every matched project from outside any of them, which is exactly
 * the guarantee `Bash(asc query:*)` as an allowlist entry depends on.
 *
 * **A project whose index is stale refuses here too**, rather than falling back to the empty store:
 * a corpus-wide query silently missing the local project's records would be the false-green class
 * this epic treats as severity-zero, and "there is no project" is not what is wrong. The remedy is
 * the same one `openIndex` names.
 */
export function openQueryProject(startDir: string): QueryProject {
  const root = findProjectRoot(startDir);
  if (root !== undefined) {
    const { tree, index } = storePaths(root);
    return { root, store: openIndex(tree, index) };
  }

  return { root: undefined, store: openStore({ dir: ':memory:', readOnly: true }) };
}
