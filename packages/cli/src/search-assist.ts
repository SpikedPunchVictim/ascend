/**
 * What `asc search` has to say beyond its rows, said as something the caller can act on.
 *
 * **The failure this exists to prevent is the dead-end query.** A caller -- most often a model --
 * searches, gets `[]`, and has no way to tell four different situations apart: the type is empty;
 * the type has entries but none of them is searchable; the type is partly searchable and the query
 * missed the searchable part; the query missed a type that was fully searchable. All four print the
 * same nothing, and the responses they want are different -- record something, stop searching and
 * read a property instead, try a different word, or accept that the term is absent. A `[]` with no
 * explanation converts every one of those into the same next move, and the next move is usually to
 * stop using the command.
 *
 * **This block is no longer confined to the zero-result path, and the reason is a measurement.**
 * Gating it on `rows.length === 0` was coherent with its name and wrong about its consequence: a
 * term living in a property then became findable or not according to whether an unrelated row
 * happened to match the same query. Measured on a corpus earned from live workflows
 * (`docs/evidence/EV-17.md`), of the searches in the one type that can exhibit the case, 95 returned
 * nothing and 7 returned rows -- and every one of those 7 withheld a property match the corpus
 * literally holds. There were zero searches that returned rows without withholding something. So a
 * result set that looks complete while a substring match sits in the store unreachable is the
 * "reports success wrongly" class, and it now costs one `json_each` scan per search (0.1228 ms
 * measured, 1.01x the FTS query it accompanies) to not do that.
 *
 * **The measurements are what make this honest.** Every number here is read from the store at the
 * moment of the search: how many entries of the type exist, how many of them the index holds, and
 * how many entries carry each value suggested. Nothing is inferred, guessed, or padded. An assist
 * that invents a suggestion is worse than an empty one -- it is a second dead end, reached after a
 * round trip, wearing the badge of help.
 *
 * **What this deliberately does NOT do is guess at vocabulary.** The mechanism this is modelled on
 * suggests near-miss words by trigram similarity over its index. That works when one index holds the
 * whole searchable space, which is true of a code index and false here: `evidence_text` is only one
 * of the places a value can live, and on the frozen corpus it is the *smaller* one. Matching terms
 * against **property values that exist** is the same idea pointed at the space ascend actually has,
 * and it gives a floor a caller can reason about: a suggested value is always one some entry
 * carries, never a word that merely looks like a word. Measured, the vocabulary pass it replaces
 * finds nothing at all for a transposition typo at its own floor, over a vocabulary whose median
 * document frequency is 1 -- `docs/evidence/EV-15.md` has both measurements and the decision.
 */

import type { PropertyValueHit, SearchScope } from '@ascend/store';

/** One property value that occurs in the type, offered as a lead rather than as a result. */
export interface AssistValue {
  readonly property: string;
  readonly value: string;
  /** How many entries of this type carry this exact value. A measurement, never an estimate. */
  readonly entries: number;
  /**
   * How many of those entries have been struck (`asc-9xi0`). A COUNT, because a group aggregates
   * entries -- a value carried by three entries of which one is struck is neither marked nor
   * unmarked. The value is not withheld: this list's promise is that every row is a measurement of
   * rows that exist, and a struck row exists. What the count changes is what the SUGGESTION is
   * worth, which is the caller's judgement to make rather than this list's to make by omission.
   */
  readonly struck: number;
}

/**
 * What the search had to say for itself, as one of four exhaustive cases.
 *
 * A code rather than a sentence, because the caller that most needs this is a program. The prose is
 * derived from the code at render time, so `--json` consumers branch on `reason` and terminal users
 * read the same fact written out -- one source for both, which is what stops the two drifting.
 *
 * `rows-returned` is the one case that is not a dead end, and it exists because silence there was a
 * measured defect rather than a design. The other three are about the type and the query; this one
 * is about the result, and the assist accompanies it rather than explaining it.
 */
export type AssistReason = 'rows-returned' | 'type-empty' | 'nothing-indexed' | 'no-match';

