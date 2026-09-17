/**
 * `asc query "<sql>"` -- arbitrary read-only SQL against the store.
 *
 * **The connection cannot write, and that is the command's whole design.** Not "the command does
 * not write" -- the handle is opened read-only (`OpenOptions.readOnly`), so no statement a caller
 * can type will change the file. Measured: a write through it is refused
 * (`attempt to write a readonly database`), and `ATTACH` still works, so `--across` is unaffected.
 *
 * This matters beyond tidiness. The store is gitignored, so there is no version control net under a
 * mistyped `DELETE FROM entries`, and entries are immutable by construction (`recorder.ts`), so
 * there is not even a delete path to undo it with. `Bash(asc query:*)` is a defensible
 * `settings.json` allowlist entry only because the command has been *shown* unable to mutate, so
 * this is the one property of this command that must not be traded away.
 *
 * A statement that tries to write is a **refusal** (exit 1), not a usage error: the caller typed a
 * valid command line and the store said no.
 *
 * **What the values mean is SQLite's representation, not a declared type** -- see
 * `query-values.ts`, where that was measured rather than assumed.
 */

import { Args, Flags } from '@oclif/core';
import {
  attachHeadroom,
  attachStore,
  databaseNames,
  detachStore,
  foldDatabaseName,
  DuplicateProjectError,
  sqlitePrimaryCode,
  STORE_DIR,
  STORE_FILE,
  type Attachment,
  type ProjectSource,
  type Store,
} from '@ascend/store';
import { globSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import { normalizeRow } from '../query-values.js';
import { statementCount } from '@ascend/store';
import type { Output } from '../output.js';

/**
 * The handle this command runs statements against.
 *
 * Written as an indexed access on the store's own `Store` type rather than as an import, and that is
 * a boundary rule rather than a preference: `node:sqlite` may not be imported anywhere but
 * `@ascend/store` (align and eslint both enforce it), and `import type { DatabaseSync } from
 * 'node:sqlite'` names the specifier even when the import erases. `Store['db']` is the same type,
 * reached through the package that is allowed to own it.
 */
type Handle = Store['db'];

/**
 * `SQLITE_READONLY`, and the reason this is a number rather than a message match.
 *
 * Measured on a refused write: the thrown `Error` carries `errstr: 'attempt to write a readonly
 * database'` **and** `errcode: 8`. Matching the text would be matching a translation -- SQLite's
 * wording is not part of its interface -- while the code is.
 *
 * The extended-code mask this comment used to explain now lives in `sqlitePrimaryCode`, in the
 * package that owns the driver, because this file was the second of three copies of it. Comparing
 * the value that returns against this constant is the whole check; comparing `errcode` itself is
 * not, and `SQLITE_READONLY_RECOVERY` (`8 | 256`) is the family that says so.
 */
const SQLITE_READONLY = 8;

/** Refuse anything that is not exactly one statement, before the store is even opened. */
function requireSingleStatement(sql: string): void {
  const count = statementCount(sql);

  if (count === 0) {
    throw usageError(
      `the SQL is empty, or holds only comments -- which SQLite does not accept as a statement. ` +
        `Pass one statement, for example: asc query 'SELECT count(*) FROM entries'`,
    );
  }

  if (count > 1) {
    // Named as the caller's mistake rather than as a capability limit, because that is what it is:
    // `db.prepare()` runs the first statement and discards the rest in silence (measured).
    throw usageError(
      `the SQL holds ${String(count)} statements. asc query runs exactly one, and SQLite's prepare ` +
        `would run the FIRST and discard the others without saying so -- so a two-statement query ` +
        `would report success for half of it. Run them as two asc query calls.`,
    );
  }
}

/**
 * The project directory a glob match names.
 *
 * A match is read as a **project directory** -- the thing holding `.ascend/` -- and the store is
 * `<match>/.ascend/ascend.db`. The `<project>/.ascend/ascend.db` spelling is accepted too, because
 * that is what shell completion and `ls` produce, and a rule that refused it would be a rule about
 * spelling rather than about projects. Recognised structurally (the last two segments are `.ascend`
 * and `ascend.db`) rather than by cutting the string, so it gives the same answer on any separator.
 */
function projectDirOf(match: string): string {
  const parent = dirname(match);
  return basename(parent) === STORE_DIR && basename(match) === STORE_FILE ? dirname(parent) : match;
}

/** Resolve a path that may not exist, since whether it exists is `attachStore`'s refusal to write. */
function resolveOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // ENOENT for a project with no store yet -- which is a refusal `attachStore` writes well, not a
    // reason to fail here with a path error that names neither the glob nor the store.
    return resolve(path);
  }
}

