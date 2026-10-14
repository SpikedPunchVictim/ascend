# 0089 — A mutation verdict that moved with the machine

| | |
|---|---|
| **Bead** | `asc-9lfs` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | `pnpm mutate gate-lock --allow-dirty`, while writing the mutation spec for `asc-09wx.14`'s cross-session gate lock |
| **Entry type(s)** | none — this surfaced from `scripts/mutate.mjs`, which is a script rather than an `asc` command |
| **Severity** | P2 |
| **Status** | open |

## What was found

**`scripts/mutate.mjs` runs each named killer once and reports its verdict as a fact about the
mutant. When the killer asserts a wall-clock bound, that verdict is a fact about the machine.**

The spec's mutant L4 folds the gate lock's wait into the first step's recorded duration — the one
defect the lock's own rules exist to prevent, since a wait counted as a step makes the gate look
slower exactly as the lock made it faster. The runner reported L4 as **SURVIVED**. Planted by hand
and run under `npx vitest`, the same killer at the same commit **fails**.

The killer's assertion is `waited_ms + total_ms <= elapsed`, where `elapsed` is the test's own
wall clock around the gate process. Under the mutant a wait `W` appears twice on the left and once
on the right, so the assertion fails exactly when `W > overhead` — and `overhead` is everything
between the test's clock starting and the gate's first step: node boot, two `git` spawns, process
teardown. Nothing in the test controls it.

## How it surfaced

The spec is required to report its result beside the gate result, so the run was not optional and
its red was not ignorable. What made the survivor legible as a *machine* artefact rather than a
fixture gap — the reading `mutation-survivors-point-at-the-fixture` would have suggested — was
planting the mutant by hand with a temporary probe line and reading the row it printed:

```
PROBE {"waited":1009,"total":4048,"elapsed":4907.79,...}
FAIL scripts/gate.test.ts > driving the real gate > waits for another session's gate, and the wait is not inside a step's duration
```

The mutant died. The runner had said it lived. Both statements were about the same tree, and the
difference between them was 860 ms of overhead against a 1009 ms wait — a 15% margin, on a machine
that was simultaneously running three other sessions' mutation runs.

**Nobody was looking for it.** The question was "does this mutant die?", and the answer the tool
gave was wrong; the second question — "is the tool's answer stable?" — had no reason to be asked
until the first answer contradicted a hand-run.

The first repair was on the killer's side, and it was a **number rather than a mechanism**: the hold
was raised from one poll interval to four seconds, on the reasoning that the margin should be a
multiple of the measured overhead rather than a coin toss. Planting L4 again and running the killer
by hand then failed with `AssertionError: expected 9152 to be less than or equal to 7862.054209` — a
margin of 1290 ms — and that was taken as the repair holding, the test's comment rewritten to carry
the arithmetic so the constant would not be shrunk back.

**The spec run disproved it in the same session.** L4 survived again, at the same four seconds,
because `overhead` has no ceiling: it is a process spawn, and a process spawn on this machine was
measured at **2785 ms for a two-line shell script**. Outrunning it with a constant is not a repair;
it is a bet that can be re-lost by a busier afternoon. That is three attempts at one killer — one
poll, four seconds, and then a different question — so the third changed the **kind** of witness
rather than the number.

What replaced it is a clock that shares the row's window. `scripts/gate.mjs` now records `wall_ms`,
its own `hrtime` across the step loop and the lock release: every step's `ms` is measured inside it,
and node's boot, the two `git` calls that fill the rest of the row and the process's teardown are all
outside it. The assertion became `total_ms <= wall_ms + 50`, and planting L4 by hand then failed with
`AssertionError: expected 2738 to be less than or equal to 764` — a margin of 1974 ms against a
slack of 50 ms, and, more to the point, a slack that is not a function of load at all: no process is
spawned inside the window, so there is nothing for the machine to slow down. The hold went back down
to one poll interval, and the contended test went from 12.2 s to 3.5 s.

## The metric

The runner's verdict, verbatim from the spec run (`pnpm mutate gate-lock --allow-dirty`):

```
| L4 | SURVIVED a named killer | - | waits for another session's gate, and the wait is not inside a step's duration |
7 mutant(s), 1 problem(s). FAILS.
```

The same mutant's killer, planted by hand at the same commit and run under
`npx vitest run scripts/gate.test.ts -t "waits for another session's gate"`, before the hold was
raised:

```
AssertionError: expected 5057 to be less than or equal to 4907.794834
```

and after it was raised:

```
AssertionError: expected 9152 to be less than or equal to 7862.054209
```

and, once the witness itself was replaced by the gate's own clock across the step loop:

```
AssertionError: expected 2738 to be less than or equal to 764
```

Every hand-run restored the tree from a byte copy taken first, verified by sha256 — the mutation
runner edits the working tree, so a hand-plant that is not checked on the way back is a poisoned
tree and every later verdict from it is unearned.

