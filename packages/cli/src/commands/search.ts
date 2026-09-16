/**
 * `asc search <type> "<text>"` -- BM25-ranked full-text search over a type's evidence text.
 *
 * **What this searches is narrower than the name suggests, and the command says so when it matters.**
 * The index covers `evidence_text` and nothing else. Properties, the type name and the envelope are
 * not in it, so a term that lives in a property is invisible here however often it occurs -- measured
 * on the frozen corpus, a search for `cargo` against `verification_run` matches nothing while **215
 * entries carry it in a `runner` property**. That is not an index defect; it is the boundary of what
 * was indexed, and a search that reported only `[]` would let a caller conclude the corpus lacks the
 * term. So the zero-result path reports what was searched and where else the terms actually occur.
 *
 * **Ranking is BM25 and the scores are negative.** FTS5's `bm25()` returns lower-is-better, so the
 * rows come best-first and a more negative `score` is a better match. That is inverted from every
 * intuition a caller brings, so the column is named `score` and documented rather than left to be
 * discovered. The score is comparable within one result set only: it is a function of the corpus's
 * own term statistics, so a -2 in one type is not a -2 in another.
 *
 * **The snippet is the answer, not the entry.** A search result a caller has to follow with a second
 * read is a search that saved nothing. Each row carries the matched text with the matched terms
 * wrapped in `**`, which is the same convention `asc explore --sample` uses.
 *
 * Read-only by construction: `searchEntries` issues one `SELECT`, and the connection is opened by
 * `withProject` on the same terms every other reading command uses.
 */

import { Args, Flags } from '@oclif/core';
import { DEFAULT_PAGE_SIZE } from '@ascend/core';
import {
  countSearchMatches,
  findType,
  propertyValueMatches,
  searchEntries,
  searchScope,
  searchTerms,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import { knownNames } from '../register-document.js';
import { buildAssist } from '../search-assist.js';
import { subset, type Output, type Row } from '../output.js';

/**
 * How many property values the assist will name.
 *
 * Five, and the bound is a judgement rather than a measurement -- stated plainly because a number
 * that looks measured and is not is the kind of thing this project refuses. The reason it is small:
 * the assist is read at the moment a caller has already failed once, and a wall of candidates is
 * another decision to make at the worst moment to make one. Measured on the frozen corpus, the
 * suggestions a real query produces are few anyway -- `cargo` against `verification_run` yields
 * three, `bash` against `tool_denial` yields one -- so this cap trims nothing a caller would want.
 */
const ASSIST_VALUE_LIMIT = 5;

export default class Search extends BaseCommand {
  static override description =
    "Search one entry type's evidence text, best match first. The index covers evidence_text only " +
    '-- not properties, not the type name -- so a term that occurs in a property is invisible here, ' +
    'and a search that finds nothing says why and reports where else the terms occur. Scores are ' +
    "FTS5's bm25(): they are NEGATIVE and lower is better, and they compare within one result set " +
    'rather than across types.';

  static override args = {
    type: Args.string({
      required: true,
      description: 'The entry type to search. A name that is not registered is refused.',
      ignoreStdin: true,
    }),
    text: Args.string({
      required: true,
      description:
        'The text to search for. Split into runs of letters, digits and underscores, each matched ' +
        'as a phrase; a query with no run of three or more is refused rather than matched.',
      ignoreStdin: true,
    }),
  };

  static override flags = {
    limit: Flags.integer({
      description: `Maximum rows to return. Defaults to ${String(DEFAULT_PAGE_SIZE)}.`,
      min: 1,
    }),
  };

  static override examples = [
    '<%= config.bin %> search user_correction "wrong directory"',
    '<%= config.bin %> search verification_run "cargo test" --limit 5',
    '<%= config.bin %> search tool_denial "permission" --json',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Search);
    const format = this.resolveFormat(flags);
    const limit = flags.limit ?? DEFAULT_PAGE_SIZE;

    // Refused before the store is opened, because it is a fact about the query and not about the
    // project. `toFtsMatch` turns a query with no usable term into null and `searchEntries` into an
    // empty array, which would be an answer of "nothing matches" to a question that was never asked:
    // the term was too short to match anything, so the empty array is a fact about the tokenizer.
    // A caller who reads it as "the corpus lacks this" has been told something false by a command
    // that reported success -- the class this project treats as severity-zero.
    const terms = searchTerms(args.text);
    if (terms.length === 0) {
      throw usageError(
        `'${args.text}' holds no searchable term. A term is a run of letters, digits or underscores ` +
          `at least 3 characters long, which is what the trigram index can match -- so a shorter ` +
          `one cannot be matched however the index is built. Search for a longer word, or read the ` +
          `type's entries with 'asc explore ${args.type}'.`,
      );
    }

    await this.withProject(({ store }) => {
      // A name nobody registered is a mistyped name or the wrong project, and it is a different
      // answer from "your search found nothing" -- which is a real result, and one this command
      // explains at length rather than refusing. Refused here for the reason `asc explore` refuses
      // it: silence would report a typo as an empty corpus.
      const db = store.db;
      if (findType(db, args.type) === undefined) {
        throw refusal(
          `There is no entry type named '${args.type}' in this project. ${knownNames(store)}`,
        );
      }

      const hits = searchEntries(db, args.text, { limit, type: args.type });
      const rows: Row[] = hits.map((hit) => ({
        id: hit.entryId,
        score: hit.score,
        snippet: hit.snippet,
      }));

      // The assist is built from measurements taken on the zero-result path only. Two full-corpus
      // counts and one `json_each` scan are affordable exactly because a caller who got rows never
      // pays for them -- and a caller who got none is the only one who needs them.
      const assist =
        rows.length > 0
          ? undefined
          : buildAssist(
              searchScope(db, args.type),
              propertyValueMatches(db, {
                type: args.type,
                terms,
                limit: ASSIST_VALUE_LIMIT,
              }),
            );

      // `total` is counted rather than inferred from `rows.length`, and this is the severity-zero
      // guard rather than a nicety. `Output.coverage` defaults to `complete(rows)`, which asserts
      // that the rows shown are the whole result -- and under a LIMIT that is false. Measured on
      // the frozen corpus: `the` against `user_correction` matches 17 entries and at `--limit 1`
      // the row list holds one, so the default would have reported `shown: 1, total: 1,
      // has_more: false` -- a search that found 17 things claiming it found exactly one, in the one
      // field a consumer reads to decide whether it has the whole answer. The count costs 0.0221 ms
      // on the same corpus, which is less than the assist's own scan and is paid on every search
      // rather than only on the empty ones.
      const total = countSearchMatches(db, args.text, { type: args.type });

      const output: Output = {
        columns: ['id', 'score', 'snippet'],
        rows,
        // Stated only when the limit actually withheld something. `complete(rows)` and an honest
        // `subset(n, n, false)` are the same statement, and the defaulted one says it for free.
        ...(rows.length < total ? { coverage: subset(rows.length, total, true) } : {}),
        ...(assist === undefined ? {} : { assist }),
      };

      this.emit(format, output);
    });
  }
}
