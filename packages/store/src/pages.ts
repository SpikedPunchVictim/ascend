/**
 * Paging entries, by cursor.
 *
 * The order and the reasons behind it are in `@ascend/core`'s `cursor.ts` -- `(recorded_at,
 * id)`, because `id` alone is caller-supplied and `recorded_at` alone is not a total order
 * on real data. This file is the half that touches the table.
 *
 * **`total` is counted, never estimated.** It is the size of the whole result set for the
 * scope, not of the page, and a coverage line that said "showing 40 of about 512" would be
 * a fabricated denominator in the one place a reader is being asked to trust a proportion.
 * One extra `COUNT(*)` per page is the price, and it is measured below rather than assumed.
 *
 * **`has_more` costs no second query.** The page query asks for one row more than the page
 * will show; if that row comes back, there is more, and it is dropped. Asking whether a
 * further row exists is then a fact about a query already run, rather than a count that
 * could disagree with it.
 *
 * **`ORDER BY recorded_at, id` is stable, and within a derived type it is not chronological
 * (`asc-bn0`).** `recorded_at` is when `asc` wrote the row, and for a type derived by `asc
 * ingest claude-code` every entry of one run shares that single instant -- measured
 * 2026-09-18 on this project's own store, 1,702 of 1,797 entries (94.7%) share one
 * `recorded_at`. Every row of a derived type therefore ties on the first key, and the
 * comparison falls through to `id` -- which is unique, so the pair stays a total order and two
 * walks of it cannot disagree. The order they agree on is by `id`, not by when anything
 * happened.
 * **This is a documented consequence, not a defect, and the clause does not change for it.**
 * `(recorded_at, id)` is total and stable, which is exactly what a keyset cursor needs --
 * `id` alone is caller-supplied and cannot be trusted as an ordering, and `recorded_at` alone
 * is not total on data this ingest produces.
 *
 * **`asc-pcu` added the second order rather than changing this one.** A chronological paging
 * mode -- ordering a derived type by a property inside `properties_json` instead -- was out of
 * scope when this file was written and is `ORDERS.event` below. It is a second `(key, id)` pair,
 * so everything above still holds of it: the `id` tiebreak is what makes it total, and it is the
 * DEFAULT that did not move. A cursor carries the order it was issued under, so the two cannot be
 * replayed against each other.
 */

import {
  assertCursorScope,
  canonicalName,
  CURSOR_ORDER_TOKENS,
  CursorError,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  PageSizeError,
  scopeFingerprint,
  type Cursor,
  type CursorOrderName,
} from '@ascend/core';
import type { SqlDatabase } from './sql-port.js';
import { findEntry, type RecordedEntry } from './recorder.js';
import { findType } from './registry.js';
import { typeFilterScope } from './type-filter.js';

/** What to page through (`asc-56k` added `filter`, joining it to the `type` scope). */
export interface PageOptions {
  readonly type: string;
  readonly cursor?: string;
  readonly limit?: number;
  /**
   * Which clock the walk is ordered by (`asc-pcu`): `stored` (the default) or `event`.
   *
   * The two are `ORDERS` below, and the name is the caller's vocabulary -- the token a cursor
   * carries for the chosen order is derived from it here, so a caller cannot name an order and a
   * token that disagree.
   */
  readonly order?: CursorOrderName;
  /**
   * A SQL predicate over `type`'s rows, with declared properties as bare columns -- see
   * `typeFilterScope` (`type-filter.ts`). Not the same vocabulary `asc annotate --scope` takes:
   * that predicate is corpus-wide, over the raw `entries` table, because it runs before any one
   * type is chosen.
   */
  /**
   * Narrow to entries that have stopped counting (`asc-bqb5`).
   *
   * The store's own invalidation predicate (`struckSql`, `sql.ts`), not a second spelling of it --
   * `asc-9xi0` collapsed every reader onto one definition so two surfaces cannot come to disagree
   * about which rows have stopped counting. Composes with `filter`: both narrow one scope.
   */
  readonly struck?: boolean;
  readonly filter?: string;
}

