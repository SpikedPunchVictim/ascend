/**
 * Following a symlink to the file it really names, for commands that edit a file outside the store.
 *
 * Two commands need this and they need it for the same reason: `asc init` appends to `.gitignore`
 * and `asc install-hook` appends to `.claude/settings.json`, and both write with a temp-file-then-
 * rename. **Renaming onto a link's own path replaces the LINK with a regular file**, so a repository
 * that deliberately shares one settings or ignore file with others silently stops sharing it, with
 * no message and no way back -- the target path is not recoverable from the file afterwards.
 *
 * Extracted rather than written twice. The rule has one owner per the project's own convention
 * (`base.ts:ascendVersion` records the same move for the same reason), and the two callers are the
 * two commands that write outside the store, so there is no third case waiting to be missed.
 *
 * Measured (`/tmp/probe-b7.mjs`, asc-bcv.11) on the `.gitignore` case: the link went
 * `isSymbolicLink` true -> false, its content survived, and a second repository linked at the same
 * target no longer saw the change. Resolving the path ONCE and using the resolved path for BOTH the
 * read and the write is the fix; the read already followed the link, which is why only the write
 * was wrong.
 */

import { lstatSync, realpathSync } from 'node:fs';

/**
 * Where a symlink actually lives, if the path is a symlink at all.
 *
 * Three answers, and the third is the reason this is not a boolean:
 *
 *   - `undefined` -- not a link (or nothing at that path), so the requested path is the real one
 *   - a path      -- a link, resolved. `realpathSync` and not `readlinkSync`, because a link's
 *                    target may be relative and may itself be a link; resolving once here means the
 *                    read and the write cannot disagree about which file they mean
 *   - `null`      -- a link pointing at nothing
 *
 * **`lstatSync`, not `existsSync`**, and that is the point of the third answer: `existsSync` follows
 * a link, so a DANGLING symlink answers "no file here" and the create branch would replace the link
 * with a regular file -- the same defect as the healthy-link case, reached through the branch that
 * looks like it is creating something new.
 */
export function symlinkTarget(path: string): string | null | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
  } catch {
    // Nothing at `path` at all. Not an error: this is the ordinary "no file here" case.
    return undefined;
  }

  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Quote a value for `/bin/sh`, exactly.
 *
 * The hook command written by `asc install-hook` carries three absolute paths -- the binary, the
 * store and the interpreter -- and an absolute path on macOS routinely contains a space
 * (`/Users/first last/...`). Unquoted, that command would silently split into two arguments and the
 * hook would run something else or nothing at all.
 *
 * Single quotes, because they suppress every expansion: under double quotes a path containing `$`
 * or a backtick would be expanded by the shell into something the user never wrote. The one
 * character single quotes cannot contain is the single quote itself, and this closes it with the
 * standard `'\''` sequence -- close, escaped quote, reopen. That makes the construction TOTAL: every
 * byte of the input survives as itself, so there is no input that produces a wrong command.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}
