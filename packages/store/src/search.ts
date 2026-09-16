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
  const tokens = searchTerms(query);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * The terms a search would look for, in the order they appear.
 *
 * Extracted from `toFtsMatch` so that anything explaining a search's result works from **the same
 * tokens the search used**. A second tokenizer written for the zero-result assist would be a second
 * opinion about what the query means, and the one observable consequence would be an assist that
 * reports on terms the search never looked for -- a wrong explanation of a right answer, which is
 * harder to notice than a wrong answer.
 */
export function searchTerms(query: string): readonly string[] {
  return (query.match(TERM) ?? []).filter((token) => codePointLength(token) >= MIN_TERM_LENGTH);
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

/**
 * How many entries a search matches in total, before any limit.
 *
 * **Exists because `LIMIT` makes the result count a lie, and nothing else can correct it.** A search
 * capped at one row reports one row; a caller asking "does this corpus mention X" reads that as "it
 * mentions X once", and "how many entries discuss this" reads it as one. Measured on the frozen
 * corpus: `the` against `user_correction` matches **17** entries, and at `--limit 1` the row list
 * cannot tell that apart from a corpus that matches once.
 *
 * Cheap enough to run unconditionally: **0.0221 ms** measured against that same corpus (n=200), which
 * is the cost of `indexedCountForType` and about a 35th of the `json_each` scan the zero-result path
 * already does. The plan is an FTS index scan joined to `entries` by primary key, so it counts
 * matched documents rather than reading them.
 *
 * Returns 0 for a query with no usable term, matching `searchEntries`, so the two cannot disagree
 * about whether a query is answerable.
 */
export function countSearchMatches(
  db: DatabaseSync,
  query: string,
  options: { readonly type?: string } = {},
): number {
  const match = toFtsMatch(query);
  if (match === null) return 0;

  const filter = options.type === undefined ? '' : ' AND e.type_name = ?';
  const params: unknown[] = [match];
  if (options.type !== undefined) params.push(options.type);

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${FTS_TABLE}
         JOIN entries AS e ON e.id = ${FTS_TABLE}.entry_id
        WHERE ${FTS_TABLE} MATCH ?${filter}`,
    )
    .get(...(params as never[])) as { n: number };
  return row.n;
}

/**
 * How much of one type a search actually looked over.
 *
 * **The two numbers are the point, and they are different questions.** `entries` is the type;
 * `indexed` is the part of it the FTS index holds, which is the only part `searchEntries` can ever
 * return. When they differ, a search that returns nothing has not said "this type holds nothing like
 * that" -- it has said "the part I was able to read holds nothing like that", and those two claims
 * want opposite responses from a caller. Nothing else in the API reports the second.
 *
 * Measured on the frozen EV-11 corpus, where the distinction is not hypothetical: 1,491 entries
 * across five populated types, of which **20** are indexed -- all of them `user_correction`. The
 * other four types are an unconditional zero for every query a caller could type, `""` and single
 * common letters included, because there is no document for a query to match rather than because the
 * query was poor. `indexedCountForType` is the only way to tell those apart.
 *
 * `indexed` is counted through the join to `entries` rather than by counting non-null
 * `evidence_text` columns, because the join is what `searchEntries` runs. A store whose index had
 * fallen behind its rows would report the same number either way, and reporting the index's own view
 * is what keeps this number an explanation of the search rather than a second opinion about the
 * table.
 *
 * `docs/evidence/EV-15.md` has the corpus measurements this was built against.
 */
export interface SearchScope {
  /** Entries of this type, at any version. */
  readonly entries: number;
  /** How many of them the index holds -- the searchable part. */
  readonly indexed: number;
}

export function searchScope(db: DatabaseSync, type: string): SearchScope {
  const entries = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE type_name = ?').get(type) as {
    n: number;
  };
  const indexed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${FTS_TABLE}
         JOIN entries AS e ON e.id = ${FTS_TABLE}.entry_id
        WHERE e.type_name = ?`,
    )
    .get(type) as { n: number };
  return { entries: entries.n, indexed: indexed.n };
}