/**
 * What a search has to say for itself beyond its rows.
 *
 * **Present on every search, including one that returned rows.** Absent is no longer a signal, and
 * `reason` says which case this is: a consumer that cares only about dead ends tests for the three
 * zero-result codes rather than for the block's presence.
 *
 * The block appears even when its lists are empty, because "the search looked at 20 entries and none
 * matched" is a different fact from "no search was run".
 */
export interface SearchAssist {
  readonly reason: AssistReason;
  /** Entries of this type that exist. */
  readonly entries: number;
  /** How many of them the index holds -- everything the search could have matched. */
  readonly indexed: number;
  /**
   * How many of `entries` have stopped counting (`asc-9xi0`).
   *
   * `entries` stays the recorded total -- it is what `assistReason` tests for `type-empty`, and a
   * type holding 300 rows is not an empty type however many of them were struck. This is the number
   * the rendered coverage sentence leads with instead: for a caller who got nothing back, "how much
   * of this type still stands" is the question being asked.
   */
  readonly struck: number;
  /**
   * Property values that actually occur in this type and contain a term of the query.
   *
   * Each carries the count of entries of this type holding that exact value. It is **not** the count
   * withheld from this result set -- a suggested value may be carried by entries already shown. The
   * number is a measurement of the type, and reading it as "you are missing N" would be reading more
   * than it says.
   */
  readonly values: readonly AssistValue[];
}

/**
 * Name the reason, from the two counts, the result, and nothing else.
 *
 * Kept apart from the store and from the renderer so it can be exercised at every boundary without
 * a database: `entries`, `indexed` and whether rows came back are the whole input, and the
 * interesting cases -- an empty type, a type whose entries carry no evidence, a type that is partly
 * indexed, a search that succeeded -- are four lines of a table rather than four databases.
 *
 * The order of the tests is load-bearing, not stylistic. `rowsReturned` is tested first because a
 * search that returned rows is not any kind of dead end, and because the other three codes are
 * questions about why nothing came back. Then: a type with no entries also has no indexed documents,
 * so `nothing-indexed` is the true answer to a narrower question and `type-empty` is the true answer
 * to the one the caller is asking -- testing `indexed === 0` first would tell a caller their entries
 * are unsearchable when they have no entries at all.
 */
export function assistReason(scope: SearchScope, rowsReturned: boolean): AssistReason {
  if (rowsReturned) return 'rows-returned';
  if (scope.entries === 0) return 'type-empty';
  if (scope.indexed === 0) return 'nothing-indexed';
  return 'no-match';
}

/**
 * Build the assist from measurements that have already been taken.
 *
 * `rowsReturned` is passed rather than inferred from the counts: the counts describe the type, and
 * whether this particular query matched is a fact only the caller holds.
 */
export function buildAssist(
  scope: SearchScope,
  values: readonly PropertyValueHit[],
  rowsReturned: boolean,
): SearchAssist {
  return {
    reason: assistReason(scope, rowsReturned),
    entries: scope.entries,
    indexed: scope.indexed,
    struck: scope.struck,
    values: values.map((hit) => ({
      property: hit.property,
      value: hit.value,
      entries: hit.entries,
      struck: hit.struck,
    })),
  };
}

/**
 * The assist as lines of text, for `--table` and `--csv`-less output.
 *
 * Wrapped rather than written as one long line, because the whole point is that a reader takes it
 * in: a single 300-character sentence about index coverage is one a caller skips, and skipping it
 * leaves them exactly where the bare `[]` did.
 *
 * The count of entries is phrased to be true when it is one. `1 entries` is the kind of detail that
 * makes a reader distrust every other number on the line.
 */
