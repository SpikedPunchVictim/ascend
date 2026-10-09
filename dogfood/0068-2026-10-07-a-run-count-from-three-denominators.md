# 0068 — a run count that came from three different denominators

| | |
|---|---|
| **Bead** | `asc-zvot` (found while working `asc-qt6r`) |
| **Surfaced** | 2026-10-07 |
| **Surfaced by** | `node spike/qt6r-run-structure.mjs`, while trying to reproduce the anchor `asc-qt6r`'s acceptance names |
| **Entry type(s)** | `skill_activation` (derived) |
| **Severity** | P3 |
| **Status** | corrected 2026-10-09: the measurement stands — 4,668 rows, 22 sessions, 45 runs, 14 distinct values, longest run 2,037 — and the **claim** drawn from it does not. See *The correction* below |

## What was found

`asc-qt6r`'s acceptance fixes its anchor as *"`skill-activation`: 87 runs from 6,395 lines, the
numbers above are the anchor"*, and `docs/evidence/EV-patterns.md`'s 2026-09-14 Amendment states the
same phenomenon as *"6,395 lines across 71 files, only 12 distinct values, 6,308 consecutive
repeats, 87 independent value-runs."*

Those numbers do not describe one corpus, and no single instrument produced them.
`packages/adapter-claude-code/src/derive.ts:18` states the 6,395 as *transcript records carrying
`attributionSkill`*, and says the same measurement *"yields 87 activations"* — so the 87 is the
**adapter's** count of emitted activations, not a run count over 6,395 rows.
`derived-types.ts:37` records `skill_activation 87 session + first record uuid`.

Measuring the runs directly, over the frozen corpus the same record's other tables come from,
gives neither number. Nobody set out to find this: the spike was written to reproduce 87 and
returned 45, and the gap is the finding.

## How it surfaced

**Nobody was looking for it.** The spike existed to answer three pre-registered questions about
run structure (recorded in `docs/evidence/EV-run-structure.md`); reproducing the acceptance's own
anchor was a side-effect of pointing the new statistic at the same data, and the first number it
printed disagreed with the one written down.

The mechanism is the one `dogfood/0066` names — *a number travelling between instruments without
its parameter* — but with a sharper edge: here the number did not travel between two instruments,
it was assembled from three. A line count from the transcript tree, a run count from the adapter,
and a file count from the transcript tree are quoted in one sentence as though they were one
measurement of one thing.

## The metric

The corpus is the frozen `spike/corpus.db` (2026-09-11), read-only, through `node:sqlite`:

```
$ node -e "…SELECT session_id, skill_name, recorded_at, id FROM events WHERE skill_name IS NOT NULL
            ORDER BY session_id, recorded_at, id…"
rows with skill_name: 4668
sessions: 22
rows 4668 runs 45 E[R] 1065.6 ratio 0.042 longest 2037
distinct skills: 14 repeat adjacencies: 4623
```

So, over the corpus: **4,668 rows, 22 sessions, 45 runs, 14 distinct values, longest run 2,037** —
against the record's *6,395 lines, 71 files, 12 distinct values, 87 runs*. Every one of the five
quantities differs.

The finding does not depend on which is right, and this record does not claim the record is wrong:
it claims the four numbers are not commensurable, which is why they cannot be checked against each
other. `skill_activation` on the live store is a third denominator again — `asc stats
skill_activation --assoc` reports **243 entries** over 5 properties (2026-10-07).

`spike/qt6r-run-structure.mjs` reproduces the block above.

## The pattern

A quantity that is *defined by a pipeline stage* — rows carrying an attribution, activations the
adapter chose to emit, runs within a session, entries in the store — changes value at every stage,
and the stage is never written down. The class is not "a wrong number"; it is "a right number that
belongs to an unstated denominator", which is indistinguishable from a wrong number to every
reader who tries to use it.

The recognition rule: **if a record's sentence contains two counts, check that one pipeline stage
produced both.** Counts from different stages are not two facts about one thing.

## Why nothing else would have caught it

No test can. The numbers are about a corpus and about an adapter's output, and no fixture can
assert what either contains.

`align check` sees nothing: all three numbers are correct in the artifact that printed them.

A code review reads `derive.ts:18` and `derived-types.ts:37` and finds the 87 stated twice, in
agreement with itself, which reads as corroboration rather than as one instrument quoted twice.

