/**
 * Handler end of life (`asc-09wx.8.5`): which ledger rows hold a handler, and what that leaves the
 * handler as.
 *
 * **Nothing retires a handler today, and the design's own words are the reason this exists**: *"No
 * step retires a handler today, so a handler outlives the change it measured."* A handler is a file;
 * a row is an entry; and between them there is no link anyone reads. So a handler that measured a
 * change closed two months ago is still sitting in `handlers/`, replaying on every `asc handlers
 * check`, indistinguishable from one that is live.
 *
 * **Retirement is DERIVED, and the watch is the only thing written down** (`asc-09wx.8.5`'s decision,
 * entry `1d5cbb28`). A handler named by a chain whose newest entry is `graded`, `reverted` or
 * `ungradeable` is retired by that fact -- the ledger already shows it and a property restating it
 * would be a second source for a fact that has one. `disposition: regression_watch` is the datum that
 * cannot be derived, because it is a choice, and it therefore lives on the entry that closes the row.
 * That asymmetry is the whole of the rule below: `open` and `retired` are read off `status`, and only
 * `watch` is read off `disposition`.
 *
 * **The fourth state is the absence of a state, and it is the one a reader is looking for.** A
 * handler on disk that NO row names is covered by nothing -- not by an open row, not by a watch --
 * and that is what `unheld` names. It is not a finding about the handler; it is the observation that
 * nobody has said anything about it, which is a different thing and the one worth surfacing.
 *
 * This module reads chains and a directory listing and touches nothing else: no replay, no store, no
 * clock. What a WATCH's rate is doing now is `asc handlers review`'s question, and it needs the log.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { changeOf, handlerPathOf, type LedgerRow } from './intervention.js';
import { HANDLERS_DIR } from './typed-handlers.js';

/**
 * What the ledger leaves a handler as.
 *
 * Four values, and only three of them are states a row can produce: `open` (some row's newest entry
 * is `proposed` or `applied`, so the handler is still measuring), `watch` (every row that names it is
 * closed and at least one closed saying `regression_watch`), `retired` (every row that names it is
 * closed, none watching), and `unheld` (no row names it at all -- see `handlerFiles`, which is the
 * only thing that can produce this one).
 */
export type HandlerState = 'open' | 'watch' | 'retired' | 'unheld';

/** One ledger row, read as a claim on the handler its metric names. */
export interface HandlerHolding {
  /** The chain's root entry id -- what a reader passes to `asc handlers grade`. */
  readonly root: string;
  /** The row's `change`, which is what the handler was measuring. */
  readonly change: string;
  /** The newest entry's `status`. */
  readonly status: string;
  /** What that status plus `disposition` leaves the handler as. */
  readonly state: HandlerState;
  /** The newest entry's `recorded_at`, so a reader can see how long this has stood. */
  readonly recordedAt: string;
}

/** Every row that names one handler path, and what they leave it as between them. */
export interface HandlerLife {
  /** The path exactly as `metric.handler` spells it, which is how `asc handlers check` takes it. */
  readonly path: string;
  /** One per row that names this path, in the order `ledgerRows` returned them. */
  readonly holdings: readonly HandlerHolding[];
}

/**
 * The statuses that mean a row is still measuring.
 *
 * `proposed` counts: the change has not landed, and the handler is the ruler the row intends to
 * grade with. Calling that retired would report a handler as outliving its row before the row has
 * even begun.
 */
const OPEN_STATUSES: readonly string[] = ['proposed', 'applied'];

/** The status a row must be closed at, and the disposition that keeps its handler, to be a watch. */
const WATCH_DISPOSITION = 'regression_watch';

/** A status as a reader recognizes it, or a word for its absence. */
function statusOf(row: LedgerRow): string {
  const value = row.head.properties['status'];
  return typeof value === 'string' && value.trim() !== '' ? value : '(no status)';
}

/**
 * What one row leaves its handler as.
 *
 * **A row still measuring is `open`, whatever its `disposition` says.** A watch is what a row becomes
 * when it STOPS measuring -- `applied` beside `regression_watch` is a legal row the schema does not
 * forbid, and it means "still running, and here is what to do afterwards", not "watched". Reading the
 * disposition first would report a handler as watched while a live row still reads it, and a handler
 * reported as watched is one nobody goes back to.
 *
 * This is the same precedence `stateOfLife` applies between holdings, for the same reason: the
 * question at both levels is whether anything still reads the file.
 */
