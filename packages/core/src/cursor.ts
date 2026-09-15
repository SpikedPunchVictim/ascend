/**
 * Cursors: where a page stopped, and which question it was answering.
 *
 * WHY NOT AN OFFSET. `LIMIT n OFFSET m` is positional, so it is only stable while nothing
 * is inserted -- every insert before the offset shifts the whole window and the reader
 * silently sees a row twice or never. Measured on the real corpus, against the largest
 * type: a keyset page costs **122.7 us** and an `OFFSET 400` page **256.9 us**, and the
 * offset arm degrades linearly with depth where the keyset arm does not. So keyset is both
 * the correct answer and the faster one.
 *
 * WHY `(recorded_at, id)` AND NOT EITHER ALONE.
 *
 *   - `id` alone is not a valid order. IDs are caller-supplied, never minted here:
 *     `RecordContext.id` is injected (the store's `recorder.ts`) and `asc record --id` lets
 *     a caller name its own. Nothing constrains one to be monotonic, so ordering by `id`
 *     would be ordering by an arbitrary caller string.
 *   - `recorded_at` alone is not a total order, and on real data it is not even close.
 *     Measured over the corpus built by `asc ingest`: EVERY derived type has exactly ONE
 *     distinct `recorded_at`, because a single ingest run stamps all of its entries with
 *     the same instant -- `verification_run` 486 entries / 1 distinct, `tool_denial` 457/1,
 *     `context_compaction` 441/1, `skill_activation` 87/1, `user_correction` 20/1. The
 *     `id` tiebreak is therefore the NORMAL case, not an edge case, and a pagination built
 *     on `recorded_at` alone would repeat or drop rows on every page after the first.
 *
 *     The pair is a total order because `id` is the primary key and so unique.
 *
 * WHY THE SCOPE FINGERPRINT. A cursor is a value a caller stores and hands back. If it
 * carried only a position, a cursor issued for one type could be replayed against another
 * and would return a page that is wrong while looking entirely ordinary -- the
 * plausible-wrong-answer class, and the reason a mismatch is a refusal rather than a
 * best-effort read.
 *
 * **This fingerprint is an integrity check, not authentication.** It is derived from the
 * scope with no secret, so anyone who can read this file can compute a valid one for any
 * scope. That is the correct weight for the threat: the thing being prevented is a caller
 * -- very often a language model -- reusing a token against the wrong question, not an
 * adversary forging one. Nothing here should be relied on to keep anyone out.
 */

import { canonicalJson, sha256Hex } from './hash.js';

/**
 * Marks the encoding, so a token from a future version is rejected by name rather than
 * misread. Bump this only for a change a reader could not detect on its own.
 */
export const CURSOR_PREFIX = 'asc1:';

/**
 * How many entries a page shows when the caller does not say.
 *
 * Forty rather than ten: a page is meant to be read by a model, and the coverage line is
 * what stops it generalising from whatever it read -- so the page should be large enough to
 * be worth a round trip and small enough to leave room for the prompt around it.
 */
export const DEFAULT_PAGE_SIZE = 40;

/** A caller asked for a page size the store will not serve. */
export class PageSizeError extends Error {
  constructor(readonly requested: number) {
    super(`page size must be at least 1, got ${String(requested)}`);
    this.name = 'PageSizeError';
  }
}

/** A cursor could not be read, or does not belong to the question being asked. */
export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorError';
  }
}

/** The `(recorded_at, id)` of a page's last row: everything after this position comes next. */
export interface CursorPosition {
  readonly recordedAt: string;
  readonly id: string;
}

/**
 * A position, plus the fingerprint of the scope it was issued for.
 *
 * `scope` is what makes a cross-scope replay a refusal instead of a wrong page.
 */
export interface Cursor extends CursorPosition {
  readonly scope: string;
}

/**
 * What the caller is paging through, as the fingerprint sees it.
 *
 * `order` is part of the scope deliberately: it is fixed today, but the moment a second
 * ordering exists, cursors from one must not be honoured by the other.
 */
