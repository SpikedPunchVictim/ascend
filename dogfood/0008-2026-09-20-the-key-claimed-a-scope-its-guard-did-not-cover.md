# 0008 — The derived key claimed uniqueness over a scope its guard did not cover

| | |
|---|---|
| **Bead** | `asc-iq6` |
| **Surfaced** | 2026-09-20 |
| **Surfaced by** | `derive-real-corpus.test.ts` going red against the live corpus, blocking an unrelated commit (E10, `asc-2wa` + `asc-1l2`) |
| **Entry type(s)** | `verification_run` (derived) — the type that collided |
| **Severity** | P0, matching the bead |
| **Status** | fixed in the commit that adds this record |

## What was found

`asc ingest claude-code` gives every derived entry a key that is supposed to be unique across a
whole sweep, and it disambiguates a repeat by suffixing `#2` rather than losing the event. The
set that enforced that promise was scoped to **one file**. The key is not: for a
`verification_run` it is `${sessionId}:${resultId}`, and a session id is not per file — a
session's subagent transcripts all carry the **parent's** session id. Tool-use ids are unique
within one agent's conversation, not across sibling subagents, so two subagent transcripts of the
same session can independently mint the same `toolu_...`. Each file checked itself, found no
repeat, and emitted the same unsuffixed key. The collision existed only in the union — which is
exactly the scope the key claims.

The defect is a **scope mismatch**, not a hash weakness. Nothing about the key derivation was
wrong; the guard was measuring a smaller world than the promise.

## How it surfaced

Nobody was looking for it. It arrived as a red gate on a commit about a packaging change, which
has nothing to do with key derivation. The first reading was that this was more of the
suite-contention noise recorded in `dogfood/0007` — the same test file, and that finding was two
days old. That reading was wrong and the evidence that killed it was a re-run on a quiet machine:
the failure reproduced with an identical assertion message, in 58.91 s rather than a timeout. A
contention hypothesis predicts "quieter passes"; this got quieter and stayed red, and the red
named a *value*, not a deadline.

It needed three conditions at once, which is why it took until now: one session had to spawn more
than one subagent, two of those subagents had to mint the same tool-use id, and the sweep had to
cross both files. The working agreement on this project — an orchestrator delegating
implementation to several subagents — makes the first condition routine, so the corpus produced
it by being used the way the project intends. A session with one agent, or none, never produces
it.

## The metric

The failure, on a quiet machine, reproducible:

```
 ❯ packages/adapter-claude-code/test/derive-real-corpus.test.ts (9 tests | 1 failed | 1 skipped) 57516ms
   × the deriver against the real corpus > gives every entry a unique key, and drops nothing for want of an identity 9ms
     → expected [ Array(1) ] to deeply equal []

AssertionError: expected [ Array(1) ] to deeply equal []
+ Array [
+   "verification_run|f5717795-f5a9-4ad5-998d-4ec3422511d0:toolu_01PHpbHyJGmc1fybTuTo9391",
+ ]

 Test Files  1 failed (1)
      Tests  1 failed | 7 passed | 1 skipped (9)
   Duration  58.91s
```

The two colliding files, both reporting `sessionId` `f5717795-f5a9-4ad5-998d-4ec3422511d0`:

```
subagents/agent-ae8f90b901854f5a1.jsonl   218 records, 1 tool_result with that id
subagents/agent-ae0a4b4ecfcc62a21.jsonl   141 records, 1 tool_result with that id
```

Blast radius, counted over the live transcript corpus on 2026-09-20:

```
subagent transcripts                                861
main transcripts                                     52
sessions having subagent transcripts                 23
sessions having MORE THAN ONE (collision possible)   20
```

Subagent transcripts are 861 of 913 files — the majority of the corpus by file count, so the
exposed surface is not a corner of it. (A sweep run a few hours later the same day read 910
files, having skipped 5 ephemeral temp-root projects. The corpus grows while it is being used —
`asc-9ac` measures that growth — so two counts from one day differing by a few files is the
expected behaviour, not a contradiction.) **Observed collisions: 1** — and the census below
establishes that 1 is the total, not a lower bound. The 20 sessions that *can* collide sit
exactly at `MIN_N` (20, `packages/analysis/src/proportion.ts:50`), and a single collision is an
anecdote at any n, so no rate is stated here.

