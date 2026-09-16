/**
 * Driver errors, said in the shape this project requires: **context -> problem -> fix**.
 *
 * `cli-best-practices` rule 8. The store's own errors are already written that way -- `EntryRejected`
 * names the field, the expected type and what arrived -- so `errors.ts` prints them as-is. What it
 * had no answer for is the layer underneath the store: the operating system and SQLite. Those report
 * a code and a syscall, and nothing else. Measured by driving the real binary, four of them reached
 * the user as a bare sentence with no context and no next step:
 *
 *   `asc init` in a project holding a FILE named `.ascend`
 *     -> `Error: EEXIST: file already exists, mkdir '/private/tmp/tno/.ascend'`
 *   `asc query 'SELECT * FROM entries WHERE'`
 *     -> `Error: incomplete input`
 *   `asc query 'SELECT * FROM nope'`
 *     -> `Error: no such table: nope`
 *   a project whose `.ascend` directory is unreadable
 *     -> `Error: unable to open database file`
 *
 * None of the four names what ascend was doing, which path it was doing it to, or what to do next --
 * and the first is the worst of them, because "EEXIST" reads like an internal assertion rather than
 * "you have a file where ascend needs a directory".
 *
 * **Every branch here keys on a CODE, never on the text of a message.** SQLite's wording is not part
 * of its interface -- it is the string `sqlite3_errstr` happens to return, and matching it would be
 * matching a translation. The codes are stable, and the driver exposes them as real properties
 * rather than only inside the sentence: measured, `node:sqlite` throws a plain `Error` whose own
 * properties are exactly `{ code: 'ERR_SQLITE_ERROR', errcode, errstr }`, and a Node filesystem
 * error carries `{ code, errno, syscall, path }`. So the path in the `EEXIST` message above is read
 * from `error.path`, not parsed out of the sentence that quotes it.
 *
 * **The driver's own sentence is still carried**, because it is the specific part and this module's
 * branches are the general part: code 1 is one code covering both `incomplete input` and `no such
 * table`, and a message that dropped the difference to keep the branch tidy would have thrown away
 * the only detail that says which happened.
 *
 * **What this deliberately does NOT do is guess.** A code with no entry here gets the code, the
 * syscall and the path, and says plainly that ascend has no specific advice for it -- which is a
 * weaker message than the ones above and a truer one than a fix line invented to fill the space.
 * That is the same rule the store follows when it omits a duration it cannot measure rather than
 * reporting the busy timeout as though the wait had taken that long.
 */

import { sqlitePrimaryCode, STORE_DIR, STORE_FILE } from '@ascend/store';

/** Where the store lives, spelled once so a message cannot drift from the code that makes it. */
const STORE_PATH = `${STORE_DIR}/${STORE_FILE}`;

/**
 * The filesystem's refusal codes, and what to do about each.
 *
 * Only codes whose fix can be stated truthfully are listed. The rest fall through to
 * `filesystemFailure`, which still names the code, the syscall and the path.
 */
const FILESYSTEM_PROBLEMS: Readonly<Record<string, string>> = {
  EEXIST: 'a FILE is already at that path, and one path cannot be both',
  EACCES: 'you do not have permission to use that path',
  EPERM: 'the operation is not permitted on that path',
  ENOENT: 'there is nothing at that path',
  ENOTDIR: 'a component of that path is a file rather than a directory',
  EISDIR: 'that path is a directory, and a file was needed',
  EROFS: 'the filesystem holding that path is mounted read-only',
  ENOSPC: 'the filesystem holding that path has no space left',
  EMFILE: 'this process has run out of file descriptors',
  ENFILE: 'the system has run out of file descriptors',
  ENAMETOOLONG: 'the path is longer than the filesystem allows',
  ELOOP: 'the path holds a symlink loop',
};

/**
 * The fix line for each, written to stand as its own sentence after the problem line.
 *
 * Capitalised, because that is what they are: the message reads `<context>: <problem>. <fix>`, and a
 * lowercase fix after a full stop is the kind of detail that makes a reader distrust the rest of it.
 */