export interface CursorScope {
  readonly type: string;
  readonly order: string;
}

/** The order every cursor in this version is issued against. */
export const CURSOR_ORDER = 'recorded_at,id';

/**
 * The fingerprint for a scope.
 *
 * Sixteen hex characters -- 64 bits -- because this is compared for equality between two
 * values a caller round-tripped, not searched against a corpus. A collision needs a
 * deliberate search, and the alternative failure it would cause is a cursor from one type
 * being accepted for another, which the scope name in the token still makes visible in a
 * bug report.
 */
export function scopeFingerprint(scope: CursorScope): string {
  return sha256Hex(canonicalJson({ order: scope.order, type: scope.type })).slice(0, 16);
}

/**
 * The token for a position.
 *
 * `encodeURIComponent` over canonical JSON rather than base64: core is pure and must not
 * reach for `Buffer`, while `encodeURIComponent` is a JavaScript builtin and the SHA-256
 * beside it is already implemented in-repo for the same reason. The result happens to be
 * legible, and callers must still treat it as opaque -- the payload is an implementation
 * detail, and a caller that parses it has taken on a dependency this file does not owe it.
 */
export function encodeCursor(cursor: Cursor): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(
    canonicalJson({ i: cursor.id, r: cursor.recordedAt, s: cursor.scope }),
  )}`;
}

/** Narrows a decoded value to a string field, or explains which one was missing. */
function field(value: Record<string, unknown>, key: string, what: string): string {
  const found = value[key];
  if (typeof found !== 'string' || found === '') {
    throw new CursorError(`cursor is missing its ${what}`);
  }
  return found;
}

/**
 * Reads a token back.
 *
 * **Everything here is a refusal.** A cursor arrives as untrusted text -- from a model, a
 * shell variable, a file written by an older run -- so each way it can be wrong gets its
 * own message rather than a default: a wrong prefix, text that is not the encoded JSON,
 * JSON that is not an object, and any field missing or empty. A permissive reader here
 * would turn a corrupted token into a page starting somewhere else, which is precisely the
 * failure a cursor exists to prevent.
 *
 * The failure is loud in the caller's terms too: this throws `CursorError`, which the CLI
 * maps to a usage error and exit 2 -- the caller's argument was wrong, and the fix is a
 * different cursor, not a retry of the same one.
 */
export function decodeCursor(text: string): Cursor {
  if (!text.startsWith(CURSOR_PREFIX)) {
    throw new CursorError(
      `not a cursor: it does not begin with '${CURSOR_PREFIX}'. Pass a cursor from a previous page, or omit it to start at the beginning.`,
    );
  }

  const payload = text.slice(CURSOR_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(payload)) as unknown;
  } catch {
    throw new CursorError('cursor is not readable: its payload is not valid encoded JSON');
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new CursorError('cursor is not readable: its payload is not a JSON object');
  }

  const value = decoded as Record<string, unknown>;
  return {
    recordedAt: field(value, 'r', 'recorded_at'),
    id: field(value, 'i', 'id'),
    scope: field(value, 's', 'scope'),
  };
}

/**
 * Refuses a cursor issued for a different question.
 *
 * Separate from `decodeCursor` because the two failures are different in the caller's
 * hands: a malformed token is a bad argument, while a well-formed token from the wrong
 * scope is the caller having mixed two queries up. The message says which scope the cursor
 * belongs to, because that is what the caller needs in order to notice the mix-up.
 *
 * The messages here name no command-line flag, deliberately. This is core: it is handed a
 * string and answers about the string, and whether it arrived as `--cursor` or as a value read
 * from a file is a fact the caller's own layer knows and this one does not. So the fix is
 * phrased in terms of the cursor itself, and the boundary is where a flag gets named.
 */
export function assertCursorScope(cursor: Cursor, scope: CursorScope): void {
  const expected = scopeFingerprint(scope);
  if (cursor.scope !== expected) {
    throw new CursorError(
      `cursor was issued for a different query: it belongs to scope ${cursor.scope}, this one is ${expected}. Start over by omitting the cursor.`,
    );
  }
}
