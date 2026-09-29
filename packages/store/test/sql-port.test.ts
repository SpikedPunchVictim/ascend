import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SqlDatabase, SqlStatement } from '../src/sql-port.js';

/**
 * The store names a port, and one module names the driver.
 *
 * **What this file is the evidence for, stated narrowly because the epic's phrase is wider.** E12's
 * description says "storage-neutral read layer", and this port is not that: it names `prepare`,
 * `exec` and a row's shape, so a backend that does not speak SQL cannot implement it. Two things on
 * the public surface make neutrality impossible to claim honestly -- `asc query` hands the user raw
 * SQL as a stable feature, and `--across` ATTACHes other projects onto the connection -- so any
 * interface covering them is SQL-shaped. What the port does buy, and all this file checks, is that
 * **the store's fourteen modules stop naming the driver**: a new module cannot reach for
 * `node:sqlite` without failing the first test below.
 *
 * **The scan is a source scan because the claim is a source claim.** "Only `db.ts` constructs the
 * driver" is not observable by running the code -- every call site behaves identically either way --
 * so the check has to read the source, which is this repository's established idiom for exactly this
 * shape of invariant (`recorder.test.ts`'s "reads no clock and draws no randomness, in any module").
 *
 * **The second test exists because the port is STRUCTURAL, so nothing generates the link between it
 * and the driver.** `DatabaseSync` satisfies `SqlDatabase` as a matter of TypeScript's assignability,
 * which means no adapter file exists to go stale and nothing at runtime confirms the members are
 * still there. A `node:sqlite` upgrade that renamed `setReturnArrays` or dropped `isTransaction`
 * would first surface as a TypeError inside `asc query`, at whichever call site ran first. Pinning
 * the members here moves that failure to one place with a message that names the port.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Remove comments, so PROSE about the driver is not read as an import of it.
 *
 * Not a precaution -- measured: `schema.ts` discusses the import graph in a doc comment, and the
 * phrase it uses (`... imports only `@ascend/core`, `./sql.js` and `node:sqlite``) is one word away
 * from matching. `statements.ts` and `jsonl-index.ts` name the driver in prose too. A guard that a
 * comment about the rule can trip is a guard that gets deleted rather than fixed.
 *
 * A block comment is replaced by its own newlines rather than by the empty string, so line numbers
 * stay true to the file a reader would open. Checked against this package before relying on it:
 * there is no `/*` or `//` inside any string literal in `packages/store/src`, which is the one way
 * this could hide a real import rather than merely fail to strip a comment.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');

/**
 * An import of the driver, allowing the statement to be WRAPPED across lines.
 *
 * The wrapping is the point, not a detail. This repository's formatter breaks long import lists, so
 * a guard anchored to one line would pass or fail on where the break happened to fall -- and
 * `recorder.test.ts` measured that exact failure for a neighbouring guard, where five of six
 * spellings of one statement walked past a per-line version. `[\s\S]*?` cannot run away here: the
 * nearest `import` before a `from 'node:sqlite'` is always the statement introducing it.
 */
const DRIVER_IMPORT = /\bimport\b[\s\S]*?from\s*['"]node:sqlite['"]/;

/**
 * Every module in `src/` that imports the driver, by file name, sorted.
 *
 * A FRESH regex is built per file rather than the pattern being hoisted, and that is a correction
 * rather than a style choice: `.test()` on a `g` regex advances `lastIndex`, so a hoisted one would
 * answer for the first file and then skip ahead in the next, reporting a file that does import the
 * driver as one that does not. `recorder.test.ts` names the same trap for the same reason.
 */
function driverImporters(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => {
      const source = stripComments(readFileSync(join(SRC, name), 'utf8'));
      return new RegExp(DRIVER_IMPORT.source, 'g').test(source);
    })
    .sort();
}

describe('the store names the driver in exactly one module', () => {
  it('imports node:sqlite from db.ts and nowhere else in src/', () => {
    // `db.ts` is asserted by NAME rather than by count, so a second import landing in a new file is
    // a failure that says which file, and moving the driver out of `db.ts` is a failure too.
    expect(driverImporters()).toEqual(['db.ts']);
  });

  it('publishes the port, so a caller outside the package can name it', () => {
    // The CLI needs the type to declare a handle parameter, and without this it would have to keep
    // spelling `Store['db']` -- which reads as a workaround and is one. Asserted on the barrel's
    // source because a type export cannot be observed at runtime, which is the same reason the scan
    // above reads source rather than behaviour.
    const barrel = stripComments(readFileSync(join(SRC, 'index.ts'), 'utf8'));
    expect(barrel).toMatch(/SqlDatabase/);
  });
});

describe('the port describes the driver it stands in front of', () => {
  /**
   * Every member the store and the CLI call, exercised on a real `DatabaseSync`.
   *
   * The assertions are the SHAPES the port declares rather than the driver's documented behaviour,
   * so this test answers "is the port still true of the driver" and not "does SQLite work". Each
   * value is chosen so a wrong answer is visible: `get` on a missing row must be `undefined` rather
   * than an empty object, `all` must be an array of row objects, and the two flags `asc query` sets
   * must change the result in the direction that command depends on.
   */
  it('has every member, with the effect the callers rely on', () => {
    const db: SqlDatabase = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
      expect(db.isTransaction).toBe(false);

      const insert: SqlStatement = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)');
      // `changes` is the one field of a run result anything reads (`registry.ts` counts deletions).
      expect(insert.run(1, 'one').changes).toBe(1);
      expect(insert.run(2, 'two').changes).toBe(1);
      expect(insert.run(3, null).changes).toBe(1);

      const query: SqlStatement = db.prepare('SELECT a, b FROM t WHERE a = ?');
      expect(query.get(1)).toEqual({ a: 1, b: 'one' });
      // A miss is `undefined`, and a store that read `{}` here would report a row that is not there.
      expect(query.get(9)).toBeUndefined();

      const all: SqlStatement = db.prepare('SELECT a FROM t ORDER BY a');
      expect(all.all()).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);

      // The three members that exist for `asc query` alone.
      const columns: SqlStatement = db.prepare('SELECT a AS x, b AS y FROM t');
      expect(columns.columns().map((column) => column.name)).toEqual(['x', 'y']);

      // Measured in `query-values.ts`: without this flag the statement throws a RangeError naming
      // JavaScript rather than the caller's SQL, so a legitimate query fails with a message about
      // the wrong thing. Bracket access because `SqlRow` is an index signature.
      const big: SqlStatement = db.prepare('SELECT 9223372036854775807 AS n');
      big.setReadBigInts(true);
      expect(big.get()?.['n']).toBe(9223372036854775807n);

      // Measured in `query.ts`: the driver builds a row keyed by column name, so `SELECT 1 AS x, 2
      // AS x` returns `{x: 2}` and the first value is gone before JS sees it. With arrays on, both
      // survive -- which is the only reason a duplicate column is reportable at all.
      const arrays: SqlStatement = db.prepare('SELECT 1 AS x, 2 AS x');
      arrays.setReturnArrays(true);
      expect(arrays.all()).toEqual([[1, 2]]);
    } finally {
      db.close();
    }
  });
});