/**
 * A database name a user can type without quoting.
 *
 * `ATTACH ... AS "my-project"` is legal, but `SELECT * FROM my-project.entries` is a syntax error,
 * so a name carrying a hyphen would be unreachable from the only SQL the caller can write. Only
 * characters that survive unquoted are kept, and a leading digit is prefixed because
 * `SELECT * FROM 3d_print.entries` is not an identifier either.
 */
function aliasBase(label: string): string {
  const cleaned = basename(label).replace(/[^A-Za-z0-9_]/g, '_');
  if (cleaned === '') return 'project';
  return /^[0-9]/.test(cleaned) ? `p_${cleaned}` : cleaned;
}

/**
 * `base`, or `base_2`, `base_3`, ... -- the first name this connection is not already using.
 *
 * `taken` holds **folded** names (`foldDatabaseName`), not raw ones, because the comparison SQLite
 * makes when it refuses an ATTACH is case-insensitive. Testing raw spellings here would hand out
 * `Temp` on a connection that already answers to `temp`, and the refusal would arrive from SQLite
 * as `database temp is already in use` -- naming neither the project nor the alias it was for.
 */
function allocateAlias(label: string, taken: ReadonlySet<string>): string {
  const base = aliasBase(label);
  if (!taken.has(foldDatabaseName(base))) return base;

  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}_${String(suffix)}`;
    if (!taken.has(foldDatabaseName(candidate))) return candidate;
  }
}

/**
 * `~` at the start of a glob, as the user's home directory.
 *
 * `fs.globSync` performs no tilde expansion -- `~` is a literal directory name -- and `--help`'s own
 * example is single-quoted, so the shell does not expand it either. Measured: `globSync('~/projects/*')`
 * matched nothing, while `globSync(homedir() + '/*')` matched 17 entries. So the example `asc query
 * --help` prints could never have worked, and the corpus it names (`ARCHITECTURE.md`'s real
 * `~/.claude/projects/` tree) is the one a caller is most likely to reach for.
 *
 * Anchored on `~/` or a bare `~`. `~user` means another user's home directory, which `homedir()`
 * cannot resolve, so it is deliberately left alone rather than silently rewritten to the wrong path.
 *
 * Concatenated rather than `join`ed: only the `~` is being expanded, and `join` would also normalize
 * the rest of the pattern -- collapsing `..`, dropping a trailing slash -- which is a second change
 * to a string the caller is entitled to have matched as written.
 */
function expandHome(pattern: string): string {
  return pattern === '~' || pattern.startsWith('~/') ? `${homedir()}${pattern.slice(1)}` : pattern;
}

/**
 * The pattern as the caller wrote it, plus what it became -- but only when the two differ.
 *
 * "matched no projects: '~/x/*'" leaves a caller unable to tell whether the `~` was understood and
 * the directory is empty, or never expanded at all. Saying both answers that without a second run.
 */
function describePattern(pattern: string, searched: string): string {
  return pattern === searched ? `'${pattern}'` : `'${pattern}' (expanded to '${searched}')`;
}

/** A result column that shared its name with an earlier one, and the name it was given instead. */
interface Rename {
  readonly from: string;
  readonly to: string;
}

interface ReadResult {
  readonly output: Output;
  readonly renamed: readonly Rename[];
}

/**
 * The result columns, with duplicates disambiguated.
 *
 * **Measured, and it is a real dropped value rather than a cosmetic clash.** `SELECT 1 AS x, 2 AS x`
 * is legal SQLite, and `columns()` reports two columns both named `x` -- but `all()` returns
 * `[{"x":2}]`. The row is built as an object keyed by SQLite's own column names, so the second
 * overwrites the first and the value is simply gone: two columns in, one out, no error. A missing
 * value that looks exactly like a present one is the "reports success wrongly" class.
 *
 * **Renaming alone is not the fix, and this is the part worth keeping.** The collision happens
 * *inside the driver*, before this function's caller ever holds a row, so renaming the column list
 * without changing how rows are read produced a header advertising `x_2` beside an empty cell -- a
 * lie about the data in place of a missing value. Measured on the real binary, which is how that was
 * caught. The two halves that do work are together in `read()`: `setReturnArrays(true)`, so the
 * values arrive as `[[1, 2]]` with nothing to collide, and this rename, so the keys built from them
 * can hold both.
 *
 * `column.name` is never null, which is also measured: an unnamed column comes back named after its
 * expression text (`SELECT 1` gives the name `"1"`), so there is no null case to guard.
 *
 * Renamed rather than refused, and suffixed the way `--across` names a second project sharing a
 * basename. `SELECT a.*, b.*` is an ordinary query, and refusing it would mean refusing something
 * SQLite answers happily -- while the suffix is visible in the header and the JSON keys, so nothing
 * about the output is quietly different from what was asked for.
 */
function columnNames(columns: readonly { readonly name: string }[]): {
  readonly columns: readonly string[];
  readonly renamed: readonly Rename[];
} {
  const taken = new Set<string>();
  const renamed: Rename[] = [];

  const names = columns.map((column) => {
    if (!taken.has(column.name)) {
      taken.add(column.name);
      return column.name;
    }

    let suffix = 2;
    while (taken.has(`${column.name}_${String(suffix)}`)) suffix++;
    const name = `${column.name}_${String(suffix)}`;
    taken.add(name);
    renamed.push({ from: column.name, to: name });
    return name;
  });

  return { columns: names, renamed };
}

/**
 * One row array and the column names, zipped into the row object the renderers take.
 *
 * A missing element becomes `null` rather than `undefined`, because SQL's own absent value is `null`
 * and a row must not offer two spellings of "nothing" depending on which came back. The lengths are
 * equal by construction -- both come from one statement -- so this is a guard against a driver that
 * changed shape, not against the query.
 */
const zipRow = (columns: readonly string[], values: readonly unknown[]): Record<string, unknown> =>
  Object.fromEntries(columns.map((name, index) => [name, values[index] ?? null]));

/**
 * Run the statement and shape it for the renderers.
 *
 * A free function rather than a method: it reads a handle and returns a value, so it has nothing to
 * do with the command and is callable from a test without constructing one.
 */
function read(handle: Handle, sql: string): ReadResult {
  const statement = handle.prepare(sql);

  // Not an optimisation. Measured: `SELECT 9223372036854775807` on a default statement throws
  // `RangeError: Value is too large to be represented as a JavaScript number`, so a legitimate query
  // would fail with a message about JavaScript, naming neither the SQL nor the store. See
  // `query-values.ts` for what the flag costs and how that is paid.
  statement.setReadBigInts(true);

  // Rows as ARRAYS, and this is the other half of the duplicate-column fix rather than a preference.
  // `node:sqlite` builds a row object keyed by SQLite's own column names, so for `SELECT 1 AS x, 2
  // AS x` the driver itself returns `{x: 2}` -- the first value is already gone before this function
  // is handed anything, and no amount of care after the fact can recover it. Measured on the same
  // statement: with this flag on, the same query returns `[[1, 2]]`. The keys are applied by
  // `zipRow` below, using the disambiguated names.
  statement.setReturnArrays(true);

  const { columns, renamed } = columnNames(statement.columns());

  try {
    // The cast goes through `unknown`, and the reason is a gap in the typings rather than in the
    // driver: `@types/node` declares `all()` as `Record<string, SQLOutputValue>[]` and does not
    // change it for `setReturnArrays`, so the declared type is silent about the shape the flag
    // actually produces. Measured, which is what makes the cast defensible: the same statement
    // returns `[[1, 2]]` with the flag on and `[{x: 2}]` with it off.
    const rows = (statement.all() as unknown as readonly (readonly unknown[])[]).map((values) =>
      normalizeRow(zipRow(columns, values)),
    );
    return { output: { columns, rows }, renamed };
  } catch (error) {
    // The one failure whose raw text explains nothing: `attempt to write a readonly database` does
    // not say that this is by design, or that the statement is what has to change. Every other error
    // propagates verbatim, which is `errors.ts`'s stated default -- a SQLite syntax error already
    // reads as an error, and wrapping it would bury the part that says what is wrong.
    const errcode = sqlitePrimaryCode(error);
    if (errcode === SQLITE_READONLY) {
      throw refusal(
        `the statement tried to modify the store, and asc query holds a read-only connection. ` +
          `That is the guarantee that makes 'asc query' safe to allowlist, so it is not a setting ` +
          `that can be turned off -- the statement is what has to change. Reads only.`,
      );
    }
    throw error;
  }
}

