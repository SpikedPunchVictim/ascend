# 0117 — A measurement input reaped from a temp tree, and a published result that degraded 3.3× in silence

| | |
|---|---|
| **Bead** | `asc-0qbw` (P2, open) — the temp tree; `asc-560h` (P3, in progress) — the re-measurement it blocked |
| **Surfaced** | 2026-10-18 |
| **Surfaced by** | claiming `asc-560h` early, to check its premise before the date it names |
| **Entry type(s)** | none — the inputs are spike artifacts, not ascend records |
| **Severity** | P2 |
| **Status** | tracer rebuilt, validated and committed; the temp-tree rows are gone, but an equivalent set is re-derived and the published figures reproduce |

## What was found

**`asc-560h` could not be run as written, for two independent reasons, and only one of them was
wrong when the bead was written.**

**The map half.** The bead says *"no commit map regeneration is needed"*, and the obvious reading of
why that matters — that the map has grown by 2,257 commits and a bigger population means a bigger
ceiling — is backwards. Measured rather than reasoned: a refresh **cannot move the ceiling**. It is
489 on the frozen map and 489 on a fresh dump, with `missing-from-frozen 0` for all eight
repositories. The ceiling is join ∩ map, every commit the join names is already in the frozen map, and
a refresh adds only commits the join has never heard of. What a refresh decides is the **outcome**:
of the 95 units still open at `EV-71`'s NOW, **85 have rework candidates the frozen map cannot see**
(344 distinct commits), because their windows reach past coverage ending `2026-10-15T23:52Z`. Grading
them on the frozen map right-censors exactly the rework the 7-day window exists to catch.

**The input half.** The EV-63 scratchpad that holds `traced.tsv`, `list.tsv` and the `blame.py` tracer
is **empty — 0 files**. `asc-0qbw` predicted this and offered it as a choice: commit the scripts, or
accept the loss deliberately. Neither happened. `gen_seeds.py` built the surviving `U` lists with
`only_unfed=True`, deliberately skipping every commit EV-63 had already traced, so those rows existed
in one place and it is gone.

Re-running `remeasure.py` against what survives is silent about it:

```
                     published (EV-73)   re-run 2026-10-18   restored
rework pairs                      21,820               19,927     21,822
any rate                         0.78173              0.57614    0.78173
designEffect                     4.60581             15.22071    4.60581
effective N                       85.544               25.886     85.544
```

**The design gets 3.3× worse and nothing errors.** The funnel is untouched — 852 units, 489
source-bearing, 394 closed, 95 open, 363 ungradeable — because those come from the map and the join,
not from the traces. Only the outcome moves, which is precisely the shape that reads as "the world
changed" rather than "an input went missing".

## How it surfaced

**Nobody was looking for it.** The bead is a date-bound re-measurement, and the first thing done was
to check its premise instead of waiting for the date — that is the whole reason both halves surfaced
four days early. The map half came from asking what a refresh can and cannot move and measuring both
sides. The input half came from running the measurement to establish a baseline before the recovery
work, which is the step that is only obvious if you intend to prove the recovery worked afterwards.

The degradation was caught the same way the spike catches everything else in this area: **a rate that
moves the wrong way is a missing input, never a finding.** `remeasure.py`'s own docblock already
records that leaving `ev63/*/traced.tsv` out takes the `any` rate 0.78 → 0.58 — the warning was
written in the file being run, and the failure was silent anyway, because nothing asserts that the
file is there.

## The metric

Recovery is measured against the tracer's own surviving output, not asserted. `cost/blame.py` was
rebuilt from the 16 surviving `(tag, repo)` trace lists and the format they record:

```
stratified sample, 25 commits from each of the 16 lists
  attempt 1  diff without -w              7/322 commits exact
  attempt 2  -w on diff and blame        138/322 exact, every error a MISSING row
  attempt 3  files keyed on the OLD side 322/322 exact, no extra row anywhere
exhaustive, the eight lists short enough to run whole
  7 of 8 reproduce exactly; U.grizzly-pl differs in ONE row of 2,992, in a column no consumer reads
```

