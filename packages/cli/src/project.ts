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

import { statSync } from 'node:fs';
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

export interface ProjectOptions {
  /** How long a writer waits for a lock. Defaults to the store's own default. */
  readonly busyTimeoutMs?: number;
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
  });

  return { root, store };
}