export default class Query extends BaseCommand {
  static override description =
    'Run one read-only SQL statement against the store. The connection cannot write, so no ' +
    "statement can change your data. Values are SQLite's representation of a column rather than a " +
    'declared type: a boolean property reads as 1 or 0, a json property as JSON text, a blob as a ' +
    'hex literal, and an integer too large for a JavaScript number as a decimal string.';

  static override args = {
    // `ignoreStdin` because `sql` is `required: true` and oclif would otherwise satisfy that
    // requirement from stdin -- so `printf 'SELECT 1 AS x' | asc query` RAN the statement, with
    // nothing documenting that stdin is an input to this command. It also contradicts
    // `input.ts`: "a command that reads stdin when given no operand looks like it is waiting for
    // input when it is actually waiting for a keypress". Whether it worked was a race against
    // oclif's 10 ms stdin abort, so the same pipeline could run or refuse depending on how fast
    // the producer was. A missing operand is now always a usage error naming the operand.
    sql: Args.string({
      required: true,
      description: 'One SQL statement. Quote it so your shell does not split it.',
      ignoreStdin: true,
    }),
  };

  static override flags = {
    across: Flags.string({
      description:
        'Attach every project matching this glob, each under its own database name, and report ' +
        'the names on stderr. Quote the glob. The project you are in stays unqualified as "main". ' +
        'A SQLite connection holds a limited number of attached databases, so a glob matching ' +
        'more projects than fit is refused rather than partly attached.',
    }),
  };

