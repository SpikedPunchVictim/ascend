# 0119 — a suite that runs inside a worktree, asserting the repository has one

| | |
|---|---|
| **Bead** | `asc-9ve8` |
| **Surfaced** | 2026-10-19 |
| **Surfaced by** | the live pre-push hook run of the commit that built it — and, minutes earlier, the mutation runner refusing to start |
| **Entry type(s)** | none — this is about a test's precondition, not the store |
| **Severity** | P1 (it would have blocked every push) |
| **Status** | fixed in the working tree |

## What was found

Two tests in `scripts/push-gate.test.ts` asserted that `git worktree list` held **exactly one** entry.
The property they meant is "the run leaves no worktree behind". What they wrote is "the repository has
exactly one worktree", which is a precondition the test does not own — and the feature under test is
precisely a pre-push hook that holds a worktree **while it runs the suite inside it**.

So the gate that guards a push ran the suite in a worktree, the suite asserted there was only one
worktree, and the push was blocked by the gate's own tests. The tree at `8a7c4f1` carries the defect:
every push after it fails, for a reason that has nothing to do with what is being pushed.

## How it surfaced

**Nobody was looking for it.** Two instruments said it within the same hour, and the first one read as
a problem with the instrument:

- `pnpm mutate push-gate` refused to start — `BASELINE "runs the gate in a worktree of the commit, and
  records a row about THAT commit" fails on the unmutated tree -- kills nothing`. A killer that fails
  on the unmutated tree is a test whose precondition is not met, and that refusal is the whole reason
  the mutation harness has a baseline step.
- The live hook (`sh .beads/hooks/pre-push < refs`) exited 1 with those two tests failing inside its
  own worktree.

The live run is what made the mechanism legible: the failing tests were inside a directory that existed
only because the run was happening.

## The metric

Verbatim from the live hook run:

```
 FAIL  scripts/push-gate.test.ts > gating a pushed commit > runs the gate in a worktree of the commit, and records a row about THAT commit
 FAIL  scripts/push-gate.test.ts > gating a pushed commit > blocks the push when the gate refuses the commit, and still removes the worktree
[pre-push] ascend gate FAILED (exit 1) -- push blocked
```

and the count the assertion was about: `git worktree list` held **2** entries for the length of the
run — the checkout and the gate's worktree — returning to 1 only after it. After the fix (compare
against the count taken *before* the run, not against one), **8 of 8** tests pass in both conditions:
standalone, and with a live hook's worktree open beside them.

**`n = 2`** — two instruments, one machine, one repository. Under `MIN_N`, so this is an anecdote about
mechanism, not a rate.

## The pattern

**An assertion about a global quantity is a precondition the test does not own.** The suite stopped
being the only thing in the repository the moment the repository began running it from a worktree.
`git worktree list` has one line in almost every repository, which is what makes the assertion read as
obviously true — it was true for exactly as long as nothing else used worktrees, which is until the
feature that needed them landed.

## Why nothing else would have caught it

- **Not a review.** One line of `git worktree list` is what every reader expects to see.
- **Not the commit gate.** The tests pass when run normally, and only fail while another worktree
  exists — which is the push path, and only the push path.
- **Not the mutation spec on its own.** It refused before applying anything, so its output names a
  baseline problem rather than the test's precondition.
- **Not the demo the plan called for, in the direction it was written.** The plan said "run the hook
  for real and show its row". That is what failed, which is the demo working.

## Consequences and constraints

- The two driven tests now capture `worktreeCount()` before the run and assert it returns to that
  number. The weaker assertion is the honest one: this repository may legitimately hold other
  worktrees, and a test has no business asserting otherwise.
- The mutation spec's M4 (`--detach` dropped from `git worktree add`) is an **intended survivor**:
  `git worktree add <path> <40-hex sha>` detaches either way, measured in a scratch repository where
  `symbolic-ref -q HEAD` fails in both forms. It is declared with its `why` rather than deleted, so
  the flag's intent at the call site stays written down.
- The fix is in the same change as the feature. There is no window in which the pushed tree carries
  the defect.

## Links

- Bead: `asc-9ve8`
- The feature: `asc-n0if`, `dogfood/0096`
- The harness that refused first: `scripts/mutate.mjs`'s baseline step, `dogfood/0070`
