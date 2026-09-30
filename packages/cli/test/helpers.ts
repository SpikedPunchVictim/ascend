/**
 * Shared helpers for the CLI suites.
 *
 * Not collected as a suite: `.test.ts` is what vitest includes, so this file is imported rather than
 * run. It lives here rather than in `src/` because nothing the product ships needs it.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, INDEX_FILE, STORE_DIR } from '@ascend/store';

/**
 * One built store, for suites whose fixtures do not care when.
 *
 * Fixed rather than `new Date()`, so a re-run rebuilds byte-identical indexes and a diff of two
 * runs is a diff of what changed.
 */
const AT = '2026-09-29T00:00:00.000Z';

/**
 * Give `dir` a store with nothing registered: an empty `.ascend/` tree and the index for it.
 *
 * **The index is not decoration, and that is the whole reason this helper exists.** A read opens
 * `index.db` and refuses when it does not describe the tree beside it, and a read never builds one
 * (`asc-i5tj.3.1`). So a fixture that only created `.ascend/` used to be a project every read
 * worked in -- the store file *was* the thing being read, and opening a missing one created it --
 * and is now a project every read fails in. Four suites had that fixture; this is the one
 * definition they share, rather than four copies of the two calls each needs.
 *
 * **An empty tree is a legitimate store and is not what `asc init` leaves behind.** `init` installs
 * the four `STARTER_TYPES` through a fused write, so a project it set up has types in it; several
 * suites below assert on an empty registry, and building that state directly is the honest way to
 * get it. `buildIndex` over a tree with no record files yields a current index for the empty
 * fingerprint, which is exactly the store whose `asc types list` has no rows.
 */
export function emptyStore(dir: string): string {
  const tree = join(dir, STORE_DIR);
  mkdirSync(tree, { recursive: true });
  buildIndex(tree, join(tree, INDEX_FILE), { now: AT });
  return dir;
}

/**
 * stderr as one line, with ascend's own wrapping undone.
 *
 * **ascend wraps a failure or a warning at 80 columns** (`errors.ts`, `renderForStderr`), at spaces
 * only. A phrase in a message can therefore still land either side of a line break, so
 * `toContain('asc install-hook')` fails against the raw text on a phrase that is plainly there.
 * Collapsing the runs of whitespace is what makes a substring assertion mean what it reads like.
 *
 * **Nothing strips a `›` any more, and this function is the check that none is needed.** Until
 * asc-98c, oclif rendered every error and every warning, wrapping with `wrapAnsi(..., { hard: true })`
 * and prefixing each continuation line with ` ›   ` -- and breaking mid-token, so a path arrived as
 * `.../asc-ingest-IgAq9O › /.claude/projects` and could neither be read nor pasted. ascend now
 * renders its own, so there is no marker to strip; if one comes back, the assertions that go
 * through here fail, which is the only way they should learn about it.
 *
 * One copy, shared by `init.test.ts` and `install-hook.test.ts`. It was two, and the second was
 * written without the measurement the first records -- so it collapsed whitespace alone and failed
 * on the wrapped command it was written to read, which is exactly the rediscovery this file exists
 * to stop.
 */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
