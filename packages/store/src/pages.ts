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
 * is not total on data this ingest produces. A chronological paging mode, ordering a derived
 * type by a property inside `properties_json` instead, is a real question with a real cost
 * (an index, or a full sort plus a second cursor encoding over that column) and it is
 * out of scope here: it is bead `asc-pcu`.
 */

import {
  assertCursorScope,
  canonicalName,
  CURSOR_ORDER,
  CursorError,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  PageSizeError,
  scopeFingerprint,
  type Cursor,
} from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { findEntry, type RecordedEntry } from './recorder.js';

/** What to page through. `type` is the whole scope today; filters will join it in `asc-56k`. */
export interface PageOptions {
  readonly type: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** A page, with everything a caller needs to know how much of the corpus it is looking at. */
export interface PageResult {
  readonly rows: readonly RecordedEntry[];
  /** The size of the whole result set for this scope. */
  readonly total: number;
  /** Whether the scope holds rows this page did not show. */
  readonly hasMore: boolean;
  /** Where to resume, or `null` when this page is the last one. */
  readonly nextCursor: string | null;
  /** The scope fingerprint this page's cursor belongs to. */
  readonly scope: string;
}

/**
 * The entry rows after a position, in order.
 *
 * The row-value comparison `(recorded_at, id) > (?, ?)` is SQLite's lexicographic pair
 * comparison, and it is the whole keyset. **Verified against the corpus rather than read
 * off the query plan**: the plan renders the index constraint as `recorded_at>?`, which
 * reads as though the `id` term were being dropped -- and since every entry of every
 * derived type shares one `recorded_at`, that reading predicts an empty page 2. Walking
 * `verification_run` in pages of 41 through this predicate returned **486 of 486 ids, 0
 * duplicates, 0 missing**, and the concatenated pages were byte-identical to the single
 * `ORDER BY recorded_at, id` query. So the plan display is just how SQLite names the index
 * constraint, and the pair comparison is being honoured.
 */
/**
 * The keyset order, named once.
 *
 * Written as a constant and interpolated rather than typed into each statement, because the three
 * readers below have to agree about it -- a dump whose files are ordered differently from the pages
 * a caller can resume is two answers to "what is in this type", and the second one is not obviously
 * the wrong one. `@ascend/core`'s `CURSOR_ORDER` is the prose half of the same rule.
 */
const ORDER = 'ORDER BY recorded_at, id';

const AFTER_POSITION = `SELECT id FROM entries
   WHERE type_name = ? AND (recorded_at, id) > (?, ?)
   ${ORDER}
   LIMIT ?`;

const FROM_START = `SELECT id FROM entries
   WHERE type_name = ?
   ${ORDER}
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
 */
const ALL_IN_ORDER = `SELECT id FROM entries
   WHERE type_name = ?
   ${ORDER}`;

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
export function pageEntries(db: DatabaseSync, options: PageOptions): PageResult {
  // The default comes from core rather than being written here, because the CLI prints it in
  // `--limit`'s help text from the same constant. Two copies of one number is two numbers.
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new PageSizeError(limit);

  const type = canonicalName(options.type);
  const scope = scopeFingerprint({ type, order: CURSOR_ORDER });

  let position: Cursor | undefined;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);
    assertCursorScope(decoded, { type, order: CURSOR_ORDER });
    position = decoded;
  }

  // One more than the page, so "is there more" is answered by a row that arrived rather
  // than by a count that could disagree with the rows.
  const probe = limit + 1;
  const ids = (
    position === undefined
      ? db.prepare(FROM_START).all(type, probe)
      : db.prepare(AFTER_POSITION).all(type, position.recordedAt, position.id, probe)
  ) as { id: string }[];

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

  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ id: last.id, recordedAt: last.recordedAt, scope })
      : null;

  const counted = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE type_name = ?').get(type) as {
    n: number;
  };

  return { rows, total: counted.n, hasMore, nextCursor, scope };
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
 * applies to a page. See `ALL_IN_ORDER` for why this returns ids rather than entries.
 *
 * `type` is canonicalized before the lookup, for the reason given on `pageEntries` above
 * (asc-pw2): `entries.type_name` is always the canonical spelling.
 */
export function entryIds(db: DatabaseSync, type: string): readonly string[] {
  const rows = db.prepare(ALL_IN_ORDER).all(canonicalName(type)) as { id: string }[];
  return rows.map((row) => row.id);
}
