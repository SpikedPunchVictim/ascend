/**
 * The state rule for `intervention` rows (`asc-09wx.8.1`): a chain, and what its newest entry means.
 *
 * **Why a chain rather than a status column.** Entries in this store are immutable by trigger
 * (`entries_are_immutable`); nothing updates a row. So a ledger row that moves from `proposed` to
 * `applied` to `graded` is three entries, each naming the root row it continues in `continues`, and
 * the row's CURRENT state is the newest entry in its chain. The alternative -- an annotation, which
 * the design's own wording gestured at -- was rejected because annotations in this store are the
 * invalidation mechanism (`RESERVED_SCHEME`), and a reader asking "has this entry been invalidated"
 * would see a state change as a retraction of the row it describes.
 *
 * **The cost is that chain resolution is a query each reader writes, and this is that query, once.**
 * `asc-09wx.8.5`'s brief line and end-of-life rule are the callers; both wanted the same three
 * things -- the current state, the history behind it, and whether a grade was taken too early to
 * mean anything.
 *
 * **What this deliberately does NOT do: supply the n.** The rule this file enforces is the DATE half
 * of "a row cannot be graded before its grading point" -- it knows when a grade was taken and when
 * the row's own `grading_point` falls due. It cannot know how many units the metric collected, which
 * is the other half and the half that makes a reading an anecdote rather than a small sample. That
 * number comes from replaying the handler the row names, and it belongs to `asc-09wx.8.3`, which is
 * the bead that builds the replay. A caller that has both should report the shortfall AND the n; a
 * caller that has only this file reports the shortfall and says the n is unknown, rather than
 * implying it was adequate.
 */

import { entryIds, findEntry, type SqlDatabase } from '@ascend/store';

/**
 * The fields of a stored entry this rule reads.
 *
 * Structural rather than the store's own row type on purpose: every reader that has entries has
 * these three -- `id` and `recorded_at` are envelope columns and `properties` is the decoded
 * `properties_json` -- so a caller maps its own row into this shape and nothing here depends on
 * which reader it was.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly recorded_at: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A grade taken before the chain's own grading point. */
export interface PrematureGrade {
  /** When the chain's `grading_point` falls due, as an ISO 8601 instant. */
  readonly dueAt: string;
  /** Whole days remaining. Never `0` while a grade is premature. */
  readonly daysShort: number;
}

/** One ledger row: a chain, its newest entry, and what that entry is worth reading as. */
export interface LedgerRow {
  /** The root entry's id -- what every entry in `chain` names in `continues`. */
  readonly root: string;
  /** The newest entry in the chain. Its `status` is the row's current state. */
  readonly head: LedgerEntry;
  /** Oldest first, `head` last. */
  readonly chain: readonly LedgerEntry[];
  /** Set when `head` claims a grade the row's own grading point says is too early. */
  readonly premature: PrematureGrade | undefined;
}

const DAY_MS = 86_400_000;