const FILESYSTEM_FIXES: Readonly<Record<string, string>> = {
  EEXIST:
    'Move that file aside, or delete it if nothing needs it, and re-run. ascend creates a directory ' +
    'at that path when it sets up a store or writes output.',
  EACCES: 'Check the permissions on the path and on every directory above it, then re-run.',
  EPERM: 'Check the permissions on the path and on every directory above it, then re-run.',
  ENOENT: 'Check the path is spelled as you meant it, and that you are in the project you meant.',
  ENOTDIR:
    'Check the path component by component -- one of them is a file where a directory was needed.',
  EISDIR: 'Name a file inside that directory rather than the directory itself.',
  EROFS: 'Write somewhere else, or remount that filesystem read-write.',
  ENOSPC: 'Free space on that filesystem, then re-run.',
  EMFILE: 'Close some files, or raise the descriptor limit, then re-run.',
  ENFILE: 'Close some files, or raise the system descriptor limit, then re-run.',
  ENAMETOOLONG:
    'Shorten the path -- moving the project closer to the filesystem root usually does it.',
  ELOOP: 'Check the symlinks along that path for a cycle.',
};

/** The message fields a Node filesystem error carries, duck-typed for the reason `isBusyError` is. */
interface FilesystemFields {
  readonly code: string;
  readonly syscall?: string;
  readonly path?: string;
}

/**
 * Whether this is a Node filesystem error, judged by the shape it actually has.
 *
 * Every filesystem error carries an `E`-prefixed `code` **and** either a `syscall` or a `path`;
 * every other Node error carries `ERR_`-prefixed codes instead. The `syscall`/`path` requirement is
 * what makes this a shape check rather than a name-prefix guess, and it is not defensive: measured,
 * the EEXIST above carries all of `code`, `errno`, `syscall` and `path`.
 */
function filesystemFields(error: unknown): FilesystemFields | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, syscall, path } = error as {
    readonly code?: unknown;
    readonly syscall?: unknown;
    readonly path?: unknown;
  };
  if (typeof code !== 'string' || !/^E[A-Z]+$/.test(code)) return undefined;
  const hasSyscall = typeof syscall === 'string';
  const hasPath = typeof path === 'string';
  if (!hasSyscall && !hasPath) return undefined;
  return {
    code,
    ...(hasSyscall ? { syscall } : {}),
    ...(hasPath ? { path } : {}),
  };
}

function filesystemFailure(fields: FilesystemFields): string {
  const where = fields.path === undefined ? '' : ` at '${fields.path}'`;
  const did = fields.syscall === undefined ? 'an operation' : `'${fields.syscall}'`;
  const problem = FILESYSTEM_PROBLEMS[fields.code];
  const fix = FILESYSTEM_FIXES[fields.code];

  if (problem === undefined || fix === undefined) {
    return (
      `ascend ran ${did}${where} and the operating system refused it, with ${fields.code}. ` +
      `That code is all the system reported, and ascend has no specific advice for it. ` +
      `Check that the path exists, that its parent is a directory, and that you may use it, then ` +
      `re-run.`
    );
  }

  return (
    `ascend ran ${did}${where} and the operating system refused it, with ${fields.code}: ` +
    `${problem}. ${fix}`
  );
}

/**
 * SQLite's primary result codes, from the `errcode` the driver reports.
 *
 * Named rather than left as bare numbers at their uses, so the branch below reads as the codes it is
 * about. These are the PRIMARY codes: `sqlitePrimaryCode` masks the extended ones down before this
 * switch sees them, because `SQLITE_READONLY_RECOVERY` is `8 | 256` and comparing against `8`
 * directly would miss the whole family it belongs to.
 */
const SQLITE_ERROR = 1;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

/**
 * What SQLite's code means for a user, keyed on the primary code.
 *
 * `message` is the driver's own wording -- `incomplete input`, `no such table: nope` -- carried
 * through because the code is too coarse to replace it: code 1 covers every statement SQLite could
 * not make sense of, valid or not.
 */