/** A page, with everything a caller needs to know how much of the corpus it is looking at. */
export interface PageResult {
  readonly rows: readonly RecordedEntry[];
  /** The size of the whole result set for this scope. */
  readonly total: number;
  /**
   * Entries of this type before the filter. Equal to `total` when there is no filter.
   *
   * A filtered `total` alone cannot tell "the filter excluded everything" from "there is nothing
   * here" -- `total: 0` is the same number either way, and the two need different fixes from
   * whoever is reading it: a typo in a predicate, or an empty corpus. `unfiltered` is the fact
   * that tells them apart, the same rule this project already applies to every other proportion
   * it reports (a denominator is stated, not left for the reader to assume).
   */
  readonly unfiltered: number;
  /** Whether the scope holds rows this page did not show. */
  readonly hasMore: boolean;
  /** Where to resume, or `null` when this page is the last one. */
  readonly nextCursor: string | null;
  /** The scope fingerprint this page's cursor belongs to. */
  readonly scope: string;
}

/**
 * The event-time key given to a row with no clock.
 *
 * `occurred_at` is declared but NOT `required` (`derived-types.ts`): a transcript with no timestamp
 * is a real state, and omitting is how the deriver keeps it distinguishable from an event at the
 * epoch. What the key must not be is NULL. In the row-value comparison below a NULL component makes
 * the whole comparison NULL, which is not true, so every row with no clock would be silently DROPPED
 * the moment a caller followed a cursor past it -- no error, no missing row on the page in front of
 * them, just a corpus that gets shorter as it is read.
 *
 * **`''` is the obvious substitute and it does not work, for a reason worth writing down.** The key
 * is not only compared, it is ENCODED: the position of a page's last row goes into the cursor
 * verbatim, and `decodeCursor` refuses an empty field as a corrupt token -- correctly, because a
 * truncated payload and an absent clock would otherwise be one value. A first version of this used
 * `''` and the walk stopped one page in with `cursor is missing its recorded_at`.
 *
 * So the key is a sentinel that a real `occurred_at` cannot hold and cannot sort before: the
 * `timestamp` schema requires the first character to be a digit, and `'!'` is below every digit, so
 * an absent clock compares and sorts first among the rows it is tied with -- the "sorts as `''`"
 * order `stats.ts`'s `eventOrder` gives it, in a spelling a cursor can carry.
 */
const NO_EVENT_TIME = '!';
const EVENT_TIME_PROPERTY = 'occurred_at';
const EVENT_TIME_KEY = `COALESCE(json_extract(properties_json,'$.${EVENT_TIME_PROPERTY}'),'${NO_EVENT_TIME}')`;

/**
 * One ordering over `entries`: the key rows are sorted by, and the words a refusal to cross orders
 * needs.
 *
 * The key is the FIRST position component. The second is `id` in every order, written into the
 * statements below rather than stored here -- it is the primary key, so it is the one term that
 * cannot differ between two orders, and a per-order copy of it would be two spellings that could
 * come to disagree.
 */
interface PageOrder {
  /** The sort key, as SQL. Interpolated into every statement below, never re-typed into one. */
  readonly key: string;
  /** The token this order carries in a cursor's scope (`@ascend/core`'s `CURSOR_ORDER_TOKENS`). */
  readonly token: string;
  /** What the key holds. Used only in the message a cross-order cursor is refused with. */
  readonly holds: string;
  /**
   * The declared property the key orders by, or `undefined` when the key is a column of `entries`
   * itself -- `recorded_at` is one, and so is `id`.
   *
   * Named so the "is this order defined for that type?" question is a property of the order rather
   * than a comparison against a SQL string. A third order added with no `property` is one the check
   * cannot see, and it would be added by someone editing this table, which is where the `undefined`
   * is written down.
   */
  readonly property?: string;
}

/**
 * A caller asked for an order this type cannot be put in.
 *
 * A refusal rather than a usage error, and it is raised nowhere near argv: the command line was
 * fine and this type is what said no, which is `--cluster bad-column`'s shape exactly. `asc`'s
 * `describeFailure` already maps an error that is not an oclif one to exit 1 with its message, so
 * nothing converts this at a call site -- and the message is written as the whole thing a caller
 * reads, context to fix, because that is what it becomes.
 */
