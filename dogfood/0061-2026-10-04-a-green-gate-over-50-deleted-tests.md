# 0061 — a green gate over 50 deleted tests

| | |
|---|---|
| **Bead** | `asc-049w` |
| **Surfaced** | 2026-10-04 |
| **Surfaced by** | writing the renderer's tests for Stage 2 of `asc-0hys`; a `Write` replaced an existing 659-line test file, and the gate that ran over the result reported green |
| **Entry type(s)** | `verification_run` (derived) |
| **Severity** | P1 |
| **Status** | fixed in `4495e23` |

## What was found

**The gate cannot see a deleted test.** The pre-commit gate runs the whole suite and prints
`Test Files 128 passed (128)` followed by a pass count. Nothing compares that pass count against a
stored baseline, so removing tests leaves a green verdict: a deleted test and a passing test are the
same word in the gate's output. The file count moves only when a whole file is added or removed, so
the one number the gate does print at file granularity is blind to a file being hollowed out.

This is an absence, not a wrong value — the thing that should happen (a count compared against what
it was) does not happen anywhere. Absences are what a code review will not catch, and no test covers
this one, because the behaviour of a test that does not exist is not a behaviour any test can assert.

## How it surfaced

A file was destroyed by an ordinary write, and the gate blessed the result.

While adding the renderer's tests for the clustering correction, I wrote
`packages/cli/test/output.test.ts` believing — on the authority of a check carried in from a compacted
session and reported as verified — that no such file existed. It did. The `Write` replaced 659 lines
and 55 tests (table clipping, surrogate and grapheme-cluster cuts, CSV neutralisation, `renderProportion`'s
own 8 tests) with 5.

The full gate then ran over that tree and **exited 0**: `Test Files 128 passed (128)`, the same 128 as
the run before it. Nothing in the gate's output had changed shape. It surfaced only because the pass
count, `2936`, disagreed with a number from earlier in the same session, `2981` — and that number
existed only because I happened to have it in context. A fresh session would have had no baseline to
compare against and no reason to look.

**Nobody was looking for it.** The gate was run three times over the damaged tree and was green every
time. It was not a review, a lint rule, or a test that found this; it was a coincidence of memory.

The damage never reached a commit — the file was restored from `HEAD` before `fd96e49` — so no history
needs correcting. The green verdicts were real, though, and were the only signal anyone had.

## The metric

**`git show HEAD~2:packages/cli/test/output.test.ts | wc -l`** → `659` (the file as it stood before
this work; `HEAD~2` is `137fc91`).

**`npx vitest run packages/cli/test/output.test.ts`** at that revision → `Tests  55 passed (55)`.

**The gate over the overwritten tree** (`pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm align`):

```
 Test Files  128 passed (128)
      Tests  2936 passed | 2 skipped (2938)
verdict: green
```

**The gate over the same tree once the file was restored and merged** (3 design tests added to the
existing `renderProportion` block, which already had 8 of its own):

```
 Test Files  128 passed (128)
      Tests  2989 passed | 2 skipped (2991)
verdict: green
```

Both runs report **`128 files`**. The overwritten tree's 5 tests and the restored tree's 58 differ by
53; the suite totals differ by 53 (`2989 − 53 = 2936`). **50 tests were missing**, and the file count
was identical in both runs.

**The repair, checked by name rather than by count** — every touched file, its `it(...)` names at
`HEAD~2` against its names now:

```
packages/cli/test/output.test.ts               HEAD=46 now=49  LOST=[]  added=3
packages/analysis/test/proportion.test.ts      HEAD=17 now=21  LOST=[]  added=4
packages/analysis/test/design-effect.test.ts   HEAD=11 now=11  LOST=[]  added=0
```

(46 vs 55 and 17 vs 22 because `it.each` expands at run time and one name contains an apostrophe, so
the single-quote extraction misses it. The name diff is the check that matters: `LOST=[]`.)

This is a group of **1** file — an anecdote, not a rate. It is reported as a single observed fact:
it happened once, and nothing here measures how often it happens.

## The pattern

**A measured quantity with no baseline.** A count is only a check if something remembers what it was.
`ascend` already applies this reasoning to two neighbours and not to this one:

- `align` baselines debt — `baselined debt: 21 → 21 (0)` — and reports the movement.
- `asc store verify --staged` baselines record ids — `1 baseline(s) ... no lost record ids` — and the
  pre-commit hook runs it.

The test count is the one measured quantity in the gate with no baseline, and it is the one whose
regression is silent, because a suite that loses tests keeps printing `passed`.

The class is broader than tests: any assertion of the form "this is still true" that has no record of
what "still" refers to degrades into an assertion that nothing changed shape. This project's own
recurring theme — a count that outlives its transcript — is the same idea from the other side.

## Why nothing else would have caught it

Stated plainly, because two things *would* have:

- **`git diff --stat` would have.** A 659-line file becoming a 63-line file is ~600 deletions with one
  insertion. It is not subtle. Nobody ran it before the first gate; I ran it only after the pass count
  already looked wrong.
- **A reviewer reading that diff would have.** `ReportFindings` exists for exactly this, and "you
  replaced a 659-line test file" is a finding any reviewer would raise.

What would **not** have caught it, and this is the part worth keeping: `typecheck` (the file still
compiled), `lint` (the file was still clean), `align` (no import changed), and **the test run itself**,
which is the gate phase whose entire job this is. The gate's green is the trust anchor for every change
in this repo, and a verdict that survives a silent deletion of the evidence does not degrade gracefully
— it fails at the one moment it is being relied on.

## Consequences and constraints

- **No committed state is wrong.** The damaged tree was repaired before any commit, verified by
  name-diffing against `HEAD~2`, so this is a finding about a signal, not about data. Nothing needs
  invalidating and no entry is affected.
- **A baseline is a new way to make the gate red for the wrong reason.** An intentional deletion has to
  update the baseline in the same commit, or the gate blocks legitimate work — which is how a baseline
  becomes a number people edit until it stops complaining. `align`'s `baselined debt: 21 → 21 (0)` line
  is the shape that works: the movement is printed, so raising a baseline is visible in the diff rather
  than silent.
- **The count has to come from the runner, not from the files.** `grep -c "it("` was wrong twice while
  measuring this — it missed `it.each` expansion and a double-quoted name. A baseline built on that
  extraction would have been wrong in the same direction it was supposed to detect.

## Links

- Bead: `asc-049w`
- Plan: `IMPLEMENTATION_PLAN.md`, "Stage E22", Stage 2 status
- Entries recorded at the time: `dc79efd7-9e51-4d1d-99b2-a45d3c88ff3d` (`stage_transition`, Stage 2)
- Related: `dogfood/0034` (an absent reason stored as a value — the same shape, a check whose reference
  was never carried)
