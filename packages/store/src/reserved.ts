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
 * "no category without a real instance already in the corpus", and four labels have one.
 * `superseded` covers a later entry measuring the same thing better, `wrong_subject` covers an entry
 * that should never have been recorded about this subject at all, `wrong_value` covers a right
 * subject whose PRIMARY MEASUREMENT is unusable, and `duplicate` covers a second row for an event the
 * corpus already holds.
 *
 * **`duplicate` was admitted on 15 measured instances (`asc-hbxl`, 2026-10-09).** A derived entry's
 * id was a function of the sweep's READ SET as well as the event: a repeated per-event key got a `#2`
 * suffix assigned in traversal order, so a transcript appearing between two runs could write one
 * event a second time under a suffixed id (`docs/evidence/EV-45.md`, `asc-hbxl`). Those rows are the
 * 15 byte-identical duplicates. `duplicate` is none of the other three: the subject is right
 * (`wrong_subject` is out), the measurement is fine (`wrong_value` is out), and a duplicate is
 * IDENTICAL to its base, whose base is EARLIER -- whereas `superseded` names a LATER entry that
 * measures the same thing better. So `duplicate` deliberately takes no `--superseded-by`.
 *
 * **Adding it was NOT the "cheap addition" this docblock used to predict, and the correction is
 * recorded rather than quietly dropped.** The reserved scheme's shape is pinned by the compile-time
 * `INVALIDATION_SCHEME_SPEC` and compared by hash in `restoreInvalidationScheme`, so widening this
 * vocabulary changes the hash of the shape the store's OWN tracked `.ascend/schemes/0001.jsonl` line
 * carries -- and replaying that line against the new hash would be refused, breaking `asc index
 * build` on this repo's own tree. The door now also admits a frozen set of historical reserved
 * shapes (`INVALIDATION_SCHEME_HISTORY` in `annotations.ts`), which is the real cost of a fourth
 * label.
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
export const INVALIDATION_LABELS = [
  'wrong_subject',
  'wrong_value',
  'superseded',
  'duplicate',
] as const;

/** One label from the closed invalidation vocabulary. See `INVALIDATION_LABELS`. */
export type InvalidationLabel = (typeof INVALIDATION_LABELS)[number];
