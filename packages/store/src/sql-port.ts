/**
 * The port the store's own modules name, in place of the driver.
 *
 * ## What this is, and what it is NOT
 *
 * It is a **SQL-shaped port**: it names `prepare`, `exec`, and the shape of a row, so an
 * implementation has to speak SQLite's dialect. It is therefore **not** the "storage-neutral read
 * layer" E12's description asks for, and the difference is written down here rather than left for a
 * reader to discover, because the phrase appears in a plan and this file is what exists.
 *
 * Neutrality is not reachable from where ascend stands, and the reason is on the public surface
 * rather than in the internals: `asc query` hands the user arbitrary SQL as a stable, documented
 * feature, and `--across` ATTACHes other projects' stores onto the connection so one statement can
 * join them. An interface that covered those would have to expose the SQL, and would then be
 * SQL-shaped under a different name. The honest conclusion is that the source of truth can move
 * without the *query language* moving, and E12.4 is where the source of truth moves.
 *
 * What the port does buy is the thing the epic's stage actually needs: **the store's fourteen
 * modules stop naming the driver.** One module constructs it; every other module names a type.
 * Enforced by a source scan in `test/sql-port.test.ts`, which asserts `db.ts` and no other file.
 *
 * ## Why it is structural rather than a wrapper class
 *
 * `DatabaseSync` already satisfies this interface as a matter of assignability, so `db.ts` hands the
 * driver's own object through and there is no adapter to drift from it. A wrapper with exactly one
 * implementation behind it would be an abstraction with no second case to pay for it, and the
 * project's own rules say to leave those unwritten. The cost of the choice is that nothing generates
 * the link between the port and the driver, so `test/sql-port.test.ts` pins every member against a
 * real `DatabaseSync` at runtime -- a driver upgrade that renames one then fails in one place, with
 * a message that names the port, instead of inside whichever command runs first.
 *
 * ## Why it is its own module and not part of `db.ts`
 *
 * `db.ts` imports `schema.ts`. Declaring the port there would make each of the other thirteen
 * modules reach `db.ts` through the schema edge they already have, and `align`'s `noCycles()` would
 * report it -- correctly. This module imports *nothing*, which is what makes it safe to name from
 * anywhere, and is also the reason the scan above can assert that it does not name the driver.
 *
 * ## Why the surface is exactly these members
 *
 * Enumerated from this package's source rather than from the driver's documentation, so the port is
 * a claim about what ascend uses and a widening of it is a deliberate edit:
 *
 * | member                | call sites | needed by                                    |
 * |-----------------------|-----------:|----------------------------------------------|
 * | `prepare`             |         43 | everything that reads or writes a row        |
 * | `exec`                |         43 | the DDL: migrations, generated views, ATTACH |
 * | `isTransaction`       |         11 | the refusals that must not run inside one    |
 * | `close`               |          4 | `openStore`'s callers and the index build    |
 * | `run` / `get` / `all` |  13/52/39  | every statement in the package               |
 *
 * `columns`, `setReadBigInts` and `setReturnArrays` exist for `asc query` alone, and each is here
 * for a measured reason rather than for completeness -- see their own notes below. Two members the
 * driver offers are deliberately absent because nothing calls them: `iterate` and `expandedSQL`.
 * The named-parameter overloads are absent too, measured rather than assumed: `.(run|get|all)({`
 * occurs 0 times in `packages/store/src` and `packages/cli/src`, so binding by name would be a
 * capability with no caller.
 */

/**
 * A value SQLite can bind, spelled to match the driver's own `SQLInputValue`.
 *
 * It is copied rather than imported so that this module names nothing, which is what lets it sit at
 * the bottom of the package's import graph. The two must stay equal: a narrower union here would
 * make `DatabaseSync` stop satisfying the port, and a wider one would admit a value the driver
 * refuses. The runtime pin in `test/sql-port.test.ts` binds a string, a number and a null through
 * the port, which is the shape every call site in this package actually passes.
 */
export type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;

/** One row of a result, keyed by column name. */
export type SqlRow = Record<string, unknown>;

/**
 * What a `run` reports back.
 *
 * Only `changes` is declared, because only `changes` is read (`registry.ts` counts the rows a
 * deletion removed). `lastInsertRowid` is not here: ascend's ids are UUIDs minted by the caller, so
 * the driver's rowid never reaches a record and a port that offered it would invite it to.
 */
export interface SqlRunResult {
  readonly changes: number | bigint;
}

/**
 * A column of a prepared statement's result set.
 *
 * **Only `name`, and the four omitted fields are the point.** The driver also reports `type`,
 * `column`, `table` and `database`, and the obvious hope -- that a query would say whether a column
 * is a boolean, or a `json` property, or JSON -- was measured and does not hold: `type` is `null` for
 * every column of a generated view that is an expression (all 8 property columns of `v_decision_v1`,
 * and `1+1 AS two`), so a renderer built on it would be guessing from a field that is usually empty.
 * `asc query` states the limitation in `--help` instead, which is the honest trade, and the port
 * declines to expose a field whose only use here would be the mistake. `query-values.ts` holds the
 * measurement.
 */
export interface SqlColumn {
  readonly name: string;
}

/** A statement prepared on a connection. */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): readonly SqlRow[];

  /**
   * The columns of this statement's result set. `asc query` only.
   *
   * See `SqlColumn` for why nothing else is read off it.
   */
  columns(): readonly SqlColumn[];

  /**
   * Return integers outside `Number`'s safe range as `bigint` rather than throwing. `asc query` only.
   *
   * **Not an optimisation.** Measured: `SELECT 9223372036854775807` on a default statement throws
   * `RangeError: Value is too large to be represented as a JavaScript number`, so a legitimate
   * query fails with a message about JavaScript that names neither the SQL nor the store. The cost
   * is that every integer on the statement becomes a `bigint`, which `JSON.stringify` then refuses,
   * so `query-values.ts` converts back the ones that fit and prints the rest as decimal strings.
   */
  setReadBigInts(enabled: boolean): void;

  /**
   * Return each row as an ARRAY of values rather than an object keyed by column name.
   * `asc query` only, and it is half of the duplicate-column fix rather than a preference.
   *
   * The driver builds a row object keyed by SQLite's own column names, so `SELECT 1 AS x, 2 AS x`
   * arrives as `{x: 2}` -- the first value is gone before this package sees anything, and no care
   * afterwards can recover it. Measured on the same statement: with this on, it returns `[[1, 2]]`.
   */
  setReturnArrays(enabled: boolean): void;
}

/** A connection. The one thing the store's modules are allowed to name. */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;

  /**
   * Run SQL that returns nothing: the DDL, the migration steps, and the `ATTACH`/`DETACH` a
   * cross-project union performs. Deliberately not interchangeable with `prepare` -- see
   * `statements.ts` for why a caller's multi-statement string is refused rather than silently
   * truncated to its first statement.
   */
  exec(sql: string): void;

  /**
   * Whether a transaction is open on this connection.
   *
   * Read by the refusals that must not run inside one -- a migration, and the writes that would
   * otherwise deadlock against a caller's own transaction.
   */
  readonly isTransaction: boolean;

  close(): void;
}