  static override examples = [
    "<%= config.bin %> query 'SELECT count(*) FROM entries'",
    "<%= config.bin %> query 'SELECT * FROM v_decision_v1' --json",
    "<%= config.bin %> query 'SELECT type_name, count(*) AS n FROM entries GROUP BY 1' --csv",
    "<%= config.bin %> query 'SELECT * FROM other.entries' --across '~/projects/*'",
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Query);
    const format = this.resolveFormat(flags);
    requireSingleStatement(args.sql);

    await this.withQueryProject((project) => {
      const handle = project.store.db;
      const localFile =
        project.root === undefined
          ? undefined
          : resolveOrSelf(join(project.root, STORE_DIR, STORE_FILE));

      if (project.root === undefined) {
        // Said rather than left to be discovered by an unqualified `entries` failing with
        // `no such table: entries`, which names the symptom and not the reason.
        this.warn(
          `no ${STORE_DIR}/ store in this directory or any parent, so 'main' is empty. ` +
            `Name the projects to query with --across, and qualify every table with one of the ` +
            `names it reports.`,
        );
      }

      const attachments = this.attachScope(
        handle,
        flags.across === undefined ? [] : this.expandAcross(flags.across),
        localFile,
      );

      try {
        const result = read(handle, args.sql);
        for (const rename of result.renamed) {
          // Said out loud, because the JSON key is no longer the alias the caller typed. The value is
          // in the output either way -- this exists so a caller who wrote `SELECT a.*, b.*` learns
          // why `x` is not the column they expected, instead of debugging a `--json` key.
          this.warn(
            `two result columns are named '${rename.from}', so the second is reported as ` +
              `'${rename.to}'. SQLite allows the duplicate, but a row object cannot hold both -- ` +
              `without this the first value would be dropped. Alias them to choose your own names.`,
          );
        }
        this.emit(format, result.output);
      } finally {
        // `finally`, so a statement that threw still releases every attachment. The store's own
        // `withProject` makes the same argument: a leaked attachment holds another project's file
        // open and its snapshot readable for the rest of the process.
        for (const attachment of attachments) detachStore(handle, attachment.alias);
      }
    });
  }

  /** Every project the glob names, as the store's own `ProjectSource` shape. */
  private expandAcross(pattern: string): readonly ProjectSource[] {
    const cwd = process.cwd();
    const searched = expandHome(pattern);
    const matches = globSync(searched, { cwd })
      .map((match) => resolve(cwd, match))
      .sort();

    if (matches.length === 0) {
      // A refusal, not a usage error: the command line is well formed and the filesystem had nothing
      // to match, which is the same kind of fact as `NoProjectError`. Returning an empty result set
      // would report an empty corpus as though it were the caller's data.
      //
      // The expansion is shown when it differs, because that is the path that was actually searched
      // and the caller cannot otherwise tell whether their `~` was understood. The previous wording
      // told the caller to quote the pattern -- which is what `--help`'s own example does, and
      // quoting is not what broke it: `fs.globSync` treats `~` as a literal directory name whether
      // or not the shell got involved. Advice that cannot work, aimed at the one thing the caller
      // did right, is worse than no advice.
      throw refusal(
        `--across matched no projects: ${describePattern(pattern, searched)} (searched from ` +
          `${cwd}). A glob that matches nothing would query an empty corpus and report that as ` +
          `your data. Check the pattern names real project directories -- it is matched against ` +
          `this filesystem, and a leading '~' means your home directory.`,
      );
    }

    return matches.map((match) => {
      const project = projectDirOf(match);
      return {
        label: project,
        // A match that already names the store file is used as given; a project directory gets the
        // store's path inside it.
        file: project === match ? join(project, STORE_DIR, STORE_FILE) : match,
      };
    });
  }

  /**
   * Attach every target -- except the local project -- and report the names it chose.
   *
   * **The local project is excluded, and the exclusion is the rule rather than a convenience:**
   * `main` is the project you are standing in, and every `--across` match is one of the *others*.
   * Attaching one store under two names would make
   * `SELECT ... FROM main.entries UNION ALL SELECT ... FROM that_alias.entries` count every entry
   * twice, and a single-table query would not notice -- which is what makes it worth preventing by
   * construction rather than trusting the caller's SQL to be careful.
   */
  private attachScope(
    handle: Handle,
    targets: readonly ProjectSource[],
    localFile: string | undefined,
  ): readonly Attachment[] {
    // Seeded from the connection rather than from an empty set, so a name SQLite already answers to
    // -- `main`, `temp`, or anything a previous attachment took -- cannot be allocated.
    //
    // This comment was true of `main` and false of `temp` until `databaseNames` was corrected: that
    // pragma does not report `temp` while nothing has been created there, so a project directory
    // called `temp` was handed the alias `temp` and the ATTACH failed with `database temp is already
    // in use` -- a raw driver message naming neither the project nor the alias. `databaseNames` now
    // adds the names the pragma omits, and that is what fixes the measured case.
    //
    // The fold is the other half, and it is a deliberate claim rather than a measured one: SQLite
    // refuses `Temp` and `MAIN` on a connection holding `temp` and `main`, so a raw `Set.has` here
    // would hand out `Temp` and let `attachStore` refuse it -- a correct refusal for a name this
    // function should never have chosen. **No test covers that half, and cannot on a
    // case-insensitive filesystem**, because discriminating it needs two project directories
    // differing only in case, which such a filesystem cannot hold. It is kept because the rule it
    // encodes is SQLite's, verified directly against the driver, and because the alternative is a
    // wrong-name refusal rather than a wrong answer.
    const taken = new Set(databaseNames(handle).map(foldDatabaseName));
    const seen = new Map<string, string>();
    const attachments: Attachment[] = [];

    // Which targets this command would attach, decided BEFORE the first ATTACH, because the count
    // has to be known before any of them is made -- see the ceiling refusal below.
    //
    // The test is the one the loop always made, moved rather than changed: `resolveOrSelf` is
    // `realpathSync`, which is the same resolution `localFile` was built with in `run`. Hoisting it
    // costs nothing, because it is a fact about the filesystem and not about SQLite -- no attach is
    // needed to learn it -- and it leaves ONE owner of the "is this the project I am in" rule
    // instead of a check made twice.
    const planned = targets.map((target) => ({
      target,
      local: localFile !== undefined && resolveOrSelf(target.file) === localFile,
    }));
    const wanted = planned.filter((entry) => !entry.local).length;

    // **The ceiling, refused rather than discovered.** Every `--across` target is attached at once
    // and stays attached for the caller's statement, because that statement is the caller's own SQL
    // and may name several projects in one query -- so unlike `unionEntries`, which builds its
    // statement and can therefore read one project at a time, this command cannot detach anything
    // early. Measured before this check existed: a glob matching 11 non-local projects attached ten
    // and then died on the eleventh with `too many attached databases - max 10` -- a raw SQLite
    // message naming no project, no count and no fix, at a round number a monorepo reaches
    // (asc-bcv.14, F2).
    //
    // The number comes from the connection rather than from a constant here, and `attachHeadroom`'s
    // doc block says why: the failure it would otherwise be guessing at is reported as a generic
    // `SQLITE_ERROR`, indistinguishable by code from a syntax error, so a wrong constant would put
    // the raw message back.
    const headroom = attachHeadroom(handle, wanted);
    if (wanted > headroom) {
      // A refusal rather than a usage error, matching "--across matched no projects": the command
      // line is well formed and the glob is honest about what it matched. The connection is what
      // cannot hold it.
      throw refusal(
        `--across needs to attach ${String(wanted)} projects, and a SQLite connection can hold at ` +
          `most ${String(headroom)} attached databases at once. Narrow the pattern to ` +
          `${String(headroom)} projects or fewer, or run the query once per batch.`,
      );
    }

    try {
      for (const { target, local } of planned) {
        if (local) {
          this.warn(
            `${target.label} is the project you are in, so it is already here as 'main' and was ` +
              `not attached again. Query it unqualified.`,
          );
          continue;
        }

        const alias = allocateAlias(target.label, taken);
        const attachment = attachStore(handle, target, alias);

        // After the attach, because the path that matters is the one SQLite resolved: a symlink, or
        // a second spelling of one directory, would otherwise read as two projects.
        const first = seen.get(attachment.file);
        if (first !== undefined) {
          throw new DuplicateProjectError(target.label, attachment.file, first);
        }

        seen.set(attachment.file, target.label);
        taken.add(foldDatabaseName(alias));
        attachments.push(attachment);
        this.warn(`${target.label} attached as '${alias}'`);
      }
      return attachments;
    } catch (error) {
      // **The caller's `finally` cannot cover this, which is why the release is here.** That
      // `finally` iterates `attachments`, and the assignment binding it is the call to this very
      // method -- so a throw part-way through the loop leaves `attachments` unbound, the `finally`
      // never runs, and every project attached so far stays attached for the rest of the process.
      // Measured before this existed: a 12-project glob left exactly ten databases attached after
      // the throw, released only because the CLI exits and closes the connection. That is fine for
      // this command and is a leak for any in-process caller, which is a supported way to use the
      // store.
      //
      // Detached plainly rather than defensively: each alias here was attached by this loop and is
      // recorded in `attachments` immediately after, so DETACH cannot fail for an unknown name, and
      // a `try` around it would only be able to hide the error this `throw` is reporting.
      for (const attachment of attachments) detachStore(handle, attachment.alias);
      throw error;
    }
  }
}
