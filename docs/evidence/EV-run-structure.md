# EV — run structure: what the pseudoreplication check would see, before it was built

**Question asked:** 2026-10-07 · **Measured:** 2026-10-07 · **Bead:** `asc-qt6r`

**Pre-registered.** The three questions below were written into `spike/qt6r-run-structure.mjs`'s
header *before* the file was run, and the header is in the commit. They are reproduced here
verbatim, with their answers, so that what was asked and what was found can be compared.

**Why a measurement and not a design.** `asc-qt6r` asks for E7's third control: a check that detects
a column whose values are echoes of a session state rather than independent events. The acceptance
carries an anchor from the transcript corpus. Every number the design needed — whether any live
column still has that structure, whether a threshold can be derived rather than invented, and which
order to read in — was empirical, and none of it could be read off the source.

## The questions, as pre-registered

> **Q1.** Does ANY live column actually repeat in long consecutive runs within a session? … So the
> anchor shows the mechanism is real, not that the live store still contains the defect. If no live
> column has the structure, the check has no live case to fire on and the acceptance has to be
> anchored differently.
>
> **Q2.** Can the threshold be DERIVED rather than invented? … For a column of `rows` observations, a
> random arrangement of the SAME multiset has a exactly-known expected number of runs:
> `E[R] = 1 + (rows - 1) * (1 - sum_i p_i^2)` … The observed-to-expected runs ratio is therefore a
> threshold-free statistic: no constant to pick.
>
> **Q3.** Does the ORDER matter? Runs are a property of an order, so if the two orders disagree the
> detector must say which one it used.

## Setup

Read through `openIndex` / `entryIds` / `findEntry` — the command's own path — over the live store
and over the frozen `spike/corpus.db` (2026-09-11), read-only. Regenerable with
`node spike/qt6r-run-structure.mjs`.

## Q1 — yes, and on both corpora

Over the live store (`spike/qt6r-run-structure.mjs output`), `rows` and `runs` are values in one
partition and maximal runs summed over partitions:

```
== tool_denial (777 entries)
project      by occurred_at  rows  777 sessions  41 runs   41 E[R]    41.0 ratio  1.000 longest  155
tool_name    by occurred_at  rows  777 sessions  41 runs  111 E[R]   150.1 ratio  0.739 longest  143
denial_kind  by occurred_at  rows  777 sessions  41 runs  177 E[R]   252.9 ratio  0.700 longest  127

== skill_activation (243 entries)
skill        by occurred_at  rows  243 sessions  39 runs  101 E[R]   139.8 ratio  0.722 longest   25
agent        by occurred_at  rows  152 sessions  13 runs   19 E[R]    29.3 ratio  0.649 longest   37
```

and over the corpus, on `asc-qt6r`'s own anchor data:

```
rows with skill_name: 4668
sessions: 22
rows 4668 runs 45 E[R] 1065.6 ratio 0.042 longest 2037
distinct skills: 14 repeat adjacencies: 4623
```

So the answer to Q1 is yes, and the acceptance does not need re-anchoring. **The corpus's own counts
do not reproduce** — the record says 6,395 lines over 71 files yielding 87 runs, and the corpus
yields 4,668 rows over 22 sessions and 45 runs. That is a separate finding with its own record
(`dogfood/0068`) and it does not change the answer here: the structure is present under every
denominator.

## Q2 — the ratio is derivable, and it is NOT sufficient alone

`E[R]` needs no simulation, no seed and no constant, so the ratio clears Q2 on its own terms. **It
then fails on the case the bead is actually about**, and that is the result that changed the design:

```
project      by occurred_at  rows  777 sessions  41 runs   41 E[R]    41.0 ratio  1.000 longest  155
```

`project` is constant within a session — a session happens in one project — so every partition is
degenerate, the marginals predict exactly the runs that occur, and the ratio is **1.000**. It reports
the most clustered column in the store as carrying no structure the counts do not already explain.
An instrument built on the ratio alone would be blind to precisely the shape `asc-0hys` exists to
correct.

**What was built instead:** `rows / runs` — the effective sample size — as the flag, with the ratio
reported beside it as supporting evidence. `project` is **19.0 rows per run**; the ratio is 1.000.

## Q3 — the order decides the verdict, so it must be the event's own time

Same columns, same partitions, same statistic, two orders:

```
skill   by occurred_at  ratio 0.722   |  skill   by recorded_at  ratio 0.980
agent   by occurred_at  ratio 0.649   |  agent   by recorded_at  ratio 0.991
project by occurred_at  ratio 0.931   |  project by recorded_at  ratio 0.586
```

`recorded_at` is when ascend **ingested** the entry, and a backfill of two years of transcripts
scrambles it against the event's own time (`derived-types.ts:76-82`). Reading in the stored order
**manufactures** structure on `skill` and `agent` (0.980, 0.991 — the stored order looks random where
the event order is clustered) and **hides** it on `project` (0.586 against 0.931). A detector that
took the store's row order would have shipped the opposite verdict on two of three columns. The
shipped check orders by `occurred_at`, and that decision is recorded in the code where it is made.

## What this changed

Three design decisions, each traceable to a number above:

1. **Two statistics, not one.** Q2's `rowsPerRun` is the trigger; the ratio is reported beside it.
2. **`PSEUDOREPLICATION_AT = 2`**, derived as the smallest average run at which a majority of rows
   are repetitions — checked against the measured population, where nothing sits between 1.0 (no
   repetition) and 2.4.
3. **Order by `occurred_at`, partition by `session_id`**, from Q3.

A fourth decision was made from output not in the questions: the check flags **5 of 5** columns on
both `tool_denial` and `skill_activation`. That is not the check misfiring — a session has one
project, one `cwd`, one `branch` — but it does mean the column *order* carries no information, so
the warning lists columns worst-first.

## Not measured, stated plainly

- **Whether the check's remedy works.** It names two — collapse to runs, or compute at the run count
  with a clustered method — and implements neither. No re-analysis at `runs` has been run against
  any pair in this record.
- **Whether the corpus's 45 and the adapter's 87 are the same phenomenon** under two filterings, or
  two phenomena. `dogfood/0068` states the discrepancy; it does not resolve it.
- **Whether a live pair's verdict changes** under an effective-N correction. The numbers here are
  run structures, not p-values, and no p-value was recomputed.
- **`rowsPerRun` on a corpus with no sessions.** The check declines to guess and says so; no
  hand-recorded type was assessed.
