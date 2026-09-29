# 0034 — an invariant asserted in a comment, that a second writer does not enforce

| | |
|---|---|
| **Bead** | `asc-4wx6` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | writing E12.4's equivalence-test fixture — reading `listInvalidations` to decide what an invalidation line has to carry |
| **Entry type(s)** | none — surfaced from reading code while building a test fixture, not from stored entries |
| **Severity** | P2 |
| **Status** | open |

## What was found

`listInvalidations` casts two columns to narrow types on the strength of a comment stating that only one
function ever writes the reserved scheme. The comment is false: `asc import` writes that scheme too, and
the second writer enforces **neither** of the two things the cast assumes.

```
      label: row.label as InvalidationLabel,
      // Same reasoning: `recordInvalidation` refuses an empty (or all-whitespace) reason before it
      // ever prepares the insert, so `note` is never NULL for a row this scheme wrote.
      reason: row.note as string,
```

`asc import` reaches the reserved scheme through `recordAnnotations`
(`packages/cli/src/commands/import.ts:255`), which refuses an **empty** note only —
`annotation.note !== undefined && annotation.note === ''` (`packages/store/src/annotations.ts:783`). An
**absent** note becomes SQL NULL; a **whitespace-only** note is stored verbatim. So
`InvalidationRow.reason` — typed `string` — reads back as `null`, or as `"   "`. Both with `asc import`
exiting **0**.

This is an *absence* in the sense the series cares about: nothing fails, nothing warns, and the type
system is told a guarantee holds that does not.

## How it surfaced

By trying to write an honest test fixture. E12.4's plan calls for the equivalence check to cover
*invalidations* — the one kind the corpus format cannot express as a kind, because an invalidation
rides as a scheme line plus annotations — so the fixture must carry one. Writing one means knowing what
an invalidation line has to contain, which means reading `listInvalidations` to see what a reader
assumes about it.

That reading is where it appeared: the comment says `recordInvalidation`, and `grep` says `import.ts`.

**Nobody was looking for it.** The question being asked was "what does an invalidation line need so the
fixture is valid?", and the answer to *that* is "a scheme line with the reserved spec's hash, and
annotations whose labels are in its vocabulary". The defect is in the field the question did not ask
about, and it only appeared because the comment was read closely enough to notice it named one writer.
No plan, no review, and no test was looking here.

## The metric

**How it was obtained:** `spike/e12-invalidation-reason.mjs`, written for this, run once. Two arms, each
its own scratch project (`mkdtempSync`), each writing one corpus with a single invalidation whose `note`
is the variant under test, then driving the real binary (`asc import`) as a subprocess with `HOME`
redirected, then reading the store back with `listInvalidations`. Verbatim:

```
=== arm 1: note is absent (null) ===
asc import   exit=0
annotations rows:          [{"note":null,"label":"wrong_value"}]
InvalidationRow.reason:    null (typeof object)
  -> CONFIRMED: the store holds an invalidation with no usable reason

=== arm 2: note is whitespace only ('   ') ===
asc import   exit=0
annotations rows:          [{"note":"   ","label":"wrong_value"}]
InvalidationRow.reason:    "   " (typeof string)
  -> CONFIRMED: the store holds an invalidation with no usable reason
```

**This is an existence claim, and n=1 is sufficient for one.** A single reproduction proves the shape
reaches the store; that is the whole claim. No rate is asserted and none is implied — the arms are the
two shapes the refusal *should* have caught, not a sample of how often it fails.

Two line citations in the probe's own reasoning were checked rather than assumed: `recordAnnotations` is
called at `import.ts:255` (the call opens there), and `restoreInvalidationScheme` is at
`annotations.ts:497`.

## The pattern

**An exclusivity claim ("only X writes this") that is true inside its own module and false in the
system.** `annotations.ts` is a self-contained world in which `recordInvalidation` really is the sole
writer of `RESERVED_SCHEME` — `requireName` refuses the name to every caller of `registerScheme`,
including that module's own `recordAnnotations`, which is exactly why the comment reads as safe. But
`asc import` does not go through `registerScheme` at all: it goes through `restoreInvalidationScheme`,
the door `asc-ax8c` opened *precisely because* import needs to reach the name.

So the class is: **a defence built by one module, bypassed by a second entry point added later for a
good reason.** The name and the label survived that; the reason did not. `restoreInvalidationScheme`
pins the scheme's *shape* by hash, and `recordAnnotations` checks the label against the registered
vocabulary — so both of those are enforced on the import path after all. Only `note` was assumed rather
than checked.

That asymmetry is the generalisable lesson and it is narrow enough to act on: **when a path is opened
into a reserved namespace, each invariant the reader relies on must be re-checked at the new door, and
the count of invariants is the thing to get right.** Here it was three; two were carried over and one
was dropped, and the dropped one is invisible because it is enforced by the *writer* the new door
replaces rather than by any schema constraint.

## Why nothing else would have caught it

Honestly: **a review could have**, and saying so is the point of this section. `grep recordAnnotations
packages/cli/src` finds `import.ts:255` in one step, and `listInvalidations`'s comment names the
function it is relying on. Two files apart, one grep. It went unread because nothing depended on it
until a fixture needed an invalidation with no reason — and the fixture being written *did* have a
reason, so the bug would not have been hit by simply adding one.

What could not have caught it:

- **The type system**, by construction: `as string` is the mechanism that hides it, and the cast is
  deliberate — `InvalidationRow` is a nicer type than the row. A cast is the right call given the
  invariant; the defect is that the invariant is not what the comment says.
- **The existing tests.** Nothing imports an invalidation with a missing reason. The
  reserved-scheme tests cover the *name* (that was `asc-ax8c`) and the label vocabulary; the reason is
  covered only through `recordInvalidation`, which enforces it there and therefore never exercises the
  path that does not.
- **`align check`** — dependency direction holds and no cycle is involved. This is a semantic gap, not
  a structural one.

## Consequences and constraints

A reasonless invalidation already stored is **not repairable in place**: an invalidation's id is a hash
of the claim — `entryId`, `label`, `reason`, `supersededBy`, `createdBy` — so giving it a reason
produces a *different* claim with a *different* id rather than correcting the row
(`annotations.ts:1061-1070`). So the options are the series' usual two: **prevention at write time**, or
an invalidation annotation on the entry that carries it. No cleanup task exists.

The scope is bounded, and the bound was measured rather than hoped for: `label` is *not* affected,
because the reserved scheme's vocabulary cannot be replaced — `restoreInvalidationScheme` accepts only
the spec hash the store itself writes (`annotations.ts:497`). So the class has one member here, not two.

The reason this is P2 rather than lower is **E12.4**. Today a reasonless invalidation requires a
hand-written corpus, because a store's own export always has a reason. E12.4 makes the JSONL tree the
git-tracked store — its lines are things people edit, rebase and `merge=union` — so "only the store
writes this scheme" stops being true of the *system* in a second, larger way. The assumption this bug
is made of is the one that is about to become load-bearing.

## Links

- Bead: `asc-4wx6`
- Probe: `spike/e12-invalidation-reason.mjs` (throwaway, kept for the reproduction)
- Evidence record it surfaced during: `docs/evidence/EV-34.md`
- Previous instance on the same path: `asc-ax8c`, `dogfood/0027` — import refusing the reserved scheme
  from the store's own export. That fix added the second door; this finding is what the door does not
  re-check.
- The comment that is false: `packages/store/src/annotations.ts:1208-1210`
