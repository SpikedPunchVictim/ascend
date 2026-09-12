/**
 * Full-text search over `evidence_text`.
 *
 * The index is created by migration 2 (see `schema.ts` for why trigram, and why a standalone FTS
 * table rather than external content). This module is the query side.
 *
 * **`toFtsMatch` is not a nicety -- it is required for the query path to work at all.** EV-fts
 * passed raw user-shaped queries straight to `MATCH` on real data and **8 of 14 threw a SQL
 * error**: `"unbalanced quote` -> `unterminated string`, `col:value` -> `no such column: bar`.
 * FTS5 reads `-`, `:`, `(`, `"`, `AND`, `OR` and `NEAR` as query SYNTAX, so ordinary text --
 * `error (timeout)`, `why did it fail?`, `C++ templates` -- is a malformed query.
 *
 * **And the obvious sanitizer is the wrong fix.** Wrapping the whole raw query in one quoted
 * phrase throws 0/14 but returns EMPTY for 9-13 of them, because a single phrase must match the
 * user's entire string contiguously. That trades a crash for a silent zero-result, which EV-fts
 * measured as the worse of the two failures: a query that returns nothing is indistinguishable
 * from "no such entry exists", and ascend exists to answer questions about a corpus that DOES
 * have the answer. So the sanitizer tokenizes into terms and ORs them, exactly as mast's does.
 *
 * **`OR`, not `AND`** -- ported with mast's measured reason (their F15). FTS5 ANDs bare
 * space-separated terms, so a multi-word query would require every term in one document. Against
 * a real corpus that returned zero rows for 6 of 20 queries whose target was plainly present.
 * `bm25()` already ranks by term coverage, so a document matching every term still outranks one
 * matching a single common term: OR widens the candidate pool and lets the ranker discriminate.
 *
 * The trigram tokenizer's floor is 3 characters, so shorter terms cannot match and are dropped --
 * which is also why the token filter is 3 and not 1.
 */
/** The FTS5 table migration 2 creates. Named here once so the SQL below cannot drift from it. */
const FTS_TABLE = 'entries_fts';
/** Trigram tokenizer floor: a term shorter than this cannot match any document. */
const MIN_TERM_LENGTH = 3;
/**
 * Turn free-form text into a safe FTS5 MATCH expression, or null when nothing usable remains.
 *
 * Every token is quoted as a phrase, so no character in the input can reach the FTS5 query
 * parser as syntax. Null means "no term was long enough to match anything", which the caller
 * turns into an empty result rather than an invalid query -- an empty result for a query with no
 * searchable term is the correct answer, not a failure.
 */
export function toFtsMatch(query) {
    const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? []).filter((token) => token.length >= MIN_TERM_LENGTH);
    if (tokens.length === 0)
        return null;
    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}
/**
 * Search `evidence_text`, best match first.
 *
 * The type filter joins `entries` rather than constraining the FTS table, because FTS5's
 * `xBestIndex` will not consume an equality constraint on a non-rowid column -- mast measured
 * that as a full scan at 91.7% of a write phase -- and `entry_id` is UNINDEXED, so a `WHERE` on
 * it here would scan the whole index.
 *
 * **The filter is a POST-filter, and the measurement matters more than the intent.** `EXPLAIN
 * QUERY PLAN` run with and without it produces the SAME plan:
 *
 *     SCAN entries_fts VIRTUAL TABLE INDEX 0:M2
 *     SEARCH e USING COVERING INDEX sqlite_autoindex_entries_1 (id=?)
 *
 * `idx_entries_type_time` is never used. The planner drives from the MATCH -- which is the
 * selective constraint, so this is a reasonable choice -- and looks each candidate up by primary
 * key, discarding the ones whose type does not match afterwards. So the filter is CORRECT but it
 * does not reduce the FTS scan, and a caller must not read `type` as a scope that makes a broad
 * query cheap. An earlier draft of this comment claimed the join "can be driven by a predicate";
 * the plan says otherwise, and the comment was corrected rather than the plan.
 *
 * The join is kept unconditionally so there is one query path instead of two that could drift.
 *
 * Returns an empty array, never throws, for a query with no usable term. A caller that cannot
 * tell "no results" from "your query was rejected" cannot report either honestly.
 */
export function searchEntries(db, query, options = {}) {
    const match = toFtsMatch(query);
    if (match === null)
        return [];
    const limit = options.limit ?? 20;
    const filter = options.type === undefined ? '' : ' AND e.type_name = ?';
    // The FTS table is NOT aliased: FTS5 requires the MATCH operator's left operand to be the
    // table's own name, and `WHERE f MATCH ?` against an `AS f` fails with "no such column: f".
    const statement = db.prepare(`SELECT ${FTS_TABLE}.entry_id AS entry_id,
            bm25(${FTS_TABLE}) AS score,
            snippet(${FTS_TABLE}, 0, '**', '**', '...', 12) AS snippet
       FROM ${FTS_TABLE}
       JOIN entries AS e ON e.id = ${FTS_TABLE}.entry_id
      WHERE ${FTS_TABLE} MATCH ?${filter}
      ORDER BY score ASC
      LIMIT ?`);
    const params = [match];
    if (options.type !== undefined)
        params.push(options.type);
    params.push(limit);
    const rows = statement.all(...params);
    return rows.map((row) => ({
        entryId: row.entry_id,
        score: row.score,
        snippet: row.snippet,
    }));
}
/**
 * How many indexed documents the store holds.
 *
 * Exists so a caller can tell "the corpus has nothing like this" from "the index was never
 * built" -- two situations that produce an identical empty result and want opposite responses.
 */
export function indexedDocumentCount(db) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get();
    return row.n;
}
//# sourceMappingURL=search.js.map