/**
 * Rendering command results: `--json`, `--table`, `--csv`.
 *
 * **stdout is data; stderr is everything else.** Nothing here writes a log line, a
 * warning or a progress notice to stdout, so `asc query ... | jq` never sees anything
 * but the result. Failures go to stderr and change the exit code (`errors.ts`).
 *
 * **The format never changes because of the environment.** `--json` is what you asked
 * for, `table` is what you get otherwise -- whether stdout is a TTY, a pipe or a file.
 * Defaulting to JSON when piped is a common convenience and it was rejected: it makes
 * the same command produce different bytes on different days, so a human comparing a
 * hand-run to a logged run sees a difference that means nothing, and a script that
 * forgot the flag gets a shape it did not ask for. Decoration follows the terminal
 * (`color.ts`); the SHAPE does not.
 *
 * **The JSON envelope is a contract and is versioned.** `cli-best-practices` rule 9: the
 * human-readable table may change whenever it should, but a script's parse target must
 * not. `ascend_output` carries the contract version, so a consumer can refuse a shape it
 * does not know instead of silently mis-reading one. Rows keep their native JSON types
 * (a number stays a number) -- stringifying them here would make `--json` no better than
 * scraping the table.
 *
 * Compact, not pretty-printed, on purpose: the primary consumer is a model on a token
 * budget (`asc-9y1` measures exactly that), and `jq .` is one keystroke away for a human.
 */

/** The `--json` contract version. Increment only for a breaking shape change. */
export const OUTPUT_CONTRACT_VERSION = 1;

export type OutputFormat = 'json' | 'table' | 'csv';

/** One result row. Keys are the column names, in the order the command chose. */
export type Row = Readonly<Record<string, unknown>>;

/**
 * A result, ready for any of the three renderers.
 *
 * One shape rather than three, so a command cannot report its JSON and its table from
 * two independently-built values that disagree -- the failure mode where `--json` and
 * `--table` give different answers to the same question.
 */
export interface Output {
  /**
   * The projection for `--table` and `--csv`: which fields to show, in order.
   *
   * It does NOT filter the JSON. A row may carry fields a command does not want in a
   * terminal table -- a full `type_hash`, a paragraph of prose -- and those are exactly
   * the fields a script wants. So `columns` is a view of the rows, not a definition of
   * them, and `--json` reports the rows as they are.
   */
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
}

/**
 * The versioned `--json` envelope. Every field name here is part of the contract.
 *
 * There is deliberately no `command` field naming which command produced this. It was
 * written, then removed: oclif's command id is optional on a directly-constructed
 * command, so the field would have needed a fallback -- and a provenance field that is
 * sometimes a stand-in is worse than no provenance field, because a consumer cannot tell
 * the two apart. A consumer knows which command it ran. Adding this back means giving it
 * a value that is never guessed.
 */
export interface JsonEnvelope {
  readonly ascend_output: number;
  readonly rows: readonly Row[];
  /**
   * `rows.length`, stated rather than left to be recomputed. It is what distinguishes
   * "the query matched nothing" from "the output was truncated", which is the difference
   * between a real zero and a partial answer.
   */
  readonly row_count: number;
}

export function renderJson(output: Output): string {
  const envelope: JsonEnvelope = {
    ascend_output: OUTPUT_CONTRACT_VERSION,
    rows: output.rows,
    row_count: output.rows.length,
  };
  return JSON.stringify(envelope);
}

/**
 * Longest cell the table renderer will show before eliding.
 *
 * A table's job is to be scannable, and one `evidence_text` column would otherwise set
 * the width of every row and push the columns that matter off the screen. The elision is
 * marked with `…` rather than silently cut, so what you see is never a plausible-looking
 * value that is actually a prefix. The full value is in `--json` and `--csv`, which do
 * not truncate.
 */
const MAX_CELL_WIDTH = 60;

/** What a value looks like in a table or a CSV cell. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects and arrays have no single-cell rendering of their own. JSON is the honest
  // one, and it round-trips: a reader can paste a cell back into `jq`.
  return JSON.stringify(value);
}

export function renderTable(output: Output, maxCellWidth = MAX_CELL_WIDTH): string {
  if (output.columns.length === 0) return '';

  const rows = output.rows.map((row) =>
    output.columns.map((column) => {
      // Newlines and tabs would break the grid, so a table flattens whitespace runs.
      // CSV and JSON keep the value verbatim -- the table is the lossy view, and it is
      // the one a human reads with the other two available beside it.
      const text = cellText(row[column]).replace(/\s+/g, ' ').trim();
      return text.length > maxCellWidth ? `${text.slice(0, maxCellWidth - 1)}…` : text;
    }),
  );

  const widths = output.columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  return [
    line([...output.columns]),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map((row) => line(row)),
  ].join('\n');
}

/**
 * Quote a CSV field per RFC 4180 when it needs it.
 *
 * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on repo-wide, but this
 * function is deliberately regex-and-string only: a CSV writer with a state machine is
 * how a quoting bug gets in.
 */
function csvField(value: unknown): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Line terminator: `\n`, not the RFC's `\r\n`.
 *
 * A deliberate deviation. Every consumer of this output is a Unix pipeline, and a `\r`
 * riding along at the end of the last field is a far more common cause of a wrong parse
 * (a value that compares unequal to itself, a filename that does not resolve) than a
 * non-conforming terminator is of a rejected file.
 */
export function renderCsv(output: Output): string {
  const head = output.columns.map(csvField).join(',');
  const body = output.rows.map((row) =>
    output.columns.map((column) => csvField(row[column])).join(','),
  );
  return [head, ...body].join('\n');
}

export function render(format: OutputFormat, output: Output): string {
  switch (format) {
    case 'json':
      return renderJson(output);
    case 'csv':
      return renderCsv(output);
    case 'table':
      return renderTable(output);
  }
}
