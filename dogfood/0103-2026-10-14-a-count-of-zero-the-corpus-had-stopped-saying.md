# 0103 — two documents state a count of zero that the corpus had already stopped saying

| | |
|---|---|
| **Bead** | `asc-rlv9` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | a whole-corpus sweep taken to explain a *different* finding (`asc-j6pj`), whose per-type table printed 36 entries where two docblocks print 0 |
| **Entry type(s)** | `review_finding` (derived) |
| **Severity** | P3 |
| **Status** | fixed in the working tree |

## What was found

Two docblocks in `packages/adapter-claude-code` state, as a measurement, that the derived type
`review_finding` has **no entries**. It has 36. One of them says so in a count table and calls the
zero *"a measurement rather than a missing one"*; the other omits the type from its per-type floors
and argues the omission from that same zero. The count table also carried 1,488 as a total, 843 files
and 431,039 records — all readings of 2026-09-15, of a corpus nobody controls.

What makes this more than arithmetic is *which* 36 they are: every one comes from **a single
session**, and it is the session that took the measurement. So the type the documents describe as
never exercised is now exercised exactly once, from the one place that was looking.

## How it surfaced

**Nobody was looking for it.** The sweep behind `asc-j6pj` was run to explain why
`derive-real-corpus.test.ts` had gone red on a tree that changed nothing the deriver reads, and the
probe printed a per-type table because that was the cheapest way to see what the corpus held. The
table disagreed with a docblock two files away. The finding is a *by-product*: the question being
asked was "which record type is new", and the answer arrived attached to a number that was wrong in
the opposite direction.

The mechanism worth keeping is that **these counts are prose**. The corpus test asserts floors, and
the floors are deliberately set well below the measured values, so nothing in the suite compares a
docblock's number to a sweep's. Both docblocks even carry the instruction *"treat every number here
as a measurement with a date, not a constant"* — an instruction to the reader that did nothing for
the reader, and which licensed the staleness instead of flagging it. Twenty-nine days passed between
the reading and this one; nothing was going to interrupt them.

## The metric

One pass over `~/.claude/projects` (read-only), driving the built package's own `streamCorpus` and
`createDeriver`, 2026-10-14:

```
files 2262 parsed 1122135 malformed 0
failures 0
entries 3323
counters.entries 3323
invalid 0 warned 0
unkeyable 0 unverdictable 0
repeatedKeys 4
duplicateGroups 4
missingProvenance 0
withoutCwd 0 withoutBranch 0
distinctCwds 52 distinctBranches 16 distinctProjects 17
--- byType ---
  verification_run	1490
  context_compaction	1147
  tool_denial	504
  skill_activation	138
  review_finding	36
  user_correction	8
--- review_finding ---
  count 36
  distinct sessions 1
    b5d54754-fe9e-4c00-9f7b-d25b5f14a75d	36
```

That output is reproduced exactly except for one line the probe printed — a count of distinct
`report_id` values, which read 0 because report identity lives in the entry's key rather than in its
properties, so it measured nothing. It is omitted rather than reported as a zero.

The two numbers a floor would need, from a second pass that grouped every declared type by the
`session_id` provenance property:

```
review_finding: entries=36 sessions=1
  per-session: 36

user_correction: entries=8 sessions=5
  per-session: 3, 2, 1, 1, 1

tool_denial: entries=505 sessions=44
context_compaction: entries=1147 sessions=33
verification_run: entries=1491 sessions=24
skill_activation: entries=138 sessions=32
```

`n = 1` session for `review_finding`, and `n = 1` machine — the corpus test skips wherever
`~/.claude/projects` does not exist, so every figure here is this machine's. The 36 are an anecdote
by this repository's own `MIN_N` rule, and the record says so rather than presenting them as a
population. The corpus is also live and this session's transcript is inside it, which is why
`tool_denial` reads 504 in the first pass above and 505 in the second, minutes apart.

## The pattern

**A measurement with no mechanism keeping it true.** The class is citation rot — the same class
`dogfood/0077` and `asc-3sfk` recorded for line numbers — but with a sharper edge, because these
citations point at a *number* rather than a location, and a number is what a reader trusts most.
Three sub-cases appeared at once, and only one of them was about staleness:

1. **The reading moved.** 1,488 entries became 3,323; 431,039 records became 1,122,135. Normal,
   and dated in the text, which is the most a prose count can do.
2. **The stated direction inverted.** "Has no derivation rule yet", "the producer has never run",
   "the corpus derives zero of it" — these were not stale numbers but stale *claims*, and the doc
   that says the type is unexercised is now the doc that is wrong about which way the corpus moved.
3. **The rationale was already self-inconsistent.** The `user_correction` floor is 5, and the
   comment above it read *"20 measured, across 10 sessions. The floor is deliberately at the
   measured value rather than below it"* — a sentence that did not describe the pair it sat above
   even before anything moved, because 5 is not 20. Measured now: 8 entries across 5 sessions, so
   the headroom is 3. That one was wrong the day it was written, and no date would have saved it.

## Why nothing else would have caught it

Nothing asserts these numbers, and that is deliberate rather than an oversight: the corpus test
asserts floors precisely so a live corpus does not redden a gate on growth. A review reading the
docblocks would have read them as prose about the past, which is what they look like. And the
`user_correction` inconsistency is invisible to arithmetic — only to someone comparing the comment
to the constant underneath it.

What *would* catch it is a check that the table matches a sweep, and the honest report is that such
a check can only live in the file that already skips on every machine but this one, and costs a
corpus pass to run. That is a design option, not something this finding earns.

## Consequences and constraints

- **The floor question is answered by n, not by the count.** `review_finding` stays absent from
  `MIN_PER_TYPE`, and the omission stands — but the reason changes from "the producer has never run"
  to "the producer has run once, here". A floor of 36 would be a floor on one reviewer's single
  sitting, which is the gate-teaching disease the original comment was written to avoid, arriving
  in a new costume.
- **The measurement was corrected; the floor was not.** 5 is a design decision and not arithmetic,
  so the corrected comment states plainly that the rationale for 5 is recorded nowhere it can point
  to, and gives the headroom instead.
- **The dated records were left alone.** `docs/evidence/EV-derived.md`, `EV-baseline.md`,
  `EV-ingest.md`, `docs/evidence/EV-60.md` and `dogfood/0007`/`0008` all cite 1,488 or 431,039 and
  are correct as dated readings of the corpus they measured. They are not stale and were not
  touched; a record that says "measured 2026-09-15" is doing the one thing a live count cannot.
- **A fifth site was found and NOT corrected.** `derive.test.ts` states that `review_finding` *"has
  no derivation rule yet"* and is keyed off a `ReportFindings` call *"the corpus has never made"*.
  Both are false — the rule exists and the corpus has made the call 36 times. It is left alone
  because the rule was added by `asc-gtnu`'s work, which owns that file and is still open against
  it. Recorded in the bead rather than fixed from here.

## Links

- Bead: `asc-rlv9`
- `dogfood/0102` — the finding this sweep was taken beside; it names these same stale claims and
  declines to fold them in
- `dogfood/0077` and `asc-3sfk` — citation rot in live citations, the class this is an instance of
- `asc-gtnu`, `asc-gtnu.3` — the `review_finding` producer and the fixture test that owns its rule