export class PageOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageOrderError';
  }
}

/**
 * The keyset orders, by the name the caller asks for (`asc-pcu`).
 *
 * Written as a table and interpolated rather than typed into each statement, because the three
 * readers below have to agree about it -- a dump whose files are ordered differently from the pages
 * a caller can resume is two answers to "what is in this type", and the second one is not obviously
 * the wrong one. `@ascend/core`'s `CURSOR_ORDER_TOKENS` is the half a cursor carries, and the two
 * tables are keyed by the same name so an order cannot be added to one and not the other.
 *
 * `stored` is the default and the only one that existed before `asc-pcu`, which is why
 * `PageOptions.order` is optional rather than a required choice a caller must now make.
 */
const ORDERS: Record<CursorOrderName, PageOrder> = {
  stored: {
    key: 'recorded_at',
    token: CURSOR_ORDER_TOKENS.stored,
    holds: 'the stored clock (recorded_at)',
  },
  event: {
    key: EVENT_TIME_KEY,
    token: CURSOR_ORDER_TOKENS.event,
    holds: 'event time (the occurred_at property)',
    property: EVENT_TIME_PROPERTY,
  },
};

/** The `ORDER BY` tail for one order. The `id` tiebreak is the same term in both. */
const orderBy = (order: PageOrder): string => `ORDER BY ${order.key}, id`;

/**
 * The other order, by the name of each.
 *
 * A total map rather than a lookup with a fallback: with two orders, "the other one" always exists,
 * and a `?? undefined` here would be a branch that can never be taken -- which is how a third order
 * would arrive years later with one of its crossings silently unchecked.
 */
const CROSSED_ORDER: Record<CursorOrderName, PageOrder> = {
  stored: ORDERS.event,
  event: ORDERS.stored,
};

/**
 * Refuses an order whose key the type does not declare.
 *
 * **This is not an error SQLite would ever raise.** A type with no `occurred_at` still answers
 * `--order event`: every row's key is `''`, the walk falls through to the `id` tiebreak, and the
 * page comes back looking entirely ordinary while being an `id` order the caller will read as
 * chronological. That is the plausible-wrong-answer class, and it is worse here than a bad page,
 * because a DUMP writes the order into a `manifest.json` that outlives the command: a directory
 * whose index says `occurred_at,id` beside files in `id` order is a false claim about a durable
 * artifact, read later by someone who has no way to check it.
 *
 * **It lives here rather than at the flag, because both readers have to make it.** A page and a
 * dump of one type must not answer differently about whether the order exists, and the two readers
 * are one function apart in this file; a check written into the command line would be written twice
 * and would drift.
 *
 * `stored` cannot reach it: `recorded_at` is a column of `entries`, so that order is defined for
 * every type there is, and `property` is what says so rather than a name comparison.
 */
function assertOrderIsDeclared(db: SqlDatabase, type: string, order: PageOrder): void {
  const property = order.property;
  if (property === undefined) return;

  const declared = findType(db, type)?.spec.properties.some((spec) => spec.name === property);
  // `!== true` rather than `=== false`, so a type nobody registered is refused here too rather
  // than passing the check by being absent. Both callers look the type up first and refuse an
  // unknown one with a message that lists the names that do exist, so this is a backstop -- and a
  // backstop that let the unknown case through would be answering "the order is fine" about a type
  // that is not there.
  if (declared !== true) {
    throw new PageOrderError(
      `type '${type}' declares no ${property} property, so it has no event time: every row would ` +
        `tie on the first key and the ${order.holds} order would be this type's id order instead, ` +
        'which is not what was asked for and does not look wrong. Order it by the stored clock, or ' +
        `record it under a type that declares ${property}.`,
    );
  }
}

/**
 * The entry rows after a position, in order.
 *
 * The row-value comparison `(<key>, id) > (?, ?)` is SQLite's lexicographic pair comparison, and it
 * is the whole keyset. **Verified against the corpus rather than read off the query plan**: for the
 * stored order the plan renders the index constraint as `recorded_at>?`, which reads as though the
 * `id` term were being dropped -- and since every entry of every derived type shares one
 * `recorded_at`, that reading predicts an empty page 2. Walking `verification_run` in pages of 41
 * through this predicate returned **486 of 486 ids, 0 duplicates, 0 missing**, and the concatenated
 * pages were byte-identical to the single `ORDER BY recorded_at, id` query. So the plan display is
 * just how SQLite names the index constraint, and the pair comparison is being honoured.
 *
 * Both orders get the same treatment and for the same reason: the `id` term is not decoration, it is
 * what makes a key with millions of ties a total order.
 */
