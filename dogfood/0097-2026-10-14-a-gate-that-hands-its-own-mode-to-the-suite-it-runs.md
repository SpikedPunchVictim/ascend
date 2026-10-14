# 0097 — a gate that hands its own mode to the suite it runs

| | |
|---|---|
| **Bead** | `asc-qpw7` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | `but push` — the second blocker of the first attempt to publish the gate-cost branch, found only once the first was cleared |
| **Entry type(s)** | none — this is about the gate's own environment, not the store |
| **Severity** | P1 |
| **Status** | fixed in the working tree |

## What was found

`scripts/gate.mjs` decides what a run does by reading four `ASCEND_` variables out of `process.env`:
which hook is talking (`ASCEND_GATE_HOOK`), whether every cut is off (`ASCEND_PRECOMMIT_FULL`), which
scope to take (`ASCEND_GATE_SCOPE`), whether to record (`ASCEND_GATE_NO_RECORD`). It then spawns its
steps with **its own environment**, so every step inherits all four. The suite is one of those steps.

`.githooks/pre-push` exports two of them on the command line. So `but push` ran the whole suite with
the gate's own mode switched on — and the suite contains the gate's own control-flow tests, which
assert a hook name and a step list they were never handed.

**Every push was blocked by the gate's own tests, from any tree; no commit ever was.** `git commit`
runs `.githooks/pre-commit`, which sets neither variable and takes the fast path; `but commit` runs no
hook at all (`dogfood/0095`). Only the push path set them, and nothing had pushed.

## How it surfaced

**Nobody was looking for it.** It arrived as the second blocker of the same push, after the first was
cleared, and the first blocker's message could say nothing about it: a push stops at the first failing
step, and that step was typecheck.

It hid as long as it did for the reason `dogfood/0095` gives — the instrument had only ever been
driven through paths that leave both variables unset. Every test of the runner spawns it directly;
every hook test drives `pre-commit`; the one path that sets the variables is the one nothing had
taken, and the artifact that would have shown it is machine-local and gitignored, so no test reads it.

## The metric

The push's own run: 22 rows in `test-failures.log` (machine-local, gitignored), all at one timestamp,
`2026-10-14T08:25:26.925Z`, carrying `run_tests: 3563`. That count is what identifies them as the
full-suite run `but push` started rather than one of the isolated measurements below — the arms further
down each carry `run_tests: 32`.

```
scripts/gate.test.ts                  14 rows
scripts/gate-memo.test.ts              6 rows
packages/cli/test/dev-hooks.test.ts    2 rows
```

Seven distinct assertions, verbatim:

```
expected '[pre-push] scope: everything (no cuts…' to contain '[pre-commit] format:check'
expected '[pre-push] scope: everything (no cuts…' to contain '[pre-commit] align check'
expected '[pre-push] scope: everything (no cuts…' to contain '[pre-commit] store verify --staged'
expected '[pre-push] scope: everything (no cuts…' to contain '[pre-commit] test count'
expected [ 'format:check', 'typecheck', …(5) ] to deeply equal [ 'format:check', 'typecheck', …(4) ]
expected [ 'format:check', 'typecheck', …(5) ] to deeply equal [ 'format:check', 'typecheck', …(3) ]
expected 127 to be +0 // Object.is equality
```

**The mechanism is in the first four lines and the `127`s are its symptom**, not a second cause.
`ASCEND_GATE_HOOK` made the nested runner print `[pre-push]` where the tests assert `[pre-commit]`;
`ASCEND_PRECOMMIT_FULL` appended an `align check` step the fixture never stubbed, so the spawn could
not be started and a shell's `127` ("no such command") was what the assertion compared against zero.
One cause, reported seven ways, across 22 rows in three files.

The decomposition, `npx vitest run scripts/gate.test.ts`, 32 tests, same machine:

```
  nothing set                                    32 passed
  `ASCEND_GATE_HOOK=pre-push`                     3 failed / 29 passed
  `ASCEND_PRECOMMIT_FULL=1`                      13 failed / 19 passed
  both, as `.githooks/pre-push` exports them     14 failed / 18 passed
```

**The first and last rows were measured twice, on either side of the fix**: 32 passed and 14 failed
before it was written, and 32 passed in every one of the four environments after. The middle two were
measured earlier the same session and are the decomposition of that pair into its two variables.

