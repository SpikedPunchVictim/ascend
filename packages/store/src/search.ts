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
 * **The term class is Unicode-wide, and the narrow version was a defect (`asc-bcv.8`).** The first
 * version tokenised with `/[A-Za-z0-9_]+/g`, so a query written in any script that class does not
 * cover produced no tokens at all, and `searchEntries` answered it with an empty array -- "no such
 * entry exists" for a term the index had been holding all along. Measured on a real store built
 * from the real transcripts (`/tmp/probe-b3.mjs`): `ошибка` (146 occurrences in one transcript),
 * `日本語` (186), `таймаута` (64) and `naïve` (25) each matched through a raw quoted `MATCH`, and
 * each returned **null** from `toFtsMatch` and **0 hits** from `searchEntries`.
 *
 * **It was never a non-ASCII defect; it was a short-run defect, and that is why it went unseen.**
 * `café` and `Ünicode` *worked*, by accident -- the ASCII class kept the runs `caf` and `nicode`,
 * each long enough to match, so a hit came back and nothing looked wrong. `naïve` splits into `na`
 * and `ve`, neither long enough, and returned nothing. Whether a query worked therefore depended on
 * where the non-ASCII characters happened to fall inside it.
 *
 * **The floor is 3 CODE POINTS, measured, and the check now counts in the unit the tokenizer
 * itself uses.** `日本語` (3 points) matches and `日本` (2) does not; `𐐷𐐷𐐷` (3 points, 6 UTF-16
 * units) matches and `𐐷a` (2 points, 3 units) does not. `token.length` counts UTF-16 units, so a
 * single astral letter could carry a 2-point term past the filter as a phrase that can never match
 * anything. Measured (`/tmp/probe-b3-edge.mjs`): a below-floor phrase does **not** throw -- it
 * returns 0 rows -- so that half was a silent zero rather than the crash this module exists to
 * prevent. Which is the class this module refuses, so it is fixed rather than left.
 *
 * **Widening the class is safe because every term is still quoted.** The class decides which runs
 * of the query become terms; it never decides what reaches FTS5 *as syntax*, because each term is
 * still wrapped in `"` with `"` doubled. `C++ templates` still reduces to `"templates"`, `*` still
 * reduces to null, and the hostile-input table below is unchanged by this.
 *
 * **Three sibling regexes are ASCII-only and stay that way** (`core/src/spec.ts:93,97` and
 * `cli/src/commands/query.ts:124`). All three derive SQL *identifiers*, where ASCII is a contract
 * the rest of the system relies on (`union.ts:556` depends on it). This one tokenises user
 * *prose*, where ASCII was never a contract -- only an accident of the first draft.
 */

import type { DatabaseSync } from 'node:sqlite';

/** The FTS5 table migration 2 creates. Named here once so the SQL below cannot drift from it. */
const FTS_TABLE = 'entries_fts';

/**
 * Trigram tokenizer floor, in **code points**: a term shorter than this cannot match any document.
 * Measured, not read off the docs -- `日本` (2 points) indexes nothing and can never be matched,
 * `日本語` (3) can (see the module header).
 */
const MIN_TERM_LENGTH = 3;

/**
 * A run of letters, digits or underscores, **in any script**.
 *
 * A run and not a word: the trigram tokenizer indexes every contiguous 3-character sequence with no
 * notion of a word boundary, so what this pattern decides is which stretches of the query get
 * quoted as phrases. Splitting on punctuation is therefore a query-shaping choice, not a model of
 * the index -- and it is why `busy-timeout` becomes two terms rather than one.
 */
const TERM = /[\p{L}\p{N}_]+/gu;

/**
 * Length in the unit `MIN_TERM_LENGTH` is expressed in. `.length` counts UTF-16 units, not these.
 *
 * `Array.from`, not `Intl.Segmenter`: the unit wanted is the CODE POINT, because that is what
 * FTS5's own tokenizer counts and what the floor of 3 was measured against. Graphemes would be
 * wrong here -- `e` + U+0301 is one grapheme and two code points, and SQLite counts the two.
 */
const codePointLength = (term: string): number => Array.from(term).length;

export interface SearchOptions {
  /** Cap on returned rows. Defaults to 20. */
  readonly limit?: number;
  /** Restrict to one entry type. Applied by joining `entries`, never by filtering the FTS table. */
  readonly type?: string;
}

export interface SearchHit {
  readonly entryId: string;
  /** `bm25()` is NEGATIVE -- more negative is a better match. Sorted best-first. */
  readonly score: number;
  /** Matches wrapped in `**`, for a terminal to bold. */
  readonly snippet: string;
}

/**
 * Turn free-form text into a safe FTS5 MATCH expression, or null when nothing usable remains.
 *
 * Every token is quoted as a phrase, so no character in the input can reach the FTS5 query
 * parser as syntax. Null means "no term was long enough to match anything", which the caller
 * turns into an empty result rather than an invalid query -- an empty result for a query with no
 * searchable term is the correct answer, not a failure.
 */
export function toFtsMatch(query: string): string | null {
  const tokens = (query.match(TERM) ?? []).filter(
    (token) => codePointLength(token) >= MIN_TERM_LENGTH,
  );
  if (tokens.length === 0) return null;
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
export function searchEntries(
  db: DatabaseSync,
  query: string,
  options: SearchOptions = {},
): readonly SearchHit[] {
  const match = toFtsMatch(query);
  if (match === null) return [];

  const limit = options.limit ?? 20;
  const filter = options.type === undefined ? '' : ' AND e.type_name = ?';
  // The FTS table is NOT aliased: FTS5 requires the MATCH operator's left operand to be the
  // table's own name, and `WHERE f MATCH ?` against an `AS f` fails with "no such column: f".
  const statement = db.prepare(
    `SELECT ${FTS_TABLE}.entry_id AS entry_id,
            bm25(${FTS_TABLE}) AS score,
            snippet(${FTS_TABLE}, 0, '**', '**', '...', 12) AS snippet
       FROM ${FTS_TABLE}
       JOIN entries AS e ON e.id = ${FTS_TABLE}.entry_id
      WHERE ${FTS_TABLE} MATCH ?${filter}
      ORDER BY score ASC
      LIMIT ?`,
  );

  const params: unknown[] = [match];
  if (options.type !== undefined) params.push(options.type);
  params.push(limit);

  // Mapped, not cast. The row's keys are the SQL column names; casting it to SearchHit would
  // declare `entryId` and hand back `entry_id`, so every caller would read `undefined` for the
  // one field that identifies the result -- a wrong answer that type-checks.
  interface Row {
    readonly entry_id: string;
    readonly score: number;
    readonly snippet: string;
  }

  const rows = statement.all(...(params as never[])) as unknown as readonly Row[];
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
export function indexedDocumentCount(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get() as { n: number };
  return row.n;
}
