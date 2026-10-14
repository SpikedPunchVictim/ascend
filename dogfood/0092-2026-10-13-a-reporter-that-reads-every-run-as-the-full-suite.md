# 0092 — a reporter that reads every run as the full suite

| | |
|---|---|
| **Bead** | `asc-19x2` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | running one test file while working on the gate, then reading `.testcount/` to check what the gate's own run had left behind |
| **Entry type(s)** | none — this is about the test reporter, not the store |
| **Severity** | P3 |
| **Status** | open |

## What was found

`vitest.test-count.ts` writes `.testcount/scan.json` on every run whose `ASCEND_TEST_SCOPE` is not
`subset`. Its docblock justifies that with *"the variable is absent for a person's own `pnpm test`,
so an ordinary run still records"* — and the variable is equally absent for `pnpm vitest run
<one file>`, which is not an ordinary run of the suite.

So a single-file run overwrites the scan with a single file's counts, and `scripts/test-baseline.mjs`
— whose whole job is to compare that scan against the tracked baseline — reads the difference as a
breach. The gate is shielded from this by *ordering* rather than by design: its step list is
`[...CHECK_STEPS, test, test count]`, so the full `pnpm test` step overwrites the stale scan before
`test count` reads it. What is left is developer friction — a red baseline check for anyone who
runs one file and then runs the check directly — and a docblock claim that is not true.

## How it surfaced

**Nobody was looking for it.** It arrived from a side-effect of the work: `pnpm vitest run
packages/cli/test/project-handlers.test.ts`, run to check one file quickly while the gate changes
were in the tree. Hours later, listing `.testcount/` to confirm the gate's own drive had left the
scan alone, `.testcount/scan.json` was 156 bytes holding a single file.

The `at` field says when: `2026-10-14T00:54:25.457Z`, inside the window the drives were running.

## The metric

`.testcount/scan.json` as found, verbatim:

```
{
  "at": "2026-10-14T00:54:25.457Z",
  "files": 1,
  "tests": 23,
  "passed": 23,
  "byFile": {
    "packages/cli/test/project-handlers.test.ts": 23
  }
}
```

`node scripts/test-baseline.mjs` against it, first and last lines of its output, verbatim:

```
test count: 23 collected / 23 passed in 1 files -- baseline 3049 / 3047, 3026 BELOW baseline
```

```
  BELOW   collected tests  3049 -> 23 (-3026)
  BELOW   passed tests  3047 -> 23 (-3024) -- a test skipped or gone, not necessarily deleted
```

`exit=1`. The 131 intervening `GONE` lines are every other test file in the repository, each
reported at zero because the scan never saw it.

## The pattern

**The same default-by-absence as `dogfood/0090`, from the other side of the seam.** There, a full
run inherited a `subset` value and under-recorded; here, a partial run inherits nothing and
over-records. Both come from one variable being read for a question it cannot answer — *"is this
run the full suite?"* is not the same question as *"did the gate set a narrowing variable?"*, and
absence answers the first only when the only two possibilities are "the gate narrowed it" and
"someone ran the whole suite by hand".

`dogfood/0090`'s tell was *a variable set on one step and read several processes later*. This one's
tell is smaller and worth stating on its own: **a default that stands in for a fact nobody
communicated.** The repair in 0090 made the full case explicit at the one place the gate spawns a
run; the same repair here would have the reporter require the full spelling rather than infer it,
which is only possible once every producer says which run it is.

## Why nothing else would have caught it

Not a test. `scripts/test-count-reporter.test.ts` sets `ASCEND_TEST_SCAN` to a temporary path, so no
test writes the real file, and a test that did would have to write and restore an artifact another
session's suite may be writing — which is why the seam exists. Not the gate, which is the one
consumer that is *not* affected, because it happens to run the suite before the check. Not a review
of `vitest.test-count.ts`, which states its own rule and states it confidently.

Only doing the ordinary developer thing — running one file — and looking at what it left.

## Consequences and constraints

Nothing tracked is wrong: `.testcount/scan.json` is gitignored and `.testcount/baseline.json` is
untouched. The file is machine-local evidence about one machine's last run, which is why the
reporter writes it at all.

So this is not a false green — it is a false *red*, in a check whose failure mode the repository
takes seriously from the other direction. It is worth a record rather than a silent cleanup because
the docblock claim is what a future reader will rely on, and it is the claim that is wrong.

## Links

- Bead: `asc-19x2`
- Related: `dogfood/0090` (a full run that read its scope from what it inherited) — the same seam,
  the opposite direction
- Parent: `asc-09wx.14` (cut the pre-commit gate's cost)
- Evidence record: `docs/evidence/EV-70.md`