/** The entry id this entry continues, or `undefined` when it is itself a root. */
function continuesOf(entry: LedgerEntry): string | undefined {
  const value = entry.properties['continues'];
  // A `ref` property is a non-empty string by schema, but this is not the schema and does not
  // assume its work: an empty string is a value wearing a value's clothes, and treating it as a
  // root id would merge every such entry into one chain called "".
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Total order on a chain. `(recorded_at, id)`, never `id` alone -- ids are random UUIDs. */
function order(a: LedgerEntry, b: LedgerEntry): number {
  if (a.recorded_at !== b.recorded_at) return a.recorded_at < b.recorded_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Where a chain's grading point falls: when the wait started, how long it is, and the instant that
 * lands on.
 *
 * **Exported because a reader has two different questions about it and `premature` answers only
 * one.** `LedgerRow.premature` exists for a row that HAS been graded and says whether that grade
 * was too early; `asc-09wx.8.3`'s grader and `asc-09wx.8.5`'s due line both ask it about rows that
 * have not been graded yet -- "how long does this row mean to wait, and from when" -- which is the
 * case `premature` is absent in and cannot report. The alternative was a caller re-deriving the
 * newest `applied_at` off the chain itself, which is the second implementation of the rule below.
 */
export interface GradingPoint {
  /** The newest `applied_at` the chain states: the moment the wait started. */
  readonly appliedAt: string;
  /** The newest `grading_point` the chain states, in the unit the type names -- ACTIVE days. */
  readonly days: number;
  /**
   * `appliedAt` plus `days` in CALENDAR days, as an ISO 8601 instant -- **an EARLIER BOUND on when
   * the row's wait is up, and not the wait itself.**
   *
   * **Built from CALENDAR days, and the property it is built from is stated in ACTIVE days.** The
   * `intervention` type says `grading_point` is *"in active days -- the number `asc handlers power`
   * reports"*, and a stored instant can be built from a calendar and from nothing else: which days
   * were active is a fact about the log, and this module is handed a chain. So the instant is the
   * earliest moment the day count could possibly be up, and it is early by an amount that is a
   * property of the project rather than a rounding error.
   *
   * **The two units agree only where the log is active nearly every day.** This instant is
   * `days * 24h` after `appliedAt` whatever the window holds, and `days` ACTIVE days elapse over
   * `days / coverage` calendar days, where coverage is the share of the dates in the span that carry
   * an event. Measured over this machine's real corpora (distinct UTC dates carrying an event, over
   * the `floor(span) + 2` dates the span could have touched -- the derivation and the full table are
   * in `dogfood/0106`): 0.667 for `grizzly-wip`, 0.946 for `grizzly-exp`, 0.971 for `ascend` itself,
   * 1.000 for `grizzly-pl` and `mast`. So on this repo's own log the instant lands close to where the
   * row meant -- 0.90 calendar days early on a 30-active-day wait -- and on the sparsest real one it
   * lands **14.98 calendar days early**, with the grade it permits holding **20 of the 30 active
   * days** the row asked for.
   *
   * **Early is the false-negative direction, and that is why it matters.** `premature` below flags a
   * grade taken before this instant; if the instant arrives before the wait has actually elapsed,
   * then a grade taken AT it is not flagged. (Do not reason "active days are a subset of calendar
   * days, so this is always early": in an interval of D elapsed days there can be D+1 distinct active
   * dates. Measured on the EV-55 replay, 34 active dates over 33.269 elapsed days, which is why the
   * denominator above is the dates the span could have touched and not the span in days.)
   *
   * **THE LABEL IS THE FIX, AND EVERY CALLER OWES IT (`asc-09wx.8.5`, decision `c38bf1a2`).** Nothing
   * here can compute the accurate instant -- the log is not a parameter -- so what this property
   * carries is a bound, and a reader who is told *due* will read an early instant as a verdict. A
   * caller prints this as an earlier bound and says the row is due to BECOME READABLE; `premature`
   * below is unaffected, because a grade taken before an EARLY bound is premature whatever the
   * coverage is, which is the direction that check needs. Recomputing from the log is the accurate
   * shape and is the one to revisit if a caller ever needs an exact instant: it costs a normalizer
   * sweep in whichever reader wants it, and it prints a different date on different days.
   */
  readonly dueAt: string;
}

/**
 * A metric and the entry that stated it.
 *
 * **The entry rides along because the metric's sibling facts are on it.** `intervention` refuses a
 * `metric` with no `rule` beside it (`starters.ts`, `metricWithoutRuleIssue`), so the criterion that
 * makes a grade mean anything is a property of the SAME entry -- and a reader handed only the metric
 * object has to guess which entry to read the rule off, or scan the chain a second time and risk
 * picking a different entry than this rule did.
 */
export interface StatedMetric {
  /** The entry carrying `metric`. */
  readonly entry: LedgerEntry;
  /** That entry's `metric`, as a property bag. */
  readonly metric: Readonly<Record<string, unknown>>;
}

/** A value that can be a metric property bag, or `undefined` when it cannot be one. */
function asMetric(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The newest `metric` a chain states, with the entry that states it, or `undefined` when none does.
 *
 * **Exported because more than one reader resolves the ruler, and two implementations of "which
 * entry's metric counts" is exactly the asymmetry this module exists to prevent.** The rule is the
 * same one `gradingPoint` applies to the other two facts -- the newest statement wins -- and for the
 * same measured reason: `.8.2`'s capture mechanism applies a row as a SECOND entry whose `metric` is
 * absent, so a reader that took the head's metric would find none at all, and one that took the
 * oldest would grade against a ruler the row has since replaced.
 *
 * A non-object `metric` is skipped rather than returned: it cannot be a metric, and returning it
 * would push the shape check onto every caller.
 */
export function statedMetric(chain: readonly LedgerEntry[]): StatedMetric | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    if (entry === undefined) continue; // unreachable: a chain holds no holes.
    const metric = asMetric(entry.properties['metric']);
    if (metric !== undefined) return { entry, metric };
  }
  return undefined;
}

/**
 * Where the chain's grading point falls, or `undefined` when the chain does not say.
 *
 * **The two facts are gathered independently across the chain, because they are written at
 * different moments.** `grading_point` is written with the proposal and `applied_at` by the capture
 * mechanism when the change lands -- so they arrive on different entries, and a rule that required
 * one entry to carry both would find neither and report every premature grade as fine. A state
 * change carrying neither simply does not contribute.
 *
 * **The newest statement of each fact wins.** An entry is immutable, but a fact can be restated by a
 * later entry: `asc-09wx.8`'s D1 gives a row whose ruler changed exactly two exits, and one is to
 * take a fresh baseline, which resets `applied_at` and restarts the wait. Reading the OLDEST
 * statement would compute a due date the row has since abandoned, and -- because an abandoned due
 * date is usually the earlier one -- would report a premature grade as on time. Under-flagging is
 * the direction this check cannot afford: a grade that is too early and reads as fine is the
 * false-signal class, and a grade wrongly flagged is a message someone reads and dismisses.
 */
export function gradingPoint(chain: readonly LedgerEntry[]): GradingPoint | undefined {
  let applied: string | undefined;
  let point: number | undefined;

  for (const entry of chain) {
    const at = entry.properties['applied_at'];
    // An unparseable `applied_at` is not a date to compare against. `Date.parse` on a string the
    // schema would have refused yields NaN, and NaN propagates into a comparison as false -- which
    // would read as "not premature" and hide the missing grade point behind a passing check.
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) applied = at;

    const days = entry.properties['grading_point'];
    if (typeof days === 'number' && Number.isFinite(days)) point = days;
  }

  if (applied === undefined || point === undefined) return undefined;
  return {
    appliedAt: applied,
    days: point,
    dueAt: new Date(Date.parse(applied) + point * DAY_MS).toISOString(),
  };
}

