/**
 * `asc explore --group-by` -- turning a `GroupResult` into rows, and nothing more.
 *
 * **WHY THIS IS ITS OWN MODULE.** The command's run body is where a reader finds out what the
 * command does; a crosstab adds a row shape of its own (header facts, then one row per cell) and a
 * denominator rule that differs by key count. None of that is the command's story, so the shape
 * lives here and the command calls once: build.
 *
 * **HEADER ROWS, THEN ONE ROW PER CELL -- TWO DIFFERENT COLUMN SETS ON ONE `Output`.** The header
 * facts (`count`, and each axis's `distinct`/`kept`) are reported in this command's existing
 * `field`/`value` idiom (`propertyRow`, `commands/explore.ts`); the cells are reported as raw
 * columns, `<key1>[, <key2>], count`, because that is what makes `--select stage,outcome --csv`'s
 * sibling flag true of THIS flag too: a caller piping `--group-by outcome --csv` gets a real
 * two-column CSV, not a `field`/`value` pair repeated once per outcome. `Output.columns` is a
 * single array for the whole output, so header rows leave the key/count columns blank and cell rows
 * leave `field`/`value` blank -- the same trade the default map already makes between its header
 * rows and its property rows, which leave each other's specialised columns blank.
 *
 * **ONE ROW PER CELL, NOT A RENDERED MATRIX.** `Output` is rows-and-columns, and every renderer
 * (`--table`, `--json`, `--csv`) then reads the same rows -- the failure this command's own
 * docstring already warns about is two builds of one answer that could disagree. A caller who wants
 * a matrix pivots these rows themselves; the alternative is `groupEntries` building its OWN table
 * layout, in JSON, for the one renderer among three that could show it as a grid.
 *
 * **A PROPORTION APPEARS FOR ONE KEY AND NOT FOR TWO.** With one key the denominator is unambiguous
 * (`total`, the filtered population) -- the identical question `propertyTopRows` already answers for
 * a profile's top values, so `renderProportion` over `wilson` is reused rather than re-decided. With
 * two keys a cell's share could be of its row, its column or the grand total, and picking one
 * silently would be answering a question the caller did not ask; counts are reported instead, with a
 * header row stating that the denominator is the caller's choice.
 */

import { isSmallGroup, MIN_N, wilson } from '@ascend/analysis';
import type { GroupResult } from '@ascend/store';
import { renderProportion, type Row } from './output.js';

/** `--group-by a,b` as the keys, in the order typed. */
export function parseGroupBy(raw: string): readonly string[] {
  return raw.split(',').map((key) => key.trim());
}

/** One axis's header rows: how many distinct values it took, and how many `cells` kept. */
function axisRows(axis: GroupResult['axes'][number]): readonly Row[] {
  return [
    { field: `axis.${axis.key}.distinct`, value: axis.distinct },
    { field: `axis.${axis.key}.kept`, value: axis.kept },
  ];
}

/**
 * The header row naming both populations whenever `--filter` is in force, `total === unfiltered`
 * included -- a caller who typed a filter that excluded nothing is still owed the acknowledgement
 * that it ran (the same reasoning this command already applies to a silently-ignored `--seed` or
 * `--by`). Placed first, before every other header row: `count`, right below it, is the FILTERED
 * total, and a reader has to know that before reading a `count` of zero as "this type is empty"
 * rather than "the filter excluded everything" -- the trap a filter matching nothing looks
 * identical to an empty corpus, found by probing the shipped binary rather than by a test.
 */
function filterRow(total: number, unfiltered: number): Row {
  return { field: 'filter', value: `matched ${String(total)} of ${String(unfiltered)} entries` };
}

/** The header row stating a small population is an anecdote, not an estimate (`MIN_N`, `asc-bmf`).
 * Worded like `renderProportion`'s own bracketed marker, so the two read as one convention rather
 * than two -- this fires for the two-key case too, where no per-cell proportion carries the flag. */
