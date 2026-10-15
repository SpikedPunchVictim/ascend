/**
 * The watched-file baseline: the content hash of every file a session is shaped by, as of the last
 * time `asc capture` looked (asc-09wx.8.2).
 *
 * **Why a file beside the tree rather than a row in it.** The same three properties that moved the
 * ingest cursor out (`ingest-cursor.ts`, asc-i5tj.14) hold here. The four line kinds the tree can
 * carry are `TypeLine | EntryLine | SchemeLine | AnnotationLine`, and a baseline is none of them.
 * And the tree is git-tracked and shared, while this holds absolute paths into one machine's home
 * directory -- carrying it would put one developer's `~/.claude/CLAUDE.md` into everyone's checkout.
 * So it lives at `${dir}/watched-hashes.json`, inside `.ascend/` and gitignored, and the index stays
 * a pure function of the tree.
 *
 * **What it is FOR decides every refusal in this file, and the direction is one way.** A missing row
 * costs one observation and is repaired by the next change. A SPURIOUS row cannot be taken back:
 * entries are immutable (`entries` has no UPDATE that any writer performs), so a row that says "six
 * files changed on this date" when what actually changed was ascend's own watch list is a permanent
 * false claim in the ledger. Every branch below therefore prefers silence to a claim, and the one
 * caller (`commands/capture.ts`) writes a row only when this module says the two maps are
 * comparable.
 *
 * **`watch` is what makes them comparable, and it is not decoration.** The watched set is a policy
 * and will grow -- this is its first version, and the type's own `digest` property promises a
 * second source later. Without an identity for the LIST, adding one path would make every existing
 * file look newly-appeared, and the first session after the upgrade would write exactly the
 * all-changed row that a torn write must not be able to produce either. The identity is the sha256
 * of the list, supplied by the caller because only the caller knows what it watched.
 *
 * **Written atomically, with a temp name that no second writer can share.** The temp file plus
 * rename is the same construction `writeIngestCursor` uses, and the reason is the same. The
 * `.<pid>` in the name is where this DIVERGES from that sibling, deliberately: there, a torn
 * cursor's worst case is a file re-read; here it is a diff taken against a map that is not the one
 * the last run wrote. Two concurrent `SessionStart` hooks are possible (`/clear` fires the event a
 * second time), and two interleaved writers on one shared temp path is the one way to produce that
 * map without anyone being able to tell. A killed run can leave its own temp file behind; it is
 * inert, gitignored, and named in `.gitignore` for exactly that reason.
 *
 * Time is injected, never read: this package never touches a clock (`registry.ts`'s rule). Nothing
 * in this file is timestamped, so there is nothing to inject -- the observation's time belongs to
 * the entry the caller writes, not to the baseline it was diffed against.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The baseline's file name inside the store directory.
 *
 * Exported because `.gitignore` has to name it (`asc init` writes that list, `commands/init.ts`'s
 * `DERIVED_ENTRIES`) and a second spelling of it in the CLI is a file that stops being ignored the
 * day this one is renamed -- the reason `INGEST_CURSOR_FILE` is exported too.
 */
export const WATCHED_HASHES_FILE = 'watched-hashes.json';

/**
 * The shape this module writes. A file carrying any other number is refused rather than guessed at,
 * because the guessing would be a diff against a map whose meaning had changed.
 *
 * Kept as a separate number from `SCHEMA_VERSION` on purpose: the two version different things. The
 * schema describes the store; this describes one gitignored file that a deleted-and-rebuilt store
 * never even notices.
 */
export const WATCHED_HASHES_FORMAT = 1;

