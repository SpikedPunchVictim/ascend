# 0116 — A commit map that nothing checks

| | |
|---|---|
| **Bead** | `asc-7e9u` (P3, open) — the superset assertion; `asc-560h` (P3, open) — the dated re-measurement |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | `EV-71`'s own close-out item, *"regenerate the `ev63` numstat before any re-run"*, carried into this session as a task |
| **Entry type(s)** | none — the map is a spike input, not an ascend record |
| **Severity** | P2 |
| **Status** | open |

## What was found

**The commit map the rework measurement reads is reconstructed from eight git repositories by an
ad-hoc dump, and nothing in the pipeline asserts that a rebuilt map is a superset of the map it
replaces.** Two separate errors in rebuilding it survived every check except one that had to be
applied by hand, and one of them made the experiment look *better* than the one it replaced.

**Error 1: the refspec.** The dump followed only the checked-out branch. On `grizzly-wip` that is
**835 commits against 1,884 across all refs** — so the rebuild dropped 113 source-bearing commits out
of one repository, and the 489-unit ceiling fell to **420**. A commit that is not in the map is not
"missing", it is *not a commit*: it stops being a source-bearing commit, its unit leaves the ceiling,
and the arm's accrual rate drops from 10.188 to 8.75 units per active day. The refresh reported the
population as smaller and the experiment as cheaper to run.

**Error 2: the clock.** The eight repositories' existing dumps were not built on one clock. `EV-63`'s
four snapshots record `%at`, the author date; the four grizzly dumps record `%ct`, the committer date.
ascend's `1f765ce3e4d1` is `%at` 1789713547 in the snapshot and `%ct` 1789713993 today; grizzly-exp's
`29095b9aa6dc` is the reverse. **130 commits across the eight disagree, by up to 19.7 hours**, and
every window test in the measurement — `0 < rw_at - c['at'] <= 7*DAY` — subtracts two clocks for half
the corpus. This one turned out to cost nothing measurable (`EV-73`), which is luck rather than
design: it was not detected by anything, it was found by trying to *reproduce* the old dumps and
failing on 130 of them.

## How it surfaced

**Nobody was looking for it.** The step was a chore on a close-out list — *"regenerate the numstat"* —
and it reads as mechanical: dump eight repositories, swap the files, re-run. Both errors were found
only because regenerating an input has a property that re-running does not: **it can be checked
against the input it replaces.** That check is not in any script, and it was not a step in the
handoff; it was available because the old files were still on disk.

The tell for Error 1 was one line of arithmetic that could not be true: **the ceiling can only grow.**
Adding commits to a map cannot remove a source-bearing commit from it, so a refreshed population that
comes out *smaller* is a missing input and never a measurement. That is the whole detection
mechanism, and it only works if the number being compared has a known monotonicity. It was visible
here because the funnel was printed alongside the rebuild rather than after it.

## The metric

Ceiling and accrual rate, per map, from `remeasure.py` (exact output in `docs/evidence/EV-73.md`):

```
map                        ceiling   closed   open   ceiling per active day
EV-71's (published)            489      394     95                   10.188
rebuild, HEAD only             420      326     94                    8.750
rebuild, all refs, %at         489      394     95                   10.188
rebuild, all refs, %ct         489      394     95                   10.188
```

Reproduction against the field each existing dump was written with — the second row is the only
column that is zero for a correct generator:

```
repo              old    new  old-only  differing-after-parse
ascend            367    401         0                      0
grizzly-pl       2118   3758         0                      0
mast              387    500         0                      0
spindle           220    222         0                      0
grizzly-exp      3989   4111         0                      0
grizzly-sv       3635   3735         0                      0
grizzly-wip      1843   1884         0                      0
grizzly-platform 3127   3211         0                      0
```

Re-dumping with `--all` and one field reproduces every old file exactly on its overlap, and the
outcome lands on `EV-71`'s published digits under both clocks — on **21,820** rework pairs against
`EV-71`'s **19,662**, so the agreement is a result and not a re-run.

## The pattern

**A reconstructed input has no invariant unless one is written for it.** The commit map is derived
data with an unusual property: it is *rebuilt from the same source* on every pass, so a mistake in the
rebuild is indistinguishable from a change in the source. Every downstream check the repo has — the
`EV-63` cross-check, the funnel, the design effect — reads the map and cannot see how it was made.
Both errors were in the constructor, and both were invisible to everything that consumed it.

The recognition test: **a derived input whose corruption and whose update look identical.** Where that
holds, the only available check is against the previous copy, and that check has to be run
deliberately because nothing downstream will ever run it. Here, that meant reproducing eight files
byte-for-byte before trusting one row of the rebuild — which is what turned up the clock split, an
error nobody had a question about.

## Why nothing else would have caught it

The `EV-63` cross-check is the strongest check in this spike and it is blind to both errors: it
consumes the map, and a map missing 113 commits of `grizzly-wip` reproduces `EV-63` for the
repositories that still have their commits. The design-effect arithmetic is blind for the same
reason. And both errors were in a script written *during this session*, so no amount of reading
`EV-71` would have surfaced them — the failure mode is "the refresh did its job slightly differently
from the thing it refreshed", which is not a claim any existing record makes.

## Consequences and constraints

- **`numstat.py` now carries the refspec, the field and the reproduction requirement in its docblock**,
  because it is the only place either is chosen. That is a comment, not an invariant.
- **The clock split is real and un-repaired in the legacy traces.** The `t/` tree's 11 MB of blame
  output was written under whichever clock existed when it was made and cannot be re-derived; only
  the delta traces were written against the map being measured. Bounding it properly is a full
  re-trace, 8,238 commits per field against the 2,198 the delta needs, and it was not run.
- **The 489-unit ceiling is still censored**, and the reason is now a date rather than a gap: the 95
  open windows shut between 2026-10-15 and 2026-10-22, and a re-measurement on 2026-10-22 sees 483 of
  489. No rebuild can bring that forward.
- **A superset assertion is the cheap fix and is not in place.** One line in `delta.py` — or in
  whatever consumes a map — comparing `set(new) >= set(old)` would have caught Error 1 at the moment
  it happened, and would have been true for Error 2, which is why the clock needed the byte-level
  reproduction instead.

## Links

- Beads: `asc-7e9u` (P3, open) — assert a rebuilt map is a superset; `asc-560h` (P3, open) — the
  dated re-measurement on 2026-10-22
- The measurement: `docs/evidence/EV-73.md`; what it re-derives: `EV-71.md`, `EV-72.md`
- The generator, now with the refspec and the field named: `spike/rework-design-effect/cost/numstat.py`
- The consumers: `.../cost/remeasure.py`, `.../cost/delta.py`, `.../cost/commits.py`
- The dump `EV-63` never had to leave behind: `spike/holdout-unit/` and `asc-0qbw`
- The sibling finding about a replayed input rather than a rebuilt one: `dogfood/0115`
