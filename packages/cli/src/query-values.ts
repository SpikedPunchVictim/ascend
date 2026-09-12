/**
 * Turning a SQLite value into something honest to print.
 *
 * **`asc query` has no declared types to work from, and that was measured rather than assumed.**
 * The obvious hope -- that a query over a generated view would let the renderer know a column is a
 * boolean, or that a `json` property is JSON -- does not survive contact with SQLite.
 * `StatementSync.columns()` reports a `type` for a column that resolves back to a real table
 * column (`entries.recorded_at` is `TEXT` even when read through `v_decision_v1`), and reports
 * **`null`** for every column of a view that is an expression: all 8 property columns of
 * `v_decision_v1` came back `type: null`, and so did `1+1 AS two`. `json_extract` has no declared
 * type by construction.
 *
 * So `asc query` reports what SQLite returns, and the alternative is not available: guessing from a
 * column NAME (`*_state` means property, therefore...) would be a heuristic that produces a
 * *plausible wrong value* on exactly the queries a user is least likely to check. `asc` states this
 * limitation in `--help` instead, which is the honest trade. The declared type is genuinely
 * available one command up: `asc explore` reads a spec, and `asc types show` prints it.
 *
 * What is left for this module is the two shapes that are wrong to print as they arrive, and both
 * are wrong in the same way -- a value that prints as something *else* rather than as itself.
 */

/**
 * Normalize one value from a statement that was prepared with `setReadBigInts(true)`.
 *
 * **That flag is not an optimisation, it is what keeps a legitimate query from crashing.** Measured:
 * `SELECT 9223372036854775807` on a default statement throws
 * `RangeError: Value is too large to be represented as a JavaScript number`, so the caller's query
 * fails with a message about JavaScript, naming neither their SQL nor their store. With the flag on,
 * the same statement returns the value as a bigint.
 *
 * The flag's cost is that it applies to **every** integer on that statement, not only the large
 * ones: measured, `7` comes back as `bigint 7`, and `JSON.stringify` then throws
 * `Do not know how to serialize a BigInt` -- so `--json` would fail outright rather than degrade.
 * Hence this function: integers inside `Number`'s safe range become numbers again (so the common
 * case is byte-identical to before), and the ones outside it become a **decimal string**.
 *
 * A string rather than a rounded number, deliberately. `Number(9223372036854775807)` is
 * `9223372036854776000` -- a wrong answer wearing the right shape, which is the defect class this
 * project treats as severity-zero. A decimal string is the only representation that carries the
 * value intact, and its type in `--json` says plainly that it is not a number.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }

  // A BLOB. `JSON.stringify(new Uint8Array([1,2]))` gives `{"0":1,"1":2}` -- an object keyed by
  // array index, which is not the value, is not recognisable as a blob, and cannot be turned back
  // into one. The hex literal is SQLite's own spelling for these bytes, so it is both unambiguous
  // and directly reusable: the caller can paste it into the next `asc query`.
  if (value instanceof Uint8Array) {
    return `X'${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
  }

  return value;
}

/** Normalize one row, keeping the column order SQLite returned. */
export function normalizeRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  );
}