After the fix, same file, same machine:

```
 ✓ packages/adapter-claude-code/test/derive-real-corpus.test.ts (9 tests | 1 skipped) 16425ms
   ✓ produces keys that are stable across two independent sweeps 8132ms
 Test Files  1 passed (1)
      Tests  8 passed | 1 skipped (9)
```

### The census, and the before/after comparison

The figures above are what the test reports, and the test stops after the first ten duplicates.
A full census was run afterwards, against a **frozen snapshot** of the corpus — an APFS clone,
so both arms read identical bytes and the corpus's own growth cannot confound the comparison.
The two arms differ only in `derive.ts`: one built from `HEAD~1`, one from the fix.

```
                     files  records  entries  distinct keys  duplicate keys  collisions
before (HEAD~1)        913  527,122    1,816          1,815               1           8
after  (asc-iq6)       913  527,122    1,816          1,816               0           9
```

The single duplicate before the fix was
`verification_run|f5717795-f5a9-4ad5-998d-4ec3422511d0:toolu_01PHpbHyJGmc1fybTuTo9391` — the one
the test named. So the corpus-wide answer is **1 collision, not merely "at least 1"**.

Diffing the two key dumps line by line gives the strongest form of the "nothing else moved"
claim:

```
$ diff keys-before.txt keys-after.txt
391c391
< verification_run|f5717795-f5a9-4ad5-998d-4ec3422511d0:toolu_01PHpbHyJGmc1fybTuTo9391
---
> verification_run|f5717795-f5a9-4ad5-998d-4ec3422511d0:toolu_01PHpbHyJGmc1fybTuTo9391#2
```

One line of 1,816, in the same position, gaining a suffix. Every other key is byte-identical, so
re-ingesting a store that already holds this corpus mints exactly one new id and re-recognises
all 1,815 others. That is the property the append-only argument depended on, measured rather
than reasoned.

The `keyCollisions` counter previously read **6 across 1,488 entries** on the 2026-09-15 corpus.
That figure was taken while the set was per file, so it counted same-file repeats only, and the
census above supersedes it.

## The pattern

**A uniqueness guard scoped narrower than the identifier it guards.** The class is not specific
to keys: any invariant stated over a wide domain and enforced over a narrow one fails silently,
because every local check passes. The tell is a shared identifier component — here a session id
that several files carry — which makes "per file" and "per key-space" look interchangeable until
they are not.

Its sibling in this repo's history is the reverse direction: `dogfood/0006` found a value that
claimed to be one clock and was another. Both are promises whose wording outran the code, and
both were caught by the corpus rather than by reading the code.

## Something did catch it, three days earlier, and fixed the wrong layer

This is the part worth keeping. `asc-90h` (2026-09-17, closed) found this mechanism and named
the exact line:

> `derive.ts:556-564` — `accept()` calls `begin()` whenever `path !== file.path`, which clears
> the `issued` Set that is the ONLY thing incrementing `counters.keyCollisions`. The detector
> cannot see a cross-file collision by construction.

It even separated the reset that is correct from the reset that is not:

> The per-file reset is CORRECT for the invocation map and the verdict chain (pinned by
> `derive.test.ts:553-578`). The bug is that the same reset is applied to a counter whose entire
> job is to notice a cross-file identity reuse.

That is the fix, written down three days before it was made. It was not made, because the finding
was framed as a **counter** problem — "`keyCollisions` stays 0 by construction" — rather than a
**key** problem. Framed that way, the honest options looked like (a) put a file discriminator in
the key, or (b) make the store's duplicate branch content-aware so the loss is at least visible.
(b) was chosen as the smaller change, and it was the right call for a visibility bug. But the
third option — stop clearing a set whose scope was never per file — was not on the list, because
the counter framing made the reset look like a property of the design rather than a mistake in
it.

