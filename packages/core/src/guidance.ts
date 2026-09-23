/**
 * A type's guidance (asc-bli): prose about WHY a type exists and HOW to read it, and the count
 * at which someone meant to look.
 *
 * `record_when` already says when to record a type. Nothing said why it exists or what a later
 * reader should ask of it, so a future agent had to reverse-engineer intent from the shape.
 *
 * **Prose, not identity.** Like `description` and `record_when`, guidance is carried beside a
 * spec and never inside `definitionShape`, so editing it cannot change a `type_hash` or mint a
 * version. It is kept off `TypeSpec` on purpose: the registry reads prose from its registration
 * options, not from the spec, and a field on both would be two paths to one column.
 *
 * **`review_after` is an intention, not a threshold of sufficiency.** It is the entry count at
 * which the author declared they meant to look at the type. Nobody has measured a sufficient N,
 * so naming it `min_entries` would claim a statistical property that was never computed. It
 * never gates anything: `stats.ts` already decided that every mode reports whether its N is
 * enough rather than deciding for the caller.
 */
export interface TypeGuidance {
  /** Why this type is recorded. */
  readonly purpose?: string;
  /** Open questions a later reader should ask of the entries. */
  readonly analysis_questions?: readonly string[];
  /** Semantics and gotchas: what a value, or its absence, does and does not mean. */
  readonly interpretation_notes?: string;
  /** The entry count at which someone declared they meant to look at this type. */
  readonly review_after?: number;
}

/** The guidance fields, in the order a document writes them. */
export const GUIDANCE_FIELDS = [
  'purpose',
  'analysis_questions',
  'interpretation_notes',
  'review_after',
] as const satisfies readonly (keyof TypeGuidance)[];

/**
 * Everything wrong with `guidance`, or an empty list.
 *
 * Every problem is reported at once, so a caller fixes a document in one pass. An empty string
 * or an empty list is refused rather than stored: the store never uses an empty value to mean
 * "unset" -- the field is omitted instead -- which is the rule its `description <> ''` CHECK
 * already enforces for the other prose columns.
 */
export function guidanceProblems(guidance: TypeGuidance): string[] {
  const problems: string[] = [];

  for (const field of ['purpose', 'interpretation_notes'] as const) {
    if (guidance[field] === '') {
      problems.push(`${field} is empty; omit the field to leave it unset, or give it real text`);
    }
  }

  const questions = guidance.analysis_questions;
  if (questions !== undefined) {
    if (questions.length === 0) {
      problems.push(
        'analysis_questions is empty; omit the field to leave it unset, or list at least one question',
      );
    }
    questions.forEach((question, index) => {
      if (question === '') {
        problems.push(`analysis_questions[${String(index)}] is empty; every question needs text`);
      }
    });
  }

  const reviewAfter = guidance.review_after;
  if (reviewAfter !== undefined && !(Number.isSafeInteger(reviewAfter) && reviewAfter >= 1)) {
    problems.push(
      `review_after is ${String(reviewAfter)}; it is a count of entries, so it must be a ` +
        `positive whole number`,
    );
  }

  return problems;
}