/** One property value that occurs in a type, and how many of its entries carry it. */
export interface PropertyValueHit {
  readonly property: string;
  readonly value: string;
  readonly entries: number;
}

/**
 * Property values that **actually occur** in a type and contain one of `terms`.
 *
 * This is the assist's "did you mean", and it is a different question from the one mast asks. A
 * symbol index and a text index search the same space -- code is text -- so a miss there is a
 * vocabulary miss and the fix is a better word. Ascend searches only `evidence_text`, and a
 * `verification_run` entry's `runner` is `"cargo test"` while its evidence may hold no such word.
 * Measured on the frozen corpus: `asc search verification_run "cargo"` can match nothing while **215
 * entries carry `cargo` in a property**, and the difference is not the caller's vocabulary.
 *
 * Every row is a measurement of rows that exist -- `entries` is the count of entries carrying this
 * exact value -- so a suggestion cannot name a value the type does not hold. That is deliberate and
 * it is the whole value of the feature: an assist that guesses is a second dead end with a delay.
 *
 * **Matched by containment, not by similarity, and that is a choice with a cost.** Containment has
 * no threshold to defend and no way to invent a match; the trigram floor mast uses (`minScore = 0.3`
 * in its source, with no recorded provenance) does not survive contact with this corpus -- measured
 * here, `"contxt"` finds `context` at 0.44 but `"transcipt"` finds `transcript` at nothing, because a
 * transposition breaks three of eight trigrams. So a caller's typo may find nothing here. What the
 * caller does get is a floor they can reason about: every value suggested is one that exists.
 *
 * SQLite's `LIKE` folds case for ASCII only, and this inherits that limit rather than papering over
 * it: a term differing from a stored value by non-ASCII case finds nothing.
 */
export function propertyValueMatches(
  db: DatabaseSync,
  options: { readonly type: string; readonly terms: readonly string[]; readonly limit: number },
): readonly PropertyValueHit[] {
  if (options.terms.length === 0) return [];

  // One `LIKE` per term, ORed, because a search's own terms are ORed (`toFtsMatch`) -- an assist
  // that ANDed them would report on a query the caller did not make.
  //
  // `ESCAPE` is not decoration. The terms are runs of `[\p{L}\p{N}_]+`, so `%` cannot appear but `_`
  // can: a caller searching `foo_bar` would otherwise hand SQLite a wildcard, and `LIKE '%_%'`
  // matches every non-empty value in the type. The escape character itself is escaped first, so a
  // term holding a backslash cannot consume the character after it.
  const escaped = options.terms.map((term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const where = escaped.map(() => "je.value LIKE ? ESCAPE '\\'").join(' OR ');

  const rows = db
    .prepare(
      `SELECT je.key AS property, je.value AS value, COUNT(*) AS entries
         FROM entries AS e, json_each(e.properties_json) AS je
        WHERE e.type_name = ? AND je.type = 'text' AND (${where})
        GROUP BY je.key, je.value
        ORDER BY entries DESC, je.key ASC, je.value ASC
        LIMIT ?`,
    )
    .all(
      ...matchParams(options.type, escaped, options.limit),
    ) as unknown as readonly PropertyValueHit[];

  return rows;
}

/**
 * The bound parameters, in the order the statement above names them.
 *
 * Written as one function because the type, the patterns and the limit would otherwise be three
 * spreads at the call site whose order a reader has to reconstruct from the SQL. The `as never[]` is
 * the same concession `searchEntries` makes at its own bind: the driver is typed for a primitive
 * union, and a `string[]` is not assignable to it even though every element is a string.
 */
function matchParams(type: string, patterns: readonly string[], limit: number): never[] {
  return [type, ...patterns, limit] as never[];
}
