/**
 * How many statements a caller's SQL string contains.
 *
 * **This exists because `db.prepare()` runs only the first one, silently.** Measured, on a real
 * connection: `'SELECT 1 AS a; SELECT 2 AS b; SELECT 3 AS c'` prepares and runs without an error
 * and without a warning, and returns `[{"a":1}]`. Two of the three statements the caller wrote were
 * discarded, and nothing in the output says so. Re-measured on 2026-09-17 against `node:sqlite` for
 * the rule-predicate case below, with the same result: `db.prepare('SELECT a FROM t WHERE (a > 0);
 * DROP TABLE t; --)')` prepared without complaint, returned the rows of the first statement, and
 * left `t` in place -- the trailing statements were dropped rather than executed, which is quieter
 * than executing them and just as wrong.
 *
 * That is the "reports success wrongly" class, and it is why the count is refused rather than
 * tolerated in either direction:
 *
 *   - **More than one** means ascend would answer a question the caller did not ask -- the second
 *     half of their SQL vanishes while the exit code says it worked. Whether that half was a read
 *     or a write makes no difference to the honesty of the report.
 *   - **Zero** means there is no question at all. SQLite's own answer to a comment-only string is
 *     `statement has been finalized` (measured), which names nothing about the caller's mistake.
 *
 * A single statement with a trailing `;` is one statement, because that is how everyone writes it.
 *
 * **Why a scanner and not a SQLite API.** There is none: `node:sqlite` exposes no statement count,
 * and `prepare` accepts a multi-statement string as though it did not. The alternative -- running
 * `prepare` and comparing the result against... nothing -- has no signal to compare. So the string
 * is scanned, and the scanner is deliberately narrow: it knows about quoting and comments, which is
 * everything that can hide a `;` from a naive `split(';')`.
 *
 * **The failure direction is chosen.** Anything this scanner cannot parse is treated as content, so
 * an unrecognised construct makes the count too HIGH rather than too low. Too high refuses SQL that
 * would have worked (visible, and the caller retypes it); too low silently drops statements (the
 * defect above). Between a loud refusal and a quiet lie, the refusal is the only defensible one.
 *
 * **WHY THIS IS IN THE STORE AND NOT IN THE CLI, which is where it started.** The fact it encodes is
 * a fact about `db.prepare`, so it belongs beside the layer that owns SQLite; the CLI was the first
 * caller only because `asc query` was the first command to take arbitrary SQL from a user. The
 * second caller is the rule predicate an annotation scheme stores: `asc annotate --rule "sql: ..."`
 * wraps the fragment as `SELECT id FROM entries WHERE (<fragment>)`, and a fragment holding a
 * statement terminator would be truncated by exactly the machinery above -- silently, in a
 * classification that then reports a match count as though it had considered the whole predicate.
 * The guard has to run where the fragment is wrapped, and once there are two callers the choice is
 * between moving the scanner and writing a second one. A second one is what this package's own
 * notes refuse elsewhere ("a second opinion about what the query means"), because two scanners
 * drift and only one of them gets fixed. So it moved.
 */

/**
 * Where the scan is, and therefore what a `;` means.
 *
 * `line` and `block` are comments rather than content, which is why a comment never starts a
 * statement: a string holding one comment and nothing else is not SQL, and counting it as a
 * statement would hand SQLite something whose only honest answer is an error about a finalized
 * statement rather than anything about the caller's mistake.
 */
type ScanState = 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'line' | 'block';

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';

/**
 * The number of statements in `sql`.
 *
 * Quoting follows SQLite's own rules, and each has its own way of escaping its closing character:
 * `'it''s'` and `"a""b"` double it, `` `a``b` `` doubles the backtick, and `[a]` has no escape at
 * all (`]` ends it, always). Getting any of these wrong is exactly the bug this function cannot
 * afford, because a mis-parsed quote turns a literal `;` into a statement separator -- and the
 * refusal that follows would name a statement count the caller never wrote.
 */
export function statementCount(sql: string): number {
  let state: ScanState = 'normal';
  let count = 0;
  let hasContent = false;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    switch (state) {
      case 'normal':
        if (char === ';') {
          if (hasContent) count += 1;
          hasContent = false;
          index += 1;
        } else if (char === '-') {
          // `--` to end of line; a lone `-` is the subtraction operator and stays content.
          if (next === '-') {
            state = 'line';
            index += 2;
          } else {
            hasContent = true;
            index += 1;
          }
        } else if (char === '/') {
          if (next === '*') {
            state = 'block';
            index += 2;
          } else {
            hasContent = true;
            index += 1;
          }
        } else if (char === "'") {
          state = 'single';
          hasContent = true;
          index += 1;
        } else if (char === '"') {
          state = 'double';
          hasContent = true;
          index += 1;
        } else if (char === '`') {
          state = 'backtick';
          hasContent = true;
          index += 1;
        } else if (char === '[') {
          state = 'bracket';
          hasContent = true;
          index += 1;
        } else {
          if (!isSpace(char)) hasContent = true;
          index += 1;
        }
        break;

      // Each quoted state consumes its terminator and one character past a doubled escape, so
      // `'a''b'` stays inside one string and does not end at the first `'`.
      case 'single':
        if (char === "'") {
          if (next === "'") index += 2;
          else {
            state = 'normal';
            index += 1;
          }
        } else index += 1;
        break;

      case 'double':
        if (char === '"') {
          if (next === '"') index += 2;
          else {
            state = 'normal';
            index += 1;
          }
        } else index += 1;
        break;

      case 'backtick':
        if (char === '`') {
          if (next === '`') index += 2;
          else {
            state = 'normal';
            index += 1;
          }
        } else index += 1;
        break;

      case 'bracket':
        // No escape: SQLite has no way to write `]` inside `[...]`, so the first one ends it.
        if (char === ']') state = 'normal';
        index += 1;
        break;

      case 'line':
        if (char === '\n') state = 'normal';
        index += 1;
        break;

      case 'block':
        if (char === '*' && next === '/') {
          state = 'normal';
          index += 2;
        } else index += 1;
        break;
    }
  }

  // A statement with no terminator is still a statement -- `SELECT 1` is how most callers write it.
  if (hasContent) count += 1;
  return count;
}

/**
 * Wrap a caller's predicate as the `WHERE` clause of a statement over `table`, or refuse it.
 *
 * The wrap and the check are one function rather than two because they are one decision: a fragment
 * is safe to interpolate exactly when the statement it lands in is still a single statement. Counting
 * the WRAPPED text is what makes that exact -- a `;` inside a string literal in the fragment is not a
 * separator and does not count, and a `;` anywhere else makes the wrap two statements and refuses.
 *
 * Measured against the alternative: checking the fragment alone needs a rule for a trailing `;`
 * (`'a > 0;'` is one statement by the count, and interpolating it is a syntax error inside the
 * parentheses), and every such rule is a special case of the wrap. Counting the wrap has none.
 *
 * Returns the full statement, so a caller cannot skip the check and interpolate anyway.
 */
export function wrapPredicate(table: string, fragment: string): string {
  const statement = `SELECT id FROM ${table} WHERE (${fragment})`;
  const count = statementCount(statement);

  if (count !== 1) {
    throw new TypeError(
      `a rule predicate must be a single condition, and this one makes ${String(count)} statements ` +
        `once wrapped as a WHERE clause: ${JSON.stringify(statement)}. A ';' outside a string ` +
        `literal in the predicate is the usual cause. Refused rather than run, because SQLite runs ` +
        `the first statement and discards the rest in silence -- a match count from a truncated ` +
        `predicate would describe a rule that was never applied.`,
    );
  }

  return statement;
}
