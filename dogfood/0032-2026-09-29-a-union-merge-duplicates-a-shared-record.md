# 0032 — a union merge duplicates a shared record, positionally, and the reader did not dedupe

| | |
|---|---|
| **Bead** | `asc-i5tj.7` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | an adversarial review of E12.1, run on the same model as the authoring session |
| **Entry type(s)** | `review_finding` (derived) — nine reported in one review |
| **Severity** | P1 |
| **Status** | fixed in the working tree (uncommitted) |

## What was found

E12's layout is built on `*.jsonl merge=union`, and its stated justification is that a union merge
keeps two branches from conflicting on a file both appended to. **It also duplicates.** A derived
entry's id comes from its content, so two clones that ingest the same transcript derive the same id
and write the same bytes; when both sides add that record, the merge is clean and leaves the line on
disk twice. `readRecordTree` did not dedupe, so it returned the record twice and every count
downstream was wrong by one.

**The duplication is positional, which is the part nobody had stated.** Git's union merge emits an
identical line ONCE when both sides add it as the same aligned region, and TWICE when the two sides
interleaved it with their own work differently. The first fixture written for this record put the
shared line first on both sides and the merge came out clean — the fixture, not the fix, was wrong.

## How it surfaced

**Nobody was looking for it in the sense that matters, and the author was looking in the wrong
place.** The reviewer was asked to review the new module and reported nine findings; this was the
first. The author had already run the spike's S1–S4 fixtures and a real-corpus round trip, and both
reported clean — because *neither performs a merge*. The layout spike measured how git merges these
layouts and the package tests measured the layer's reader and writer: two halves measured, and the
join between them was not. The join is the only place the design's risk lives.

The same review refuted a second thing, which is why it is recorded here rather than as a bead alone.
The plan note for E12.1 claimed the stage's acceptance criterion had been "rewritten in substance
rather than in letter". The reviewer showed that overstates what was done: the spike's record
generators are pure, layout-independent data and ARE replayable, so the criterion could have been met
by replaying them through real git rather than by substituting a different check. The substitute was
weaker than the thing it replaced, and the claim covered the difference.

## The metric

`spike/git-layout/merge-replay.mjs` — written for this finding. It writes a tree WITH the layer,
merges it with real git, and reads it back WITH the layer. Two branches each append the same
derived record and one private record, in different orders around it:

```
$ node spike/git-layout/merge-replay.mjs
merge exit code:              0
conflicts:                    0
raw lines after merge:        4
SHARED copies on disk:        2
distinct ids the layer reads: 3
entry lines the layer reads:  3
duplicate the layer removed:  1
no record lost:               true
no record duplicated:         true
```

The merge is clean — exit 0, no conflict, which is exactly what the layout was chosen for — and it
still wrote the record twice. The reader now closes that: 4 raw lines to 3 distinct records, none
lost. `git --version` was 2.50.1 (Apple Git-155).

The two false greens the same review found, each verified by re-running the mutation after the fix:

```
# reader's file sort reversed (b.index - a.index) -- 26/26 green before, now:
 × reads files in numeric order, so 0002 follows 0001 and not the reverse
 Tests  1 failed | 36 passed (37)

# head cache replaced by a per-append recount -- 26/26 green before, now:
 × derives the head count once, and does not re-read the file on later appends
 Tests  1 failed | 36 passed (37)
```

n=2 branch merges, below `MIN_N`. This is an anecdote about *how* the duplication arises, and it is
not evidence about how often. What it settles is the existence claim, which is all the fix needs: a
clean merge can duplicate a record, so the reader cannot delegate deduplication to git.

## The pattern

**Two halves measured, the join assumed.** Every component of E12.1 had evidence behind it — the
spike measured merges, the package measured the layer — and the composition of the two had none. The
risk sat exactly in the seam, and each half's evidence made the seam feel covered.

The related class, and the one worth generalizing: **a criterion satisfied by a substitute that does
not exercise the mechanism.** "The spike's fixtures cannot round-trip as files" was true, and the
substitute was chosen for being executable rather than for being equivalent. A criterion names a
mechanism for a reason; when the literal form is unavailable, the test is whether the replacement
still drives that mechanism, and here it did not.

## Why nothing else would have caught it

The suite could not: every one of its 26 tests passed with the defect present, including the four
scenario tests named after the spike's S1–S4 — they reproduce the *shapes* a merge produces, not the
merge. `align check` cannot (no import edge is involved) and neither can the type system (`string`
either way).

A review plausibly could have, and did. That is the honest answer: this was found by a review that
was asked for, on a module whose tests and spike both agreed with it — the same configuration that
hid `dogfood/0030` and `dogfood/0031`.

## Consequences and constraints

The dedupe is applied to entries and annotations only. For types and schemes a line is a
*registration*, file order is meaning, and two identical lines are two versions — collapsing them
would delete one rather than remove a duplicate. So the fix is bounded by the same distinction the
ordering rule already draws.

Distinct content under ONE id is deliberately still not collapsed. That is a different mechanism
(the spike's S3 shape), it is owned by `asc-2ezs`, and collapsing it would lose a record.

Whether a git-spawning test belongs in `packages/store`'s permanent suite is **not settled by this
record**. The replay lives under `spike/git-layout/`, which is where this repo's real-git
measurements already live; making the store's suite depend on a `git` binary and on the union
driver's positional behaviour is a decision with a maintenance cost, and it has not been made.

## Links

- Bead: `asc-i5tj.7` (dedupe), `asc-i5tj.13` (the acceptance-criterion wording)
- Related: `dogfood/0030` (a scheme name is any string), `dogfood/0031` (a type line carries no
  version), both surfaced by the same round trip and both corrected in the same review
- Replay: `spike/git-layout/merge-replay.mjs`; layout measurements: `spike/git-layout/run.mjs`
- Plan text corrected: `IMPLEMENTATION_PLAN.md` E12.1, "As built"
