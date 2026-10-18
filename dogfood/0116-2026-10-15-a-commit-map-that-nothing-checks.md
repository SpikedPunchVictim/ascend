# 0116 — A commit map that nothing checks

| | |
|---|---|
| **Bead** | `asc-7e9u` (P3, **fixed** 2026-10-18) — the superset assertion; `asc-560h` (P3, open) — the dated re-measurement |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | `EV-71`'s own close-out item, *"regenerate the `ev63` numstat before any re-run"*, carried into this session as a task |
| **Entry type(s)** | none — the map is a spike input, not an ascend record |
| **Severity** | P2 |
| **Status** | fixed in the working tree 2026-10-18 (see **Resolution**) — the assertion landed in `numstat.py`; the dated re-measurement stays open |

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
- **A superset assertion was the cheap fix and was not in place. It is now, in `numstat.py` — see
  **Resolution**.** It catches Error 1 at the moment it happens, and it is silent on Error 2 by
  construction, which is why the clock still needs the byte-level reproduction. The one-line form
  (`set(new) >= set(old)` over commit ids) turned out to be wrong here for a reason nobody had
  predicted: it fires on ascend's own map on every rebuild, because GitButler rewrites the Workspace
  Commit.

## Resolution

**Fixed in `spike/rework-design-effect/cost/numstat.py` on 2026-10-18 (`asc-7e9u`).** When the output
path already holds a map, the dump parses it, compares commit ids, and refuses to write unless every
old commit that carried numstat rows is present in the new one. The comparison runs *before* the write,
so a refusal leaves the old file byte-identical rather than half-overwritten. A genuine loss is stated
rather than inferred — `--allow-shrink "<reason>"` — and the reason is printed with the run, so the
override is a claim someone made and not a flag someone flipped.

**The rule is over commits that carried files, and that refinement is measured, not defensive.** The
one-line version — a superset over commit ids — fires on every rebuild of ascend's own map. GitButler
rewrites the Workspace Commit on each operation, so the previous one becomes unreachable from every ref
while remaining in the object database. First run against `snap/at/ascend.numstat.log`: 401 commits
held, 403 dumped, **one dropped**, and the dropped record is `6bb7e039` "GitButler Workspace Commit"
with an empty body. A commit with no body has no file for a unit to join on, so `src()` is false for it,
`delta.py` never selects it to trace, and it cannot move the ceiling, a rate or an outcome — dropping it
is inert. A check whose only possible answer is always the same `--allow-shrink` is a check that gets
rubber-stamped, which is the failure mode of a rule stricter than the invariant it protects.

Four cases, run against real dumps:

```
superset   ascend over ascend's own map      403 commits (+3 new, 0 dropped with files, 1 empty-bodied dropped)  exit 0
shrink     spindle over ascend's map         holds 401, dumps 222, 399 of the old ones that carried files are not in it
                                             and the file it refused to replace still hashes 0320234e…  exit 1
stated     the same shrink, --allow-shrink   222 commits (+222 new, 399 dropped with files, allowed: …)  exit 0
no reason  --allow-shrink with no argument   "--allow-shrink needs a reason: a map that shrank is a claim, not a flag"  exit 1
```

All eight repositories, each dumped over its own current map, pass with **zero false positives**:

```
ascend 403 (+3 new, 0 dropped)  grizzly-pl 4672 (+914)  mast 531 (+31)  spindle 222 (+0)
grizzly-exp 4424 (+313)         grizzly-sv 4765 (+1030) grizzly-wip 1884 (+0)  grizzly-platform 3211 (+0)
```

**What it still cannot see is Error 2.** It compares commit ids, which both clocks produce identically,
so it is silent on the `%at`/`%ct` split by construction. That one still needs the byte-level
reproduction of all eight dumps, and no superset test will ever replace it.

**A consequence that lands on 2026-10-22, found by the check on its first real run — and the first
version of this paragraph was wrong.** The grizzly clones have moved since the map was frozen on
2026-10-15: `grizzly-pl` by **914** commits, `grizzly-sv` by **1,030**, `grizzly-exp` by **313**;
`grizzly-wip` and `grizzly-platform` are unchanged. `asc-560h`'s premise that *"no commit map
regeneration is needed"* is stale.

**What a refresh can move, measured rather than assumed** (2026-10-18, over the join and a fresh dump
of all eight repositories):

```
ceiling on the frozen map  489      ceiling on the fresh map  489      difference  0
units already graded on a closed commit 394   open at EV-71's NOW 95   (reconciles with EV-73)
open units with rework candidates the frozen map cannot see  85   distinct candidates  344
```

The ceiling **cannot** move, and that is a structural fact rather than this dump: the ceiling is
join ∩ map, every commit the join names is already in the frozen map (`missing-from-frozen 0` for all
eight), and a refresh adds only commits the join has never heard of. The first version of this
paragraph said the opposite — that adding commits could only grow the ceiling and that accrual was at
stake — which is the Error 1 mechanism run backwards: a bad refspec *removes* join commits and drops
units, a good refresh *adds* non-join commits and moves nothing.

What a refresh decides is the **outcome**. A unit is graded only once its window has elapsed, and the
95 units still open at EV-71's NOW are exactly the ones whose windows reach past the map's coverage
end, `2026-10-15T23:52Z`. Grading them on the frozen map right-censors the rework the 7-day window
exists to catch. So the dated re-measurement needs the map refreshed **and** the new source-bearing
commits traced before `remeasure.py` runs — a candidate that is in the map but in no trace is not
rework evidence either.

## Links

- Beads: `asc-7e9u` (P3, open) — assert a rebuilt map is a superset; `asc-560h` (P3, open) — the
  dated re-measurement on 2026-10-22
- The measurement: `docs/evidence/EV-73.md`; what it re-derives: `EV-71.md`, `EV-72.md`
- The generator, now with the refspec and the field named: `spike/rework-design-effect/cost/numstat.py`
- The consumers: `.../cost/remeasure.py`, `.../cost/delta.py`, `.../cost/commits.py`
- The dump `EV-63` never had to leave behind: `spike/holdout-unit/` and `asc-0qbw`
- The sibling finding about a replayed input rather than a rebuilt one: `dogfood/0115`
