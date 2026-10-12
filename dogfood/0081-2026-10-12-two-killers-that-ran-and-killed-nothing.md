# 0081 — Two named killers that ran, and killed nothing

| | |
|---|---|
| **Bead** | none — this is a measurement of the convention itself, not a defect in ascend |
| **Surfaced** | 2026-10-12 |
| **Surfaced by** | `pnpm mutate power-check --allow-dirty`, run over a spec whose killers had been written from expectation rather than from `assertionResults` |
| **Entry type(s)** | `verification_run` (derived) |
| **Severity** | P3 |
| **Status** | recorded; no code change |

## What was found

`scripts/mutations/power-check.json` shipped its first run naming 14 killers. **Two of them did
not kill their mutant.** `M5` swapped the order of `powerVerdict`'s two checks and `M9` replaced
`ts.slice(0, 10)` with `ts` in the command's day bucketing; in both cases the named test passed
while the mutant was planted, and the runner said so:

```
| M5 | SURVIVED a named killer | - | refuses the UNIT, before it says anything about effect sizes |
| M9 | SURVIVED a named killer | - | counts the active days the units actually happened on |
```

That is the runner behaving correctly and the spec being wrong. Both survivors were **mine, and
both were guesses**: I wrote the killer from "which test ought to care" rather than from the
failing names, which is exactly what the repo's convention forbids.

An important detail: `M9` was not a near-miss that a better-chosen test would have covered. The
fixture itself could not distinguish the mutant, because every session's events shared one
timestamp per day, so *counting distinct timestamps* and *counting distinct days* agreed by
construction. The row was untested in the only fixture that existed. A different killer would not
have helped; the input had to change.

## How it surfaced

`pnpm mutate` gained a survivor column and this is its first non-empty run. Nobody was looking
for it: the spec was written believing all 14 killers were real, and the belief was reasonable —
13 of 14 were. The two failures were found by the one step in the workflow that refuses to take
the spec's word for it.

The runner's two diagnostics are worth keeping apart, because they look alike and are not:

- **`DEAD KILLER`** — the `-t` pattern matched no test, so the killer is no one's evidence
  (`dogfood/0076`, `dogfood/0080`).
- **`SURVIVED a named killer`** — the test matched, ran, and passed anyway. The mutant's behaviour
  differs from the original's in some case the suite does not reach.

Both mean the same thing for a reader — the spec asserted a check that was not one — but only the
second says the test suite has a hole rather than the spec having a typo.

## The metric

The repo's README has required since before there was a tool for it that *"a check must be shown to
fail before it is trusted to pass."* The convention says the killers are **found empirically, not
guessed**. Nobody had measured what guessing costs. On this spec:

| | count | |
|---|---|---|
| mutants planted | 14 | `pnpm mutate power-check` |
| killers named from expectation, not from `assertionResults` | 14 | all of them, first run |
| named killers that killed their mutant | 12 | |
| **named killers that did not** | **2** | **14.3%** |
| of those, cases a better-chosen killer would have caught | 1 | `M5` — the overlap of `days <= horizon` and `arm < MIN_N` had no test |
| of those, cases where the FIXTURE could not distinguish the mutant at all | 1 | `M9` — one timestamp per day, so `active_days` == unit count by construction |

The group is 14, under `MIN_N` (20, `packages/analysis/src/proportion.ts`), so the 14.3% is an
**anecdote** and is named as one. It is offered as a direction, not a rate. What it is not is
`0` — the number a reader would have inferred from a convention stated without one.

Both were repaired before the spec was accepted, and the second run is the one that counts:

```
| id | verdict | killers that died | survivors |
|---|---|---|---|
| M1 | killed by every named killer | 1 | - |
| M2 | killed by every named killer | 1 | - |
| M3 | killed by every named killer | 1 | - |
| M4 | killed by every named killer | 1 | - |
| M5 | killed by every named killer | 1 | - |
| M6 | killed by every named killer | 1 | - |
| M7 | killed by every named killer | 1 | - |
| M8 | killed by every named killer | 1 | - |
| M9 | killed by every named killer | 1 | - |
| M10 | killed by every named killer | 1 | - |
| M11 | killed by every named killer | 1 | - |
| M12 | killed by every named killer | 1 | - |
| M13 | killed by every named killer | 1 | - |
| M14 | killed by every named killer | 1 | - |

rebuild: node_modules/typescript/bin/tsc -b ok -- no build output is left holding a mutant

14 mutant(s), 0 problem(s). Every named killer killed its mutant.
```

The repair for `M5` was a new test at the overlap — a 90% reduction is powered in 29 days against
a 30-day horizon *and* leaves 15 units in the smaller arm — which is a case worth testing on its
own merits, because the wrong order there reports `answerable` for a comparison the gate would
refuse to estimate. The repair for `M9` was to give each session a distinct minute, so that
counting timestamps and counting days stop agreeing.

## The pattern

**A spec's named killers are claims, and a claim written from expectation is a guess wearing a
citation.** The failure mode has a family resemblance to `dogfood/0080` — there, a killer never ran
because the mutant did not compile; here, a killer ran and passed. In both, a spec looked complete
and was not, and in both the only thing that noticed was the runner refusing to accept the spec's
own account of itself.

The narrower and more useful pattern is the second survivor: **a fixture can make a mutant
equivalent without anyone intending it.** `M9` was not killed by any test because the input made
the mutant's difference invisible. A spec author looking for a better killer would have looked in
the wrong place; the repair was to the *input*, not to the assertion.

## Why nothing else would have caught it

A code review would not. The two mutants read as clearly wrong and the two killers read as clearly
relevant — `active_days` is what `M9` breaks and the test is named for `active_days`. Only running
it distinguishes "this test would notice" from "this test does notice".

`tsc -b` would not, and neither would the test suite: both suites were green on the unmutated tree
both before and after, 41 passing tests, and the mutant changed nothing for them.

**`dogfood/0080`'s lesson does not extend here.** That one was a compiler error inside a killer's
own `beforeAll`; this is a passing test. The two need separate checks, and the runner now reports
them separately.

## Consequences and constraints

Nothing to fix in ascend: the mechanism worked. What changes is the reading of a spec — a green
`pnpm mutate` run is evidence that the killers kill, and a spec that has never been run is not
evidence of anything, including when its author just wrote it.

The measurable consequence for this repo's practice: the first run of a new spec should be
*expected* to fail, and a spec that passes on its first attempt is a reason to read the killer
list again rather than to close the bead.

## Links

- Spec: `scripts/mutations/power-check.json`
- Predecessor, and the other diagnostic: `dogfood/0080` (a killer that never ran), `dogfood/0076`
- The convention: project `CLAUDE.md`, *"Find the killers empirically, do not guess them"*;
  `README.md`, *"every assertion is mutation-tested"*
- Entries recorded at the time: `verification_run` for the two `pnpm mutate` invocations
