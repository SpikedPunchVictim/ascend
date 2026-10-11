# 0075 — A type's guidance stayed on the version it replaced, and `asc` rendered `note` exactly like a type that never had any

| | |
|---|---|
| **Bead** | `asc-4f2w` (the remaining guard); the store was fixed by hand in the same change |
| **Surfaced** | 2026-10-11 |
| **Surfaced by** | regenerating `dogfood/types.json` for `asc-xqf1`, when six entries refreshed cleanly and the seventh would not |
| **Entry type(s)** | `note` (project-defined) |
| **Severity** | P2 |
| **Status** | fixed in the working tree (uncommitted at the time of writing) |

## What was found

A type's guidance — `purpose`, `analysis_questions`, `review_after`, `description`, `record_when`
and the per-property `prose` — is stored **per version**, but every surface that shows it reads it
through the type's **latest** version. `note` was defined with all of it, and then a later change
replaced its one property (`text`) with another (`body`) and minted version 2. The guidance stayed on
the version-1 row. Nothing was lost and nothing was deleted: the project's own description of its
last-resort type simply stopped being reachable, because every reader looks at the version nobody was
writing to.

This is an **absence**, which is why no review caught it: the surface that should have carried five
lines of guidance rendered as though the type had never been given any.

## How it surfaced

**Nobody was looking for it.** The task was `asc-xqf1` — give `evidence_record` a `predictions`
property — and its last step was to refresh `dogfood/types.json`, the artifact the README describes as
*"the replayable definition of this repository's own types … so a fresh `asc init` reproduces every one
at byte-identical `type_hash` values."*

Six of the seven entries refreshed from the current registry without incident. The seventh was
`note`, and regenerating it exposed the gap in two layers:

1. Taking the latest version — the obvious reading of "mirror the registry" — returns `note` v2, which
   carries **no guidance at all**. Six entries had guidance on their latest version; this one did not.
   A regeneration written without looking would have silently deleted `note`'s guidance from the
   artifact, and the change would have looked like housekeeping.
2. Trying to carry the guidance forward was refused by the store:

```
$ asc types define --dry-run /tmp/note-fixed.json
Error: 1 problem(s) make the prose for 'note' unusable, so nothing was written:
  prose key 'text' canonicalizes to 'text', which is not a property of note --
  the declared properties are 'body'
```

So the stranded guidance had itself gone stale: its `prose` was keyed on the property name that v2
had replaced. The mechanism is a version bump, and it stranded *and* invalidated the guidance in one
step.

Both layers were caught by using the tool, not by reading it. The first was caught by comparing six
entries against a seventh; the second by the store refusing a document it could not apply.

## The metric

Measured 2026-10-11 against the live store, `asc types export` read per name.

**Before the fix**, `note`'s latest version rendered no guidance, and the brief a recorder actually
reads said so:

```
$ asc types show note
name                   note
version                2
major                 2
status                 active
type_hash              2a540393995c08a9dace9182293103…0fc06af41910f65ec1916b7e4c718
registered_at          2026-10-09T20:18:50.807Z
property_count         1
property.body          string

$ asc
note -- no record_when given
```

`note` version 2 was registered 2026-10-09T20:18:50.807Z, so the guidance was unreachable for about
two days before anything looked.

**The class, counted** — types whose latest version lacks guidance that an earlier version carries:

```
types in registry:             14
types with >1 version:          4  ['evidence_record', 'note', 'review_finding', 'verification_run']
  of those, guidance stranded:  1  (note)
types carrying any guidance:   13
```

**1 of the 4 types that has ever bumped a version had its guidance stranded, and both of the two
project-defined types (`note`, `evidence_record`) were in that set of 4.** n = 4 is under `MIN_N`, so
this is an **anecdote about a mechanism, not an estimate of a rate** — what makes it worth recording
is the measurement's completeness, not its size: the question is "does any type have guidance only on
a superseded row", and `types export` answers it exhaustively for a 14-type registry.

After the fix the same query returns **0 of 4**, and 13 of 14 still carry guidance.

## The pattern

**Data that is per-version while every reader is per-name.** Guidance is written onto a version and
read off the latest one, and nothing binds the two. The general form: a type gains a second version
for a reason that has nothing to do with its guidance, and the guidance — which was never wrong — is
left behind by a change that had no reason to consider it.

The registry already distinguishes these: `documentSpec` deliberately keeps `version`, `status` and
`type_hash` **out** of the identity hash, so identity is the shape and version is a fact *about* it.
Guidance is stored on the version row, which puts it on the same side of that line as the shape it
happens to accompany — and only the shape has anyone re-deriving it.

`register-document.ts` names the mirror case explicitly, and warns about it: prose written to a
version that is not the latest *"was written to version 1 … the latest is 2"*. That warning fires for
`asc types import`. It does not fire for `asc types define`, and neither path warns when the guidance
was never re-applied at all — which is what happened here.

## Why nothing else would have caught it

**The failure is indistinguishable from design.** Of the 14 types, exactly one is *deliberately*
without guidance — `hand_empty`, whose own description is *"no record_when given"*. Its line in the
brief is:

```
hand_empty -- no record_when given
```

That is character-for-character what `note` rendered while its guidance sat stranded on v1. A human
skimming `asc`'s output cannot tell a type that was never given guidance from a type whose guidance
has been orphaned, and neither can anything else: there is no test, no `asc doctor` check, and no
`align` rule that compares a type's latest version against its earlier ones.

`asc store verify` passes — the store is structurally sound, and it was. The entries are untouched and
valid; no record was ever wrong. Nothing in the repository asks the question "is this type's guidance
where its readers will find it", which is why the answer went two days without being noticed.

What did catch it was regenerating an artifact that forced all seven types into the same frame at
once. The instrument was comparison, and it only worked because six of the seven agreed.

## Consequences and constraints

No stored data is involved beyond the `entry_types` row the fix writes, so nothing here collides with
entry immutability. The fix was `asc types define` of `note` v2's shape carrying v1's guidance, with
the `prose` key renamed `text` → `body`:

```
name  version  major  outcome        bump
note  2        2      prose-updated  none
```

No version was minted and both version rows survive (`[(1, '96880b60'), (2, '2a540393')]`), which is
the point: guidance is applied in place, and a corrected guidance is not a new identity.

Two constraints recorded rather than resolved:

- **The guard is missing and is filed, not built** — `asc-4f2w`. It is the cheap half: a test that no
  type's guidance sits only on a superseded version. It is deferred because its natural home is the
  import/define path or the store's registry tests, and choosing between them is a design call.
- **`dogfood/types.json` had already drifted the same way, and would not have been caught either.**
  Its `note` and `evidence_record` entries were both at version 1 while the registry held version 2,
  so a fresh clone has been getting `note` without its guidance for as long as the drift existed. The
  artifact is a fixed point again as of this change (all seven import `unchanged`), but nothing tests
  that either — the same absent guard covers both.

## Links

- Bead: `asc-4f2w` (the missing guard); `asc-xqf1` (the work that surfaced it)
- Files: `dogfood/types.json`, `dogfood/README.md`, `.ascend/types/0001.jsonl`
- Prior instance of artifact drift, same directory: `dogfood/0074` (a count left behind by a widened
  vocabulary — a different mechanism reaching the same outcome, a file that was right when written)
- The mirrored warning that exists for `import` but not `define`:
  `packages/cli/test/register-document.test.ts`, `describe('asc-w0b2 -- prose written to a version that
  is not the latest')`
