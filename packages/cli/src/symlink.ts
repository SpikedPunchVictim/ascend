/**
 * Following a symlink to the file it really names, for commands that edit a file outside the store.
 *
 * Three commands need this and they need it for the same reason: `asc init` appends to `.gitignore`,
 * `asc install-hook` writes `.claude/settings.json` AND `.claude/ascend-hook.sh`, and
 * `asc install-skill` writes the skill and its slash command into `.claude/`. Every one of them
 * writes with a temp-file-then-rename. **Renaming onto a link's own path replaces the LINK with a
 * regular file**, so a repository that deliberately shares one settings or ignore file with others
 * silently stops sharing it, with no message and no way back -- the target path is not recoverable
 * from the file afterwards.
 *
 * **This comment used to say the opposite, and the correction is the point.** It read: *"the two
 * callers are the two commands that write outside the store, so there is no third case waiting to be
 * missed."* That was an accurate count of the callers that existed when it was written and was
 * already false in the same command file: `asc install-hook` writes TWO files outside the store, and
 * only `settings.json` was resolved, so the script beside it kept the exact defect this module was
 * extracted to prevent (asc-ute8). A rule whose licence is "there is no third case" expires the
 * moment someone adds one, silently, because a missing call looks like a call that was not needed.
 * So the resolution decision now lives here as `writablePath`, and the count is not part of the
 * argument.
 *
 * Measured (`/tmp/probe-b7.mjs`, asc-bcv.11) on the `.gitignore` case: the link went
 * `isSymbolicLink` true -> false, its content survived, and a second repository linked at the same
 * target no longer saw the change. Resolving the path ONCE and using the resolved path for BOTH the
 * read and the write is the fix; the read already followed the link, which is why only the write
 * was wrong.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { refusal } from './errors.js';

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
 * The path a write must actually land on, or a refusal if there is none.
 *
 * The decision `symlinkTarget` exists to inform, made once for every writer so the answer cannot
 * differ between them: a link is followed, no link means the requested path is the real one, and a
 * link to nothing is refused. **Resolve ONCE and hand the result to BOTH the read and the write** --
 * resolving only the write leaves the two disagreeing about which file they mean, and resolving only
 * the read is the bug that was actually shipped (install-hook read through the link and then renamed
 * onto it).
 *
 * A dangling link is refused rather than repaired because `existsSync` follows links and would
 * report "no file here", sending the caller down a create branch that replaces the link. Refusing
 * costs a manual step and the message names it; replacing costs the target path, which no longer
 * appears anywhere in the file afterwards.
 *
 * `asc init` deliberately does NOT call this and handles the same `null` itself, as a skipped row
 * naming what the user must add by hand: init's whole output is a report of what it did and did not
 * do, where a refusal would abandon the rows for its other targets (init.ts:465-479).
 */
export function writablePath(requested: string): string {
  const link = symlinkTarget(requested);
  if (link === null) {
    throw refusal(
      `${requested} is a symlink to a file that does not exist, so writing through it is not ` +
        `possible and replacing it would break whatever points at it. Point it at a file, or ` +
        `remove it, and run this again.`,
    );
  }
  return link ?? requested;
}

/**
 * Quote a value for `/bin/sh`, exactly.
 *
 * Once used to quote the absolute paths `asc install-hook` baked into `.claude/settings.json`
 * directly; asc-cjm removed those paths from the settings command entirely (dogfood/0009 -- a
 * shared, tracked file is the wrong place for anything machine-specific). The remaining, and now
 * only, caller is `install-hook.ts`'s `hookScript`, which quotes the PROJECT-RELATIVE path it
 * embeds in the generated `.claude/ascend-hook.sh` for the same underlying reason: directory names
 * inside a real checkout routinely contain a space (`packages/first last/...`), and unquoted that
 * would silently split into two shell words and misresolve the binary or nothing at all.
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