/** The grade a `head` is claiming, when it claims one. */
function claimsGrade(head: LedgerEntry): boolean {
  return head.properties['status'] === 'graded';
}

/**
 * Every ledger row, one per chain, ordered by root id.
 *
 * A chain whose root is absent from `entries` still produces a row: a caller that filtered by date
 * or by project can hold the state changes without holding the entry that started the chain, and
 * dropping those rows would silently lose exactly the recent work a reader is looking for. The row
 * names the missing root in `root` either way.
 */
export function ledgerRows(entries: readonly LedgerEntry[], now: Date): readonly LedgerRow[] {
  const chains = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const root = continuesOf(entry) ?? entry.id;
    const chain = chains.get(root);
    if (chain === undefined) chains.set(root, [entry]);
    else chain.push(entry);
  }

  const rows: LedgerRow[] = [];
  for (const [root, unsorted] of chains) {
    const chain = [...unsorted].sort(order);
    const head = chain[chain.length - 1];
    if (head === undefined) continue; // unreachable: a chain is only created with one entry in it.

    const due = claimsGrade(head) ? gradingPoint(chain)?.dueAt : undefined;
    let premature: PrematureGrade | undefined;
    if (due !== undefined) {
      const remaining = Date.parse(due) - now.getTime();
      if (remaining > 0) {
        premature = { dueAt: due, daysShort: Math.ceil(remaining / DAY_MS) };
      }
    }

    rows.push({ root, head, chain, premature });
  }

  return rows.sort((a, b) => (a.root === b.root ? 0 : a.root < b.root ? -1 : 1));
}

/** The type whose entries form the ledger. */
const TYPE_NAME = 'intervention';

/**
 * Every `intervention` entry in the store, as the chain rule wants them.
 *
 * **A throw rather than a skip when an indexed entry cannot be read back.** Unreachable in practice
 * -- `entryIds` reads the same index `findEntry` does -- but dropping an entry shortens a chain, and a
 * shortened chain reads as a row that closed when it did not. That is the one way every reader built
 * on this file could be confidently wrong, so the impossible case is loud.
 */