function smallGroupRow(total: number): Row | undefined {
  if (!isSmallGroup(total)) return undefined;
  return {
    field: 'small_group',
    value: `[SMALL GROUP n=${String(total)} < ${String(MIN_N)} -- treat as anecdote, not estimate]`,
  };
}

/** The header row stating, for a two-key table, that no denominator was chosen (decision D14). */
const TWO_KEY_DENOMINATOR_ROW: Row = {
  field: 'denominator',
  value:
    "counts only: with two --group-by keys, a cell's share could be of its row, its column, or " +
    'the grand total, so this reports counts and leaves the denominator to you.',
};

/** One cell, as a row: the key values in order, the count, and -- for one key only -- the
 * qualified proportion of `total` this cell represents. */
function cellRow(cell: GroupResult['cells'][number], keys: readonly string[], total: number): Row {
  const row: Record<string, unknown> = { count: cell.count };
  keys.forEach((key, index) => {
    const cellValue = cell.values[index];
    if (cellValue === undefined) {
      // Unreachable: the store's contract is one `GroupKeyValue` per key, in `keys` order.
      throw new Error(
        `explore --group-by: cell is missing a value for key '${key}' (index ${String(index)})`,
      );
    }
    // `value` is `null` exactly when `state` is not 'measured' (the store's own contract) -- render
    // the state name in that case, never a blank cell (`TASKS.md` #7).
    row[key] = cellValue.value ?? cellValue.state;
  });

  if (keys.length === 1) {
    const proportion = wilson(cell.count, total);
    row['value'] = renderProportion(proportion);
    row['proportion'] = proportion;
    row['denominator'] = 'total';
  }

  return row;
}

/**
 * The full `columns`/`rows` pair for a `GroupResult`, ready to hand to `Output` as-is.
 *
 * `filtered` is whether `--filter` was passed, not `result.total !== result.unfiltered` -- a
 * filter that matched everything leaves those two numbers equal, and that is exactly the case
 * (requirement 2 of the fix) that still owes the caller the acknowledgement that a filter ran.
 */
export function buildGroupOutput(
  result: GroupResult,
  keys: readonly string[],
  filtered: boolean,
): { readonly columns: readonly string[]; readonly rows: readonly Row[] } {
  const header: Row[] = [{ field: 'count', value: result.total }];
  if (filtered) header.push(filterRow(result.total, result.unfiltered));
  for (const axis of result.axes) header.push(...axisRows(axis));
  if (keys.length === 2) header.push(TWO_KEY_DENOMINATOR_ROW);
  const anecdote = smallGroupRow(result.total);
  if (anecdote !== undefined) header.push(anecdote);

  const cells = result.cells.map((cell) => cellRow(cell, keys, result.total));

  return {
    columns: ['field', 'value', ...keys, 'count'],
    rows: [...header, ...cells],
  };
}

/**
 * How a row is named in a budget's trim report (`--max-tokens`'s `dropped_keys`): a header row by
 * its `field`, a cell row by its joined key values. Only cell rows are ever actually dropped --
 * `headerRowCount` is the floor a budget cannot cut below -- but this reads either shape without
 * assuming which one a caller passes.
 */
export function rowKey(row: Row, keys: readonly string[]): string {
  const field = row['field'];
  return typeof field === 'string' ? field : keys.map((key) => String(row[key])).join('/');
}

/** How many of the leading rows `buildGroupOutput` returns are header rows -- the budget floor:
 * these state what the table IS (the population and each axis's shape), and a budget that cannot
 * afford them cannot afford a crosstab at all. */
export function headerRowCount(
  result: GroupResult,
  keys: readonly string[],
  filtered: boolean,
): number {
  return (
    1 +
    (filtered ? 1 : 0) +
    result.axes.length * 2 +
    (keys.length === 2 ? 1 : 0) +
    (isSmallGroup(result.total) ? 1 : 0)
  );
}
