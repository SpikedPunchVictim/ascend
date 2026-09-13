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
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openStore, STORE_DIR, type Store } from '@ascend/store';

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

export interface Project {
  /** The directory holding the store, not necessarily the working directory. */
  readonly root: string;
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

export interface ProjectOptions {
  /** How long a writer waits for a lock. Defaults to the store's own default. */
  readonly busyTimeoutMs?: number;
  /**
   * Open the store with a handle that cannot write. See `OpenOptions.readOnly`.
   *
   * Threaded through rather than decided here, because whether a command may write is a property
   * of the COMMAND and not of project discovery -- `project.ts` finds a directory, and a module
   * whose job is finding a directory is the wrong place to hold an opinion about mutation.
   */
  readonly readOnly?: boolean;
}

/**
 * Open the store for the project containing `startDir`.
 *
 * Timeout is threaded rather than read from the environment: `cli-best-practices` rule 5
 * resolves configuration once, at the entry point, and a store-reading helper that
 * consulted `process.env` on its own would be a second place config is decided.
 */
export function openProject(
  startDir: string,
  ascendVersion: string,
  options: ProjectOptions = {},
): Project {
  const root = findProjectRoot(startDir);
  if (root === undefined) throw new NoProjectError(resolve(startDir));

  const store = openStore({
    dir: join(root, STORE_DIR),
    ascendVersion,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });

  return { root, store };
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
 * The stand-in is an in-memory store, and it is opened read-only like any other: measured,
 * `new DatabaseSync(':memory:', { readOnly: true })` still refuses writes
 * (`attempt to write a readonly database`). That matters more than it looks, because the fallback
 * connection is the one that will `ATTACH` the projects a glob matched -- so a writable fallback
 * would have been a way to mutate every matched project from outside any of them, which is exactly
 * the guarantee `Bash(asc query:*)` as an allowlist entry depends on.
 *
 * `root: undefined` is the caller's signal that `main` is empty rather than a project, and the
 * command reports that on stderr rather than letting an unqualified `entries` fail with
 * `no such table`.
 */
export function openQueryProject(startDir: string, ascendVersion: string): QueryProject {
  const root = findProjectRoot(startDir);
  if (root !== undefined) {
    return {
      root,
      store: openStore({ dir: join(root, STORE_DIR), ascendVersion, readOnly: true }),
    };
  }

  return { root: undefined, store: openStore({ dir: ':memory:', ascendVersion, readOnly: true }) };
}