/**
 * `filterClause` is `''` with no filter, or ` AND id IN (<typeFilterScope's statement>)` with
 * one -- built once per call by `pageEntries` (asc-56k) and spliced into whichever of these two
 * statements the position decides between, so a filtered page and an unfiltered one differ by
 * exactly this one clause and cannot drift into two different `ORDER BY`s or `LIMIT`s.
 *
 * `pos` is the sort key selected back out beside the id, and it is what the minted cursor carries.
 * Asking the query for the value it compared, rather than re-deriving it in JavaScript from the
 * hydrated entry, is the difference between a position that IS the boundary the next page resumes
 * from and one that merely ought to be -- `COALESCE`'s treatment of an absent clock is the kind of
 * detail a second derivation gets wrong quietly.
 */
const afterPosition = (
  order: PageOrder,
  filterClause: string,
): string => `SELECT id, ${order.key} AS pos FROM entries
   WHERE type_name = ? AND (${order.key}, id) > (?, ?)${filterClause}
   ${orderBy(order)}
   LIMIT ?`;

const fromStart = (
  order: PageOrder,
  filterClause: string,
): string => `SELECT id, ${order.key} AS pos FROM entries
   WHERE type_name = ?${filterClause}
   ${orderBy(order)}
   LIMIT ?`;

/**
 * Every id of a type, in the order the pages walk them. No `LIMIT`, and no second ordering.
 *
 * **The `--dump` reader (`asc-hg3`), and it exists to keep one ordering rather than two.** A dump
 * writes a type's entries to files, and the entries in those files have to be the entries a page
 * would show in the order a page would show them -- otherwise the two readers disagree about what
 * the corpus contains and neither is obviously wrong. Chunking the output of `pageEntries` would
 * have worked and would have re-run its `COUNT(*)` once per file; asking for the ids and hydrating
 * them through `findEntry` instead keeps the same order, the same per-row validation, and one
 * extra query for the whole type rather than one per chunk.
 *
 * **Ids rather than hydrated rows, deliberately.** A dump hydrates a chunk at a time, so the
 * memory a dump holds is one chunk plus the id list; returning whole entries here would pull every
 * `evidence_text` of a type into memory at once, which is the cost `signatures` was split out to
 * avoid on the sampling path.
 *
 * `--order` reaches here too (`asc-pcu`), so the files a dump writes are spans of the same order the
 * pages of that type walk -- and the manifest names which one, because a directory outlives the
 * command that wrote it.
 */
const allInOrder = (order: PageOrder): string => `SELECT id FROM entries
   WHERE type_name = ?
   ${orderBy(order)}`;

/**
 * One page of a type's entries.
 *
 * Hydration goes through `findEntry` rather than a second SELECT here, deliberately: that
 * function re-validates each row against the definition it names, so a row that no longer
 * satisfies its own spec is a loud failure on the read path instead of data reported as
 * though it were sound. Duplicating the projection here would have been faster and would
 * have dropped that check.
 *
 * `options.type` is canonicalized once, into `type`, before it reaches the scope fingerprint or
 * any query (asc-pw2): `entries.type_name` is always the canonical spelling (the recorder's one
 * write path never stores anything else), so a page requested under the spelling a type was
 * authored with -- `reviewKind` rather than `review_kind` -- matched no rows and looked
 * indistinguishable from an empty type. Canonicalizing here also means the scope fingerprint is a
 * function of the type's IDENTITY rather than of the caller's spelling of it, so a page issued for
 * `reviewKind` and resumed with a cursor for `review_kind` (or vice versa) are recognised as the
 * same scope instead of refused as a mismatch.
 */
