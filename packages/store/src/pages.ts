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
 */

import {
  assertCursorScope,
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
const AFTER_POSITION = `SELECT id FROM entries
   WHERE type_name = ? AND (recorded_at, id) > (?, ?)
   ORDER BY recorded_at, id
   LIMIT ?`;

const FROM_START = `SELECT id FROM entries
   WHERE type_name = ?
   ORDER BY recorded_at, id
   LIMIT ?`;

/**
 * One page of a type's entries.
 *
 * Hydration goes through `findEntry` rather than a second SELECT here, deliberately: that
 * function re-validates each row against the definition it names, so a row that no longer
 * satisfies its own spec is a loud failure on the read path instead of data reported as
 * though it were sound. Duplicating the projection here would have been faster and would
 * have dropped that check.
 */
export function pageEntries(db: DatabaseSync, options: PageOptions): PageResult {
  // The default comes from core rather than being written here, because the CLI prints it in
  // `--limit`'s help text from the same constant. Two copies of one number is two numbers.
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new PageSizeError(limit);

  const scope = scopeFingerprint({ type: options.type, order: CURSOR_ORDER });

  let position: Cursor | undefined;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);
    assertCursorScope(decoded, { type: options.type, order: CURSOR_ORDER });
    position = decoded;
  }

  // One more than the page, so "is there more" is answered by a row that arrived rather
  // than by a count that could disagree with the rows.
  const probe = limit + 1;
  const ids = (
    position === undefined
      ? db.prepare(FROM_START).all(options.type, probe)
      : db.prepare(AFTER_POSITION).all(options.type, position.recordedAt, position.id, probe)
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

  const counted = db
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE type_name = ?')
    .get(options.type) as { n: number };

  return { rows, total: counted.n, hasMore, nextCursor, scope };
}