function stateOf(row: LedgerRow, status: string): HandlerState {
  if (OPEN_STATUSES.includes(status)) return 'open';
  return row.head.properties['disposition'] === WATCH_DISPOSITION ? 'watch' : 'retired';
}

/**
 * Every handler any row names, with the rows that name it.
 *
 * **Grouped by the path as written, because the path is the identity here and there is no other.**
 * `metric.handler` is the one thing a row and a file can be matched on: the `sha256` beside it is the
 * ruler's identity and moves whenever the handler is edited, so grouping on it would put one
 * handler's history into two piles the first time someone fixed a typo in its `where`.
 *
 * Rows that name no handler are absent rather than collected under a placeholder: a `metric` with no
 * `handler` is refused at grade time, and inventing a row for it here would put a key in this map
 * that no file can ever match.
 */
export function handlerLives(rows: readonly LedgerRow[]): readonly HandlerLife[] {
  const byPath = new Map<string, HandlerHolding[]>();
  for (const row of rows) {
    const path = handlerPathOf(row);
    if (path === undefined) continue;
    const status = statusOf(row);
    const holding: HandlerHolding = {
      root: row.root,
      change: changeOf(row),
      status,
      state: stateOf(row, status),
      recordedAt: row.head.recorded_at,
    };
    const holdings = byPath.get(path);
    if (holdings === undefined) byPath.set(path, [holding]);
    else holdings.push(holding);
  }
  return [...byPath]
    .map(([path, holdings]) => ({ path, holdings }))
    .sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
}

/**
 * What a handler with these holdings is, overall -- `unheld` when nothing holds it.
 *
 * **Openness wins, then the watch, and retirement is what is left.** A handler can be named by more
 * than one row -- a watch row reusing a handler that a later row also measures with is the ordinary
 * case, not a hypothetical -- and the reading a reader needs is the strongest claim on it, because
 * that is the one that says whether anything still reads the file.
 *
 * `unheld` is checked first and is not a fourth rung on that ladder: no holdings is the absence of
 * any claim, which is a different kind of answer from "a closed row claims it".
 */
export function stateOfLife(life: HandlerLife): HandlerState {
  if (life.holdings.length === 0) return 'unheld';
  const states = life.holdings.map((holding) => holding.state);
  if (states.includes('open')) return 'open';
  if (states.includes('watch')) return 'watch';
  return 'retired';
}

/**
 * The handler files under the project's `handlers/`, as `handlers/<name>` paths.
 *
 * **Named the way a row spells them**, so the two sets can be compared directly: a row writes the
 * path a person typed, and every reader (`asc handlers check`) resolves it against the project root.
 * A missing `handlers/` is the ordinary state of a project that never wrote one -- `typed-handlers`
 * makes the same call for the same reason -- and is an empty listing rather than a failure.
 *
 * Deliberately NOT `loadProjectHandlers`: that compiles each file and returns only the typed and
 * `say:` ones, and the file this listing most needs to name is the one that is neither.
 */
export function handlerFiles(projectRoot: string): readonly string[] {
  let files: string[];
  try {
    files = readdirSync(join(projectRoot, HANDLERS_DIR))
      .filter((one) => /\.ya?ml$/.test(one))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files.map((file) => `${HANDLERS_DIR}/${file}`);
}

/**
 * Every handler file beside every handler the ledger names, each with what holds it.
 *
 * **A row naming a file that is not there gets an entry too, and that is the point of the union.** A
 * `metric.handler` whose file has been deleted or renamed is a row that can never be graded -- its
 * ruler is gone -- and a listing built from the directory alone would omit exactly the row that needs
 * someone to look at it.
 */
export function handlerLivesWithFiles(
  rows: readonly LedgerRow[],
  projectRoot: string,
): readonly HandlerLife[] {
  const lives = new Map(handlerLives(rows).map((life) => [life.path, life]));
  for (const path of handlerFiles(projectRoot)) {
    if (!lives.has(path)) lives.set(path, { path, holdings: [] });
  }
  return [...lives.values()].sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
}