export function renderAssist(assist: SearchAssist): string {
  // Both sentences that state the type's size go through this, so the struck phrasing is defined
  // once and the unstruck path keeps the bytes it always had (`standingPhrase`).
  const standing = standingPhrase(assist);
  const returned = assist.reason === 'rows-returned';
  // No lead line when rows came back: the rows above are the answer, and this block is only what
  // they do not cover. Printing 'no matches.' under a result set would be the exact falsehood this
  // block exists to prevent, and it would be printed by the block itself.
  const lines: string[] = returned ? [] : ['no matches.'];

  if (assist.reason === 'type-empty') {
    lines.push(
      `This type has no entries yet, so there is nothing for a search to find. Record one with`,
      `'asc record', or check you are in the project you meant.`,
    );
  } else if (assist.reason === 'nothing-indexed') {
    // The dead-end case, and the one worth the most words: a caller here will otherwise retry with
    // different words forever, because nothing they type can ever match.
    lines.push(
      `This type has ${standing}, and the index holds none of them: the index covers`,
      `'evidence_text', and no entry of this type carries any. No query can match, so retrying`,
      `with different words will not help -- the type's properties are where its content is.`,
    );
  } else if (assist.reason === 'no-match') {
    lines.push(
      `This type has ${standing}, of which the index holds ${String(assist.indexed)} --`,
      `only entries with evidence text are searchable, so a term absent from those cannot match`,
      `however it is spelled.`,
    );
  }

  if (assist.values.length > 0) {
    lines.push(
      '',
      returned
        ? 'The query terms also occur as property values, which a search does not cover:'
        : 'The query terms do occur as property values, which a search does not cover:',
    );
    for (const value of assist.values) {
      lines.push(`  ${value.property} = ${JSON.stringify(value.value)}  (${valuePhrase(value)})`);
    }
  } else if (returned) {
    // The reassuring half, and the reason this block is worth its cost on the rows>0 path: it says
    // the result is complete with respect to both halves of a search, so a caller who would
    // otherwise wonder whether something was withheld does not have to.
    lines.push(
      '',
      'No property value of this type contains a term of the query, so there is nowhere else in',
      'this type those terms occur.',
    );
  } else if (assist.reason === 'no-match') {
    // Said rather than left as an empty section, so a caller can tell "nothing was found" from
    // "the search for property values did not run". Same distinction the optional blocks make.
    lines.push('', 'No property value of this type contains a term of the query either.');
  }

  return lines.join('\n');
}

/**
 * The count of entries, phrased so it leads with what STANDS when anything has been struck, and
 * reads exactly as it did before when nothing has (`asc-9xi0`).
 *
 * **The struck phrasing names all three numbers.** A caller reading "2 entries that stand" alone
 * would take it for the type's size; the parenthetical gives the recorded total it was taken out of
 * and what was taken out, so the standing count is one number on a line rather than the only one.
 *
 * **The index clause stays on the recorded total** (`of which the index holds N`), because the index
 * does not know about strikes: it holds a document for every entry with evidence text, struck or
 * not, and reporting a live share there would describe a search nobody runs.
 */
function standingPhrase(assist: SearchAssist): string {
  const entries = `${String(assist.entries)} ${assist.entries === 1 ? 'entry' : 'entries'}`;
  if (assist.struck === 0) return entries;
  const live = assist.entries - assist.struck;
  return (
    `${String(live)} ${live === 1 ? 'entry' : 'entries'} that ${live === 1 ? 'stands' : 'stand'} ` +
    `(${String(assist.entries)} recorded, ${String(assist.struck)} struck)`
  );
}

/**
 * One suggested value's parenthetical: today's bytes when nothing carrying it was struck, and the
 * struck count added when something was.
 *
 * `-- all struck` when every entry carrying the value has been struck, because that is the shape a
 * caller must not have to derive from two numbers: the suggestion is a value the type holds and no
 * longer stands behind.
 */
function valuePhrase(value: AssistValue): string {
  const n = `${String(value.entries)} ${value.entries === 1 ? 'entry' : 'entries'}`;
  if (value.struck === 0) return n;
  const all = value.struck === value.entries ? ' -- all struck' : '';
  return `${n}, ${String(value.struck)} struck${all}`;
}