`asc-90h` also checked the corpus for the precondition and found it live but untriggered: one
session with two subagent transcripts sharing 18 `(sessionId, uuid)` pairs, 6 carrying genuinely
different content, none of which then carried a derivable trigger field. The conclusion recorded
at the time was "the mechanism is live, the trigger has not coincided". Three days later it
coincided.

**The generalizable lesson: when a detector cannot see a class of event, ask whether the
detector's scope is wrong before deciding the event is undetectable.** A blind counter and a
broken guard look identical from the outside, and the difference is whether the thing it is
scoped to is the thing it is protecting.

## Why the tests would not have caught it

The unit tests could not have. There *was* a test for this, and it asserted the defect: it was
named `resets the issued-key set per file, so two files do not collide` and expected two
identical keys from two files. It passed for the whole life of the bug, because it encoded the
same wrong belief the implementation did. A test written from the same misunderstanding as the
code is not a check, and the only thing that broke the tie was real data. That test is now
inverted rather than deleted, with the measurement in its doc comment, so the next reader sees
why the expectation flipped.

A second test asserted the defect from the other end. `ingest.test.ts` had
`reports a cross-file id collision rather than swallowing it as idempotency` — `asc-90h`'s own
coverage — which pinned the *mitigation* and so pinned the cause along with it. It is inverted
too: the same fixture now asserts that both events are kept and neither is reported as lost,
which is the stronger claim. The store-level guard it used to cover is still live for a different
route — a transcript edited in place between two ingests re-proposes a taken id with new content
— so that path got its own test rather than losing its coverage.

Reading the code would have been enough *if* the reader already knew that subagent transcripts
carry the parent's session id. That fact is documented in `derive.ts` itself — the verdict chain
refuses to chain across a session boundary for exactly this reason — so the knowledge was in the
file, four hundred lines from the code that needed it. The section above is what actually
happened when someone did read it.

## Consequences and constraints

Entries are immutable (`entries_are_immutable`, `entries_cannot_be_deleted`), so this is a
prevention-at-write-time fix and nothing else. `asc ingest claude-code` is idempotent **by key**
and compares content on a duplicate id (`asc-90h`), so before the fix two different events
sharing a key meant one was reported as a collision or was not stored at all — a
`verification_run` that happened and the corpus could not hold. That is the "reports success
wrongly" class, on the ingest path, which is the class this project exists to make impossible.

The fix widens the disambiguation set to the sweep and preserves the key of every entry that does
not actually collide — all but one, today — so re-ingesting a corpus already in a store stays
stable.

**Rejected alternative:** put the agent or file identity into the key. Stable and
order-independent, which is genuinely attractive, but it changes the key of every entry derived
from a subagent transcript — 861 of 913 files. Against an append-only store that mints new
identities for the majority of the derived corpus and cannot update the old rows. The cure is
larger than the disease.

**Known risk of the fix, stated so it is not rediscovered:** with a sweep-wide suffix, *which* of
two colliding entries gets `#2` depends on file traversal order, so a new transcript sorting
earlier could flip the assignment between two entries. The cross-sweep stability test already
carries a 1 % tolerance for a related reason and passes. The census puts a number on the
exposure: 9 suffixed keys out of 1,816, so this is the set of keys that could ever move — but it
is a real property of the fix, not a detail.

## Links

- Bead: `asc-iq6`
- Entry recorded at the time: `decision 3428ca5f-2664-49bc-b271-49fb09410f3f` — widening the
  guard versus re-keying, with both options and the append-only argument that settled it
- Related: `dogfood/0007` — the same test file, red for an unrelated reason two days earlier;
  mistaking this for more of that cost the first reading
- Related: `dogfood/0006` — the other "the promise outran the code" finding
- `asc-90h` (closed 2026-09-17) — named this mechanism three days earlier and fixed the symptom
  at the store; its mitigation is kept, now covering a narrower case than it was written for