The same leak reached the fixtures from the other side, and the shape is identical: two suites under
`scripts/` and one under `packages/cli/test/` each build the environment of the gate they spawn by
spreading `process.env`, so they inherited the mode of whatever started the suite — which since Cut 3
is the gate itself. One strip, applied at every place this machinery starts a process: the runner's
steps, and a fixture's runner.

**Bound: n = 1.** One push, one machine, one repository, one version-control client. That is an
anecdote, well under `MIN_N`, and it estimates nothing about how often this happens elsewhere. What
the readings establish is the mechanism, deterministically, and that it blocked every push that could
have been made.

## The pattern

**An environment inherited is a decision nobody made.** Nothing in the gate's design says a *step*
should be told what mode the *run* is in — `spawnSync` passes the parent's environment down because
that is its default, and an unexamined default is indistinguishable from a decision until something
reads it. Here something did: the suite, whose own tests read the same four variables.

It is also the same assumption `dogfood/0095` and `dogfood/0096` record, read from a third end. There
the gate's *reach* was wrong (it did not run for a `but commit`; it guarded the working tree rather
than the push). Here its reach is right and its *voice* is wrong: the gate arrives, in full, and tells
every child it spawns that the child is the gate.

And it is `TEST_STEP`'s own docblock one variable over. That docblock names this exact class for
`ASCEND_TEST_SCOPE` and answers it by having the step **state** the value it wants rather than infer it
from what it inherited — the right answer for a variable a step has a value for. The two variables the
runner reads about *itself* were missed, because they are not values any step holds.

## Why nothing else would have caught it

- **Not a test.** The gate's own tests are what failed, and they failed *because* they were driven with
  the leak. Nothing asserted what a step inherits; the fixture that could have was the one inheriting.
- **Not the gate's record.** The push wrote a blocked row, and its `blocked_at` names `test` — true,
  and it says nothing about why the test step was red.
- **Not a review.** Every line is individually ordinary: `spawnSync` with the parent environment is the
  obvious thing to write, and so is each fixture's spread of `process.env`.
- **Not the suite's own green.** `pnpm test` with nothing set is green, and that is every run anyone
  had ever done. The red existed only in the one environment nobody had yet produced.

## Consequences and constraints

- **Cut 3's safety net was not load-bearing while this stood.** The pre-push hook runs the full suite,
  and the full suite could not pass at pre-push — so the cut's whole bargain (related tests on commit,
  everything at push) was covered by a step that always went red. A gate that blocks every push is not
  a stricter gate; it is a gate that gets bypassed, and `TASKS.md` non-negotiable #5 forbids the
  bypass.
- **The strip is completeness-checked, not a hand-written deny-list.** `scripts/gate-env.test.ts` reads
  the source of every `scripts/gate*.mjs` module with its comments removed and asserts the stripped
  list is exactly the set of `ASCEND_` names appearing in **code** — a name mentioned in prose is not a
  name the runner reads. A knob added to the runner later fails the suite rather than leaking quietly
  into every step. `ASCEND_TEST_SCOPE` is the one deliberate exemption, named with its reason rather
  than left out silently: a step states it and `vitest.test-count.ts` reads it, so it is not the
  runner's to remove.
- **A name that leaves the list and a name that should never have been on it are different failures,
  and both are covered.** The wire test's expected string is written out literally rather than built
  from the list, and that is a measurement rather than a preference: with `ASCEND_GATE_HOOK` deleted
  from the list, the wire test went on passing until it was written out. The spec at
  `scripts/mutations/gate-env.json` holds four mutants — the call site reverted, the strip removed, a
  name dropped, a stale name added — each with killers found by planting it and reading the failing
  names off `assertionResults`.
- **The fixture-side strip is what makes the gate able to run its own tests.** Since Cut 3 the suite is
  a step of the gate, so "the suite runs in the gate's environment" is the normal case rather than an
  edge one. A fixture that spreads `process.env` is asserting about a mode it did not choose.
- **Nothing is broken and nothing needs reverting.** The gate did what it was told. What was missing
  was any distinction between the environment the *runner* is in and the environment its *steps* are in.

## Links

- Bead: `asc-qpw7`
- The same shape one step earlier: `dogfood/0095`, `dogfood/0096`
- The strip and its completeness check: `scripts/gate-env.mjs`, `scripts/gate-env.test.ts`
- The kill-check: `scripts/mutations/gate-env.json`
- The record of the failing push: `test-failures.log` (machine-local, gitignored)
