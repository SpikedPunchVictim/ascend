# 0007 — The gate's red was the test suite competing with itself, and a growing corpus set the deadline

| | |
|---|---|
| **Bead** | `asc-3x1` |
| **Surfaced** | 2026-09-18 |
| **Surfaced by** | Four consecutive `pnpm quality-gate` runs blocking an unrelated commit (`asc-tlc`) |
| **Entry type(s)** | `stuck_event` (starter), `decision` (starter) |
| **Severity** | P2, matching the bead |
| **Status** | fixed in `c5a417f` |

## What was found

`derive-real-corpus.test.ts` timed out against its 120,000 ms budget on four consecutive gate
runs, while passing in about 10 s when run on its own. The budget was not measuring anything the
test asserts -- every assertion in the file is size-independent -- and the test that FAILED
rotated between runs, so the red named a different victim each time. Two things were wrong at
once, and each disguised the other: the suite oversubscribes the machine against itself, and the
deadline it has to beat is set by a corpus that grows on its own.

## How it surfaced

Nobody was looking for it. The finding arrived while trying to land an unrelated change, and the
first three runs were read as ordinary machine contention -- the desktop was carrying a video
call, Docker, a VM and an editor. That reading was wrong, and the evidence that killed it was the
FOURTH run: it was the slowest of the four (685 s) on the LEAST-loaded machine. A hypothesis that
predicts "quieter is faster" and then meets "quieter was slower" is finished.

Two mechanisms, both visible only from outside a single test:

1. **The rotation was a shared promise, not flakiness.** The file memoizes one sweep --
   `shared ??= sweep()` -- so whichever test first awaits it carries the entire cost, and the
   others get the cached result for free. When that first test times out, the promise is still
   pending, so every sibling awaiting it times out too. One slow sweep, two reported failures, and
   a different name on top depending on scheduling.
2. **The suite is its own load.** Vitest defaults to one worker per core (12 here). Two suites
   spawn REAL `asc` child processes -- `8pp-truncation.test.ts` alone does 12 -- so a worker is a
   worker PLUS its children, and the suite is already at roughly double the hardware before any
   test reads a byte. Two more files then stream the whole live transcript corpus and evict each
   other's page cache.

The second half is the ascend-specific one, and the part that would have come back: the corpus
those tests read is `~/.claude/projects`, which this project's own dogfooding sessions write to
continuously. The test's cost is a function of a dataset the work itself produces.

## The metric

Sweep time for `derives entries that all satisfy their own definitions`, against its 120,000 ms
budget, full suite, same machine:

```
forks   sweep        of budget   wall-clock   verdict
   12   113,931 ms       94.9%    558-1152 s  RED (four runs)
    8    40,641 ms       33.9%        272 s   green
    6    24,094 ms       20.1%        292 s   green
    4    31,118 ms       25.9%        523 s   green
```

Contention isolated by running subsets, same test, same budget:

```
alone                                  ~10,000 ms
+ 5 heavy non-corpus CLI files         49,539 ms
+ 1 other corpus file (parallel)       77,502 ms
+ 1 other corpus file (sequential)     16,503 ms
```

Parallelism was LOSING, not trading off: the same two corpus files took 114.01 s racing each
other and 75.00 s run sequentially.

Corpus growth, which sets the deadline. The file's own header records `843 files, 431,039
records, 1,488 entries ... in 5.2 s` measured 2026-09-15. Measured 2026-09-18 by walking the same
root: **892 files, 512,690 lines, 1,515.9 MB** -- +5.8% files and +18.9% records in three days.

The change under test at the time was cleared by direct measurement rather than by argument:
`projectRelativeCwd` called once per line across the whole corpus costs **94.4 ms** for all
512,690 lines, which is 0.08% of the budget.

## The pattern

**A fixed deadline guarding a quantity that grows on its own.** The budget was set when the
corpus was 1.2 GiB and was never a claim about anything -- the assertions are all
size-independent. It is a tripwire, and a tripwire whose threshold is static while the thing it
measures compounds will eventually fire for reasons unrelated to the defect it was placed to
catch. The remedy is to restore headroom, not to move the wire: at 20% of budget the corpus can
grow 5x before this recurs; at 34%, only 3x.

A second, smaller pattern: **a memoized fixture turns one slow operation into N reported
failures.** The failure count and the failing test's name both become misleading, which is what
sustained the wrong diagnosis for three runs.

## Why nothing else would have caught it

A review would not have caught it -- nothing in the diff was wrong, and the suite had been green
at 12 forks for the project's whole life. It only became visible when the corpus crossed the
point where 12 workers no longer fit, and at that point it presented as an unrelated change being
blocked. The honest version: a test that had been sitting at 94.9% of its budget on a clean
machine was already the finding, and that number was measured and filed three days earlier
without being acted on.

## Consequences and constraints

The fix is configuration only (`vitest.config.ts`), so nothing about the corpus or any recorded
entry changes. Raising the 120,000 ms budget was the rejected alternative: the sweep does ~10 s of
real work, so a larger budget would hide exactly the regression the tripwire exists to catch.

The deadline will come back. The corpus grows with every dogfooding session, and this record's own
session added 18.2 MB to it. The headroom bought here is 5x, not permanent.

## Links

- Bead: `asc-3x1`
- Fixed in: `c5a417f`
- Blocked, and then unblocked: `asc-tlc`, fixed in `42ed373`
- Entries recorded at the time: `70e578b7-c1df-41f8-b4e7-a8f3e6476fc9` (`stuck_event`),
  `168fb357-6bc2-4e3f-b261-c90c4229e4da` (`decision`),
  `e593032e-54b7-46db-9e8b-f0a422864fe8` (`stage_transition`)