export function ledgerEntries(db: SqlDatabase): readonly LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const id of entryIds(db, TYPE_NAME)) {
    const entry = findEntry(db, id);
    if (entry === undefined) {
      throw new Error(`intervention entry '${id}' is in the index but cannot be read back.`);
    }
    entries.push({ id: entry.id, recorded_at: entry.recordedAt, properties: entry.properties });
  }
  return entries;
}

/**
 * The handler path a row's metric names, or `undefined` when it states no usable one.
 *
 * **This is the only thing a row and a file can be matched on**, so it is a ledger rule rather than
 * one reader's convenience: `metric.sha256` beside it is the ruler's identity and moves whenever the
 * handler is edited, so matching on that would split one handler's history in two the first time
 * somebody fixed a typo.
 */
export function handlerPathOf(row: LedgerRow): string | undefined {
  const value = statedMetric(row.chain)?.metric['handler'];
  // Whitespace is a value wearing a value's clothes, and a path of spaces would resolve to nothing
  // while reading as a name -- `asc handlers check` would refuse it, which is a worse place to find
  // out.
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The `change` a row was filed under, for a reader being told which handler this is about. */
export function changeOf(row: LedgerRow): string {
  // The newest statement wins here too, for the reason `gradingPoint` gives: a row restated by a
  // later entry is described by the later entry.
  for (let index = row.chain.length - 1; index >= 0; index -= 1) {
    const value = row.chain[index]?.properties['change'];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '(no change stated)';
}

/**
 * A row whose wait has run out and that nobody has graded: a grade the project owes itself
 * (`asc-09wx.8.5`).
 *
 * **The instant is an EARLIER bound, and that is the safe direction here.** `gradingPoint().dueAt` is
 * built from calendar days while `grading_point` is stated in active days, so on a sparse log this
 * fires days before the wait has truly elapsed (the derivation and the measured divergence are on
 * `GradingPoint.dueAt` and in `dogfood/0106`). What it therefore cannot do is STAY SILENT about a
 * grade that is owed: it may name one a few days early, and the brief says so in as many words. The
 * opposite choice -- deriving the instant from the log -- is accurate and would print a date that
 * moves as days are lived, inside every SessionStart.
 */
export interface DueGrade {
  /** The root entry id: what `asc handlers grade` takes. */
  readonly root: string;
  /** The handler the row names, or `undefined` when its metric names none. */
  readonly handler: string | undefined;
  /** What the row says was changed, for a reader deciding whether to spend the replay. */
  readonly change: string;
  /** The newest `applied_at` the chain states. */
  readonly appliedAt: string;
  /** The newest `grading_point` the chain states, in ACTIVE days. */
  readonly days: number;
  /** The earlier bound that has passed. */
  readonly dueAt: string;
}

/**
 * The rows whose wait is up, oldest bound first.
 *
 * **`applied` only, and the three exclusions are each a different kind of "not owed".** A `proposed`
 * row has not landed, so its wait has not started; a `graded` one has been answered; and a `reverted`
 * or `ungradeable` one was closed by a decision that there is nothing to read off it. A row with no
 * `grading_point` on any entry states no wait at all -- the capture mechanism's rows are exactly that,
 * which is why they are absent here rather than owed.
 *
 * Ordered by the bound that passed rather than by root id: root ids are random UUIDs, and a list a
 * reader is shown should put the longest-waiting first.
 */
export function dueGrades(rows: readonly LedgerRow[], now: Date): readonly DueGrade[] {
  const due: DueGrade[] = [];
  for (const row of rows) {
    if (row.head.properties['status'] !== 'applied') continue;
    const point = gradingPoint(row.chain);
    if (point === undefined) continue;
    if (Date.parse(point.dueAt) > now.getTime()) continue;
    due.push({
      root: row.root,
      handler: handlerPathOf(row),
      change: changeOf(row),
      appliedAt: point.appliedAt,
      days: point.days,
      dueAt: point.dueAt,
    });
  }
  return [...due].sort((a, b) =>
    a.dueAt === b.dueAt ? (a.root < b.root ? -1 : 1) : a.dueAt < b.dueAt ? -1 : 1,
  );
}

/** `dueGrades` over a store's own ledger -- the one call both the brief and the doctor make. */
export function dueGradesIn(db: SqlDatabase, now: Date): readonly DueGrade[] {
  return dueGrades(ledgerRows(ledgerEntries(db), now), now);
}