function sqliteFailure(primary: number, message: string): string {
  switch (primary) {
    case SQLITE_NOTADB:
      return (
        `ascend opened a file as a SQLite database, and it is not one: SQLite reported ` +
        `'${message}' (code ${String(primary)}). Ascend's store is the single file '${STORE_PATH}' ` +
        `inside a project, and '--across' attaches that same file from other projects -- so one of ` +
        `those paths holds something that is not a database, or a database that has been damaged. ` +
        `Move that file aside and run 'asc init' for a fresh store. If it holds something you need, ` +
        `copy it somewhere first: ascend cannot read it as it stands.`
      );
    case SQLITE_ERROR:
      return (
        `SQLite could not make sense of a statement: '${message}' (code ${String(primary)}). ` +
        `Either the SQL is not valid, or it names a table or column the store does not have -- ` +
        `SQLite reports both as this one code, and the wording above is what says which. The ` +
        `store's tables are entries, entry_types, annotations, annotation_schemes, meta and the ` +
        `full-text index entries_fts, plus one generated view per entry type named ` +
        `'v_<type>_v<version>'; 'asc types list' names the types that exist. If the statement was ` +
        `not one you wrote, this is a bug in ascend.`
      );
    case SQLITE_CANTOPEN:
      return (
        `ascend could not open its store file: SQLite reported '${message}' ` +
        `(code ${String(primary)}). The store is the single file '${STORE_PATH}' inside a project. ` +
        `Either it is not there, or a directory on the way to it cannot be read or searched by you, ` +
        `or the file itself cannot. Check that the project has an '${STORE_DIR}' directory holding ` +
        `an '${STORE_FILE}' you can read -- 'asc init' creates both -- then re-run.`
      );
    case SQLITE_CORRUPT:
      return (
        `SQLite reported that ascend's store file is damaged: '${message}' ` +
        `(code ${String(primary)}). ascend has no repair path of its own, and re-running will give ` +
        `the same answer. Restore '${STORE_PATH}' from a backup, or move it aside and run ` +
        `'asc init' for a fresh store.`
      );
    case SQLITE_FULL:
      return (
        `the filesystem holding ascend's store is full: SQLite reported '${message}' ` +
        `(code ${String(primary)}). Free some space, then re-run; the statement did not complete.`
      );
    case SQLITE_READONLY:
      return (
        `ascend's store is read-only: SQLite reported '${message}' (code ${String(primary)}). ` +
        `Something has made '${STORE_PATH}' or a directory above it unwritable -- a file mode, a ` +
        `read-only mount, or a connection opened read-only. Check the permissions on the store and ` +
        `on its directory, then re-run.`
      );
    default:
      return (
        `SQLite refused an operation on ascend's store, with code ${String(primary)}: ` +
        `'${message}'. ascend has no specific advice for that code, and re-running will give the ` +
        `same answer unless something changed. If the operation came from SQL you wrote, check it ` +
        `-- 'asc query --help' describes what those statements may touch.`
      );
  }
}

/**
 * The message for a driver failure, or `undefined` when this is not one.
 *
 * `undefined` is the answer that matters as much as the message: it is what keeps this module from
 * claiming errors it does not understand. `errors.ts` prints anything this declines as-is, which is
 * the store's own well-written errors and oclif's usage errors -- and a module that wrapped those
 * would bury the part that already said what was wrong.
 *
 * The two sources are tried in one order, filesystem first, because they cannot both match: an
 * `E`-prefixed `code` is not `ERR_SQLITE_ERROR`, and a `syscall` or `path` is what the filesystem
 * branch additionally requires.
 */
export function describeDriverError(error: unknown): string | undefined {
  const fields = filesystemFields(error);
  if (fields !== undefined) return filesystemFailure(fields);

  const primary = sqlitePrimaryCode(error);
  if (primary === undefined) return undefined;
  // A driver error with no message at all is still a driver error; the sentence below is built
  // around the wording, so there has to be something in it. `String(error)` is the same fallback
  // `errors.ts` uses, and it is only reached by a driver that threw without one.
  const message = error instanceof Error ? error.message : String(error);
  return sqliteFailure(primary, message);
}
