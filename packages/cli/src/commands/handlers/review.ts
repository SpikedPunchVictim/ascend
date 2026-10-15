/**
 * `asc handlers review` -- what holds each handler, and which handlers nothing holds
 * (asc-09wx.8.5).
 *
 * **The gap this closes is that a handler is a file and a row is an entry, and nothing joins them.**
 * `asc-09wx.8`'s design says it in as many words: *"No step retires a handler today, so a handler
 * outlives the change it measured."* So a handler that measured a change closed two months ago is
 * still in `handlers/`, still replayed by `asc handlers check`, and indistinguishable from one that
 * is live. This command is the join, and it is deliberately the smallest one: it reads the ledger and
 * the directory and reports what stands.
 *
 * **Retirement is derived and the watch is written down** (decision `1d5cbb28`). A handler named by a
 * chain whose newest entry is `graded`, `reverted` or `ungradeable` is `retired` -- the ledger already
 * shows that, so a property restating it would be a second source for a fact that has one. Only
 * `disposition: regression_watch` is a datum, because it is a choice, and it lives on the entry that
 * closes the row. `unheld` is the fourth answer and the one a reader is usually looking for: no row
 * names the handler at all, so nothing is covered -- not by an open row, not by a watch.
 *
 * **A WATCH is reported, not re-read, and that is a limit stated rather than a step skipped.** The
 * design asks for *"a regression watch, re-read on a schedule, that raises a new proposed row if its
 * rate returns past its baseline"*. The second half of that cannot be computed by any command: a
 * row's `baseline` is a `text` property holding the exact tool output verbatim -- prose, on purpose,
 * so a later reader can re-run the command line inside it -- so "the rate has returned past the
 * baseline" is a judgment over two prose blobs. What a mechanism can honestly do is put the watch in
 * front of a reader who can read prose, with the command that produces the current reading beside it,
 * and this prints exactly that. A command that scored a rate against a paragraph would be inventing
 * the comparison it claims to report, which is the false-signal class this product exists to prevent.
 *
 * **Read-only, and it does not replay.** Every fact here is in the registry or on disk, so this runs
 * in the time a store read takes and cannot be slowed by the size of a transcript corpus -- which
 * matters, because the SessionStart hook's payload is the other caller of this rule (`asc types
 * brief`) and that one has a measured byte budget.
 */

import { BaseCommand } from '../../base.js';
import {
  handlerLivesWithFiles,
  stateOfLife,
  type HandlerLife,
  type HandlerState,
} from '../../handler-life.js';
import { FIELD, HANDLER, VALUE, type Row } from '../../handler-scope.js';
import { ledgerEntries, ledgerRows } from '../../intervention.js';

/**
 * What each state means, as the sentence a reader needs to act on it.
 *
 * Four sentences rather than one word in a column, because three of these four states are not
 * failures and a reader who cannot tell which is which will treat all four as one. `open` and
 * `watch` need nothing done; `retired` and `unheld` are the two the listing exists to surface, and
 * they are different kinds of thing -- one is a decided fact, the other is an absence.
 */
const MEANING: Readonly<Record<HandlerState, string>> = {
  open: 'a row that is still measuring names this handler, so something reads it',
  watch:
    'every row naming it is closed and at least one closed saying regression_watch -- re-read it ' +
    'and raise a new proposed row if its rate has returned past that row’s baseline',
  retired: 'every row naming it is closed and none is watching, so nothing reads it again',
  unheld:
    'no row names this handler at all -- it is covered by no open row and no watch, so either ' +
    'retire it or give it a row',
};

export default class HandlersReview extends BaseCommand {
  static override description =
    'Report what holds each handler in handlers/: the ledger rows whose metric names it, whether ' +
    'those rows are open, watching or retired, and the handler files no row names at all. ' +
    'Read-only, and it replays nothing.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static override strict = false;

  public async run(): Promise<void> {
    const { flags } = await this.parse(HandlersReview);
    const format = this.resolveFormat(flags);

    const rows = await this.withProject(({ store, root }) => {
      // The clock is read once, here, and handed to `ledgerRows` as a value -- `base.ts` says why the
      // boundary package owns that read and nothing below it does.
      const now = new Date(this.now());
      const lives = handlerLivesWithFiles(ledgerRows(ledgerEntries(store.db), now), root);
      const out: Row[] = [];
      for (const life of lives) out.push(...reviewRows(life, root));
      return out;
    });

    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}

/**
 * The rows one handler contributes.
 *
 * **A handler with holdings gets one row per holding, and the state rides on each of them.** That
 * repeats the state across a handler's holdings, and the repetition is deliberate: a summary row
 * saying `open` above three holdings two of which are closed would be the very collapse this command
 * exists to prevent -- the reader has to be able to see WHICH row is still measuring. `stateOfLife`
 * decides a handler's own state in every case, the one no row names included, so the four-valued rule
 * lives in one place and this function only chooses how much of it to print.
 *
 * **It did not, and this paragraph used to claim it did** -- which is the second defect
 * `asc-09wx.8.5`'s mutation spec found here. The zero-holdings case returned `'unheld'` as a literal
 * and returned before the call, so `stateOfLife`'s own `unheld` branch was unreachable from this
 * command, and a docblock sentence asserting that the function decides that case was true of nothing.
 * A mutant that deleted the branch survived every test, because no test could reach it.
 *
 * The `holds` row carries the count, so a handler with no holdings is distinguishable from one whose
 * holdings produced no rows.
 */
function reviewRows(life: HandlerLife, root: string): readonly Row[] {
  const path = life.path;
  const rows: Row[] = [];

  // Asked before the branch, and not inside it: the answer for a handler with no holdings is this
  // function's one interesting output, and taking it from the rule rather than restating it here is
  // what keeps the mutant above dead.
  const state = stateOfLife(life);
  rows.push({ [HANDLER]: path, [FIELD]: 'state', [VALUE]: state });
  rows.push({ [HANDLER]: path, [FIELD]: 'meaning', [VALUE]: MEANING[state] });

  if (life.holdings.length === 0) {
    // A file the ledger names nothing about still has a file to look at, and a reader on a different
    // machine is not standing in this project's checkout.
    rows.push({ [HANDLER]: path, [FIELD]: 'file', [VALUE]: `${root}/${path}` });
    return rows;
  }

  rows.push({ [HANDLER]: path, [FIELD]: 'holds', [VALUE]: life.holdings.length });

  for (const holding of life.holdings) {
    rows.push({ [HANDLER]: path, [FIELD]: 'row', [VALUE]: holding.root });
    rows.push({ [HANDLER]: path, [FIELD]: 'row_status', [VALUE]: holding.status });
    rows.push({ [HANDLER]: path, [FIELD]: 'row_state', [VALUE]: holding.state });
    rows.push({ [HANDLER]: path, [FIELD]: 'row_change', [VALUE]: holding.change });
    rows.push({ [HANDLER]: path, [FIELD]: 'row_recorded_at', [VALUE]: holding.recordedAt });
  }

  if (state === 'watch') {
    // The re-read, as a command a reader can run -- because the comparison is theirs to make, and
    // the count this produces is the half of it no command can supply. `asc handlers grade` is not
    // named here: it splits before against after at the row's `applied_at`, which answers whether the
    // change helped, and a watch is asking whether the rate has come BACK.
    rows.push({
      [HANDLER]: path,
      [FIELD]: 're_read',
      [VALUE]: `asc handlers check ${path} -- then compare its count against the baseline on the row`,
    });
  }

  return rows;
}
