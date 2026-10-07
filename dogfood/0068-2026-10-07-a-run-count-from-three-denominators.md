# 0068 — a run count that came from three different denominators

| | |
|---|---|
| **Bead** | `asc-zvot` (found while working `asc-qt6r`) |
| **Surfaced** | 2026-10-07 |
| **Surfaced by** | `node spike/qt6r-run-structure.mjs`, while trying to reproduce the anchor `asc-qt6r`'s acceptance names |
| **Entry type(s)** | `skill_activation` (derived) |
| **Severity** | P3 |
| **Status** | open |

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