/** Every watched file's content hash, keyed by the path as the digest will spell it. */
export interface WatchedHashes {
  /**
   * The identity of the watched LIST that produced `files` -- see this module's doc. A map whose
   * `watch` does not match the caller's current list is not comparable to it and must not be
   * diffed against it.
   */
  readonly watch: string;
  /** Display path (`CLAUDE.md`, `~/.claude/settings.json`) to sha256 of the file's bytes. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * What {@link readWatchedHashes} found.
 *
 * **A result rather than a throw, and here the caller genuinely wants to continue.** The three
 * states are three different instructions: `absent` is an ordinary first run, `ok` is a comparison,
 * and `unusable` is "write no row, say so, and start again from here". A throw would collapse the
 * first and third into one catch, and the caller would then have to guess which it had -- which is
 * exactly the confusion the unreadable case is supposed to make loud. `resolveOwnBinary`
 * (`hook-script.ts`) is the precedent for the shape; this is a third state arriving, not a failure
 * to report.
 */
export type ReadWatchedHashes =
  | { readonly kind: 'ok'; readonly state: WatchedHashes }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unusable'; readonly path: string; readonly detail: string };

/** Where the baseline lives, given the store directory (`.ascend/`). */
function baselinePath(dir: string): string {
  return join(dir, WATCHED_HASHES_FILE);
}

/**
 * The stored baseline, or which of the three states it is in.
 *
 * **All four ways a file can be unusable are one answer, and the message is one sentence with the
 * reason in it.** A permission error, a hand-edit that broke the JSON, a shape from a different
 * ascend, and a `format` this build does not know are the same instruction to the caller: do not
 * diff against this, say which file it was, and write a fresh baseline. Splitting them would give
 * the caller four branches that all do the same thing -- and the message already carries which one
 * it was, which is the part a reader needs.
 */
export function readWatchedHashes(dir: string): ReadWatchedHashes {
  const path = baselinePath(dir);
  if (!existsSync(path)) return { kind: 'absent' };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return unusable(path, error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return unusable(path, error instanceof Error ? error.message : String(error));
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return unusable(path, 'it is not a JSON object');
  }

  const { format, watch, files } = parsed as Record<string, unknown>;
  if (format !== WATCHED_HASHES_FORMAT) {
    return unusable(
      path,
      `it carries format ${JSON.stringify(format)}, and this ascend writes ${String(
        WATCHED_HASHES_FORMAT,
      )}`,
    );
  }
  if (typeof watch !== 'string' || watch === '') {
    return unusable(path, 'it names no watched set, so there is nothing to say its files are from');
  }
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return unusable(path, 'it has no "files" object');
  }

  const hashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(files as Record<string, unknown>)) {
    if (file === '' || !isSha256(hash)) {
      return unusable(path, `the entry for '${file}' is not a sha256 in lowercase hex`);
    }
    hashes[file] = hash;
  }

  return { kind: 'ok', state: { watch, files: hashes } };
}

/**
 * Replace the baseline with `state`, atomically.
 *
 * The refusals are the writer's rather than a schema's -- the table that would have held them does
 * not exist, for the reasons in this module's doc -- and each one refuses a state that could only
 * come from a bug: an empty `watch` compares equal to nothing and would make every later run
 * re-baseline, and a key that is not a hash cannot be compared to one. Both would fail closed at
 * the reader anyway; failing here names the caller that produced them.
 *
 * A `files` entry for a path that is not there is not an error and is not written by the caller:
 * absence from the map is how a file that does not exist is spelled, which keeps a deleted file's
 * disappearance a diff the caller can see rather than a sentinel hash nobody computed.
 */
export function writeWatchedHashes(dir: string, state: WatchedHashes): void {
  if (state.watch === '') throw new Error('a watched-hashes baseline with an empty watch identity');

  const files: Record<string, string> = {};
  for (const [file, hash] of Object.entries(state.files)) {
    if (file === '') throw new Error('a watched-hashes baseline with an empty path');
    if (!isSha256(hash)) {
      throw new Error(`the watched-hashes entry for '${file}' is not a sha256 in lowercase hex`);
    }
    files[file] = hash;
  }

  const sorted: Record<string, string> = {};
  for (const file of Object.keys(files).sort()) sorted[file] = files[file] as string;

  const path = baselinePath(dir);
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${String(process.pid)}.ascend-tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ format: WATCHED_HASHES_FORMAT, watch: state.watch, files: sorted }, null, 2)}\n`,
  );
  renameSync(temporary, path);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function unusable(path: string, detail: string): ReadWatchedHashes {
  return { kind: 'unusable', path, detail };
}
