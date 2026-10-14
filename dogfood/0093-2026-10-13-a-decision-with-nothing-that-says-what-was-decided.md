# 0093 — a decision with nothing that says what was decided

| | |
|---|---|
| **Bead** | `asc-f3at` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | recording the decision to fold Cut 1 into Cut 3 during `asc-09wx.14`, then reading the entry back through the generated view |
| **Entry type(s)** | `decision` (starter) |
| **Severity** | P3 |
| **Status** | open |

## What was found

The starter `decision` type declares `options_considered`, `chosen`, `rationale` and
`reversibility`. **None of them is the question.** So the record of a choice says what was picked
and why, and never what it was picked *about* — and because `chosen`'s own guidance asks for the
option taken rather than for the subject, an author who does exactly what the type asks still
produces an entry a later reader cannot resolve without guessing.

There is a second half, and it is the reason this went unnoticed rather than refused. An undeclared
property is not an error. `packages/core/src/state.ts` strips it and reports why —
*"`'question'` is not a property of decision, so it was dropped"* — and the record still succeeds.
That behaviour is deliberate and documented in place: *"Stripped rather than rejected: a stripped
key is recoverable and visible, a rejected entry is lost work. Stripping is reported so it cannot
be silent."* The strip is right. The gap is that the type offers nowhere for the stripped key to
go, so the caller who tried to state the question is told to remove it or declare a new version —
and the ordinary outcome is that they remove it.

## How it surfaced

**Nobody was looking for it.** It came from an ordinary action: recording a decision, then reading
the entry back through `v_decision_v1` to confirm it had landed. The four keys were there. The
question was not, and had not been asked for by the type in the first place.

The same session had already hit the *other* end of this seam from the other side: `asc record
stage_transition` refuses an undeclared `stage` field outright — *"The document has no such field
'stage'. The fields are: …"* — because it reads a document rather than a property map. So this
session was told twice, from two surfaces, that it had no word for the thing it was trying to say.

## The metric

The entry as `asc query` returns it, `properties_json` verbatim:

```json
{"chosen":"Fold Cut 1 into Cut 3: one derived fails-closed mapping in scripts/gate-scope.mjs, built once and deepened once, serving both the inert case and the related-tests case.","options_considered":["Build Cut 1 as specified and ship the narrow inert class as its own stage","Drop Cut 1 entirely and record in EV-64 that the bead's first cut is unavailable here"],"rationale":"The inert class is narrow, and the related-tests mechanism lands on the commit that actually hurt: ten markdown files, 24 min 42 s, whose readers are a handful of tests rather than 300. Both cuts need the same derived mapping, so building it twice would cost more than the merge does, and G2 had no other content -- folding it removes a stage rather than moving work.","reversibility":"reversible"}
```

Four keys; `question` absent. The entry id is `309281f4-0802-47ba-bc9a-25df022d3e34`.

The evidence that the question is unrecoverable from the entry rather than merely unlabelled is in
its own text: `chosen` and `rationale` both refer to "the bead's first cut" and to "G2", and neither
string is defined anywhere in the entry. A reader who has the plan can reconstruct the question. A
reader who has only the store — which is the reader the store exists for — cannot.

The strip-and-warn path, verbatim from `packages/core/src/state.ts`:

```
        problem: `'${name}' is not a property of ${spec.name}, so it was dropped`,
        fix:
          `Declared properties: ${spec.properties.map((p) => p.name).join(', ') || '(none)'}. ` +
          `Remove it, or declare it with 'asc types define' (which adds a new version).`,
```

## The pattern

**A type whose fields describe an answer and never the question.** It is the same shape as
`dogfood/0060`, one type over: there, a type whose purpose line asks a question that none of its
eight properties can carry; here, a type that records a choice while nothing records the choice's
subject. The class is worth naming because it is invisible from inside the type: every declared
field is populated, every guidance line is followed, and the record is complete by its own
definition.

The tell: **a record that cannot be read without a second document.** If resolving an entry requires
the plan, the bead or the session it came from, the entry has an undeclared dependency on context
that only the writer had.

## Why nothing else would have caught it

Not the schema — the entry validates, every declared property is present, and `asc record` exits 0.
Not a warning, because the warning fires only for a property the type *refuses*, and the interesting
case is the property the author never thought to offer, because nothing in the type's own guidance
mentions it.

Not a review of `decision`, either: the four fields read as a complete set, and the omission is only
visible from the far end, when a later reader tries to use one.

## Consequences and constraints

`decision` is a starter type, so changing it is a version bump rather than an edit — `asc types
define` adds a version, and existing entries stay on the old one. Anything written before the fix
keeps its gap; **entries are immutable** (`entries_are_immutable`, `entries_cannot_be_deleted` are
enforced by trigger), so the back-catalogue cannot be repaired, only annotated.

The strip behaviour is not the defect and should not be changed to fix this: refusing an undeclared
property would lose work that the record path exists to keep, and the warning is already the right
report. The repair belongs in the type.

## Links

- Bead: `asc-f3at`
- Related: `dogfood/0060` (a type whose purpose asks a question none of its properties can answer)
- Parent: `asc-09wx.14` (cut the pre-commit gate's cost)
- Evidence record: `docs/evidence/EV-70.md`