What caught it was **pointing a new instrument at the data a record's numbers claim to describe**
and reading the disagreement as a result rather than as a bug in the new instrument. That is the
mechanism worth repeating, and it is why the spike printed the whole run structure rather than only
the pass/fail the bead asked for.

---

## The correction — 2026-10-09 (`asc-zvot`)

**The measurement stands. The claim drawn from it does not.** Every number this record printed about
the frozen corpus reproduces exactly: `events` with `skill_name IS NOT NULL` still gives **4,668
rows, 22 sessions, 45 runs, 14 distinct values, a longest run of 2,037**. What does not survive is the
sentence *"those numbers do not describe one corpus, and no single instrument produced them"* — the
charge that `EV-patterns.md`'s anchor fused counts from three pipeline stages, and that its 87 is the
adapter's number quoted back.

This was found by doing the work the record asked for. `asc-zvot` was opened to correct that anchor,
and reading the anchor closely enough to correct it is what refuted the case for correcting it.

**1. The anchor's 87 is its own arithmetic.** The sentence reads *"it appears on 6,395 lines … with
6,308 consecutive repeats. The independent count is 87 value-runs."* And 6,395 − 6,308 = **87**. The
line count and the repeat count sit in one sentence because they are one pass over one tree; the run
count is their difference. This record's thesis was that the 87 was *"the **adapter's** count of
emitted activations, not a run count over 6,395 rows"* — but a run count over 6,395 rows is exactly
what 6,395 − 6,308 is.

**2. The dates run the other way.** `git log -S` on both files:

```
$ git log --format='%ad %h %s' --date=short -S'6,395' -- docs/evidence/EV-patterns.md
2026-09-14 486cf14 Correct EV-patterns' skill-activation profile: 4,668 echoes, not a corpus

$ git log --format='%ad %h %s' --date=short -S'6,395' -- packages/adapter-claude-code/src/derive.ts
2026-09-16 1f83004 Record where a derived entry happened, not just which proj...
2026-09-15 75d482f Derive five entry types from transcripts, and measure the ...
```

The doc's 6,395 entered on **2026-09-14**; the adapter's *"yields 87 activations"* entered a day
later, on **2026-09-15**. The doc cannot have quoted the adapter, and if the two are one instrument
quoted twice then the quotation ran backwards in time. What the dates show is two measurements a day
apart that **agree** — corroboration, which is the opposite of what this record charged.

**3. The comparison ran across two snapshots, and half of it was in the wrong unit.** This record set
the frozen corpus of 2026-09-11 against the anchor's numbers, and the anchor says where its numbers
came from in the same paragraph: *"Measured 2026-09-14 on the same tree (842 files, 425,234 lines,
1,202 MB; EV-corpus used 809 files, so it has grown)."* The drift is disclosed at the point of use.
And the frozen corpus cannot be compared on files at all — `select count(distinct source) from events`
returns **1**, because `source` names the ingest and not the transcript. So *"22 sessions"* in the
block above was never the same quantity as the anchor's *"71 files"*, and printing them beside each
other as two readings of one thing is this record's error, not the anchor's.

**What the anchor got right, and better than this record did.** Its whole point is that a
session-state field echoed on every assistant message is not a corpus of events, and it says so with
a *difference* — 6,308 repeats out of 6,395 lines — which is the pseudoreplication signal `asc-qt6r`
exists to build on. It measured that a day before the adapter existed. The anchor is the better
instrument of the two.

**What survives.** A quantity *defined by a pipeline stage* does change value at every stage; that is
true and this record is where it is written down. But the two artifacts do not demonstrate it by
disagreeing — they agree on every number they share and differ only on the two that come from
different dates and different units. The number that travelled without its parameter was this
record's own *"every one of the five quantities differs"*, which is `dogfood/0066`'s class landing on
the record that named it.

**The recognition rule is kept, and is now known to be unsound in one direction.** *"If a record's
sentence contains two counts, check that one pipeline stage produced both"* is still the right reflex.
What it does not say is the converse, and the converse is what went wrong here: two counts that
**differ** are not thereby from two stages. They may be two snapshots, two units, or a snapshot and a
unit. As written the rule can manufacture a finding out of agreement, which is what it did.
