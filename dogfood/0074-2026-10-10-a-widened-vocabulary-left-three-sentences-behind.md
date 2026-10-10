# 0074 — A commit widened a closed vocabulary and left three sentences still counting three

| | |
|---|---|
| **Bead** | `asc-y7p` (found while settling it; fixed in the same change rather than filed separately) |
| **Surfaced** | 2026-10-10 |
| **Surfaced by** | editing the `wrong_value` docblock for `asc-y7p`, and reading the paragraph next to the one being edited |
| **Entry type(s)** | — (drift in ascend's own source prose, not in a stored type) |
| **Severity** | P3 |
| **Status** | fixed; the pointer it also carried moved to `asc-zz7r` |

## What was found

`4fffb08` (`asc-hbxl`) widened the closed invalidation vocabulary from three labels to four by
admitting `duplicate`. It updated the place that states the size as a deliberate fact — *"no category
without a real instance already in the corpus, and four labels have one"* — and it updated the test
that documents why widening moves the shape hash. It did not update **three other sentences in two
other files** that also said "three".

The worst of the three was not a wrong number but a wrong claim. `annotations.ts` explained the
reserved scheme's idempotence as:

> the first invalidation of a store mints version 1, and every one after it reuses that version
> because the shape -- the three labels, no rules -- **never changes**.

The shape changing is precisely what that same commit had to accommodate:
`INVALIDATION_SCHEME_HISTORY` exists three lines below, and its own docblock says so — *"Widening the
vocabulary (`asc-hbxl`) changes the hash of the current shape"*. `registerSchemeUnchecked` reuses a
version only when the shape hash matches and otherwise mints the next one, so a store that had
already invalidated under three labels moves to a new version rather than extending the old one. A
sentence asserting permanence sat inside the paragraph that had just disproved it.

## How it surfaced

Not from a search for staleness. `asc-y7p` was being closed under a decision to narrow `wrong_value`'s
documented meaning rather than build field-scoped invalidation, and the docblock carrying that
narrowing ended with a pointer: *"`asc-y7p` holds the case, and a second instance of a different shape
is what should reopen it."* Closing the bead would have left that pointer dangling, so the paragraph
had to be rewritten — and the paragraph below it, in the same file, is where the stale count sat.

**Nobody was looking for it.** The question was "what holds this reserve once the bead closes?" The
answer mattered one paragraph lower, in a sentence about version minting that nothing had reason to
re-read.

## The metric

Before the fix, across `packages/store/src` and `packages/cli/src`:

```
$ grep -rn "three labels\|only three\|four labels" packages/store/src packages/cli/src
packages/store/src/annotations.ts:102: * vocabulary had three labels. Widening the vocabulary (`asc-hbxl`) changes the hash of the current
packages/store/src/annotations.ts:113:  // v1: three labels, no rules, before `duplicate` was admitted (`asc-hbxl`).
packages/store/src/annotations.ts:949: * reuses that version because the shape -- the three labels, no rules -- never changes.
packages/store/src/reserved.ts:37: * "no category without a real instance already in the corpus", and four labels have one.
packages/store/src/reserved.ts:79: * built, by the same rule that admitted only three labels -- one real instance is not yet a
packages/store/test/annotations.test.ts:222:   * Widening the vocabulary to four labels changed the hash of the CURRENT reserved shape, and this
packages/cli/src/errors.ts:231:/** Which of the three labels a message on stderr carries. */
packages/cli/src/stats-text.ts:22: * label, and Jaccard or TF-IDF over a bag of three labels measures nothing but how many labels two
packages/cli/src/commands/invalidate.ts:48: * admitted only three labels, applied to a mechanism instead of a word. The two shapes of mistake
```

Seven of those nine are about the invalidation vocabulary. Excluding the two that are explicitly
historical — the frozen v1 shape — **four** state something about the vocabulary's current size, and
**three of the four** still said three:

| file | statement | after `asc-hbxl` |
|---|---|---|
| `reserved.ts` | "four labels have one" | correct — updated by the commit |
| `reserved.ts` | "the same rule that admitted only three labels" | stale |
| `annotations.ts` | "the three labels, no rules -- never changes" | stale, and false about permanence |
| `invalidate.ts` | "the test that admitted only three labels" | stale |

The other two hits are a different three: `errors.ts`'s `StderrLabel` and `stats-text.ts`'s cluster
labels. They were checked rather than assumed, because a count is only stale relative to what it
counts.

**n = 1: an anecdote about a mechanism, not an estimate of its rate.** One commit widened one closed
vocabulary, and it left three stale sentences. What makes it worth a record is that the search is
exhaustive for its question — a phrase sweep over the tree finds every occurrence, and three of the
four current-fact statements were wrong — rather than that the sample is large. A second instance
would be a second commit that grew a closed set.

## The pattern

**A count stated in prose, where the thing counted is a constant in another file.** The general form:
adding a member to a closed set is one edit, but the set's size is written down in as many places as
anyone ever found it convenient, and only the place that owns the definition is obviously connected
to the change.

The repository already names this cost twice. `reserved.ts` describes the vocabulary's rule as *"no
category without a real instance already in the corpus"*, and the README's own Development section
says *"a rule that never fires looks exactly like a rule that passes."* A drifted count is the same
shape: it reads exactly like a count that is right, and it is not checked by anything.

The three fixes were made **count-free** rather than renumbered — *"the same rule that admits a label
here only when a real instance is already in the corpus"*. Renumbering three to four leaves the same
trap armed for the fifth label; removing the number disarms it. `reserved.ts`'s opening sentence keeps
its literal "four labels", because there the size *is* the fact being stated rather than a phrase
identifying a rule.

## Why nothing else would have caught it

A sentence in a docblock is not compiled, not typed, and not asserted. `INVALIDATION_LABELS` is
checked by `annotations.test.ts`, which pins the label set exactly — and pins it correctly, because a
test can only compare a set to a list, not to a sentence describing the list elsewhere.

`align check` is the nearest instrument and cannot see it: it reads imports and dependency direction,
and prose in a comment has neither.

The one thing that would have caught it is a reader editing an adjacent paragraph, which is exactly
what happened, and which happened only because `asc-y7p` had a dangling pointer to close.

## Consequences and constraints

No stored data is involved, so nothing here collides with entry immutability, and no version of any
store changes: the edits are comments.

One constraint recorded rather than resolved: **the fix removes the count, so a future label lands
without a number to go stale — but `reserved.ts`'s opening sentence still counts, deliberately.** That
one sentence is the vocabulary's own statement of its size, and it will need editing on the fifth
label. It is named here as the remaining instance of the class rather than left to be rediscovered.

## Links

- Bead: `asc-y7p` (closed by this change); `asc-zz7r` (the reserve it now points at)
- Files: `packages/store/src/reserved.ts`, `packages/store/src/annotations.ts`,
  `packages/cli/src/commands/invalidate.ts`
- The commit that widened the vocabulary: `4fffb08` (`asc-hbxl`)