export function pageEntries(db: SqlDatabase, options: PageOptions): PageResult {
  // The default comes from core rather than being written here, because the CLI prints it in
  // `--limit`'s help text from the same constant. Two copies of one number is two numbers.
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new PageSizeError(limit);

  const type = canonicalName(options.type);

  // Through `typeFilterScope`, not `wrapPredicate` over the raw table (asc-56k): `entries`
  // projects every property inside `properties_json`, so a bare column name in a filter -- the
  // same vocabulary a declared property is named with anywhere else in `asc explore` -- would fail
  // with `no such column` against the raw table. `typeFilterScope` filters over a projection of
  // THIS type's rows with declared properties as bare columns instead, and still refuses
  // (`PredicateError`) a filter carrying a second statement rather than silently truncating it.
  // `asc-bqb5`: the scope is built when EITHER narrowing is present, because `--struck` alone is a
  // scope over the same projection -- and a `--struck --filter` pair is one scope, not two clauses
  // that could disagree.
  const narrowed = options.filter !== undefined || options.struck === true;
  const filterClause = !narrowed
    ? ''
    : ` AND id IN (${typeFilterScope(db, type, options.filter ?? null, {
        struck: options.struck === true,
      })})`;

  // `scopeFingerprint`'s `CursorScope` (`@ascend/core`) is a fixed two-field shape -- `type` and
  // `order` -- and widening a pure core type for one store-layer feature is a bigger change than
  // this bead is. So the filter is folded into the `type` half instead: two pages of the same
  // type under two different filters (or one filtered, one not) must mint two different
  // fingerprints, or a cursor from one would silently resume into rows the caller never queried
  // (this file's own module comment on why the fingerprint exists at all). `canonicalName`
  // (`spec.ts`) only ever produces `[a-z0-9_]`, so a `\u0000` separator cannot collide with a
  // real canonical type name, and this string is never compared to anything but another value
  // built the same way.
  // `--struck` joins the fingerprint for the reason the filter does: a cursor from a page of the
  // type's rows must not resume into rows a struck page never queried. The marker is the flag's own
  // name, so the two kinds of scope cannot collide with each other or with a type name.
  const fingerprintScope =
    options.filter === undefined && options.struck !== true
      ? type
      : `${type}\u0000${options.filter ?? ''}\u0000${options.struck === true ? 'struck' : ''}`;

  // The order is resolved ONCE, into the descriptor every statement and both fingerprints below
  // read. A `?? 'stored'` repeated at each use would be three places that have to agree about what
  // an absent `order` means, and the one that disagreed would mint a cursor for an order the query
  // did not use (asc-pcu).
  const order = ORDERS[options.order ?? 'stored'];
  assertOrderIsDeclared(db, type, order);
  const scope = scopeFingerprint({ type: fingerprintScope, order: order.token });

  let position: Cursor | undefined;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);

    // A cursor from the OTHER order for this same type is checked for first, and it is not the
    // general scope refusal wearing a different message. `assertCursorScope` below would catch it
    // too -- the two orders fingerprint differently, which is the whole mechanism -- but it would
    // report two hex digests and leave the caller to work out which of the two words in the request
    // they changed. This is the mistake a caller actually makes after adding `--order` to a command
    // line they already had, so it gets the sentence that names it. Which flag carries the order is
    // the caller's layer to say; this one names the clock, which is what it has.
    const crossed = CROSSED_ORDER[options.order ?? 'stored'];
    if (decoded.scope === scopeFingerprint({ type: fingerprintScope, order: crossed.token })) {
      throw new CursorError(
        `cursor was issued for a page ordered by ${crossed.holds}, and this page is ordered by ` +
          `${order.holds}. The same position means a different row in each, so resuming one as the ` +
          'other would page from a boundary neither order has. Start over by omitting the cursor, ' +
          'or ask for the order the cursor was issued under.',
      );
    }

    assertCursorScope(decoded, { type: fingerprintScope, order: order.token });
    position = decoded;
  }

  // One more than the page, so "is there more" is answered by a row that arrived rather
  // than by a count that could disagree with the rows.
  const probe = limit + 1;
  const ids = (
    position === undefined
      ? db.prepare(fromStart(order, filterClause)).all(type, probe)
      : db
          .prepare(afterPosition(order, filterClause))
          .all(type, position.recordedAt, position.id, probe)
  ) as { id: string; pos: string }[];

  const hasMore = ids.length > limit;
  const shown = hasMore ? ids.slice(0, limit) : ids;

  const rows: RecordedEntry[] = [];
  for (const row of shown) {
    const entry = findEntry(db, row.id);
    // The ids came from this same table in this same statement, so a miss means the table
    // changed underneath the read -- worth saying rather than skipping.
    if (entry === undefined) {
      throw new CursorError(`entry '${row.id}' was paged but is no longer in the store`);
    }
    rows.push(entry);
  }

  // The position comes from the row the QUERY returned, not from the hydrated entry beside it. The
  // hydrated entry carries `recorded_at` whichever order is in force, so minting the cursor from it
  // would hand back a stored-order position to a caller walking the event order -- a page 2 that
  // compares an `occurred_at` value against `recorded_at`, silently. `pos` is the value the keyset
  // predicate above actually compared.
  const last = shown[shown.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ id: last.id, recordedAt: last.pos, scope })
      : null;

  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM entries WHERE type_name = ?${filterClause}`)
    .get(type) as {
    n: number;
  };

  // The population the narrowing drew `total` from, so a caller can tell "the filter excluded
  // everything" apart from "there is nothing here" -- see `PageResult.unfiltered`. Skipped when
  // nothing narrowed the scope (`total` already answers this), and never re-run through
  // `filterClause` or `profileType`: this is one plain `COUNT(*)`, not the filtered query again and
  // not a whole map built to answer a single number (`profileType` measured 7.4 ms against
  // `findType`'s 26 us).
  //
  // The condition is `narrowed`, not `options.filter === undefined`, and the two are not the same
  // question (asc: bug-hunt #6). `counted.n` above is counted WITH `filterClause`, and
  // `filterClause` is built whenever `--struck` alone is present -- so gating on the filter alone
  // reported `unfiltered` equal to its own numerator on a struck page, which is exactly the
  // ambiguity `PageResult.unfiltered` exists to remove. `crosstab.ts` and `profile.ts` both
  // already treat `--struck` as a narrowing; this is the third of the three.
  const unfiltered = !narrowed
    ? counted.n
    : (
        db.prepare('SELECT COUNT(*) AS n FROM entries WHERE type_name = ?').get(type) as {
          n: number;
        }
      ).n;

  return { rows, total: counted.n, unfiltered, hasMore, nextCursor, scope };
}

/**
 * Every id of a type, in page order.
 *
 * The whole scope, which is what `--dump` needs and what no page-shaped reader gives: walking
 * cursors to the end would answer the same question in `ceil(n / limit)` round trips, each with a
 * `COUNT(*)` this does not need, for an answer that is the ids alone.
 *
 * Ids are hydrated by the caller through `findEntry`, so the per-row validation that makes the read
 * path loud about a row that no longer satisfies its own definition applies to a dump exactly as it
 * applies to a page. See `allInOrder` for why this returns ids rather than entries.
 *
 * `type` is canonicalized before the lookup, for the reason given on `pageEntries` above
 * (asc-pw2): `entries.type_name` is always the canonical spelling.
 *
 * `order` defaults to `stored`, so the readers that are not `asc explore` -- `corpus-lines.ts` and
 * `import.ts` -- are unchanged by `asc-pcu` and continue to answer in the order they always did. A
 * default rather than a required argument because those callers are asking "what ids are in this
 * type", a question with no order in it, and making them name one would dress a non-choice as one.
 */
export function entryIds(
  db: SqlDatabase,
  type: string,
  order: CursorOrderName = 'stored',
): readonly string[] {
  const canonical = canonicalName(type);
  const chosen = ORDERS[order];
  // Before the query, for the reason `assertOrderIsDeclared` gives: an order this type cannot be
  // put in produces a perfectly ordinary id list, and a dump would write it to disk under a manifest
  // claiming otherwise.
  assertOrderIsDeclared(db, canonical, chosen);
  const rows = db.prepare(allInOrder(chosen)).all(canonical) as { id: string }[];
  return rows.map((row) => row.id);
}
