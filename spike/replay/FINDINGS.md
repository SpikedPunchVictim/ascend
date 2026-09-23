# Spike asc-bolz — replay handlers: findings

Throwaway. Predictions sealed in `PREREG.md` (sha256 `960a772b…ce5594`, in the bead notes) before
anything ran. Input: an APFS clone of `~/.claude/projects`, frozen 2026-09-23T06:46:47Z.

Reproduce:

```bash
node spike/replay/replay.mjs <frozen> <out> -Users-spikedpunchvictim-projects-ascend /Users/spikedpunchvictim/projects/ascend
node spike/replay/score.mjs <out>
```

## Scope: one project's sessions, one project's handlers

The user set the scope mid-spike: collect only this project's sessions and run them through this
project's handlers. Scoped run, exact output:

```
"scope": "-Users-spikedpunchvictim-projects-ascend",
"files": 77,
"cwdEvents": 96631,
"outsideCwd": 0,
"events": 96631,
"elapsedSeconds": 1.7,
```

`outsideCwd: 0`: no record in this project's transcripts carried a `cwd` outside the project, so the
transcript directory is a sound project key for this corpus. That is n = 1 project. It is not
proven for sessions started in a parent directory.

**A scoping trap hit in the spike itself.** The first scoped run matched all 1,007 files, because
the filter tested `path.includes('/-Users-…-ascend/')` and the scratchpad holding the frozen
corpus is itself under a directory with that name. Project identity must be the path *relative to
the corpus root*, never a substring of the full path.

## Predictions, settled

| # | prediction | result |
|---|---|---|
| P1 | bead matcher recovers ≥ 25 of 31 hand `stage_transition` | **confirmed: 28 of 31** |
| P2 | matcher finds ≥ 3× hand count over the same period | **FAILED: 2.68×** (83 distinct transitions vs 31 hand; hand recall ≈ 37%, not ≤ 33%) |
| P3 | plan Status edits are the minority source | **confirmed: 5 vs 301** |
| P4 | structural `search_miss` recovers ≤ 1 of 5 hand entries | **confirmed: 0 of 5** |
| P5 | ≤ 50% of structural candidates are real misses | **FAILED, narrowly: 9 of 17** (one rater; n = 17 < MIN_N, so an anecdote) |
| P6 | full replay < 60 s | **confirmed: 1.7 s** scoped, 11.4 s over all 1,007 files |
| P7 | `stage_transition` is declarative; `search_miss` needs a window | **confirmed** |
| P8 | normalized log < 5% of transcript bytes | **FAILED raw: 10.11%**; gzipped 0.545% |

## What it means

**`stage_transition` needs no model.** 28 of the 31 hand entries have a `bd close` / `bd update
--claim` event for the same bead within 60 minutes. The three misses are not detection failures:

```
missed: 2026-09-16T22:59 asc-9y1 auto events for id at: 2026-09-17T03:48
missed: 2026-09-17T09:02 E8 asc-8ju -- Cohen's kappa auto events for id at: 2026-09-17T17:57
missed: 2026-09-17T09:25 2 of 3 -- asc-8tv + asc-8ju, the store half auto events for id at: 2026-09-17T17:56, …
```

Two are `in_progress → in_progress` progress notes inside a bead, which no command marks. One was
recorded about 5 hours *before* the bead closed. That residue (3 of 31) is what only the model can
supply. The matcher also saw 52 transitions the hand path never recorded, over the same period.

**The plan document is not where stages change in this repo.** There were 5 plan Status edits,
all before 2026-09-16, against 301 bead transitions. The type's `record_when` says "a stage in a
plan document". In practice the tracker is the plan.

**`search_miss` splits into two disjoint populations.** The structural matcher (0 hits, then a
related search with hits within 5 calls) finds misses the model **caught immediately**. The retry
*is* the evidence that it caught them. The hand entries are the other population: 3 of 5 are
`after_wrong_claim`, meaning non-empty results that were misread (wrong scope, wrong vocabulary, a
compound pattern). The overlap is 0 of 5. Structure sees the cheap misses; only the model or its
text sees the expensive ones.

P5 labels, one rater. Real misses (a zero caused by wrong vocabulary or scope, or an over-specific
pattern, then retried):
- `createTable('symbols'`
- `new-dependency` (src → dist)
- `typeHash` (wrong file)
- `row_count` (over-specific)
- `^import` (no file argument)
- `record'].*json`
- `BARE` (case)
- `fields(list, 'property\.'`
- `enumValues` → `enum_values`

Not misses:
- The same pattern re-run later: `not_declared`, `GroupResult`, `unverdictable`, `PredicateError`.
- A different question: `json_extract` → `filter`, `args:` → `static override args`, bare `filter`.

Ambiguous: `eslint-disable-next-line` → `eslint-disable`. One candidate was a duplicate (two
segments of one call).

**Q4, declarative.** `bead-close` and `bead-claim` are one-event predicate + mapping. The mapping
fans out, because one `bd close a b c` yields three entries. `plan-status-edit` needs regex capture
over before/after. `search_miss` needs a window and a cross-event join (token overlap), so a handler
DSL needs a sequence operator or it cannot express the type.

**Q5, cost and retention.** Replay is effectively free: 96,631 events in 1.7 s. The normalized log
for this project's whole history (about 35 days, the transcript retention horizon) is 27.2 MB raw,
1.47 MB gzipped. Retention should be capped by bytes, not by event count, and at this rate a year
is on the order of 15 MB gzipped. P8 failed raw mainly because of the segmenter defect below, which
inflates `command.run`.

## Found, not asked

`execSegments` (the shared segmenter behind the production derived types) splits multi-line quoted
program text (`node -e '…'`, `python3 -c "…"`) into "commands". Heads across all 1,007 files,
exact output:

```
('const', 10438), ('"', 5245), ('}', 3170)
```

For scale, there are 88,494 Bash calls, and one call yielded 155 segments. Its effect on the
production `verification_run` count is **not measured**. Filed separately.

## Limitations

- One project, one tracker (beads), one harness. The bead matcher encodes `bd` syntax, so a project
  without beads needs its own handler. That is the argument for per-project handlers.
- Ground truth is the hand path, which is itself a lower bound. "Recovered 28 of 31" measures
  agreement with what was recorded, not with what happened.
- `search.run` from Bash only counts calls with ≤ 3 segments, and hit counting from stdout is
  heuristic.
