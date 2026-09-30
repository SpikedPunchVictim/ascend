/**
 * The name ascend reserves for itself, and the closed vocabulary of the scheme under it.
 *
 * **Why this is a module of its own, and not a few lines further into `annotations.ts` where it
 * was written**: `sql.ts` needs `RESERVED_SCHEME` to build the invalidation predicate, and
 * `annotations.ts` needs that predicate back (`openEntriesByVersion`). One of the two has to hold
 * the name without importing the other, or the two import each other -- measured, not predicted:
 * `align` reported `arch.no-cycles: annotations.ts -> sql.ts -> annotations.ts` the first time the
 * predicate was imported into `annotations.ts` and the constant was still declared there.
 *
 * The three ways out were to spell the name a second time in `sql.ts` (which is the drift this
 * package's `sql.ts` module comment exists to prevent), to invert the dependency so the shared SQL
 * lives in the annotation module (which cycles differently -- `annotations.ts -> jsonl.ts ->
 * registry.ts -> annotations.ts`), or to put the name in a leaf both can import. This is the third.
 * It imports nothing, so it cannot take part in a cycle by construction.
 *
 * `annotations.ts` re-exports all three, so `@ascend/store`'s public surface and every existing
 * `import { RESERVED_SCHEME } from './annotations.js'` are unchanged. **The prose below moved with
 * the declarations**, because it is the reasoning for them and a reader who finds the constant here
 * should not have to go looking for why it is a string and not an enum.
 */

/**
 * The scheme name ascend reserves for itself.
 *
 * `ARCHITECTURE.md` states that invalidation is an annotation scheme rather than an edit, and the
 * `entries_are_immutable` trigger says so in its own message ("invalidation is an annotation scheme,
 * not an edit"). That sentence is only true of the code if the name cannot be taken by a
 * user-defined scheme whose rules mean something else, so registering under it is refused -- and the
 * refusal names the bead that will implement it, because a reservation with no work behind it is
 * indistinguishable from a typo.
 */
export const RESERVED_SCHEME = 'invalidation';

/**
 * The invalidation vocabulary. Closed, and deliberately short: the rule for admitting a label was
 * "no category without a real instance already in the corpus", and only these three had one when
 * asc-88m was written. `superseded` covers a later entry measuring the same thing better,
 * `wrong_subject` covers an entry that should never have been recorded about this subject at all,
 * and `wrong_value` covers a right subject whose PRIMARY MEASUREMENT is unusable. A fourth
 * label some future finding actually needs is a cheap, well-supported addition -- schemes are
 * versioned for exactly this -- so nothing here is pre-guessed against a case that has not
 * happened yet.
 *
 * **`wrong_value` is narrower than "some field is wrong", and the narrowing is deliberate
 * (`asc-y7p`).** Every label here strikes the WHOLE ENTRY -- an annotation names an `entry_id` and
 * nothing finer -- so a label may only be applied when the entry has stopped counting as a whole.
 * ARCHITECTURE.md (:219, :568) states the same rule from the other side: invalidation is for an
 * entry that "measured the wrong thing".
 *
 * The case that fixed this wording is the one it EXCLUDES. `asc-k6p.3` proposed `wrong_value` for
 * ten `user_correction` entries whose `evidence_text` carries the AskUserQuestion harness preamble
 * instead of the user's words (`dogfood/0005`). The earlier wording -- "a wrong or contaminated
 * recorded value" -- described them exactly, and applying it would still have been wrong: their
 * four declared properties are all true, the correction really happened, and `asc-m4u`'s fix
 * already ruled in code that such an entry stands (`derive.ts`: "THE ENTRY IS STILL EMITTED ...
 * the event's identity is fine, only its prose is absent"). Striking them would make any
 * invalidation-honouring count report nine corrections where nineteen occurred -- a new wrong
 * number written to suppress an old one, which is the failure invalidation exists to prevent.
 *
 * So: one contaminated field on an entry that otherwise stands is NOT `wrong_value`, and currently
 * has no label. Field-scoped invalidation is the obvious generalisation and is deliberately not
 * built, by the same rule that admitted only three labels -- one real instance is not yet a
 * category. `asc-y7p` holds the case, and a second instance of a different shape is what should
 * reopen it.
 */
export const INVALIDATION_LABELS = ['wrong_subject', 'wrong_value', 'superseded'] as const;

/** One label from the closed invalidation vocabulary. See `INVALIDATION_LABELS`. */
export type InvalidationLabel = (typeof INVALIDATION_LABELS)[number];