The runner's verdict after the second repair, verbatim from the spec run:

```
| L4 | SURVIVED a named killer | - | waits for another session's gate, and the wait is not inside a step's duration |
7 mutant(s), 1 problem(s). FAILS.
```

The two overheads are differences, not readings: `elapsed − (waited_ms + total_ms − waited_ms)`
from the probe row (860 ms), and the same quantity in the later run at `loadavg 32.17 36.88 35.77`
on twelve cores (2710 ms). The runner records no load, so neither figure can be recovered from its
own output — which is the gap `asc-9lfs` proposes to close.

**One mutant, one machine.** This is an anecdote and is labelled as one; nothing here estimates how
often a timing-bound killer flips.

## The pattern

**An assertion about time has a power, and that power is a margin.** A killer of the form
`A + B ≤ C` where `C` is a clock the test does not own is only as strong as the slack between the
quantity the mutant inflates and the noise the environment adds — and that slack shrinks as the
machine gets busier, which is precisely when a mutation run is most likely to be run (it is long,
and it is run beside other work). The mutant does not become less detected; the *verdict* changes.

The instrument-side half of the class: **a tool that reports a verdict without reporting the
conditions it was reached under cannot distinguish a true survivor from a flaky one.** The runner is
careful about the failure direction it does model — every named killer must pass on the unmutated
tree first, so a killer that fails for an unrelated reason cannot be counted as a kill — and it has
nothing for this one, because the baseline run is *also* load-dependent and is run once too.

The repair rule, which belongs in the spec author's hands rather than the runner's: **a killer that
asserts a wall-clock bound must hold a margin that is a multiple of the overhead it can measure,
not the smallest value that passes on a quiet machine.** Where the margin cannot be made large
enough to dominate the environment, the assertion is the wrong shape and the quantity needs a
witness that does not pass through a clock the test does not own.

**The second half of that rule is the one that was right, and the first half is what failed.** A
multiple of a measured overhead is still a bet on the overhead staying under the multiple, and here
the same machine measured it at 860 ms and then at 2710 ms an hour later. The rule to keep is the
one about the clock: **an assertion's noise floor should not contain a thing the machine can slow
down.** A process spawn is such a thing in this environment, and it is why `wall_ms` — measured
inside the gate, around the step loop and nothing else — turned a 1290 ms margin at the mercy of
load into a 1974 ms margin that load cannot touch.

**And the repair was first validated the same way the defect was found.** The four-second hold was
believed to work because one hand-run, at one load, failed as predicted — an n of one under
conditions nobody varied, which is exactly the shape of evidence that produced the flake it was
meant to cure. What settled it was the spec run, not the hand-run: the machine's own verdict, once
the killer had been repaired the wrong way, was that the mutant lived.

## Why nothing else would have caught it

The suite was green: 26 tests across the two gate files, before and after. `pnpm mutate`'s own
baseline check passed, since the killer does pass on the unmutated tree. A review of the assertion
would have read the arithmetic as sound, because it is — `S + 2W > S + W + overhead` is exactly the
inequality intended and it was true on the machine it was written on.

What caught it is the repo's own rule that a survivor is a finding, combined with the price of
doubt: planting the mutant by hand rather than accepting the verdict. The transferable form is that
a *survivor* deserves a hand-run whenever the killer's assertion involves a threshold, because the
two explanations — fixture gap and flaky assertion — have opposite repairs, and the runner cannot
tell the reader which one it is.

## Consequences and constraints

Nothing in the tree is wrong. The finding is about an instrument's verdict, so the response is a
practice, not a patch: the assertion is now the one the gate's own clock can support, and the
reason it is that clock rather than the test's is written beside it in `scripts/gate.test.ts`.

The gate gained a field for it. `wall_ms` is the gate's `hrtime` across the step loop and the lock
release, recorded beside `total_ms`, and it is useful beyond this test: a row whose two agree is a
row whose per-step durations account for the whole of the gate's own working time, and a grader
comparing runs at different loads can tell a slow step from a slow machine without a stopwatch.

The other repair is a candidate on `asc-9lfs`, not a commitment: recording `loadavg` beside each
verdict, or re-running a survivor's killer once and reporting "survived twice" separately from
"survived once". Deliberately not proposed: a timeout. `scripts/mutate.mjs` has none on purpose, and
adding one would turn the runner's own behaviour into the load-dependent thing — it is already the
reason every test of an unblocking rule in this spec releases the lock from a helper process, which
is written into the spec's own `_` field.

No entries are invalidated: nothing about this finding is about recorded data.

## Links

- Bead: `asc-9lfs`
- The spec the verdict came from: `scripts/mutations/gate-lock.json`, mutant `L4`
- The killer repaired: the contended-gate test in `scripts/gate.test.ts`
- The work it was found under: `asc-09wx.14`, stage G3
- Same class, different instrument: `dogfood/0063`, `asc-pcaw`