The two details were both recovered by making the rebuild fail against known-good output, and both
were wrong the first time. Whitespace: with `-w` on the blame alone, whitespace-only edits counted as
replaced lines and every count ran high. Deletions: keying files on `+++ b/<path>` drops every deleted
file, because a deletion's new side is `/dev/null` — 75 rows on one ascend commit alone.

End to end, with the re-traced commits and the frozen map at `EV-71`'s NOW, every published digit is
back. Rework pairs land at **21,822 against EV-73's 21,820**; the two extra flip no unit, which is the
direction the instrument's own monotonicity requires.

```
rule    rho                  designEffect        effectiveN          rate
first   0.06902839626965787  3.5960984160502294  109.56318610232849  0.700507614213198
any     0.09587580881514247  4.605806434067972    85.54419419055104  0.7817258883248731
last    0.1038284608692893   4.904898815129769    80.3278548345703   0.6649746192893401
all     0.1367731653077876   6.1439207196213115   64.12843166118925  0.5558375634517766
```

## The pattern

**A derived input outside the repository, and a consumer that cannot tell "missing" from "changed".**
The commit map has an invariant now (`asc-7e9u`, `dogfood/0116`) because it is rebuilt from a source
and its corruption would be indistinguishable from an update. These traces are the same failure with a
different cause: nothing rebuilds them, so their absence is not a rebuild error anyone can notice —
the consumer reads a shorter pair set and reports a worse design with no malformed value anywhere.

The recognition test: **an input whose absence and whose absence of effect are both plausible.** The
funnel did not move, because the funnel does not read traces; the outcome did move, and moved in the
direction a real result could plausibly move. There is no arithmetic that cannot be true, so the
`dogfood/0116` tell — a ceiling that shrank — does not apply here. The only tell available was the
baseline: measure before the recovery, and require the recovery to put the published digits back.

## Why nothing else would have caught it

The `EV-63` cross-check reads the map and does not read traces. The funnel reads the map and the join.
`clusterDesign` takes whatever outcomes it is handed and returns a well-formed design effect for a
degenerate pair set. And `remeasure.py`'s warning about the missing file is a comment, not a check, so
the only thing that failed was a number nobody had a reason to re-read — until a date forced a re-read.

## Consequences and constraints

- **The tracer is now tracked source** (`spike/rework-design-effect/cost/blame.py`), which is the half
  of `asc-0qbw` that costs nothing to fix. The original rows are not recoverable; an equivalent set is.
- **`cost/t3/` holds the re-traced coverage** and is ignored like `t/` and `t2/`. It exists as a third
  directory rather than a merge because its commit lists come from a different `already()` set, and
  merging would overwrite rows a different selection produced.
- **`remeasure.py` still cannot tell a missing trace directory from an empty one.** The check that
  would close this is a coverage assertion — every source-bearing commit in the map is in some trace —
  and it is not written.
- **The 2026-10-22 run still needs the map refreshed and the new commits traced**, for the reason in
  the first half above. The date was never the only obstacle; it was the visible one.

## Resolution

Fixed in the working tree on 2026-10-18: `blame.py` rebuilt and validated as above, `cost/t3/` traced
over the 3,281 uncovered commits, and the measurement re-run to reproduce every published figure.
`asc-0qbw` is **not** closed by this — `ev62/outcome.py` and `ev63/analyse.py` remain lost, and the
coverage assertion above is unwritten.

## Links

- Beads: `asc-0qbw` (P2, open) — the temp tree; `asc-560h` (P3, in progress) — the dated
  re-measurement this blocked; `asc-7e9u` (fixed) — the map's own superset check
- The measurement: `docs/evidence/EV-73.md`, `EV-71.md`, `EV-72.md`
- The rebuilt tracer: `spike/rework-design-effect/cost/blame.py`
- The sibling finding about a rebuilt input rather than a reaped one: `dogfood/0116`
