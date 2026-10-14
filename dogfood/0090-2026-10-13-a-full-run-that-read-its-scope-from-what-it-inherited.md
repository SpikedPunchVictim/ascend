# 0090 — a full run that read its scope from what it inherited

| | |
|---|---|
| **Bead** | `asc-qa44` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | driving the real `.beads/hooks/pre-commit` with one `packages/store` source file staged — the end-to-end drive `asc-09wx.14`'s plan calls for, not a test |
| **Entry type(s)** | none — this is about the gate, not the store |
| **Severity** | P2 |
| **Status** | open |

## What was found

The gate tells `vitest.test-count.ts` whether the run it is watching is the whole suite by exporting
`ASCEND_TEST_SCOPE` on one step's environment. **An environment variable is inherited by every process
below the one it is set on**, so any gate nested inside that step's run reads a scope that belongs to a
different run — and the reporter's rule, *"absent means full"*, is a rule about absence that a nested
full run cannot satisfy.

The consequence is a false reading in the safety mechanism built to prevent a false reading. A full
gate nested inside a subset run runs `pnpm test`, the reporter sees the inherited `subset`, declines to
write `.testcount/scan.json`, and prints that it was narrowed; then `test count` compares a scan written
by some earlier run. The push would be judged against a baseline from another day.

## How it surfaced

**Nobody was looking for it.** It arrived from the plan's own verification step: stage a real change,
run the real hook, read `.ascend/gate-runs.jsonl`. The staged path was `packages/store/src/index.ts`,
which selects `cli`, `core` and `store` — and `packages/cli/test/dev-hooks.test.ts` lives in the `cli`
subset and drives the real hooks. So the drive nested a gate inside a gate, which no unit test does.

The failing arm is the *pre-push* one:

```
 FAIL  packages/cli/test/dev-hooks.test.ts > pre-push gate > runs the whole suite, not a narrowed one, and says it is the push talking
AssertionError: expected '[pre-push] scope: everything (no cuts…' to contain 'pnpm-stub: test [ASCEND_TEST_SCOPE=]'

- pnpm-stub: test [ASCEND_TEST_SCOPE=]
+ [pre-push] scope: everything (no cuts were asked for)
+ [pre-push] format:check
+ pnpm-stub: format:check [ASCEND_TEST_SCOPE=subset]
...
+ pnpm-stub: test [ASCEND_TEST_SCOPE=subset]
```

The `[ASCEND_TEST_SCOPE=subset]` on `format:check`, `typecheck` and `lint` is the tell: those steps
read nothing, so the value can only have come from outside the gate.

**The fixture was environment-dependent and that is the second half of the finding.** The assertion
`toContain('pnpm-stub: test [ASCEND_TEST_SCOPE=]')` was true whenever the suite happened to be running
with nothing set — which is every run of `pnpm test` — and false under the gate's own subset step. A
test that passes alone and fails inside the gate is not a flaky test; it is a fixture reading its
environment instead of pinning it.

## The metric

The failing assertion, verbatim, from
`./.beads/hooks/pre-commit > /tmp/asc-drive-subset.log 2>&1` with one store source file staged:

```
 expected '[pre-push] scope: everything (no cuts…' to contain 'pnpm-stub: test [ASCEND_TEST_SCOPE=]'
```

The run it came from, verbatim from the row it wrote to `.ascend/gate-runs.jsonl`:

```
scope "tests"   skipped [{"step":"test count","why":"a subset run cannot move the full-suite baseline"}]
steps format:check:7024:0 typecheck:5970:0 store verify --staged:1619:0 lint:22108:0 test:344992:1
total_ms 381713   outcome "blocked"   blocked_at "test"   loadavg [30.771484375,55.1474609375,66.39208984375]
```

The same drive re-run after the fix reached the same `test` step and no longer failed this arm.

## The pattern

**A default-by-absence read by a process that inherited the variable.** The design was right that
"absent means full" is the safe direction for a person typing `pnpm test`; it was wrong to rely on
absence inside a tree of processes it spawns itself. The class is the one `dogfood/0061` names from the
other side — there, a check that was present but unwired; here, a signal that is present but describes
someone else. Both produce a verdict nobody earned, and neither is visible in the code that reads it,
because in both cases the reading code is correct and the input is not.

The tell to look for: a variable that is set on one step and read several processes later.

## Why nothing else would have caught it

Not the unit tests — `dev-hooks.test.ts` passes in every environment except the one the gate creates,
because in every other environment the variable is unset and absence reads as full. Not
`gate-scope.test.ts`, which tests the predicate directly. Not the mutation spec, which had no mutant
that could see it, since no mutant makes a spawned process inherit anything.

Only a run that nested a gate inside a gate. The plan asked for exactly that run and it took one
attempt, at a cost of about six minutes — against the alternative of shipping the cut with the baseline
check reading a stale scan, silently, on every push.

## Consequences and constraints

The repair states the scope **on the step** rather than relying on absence: the suite step carries
`ASCEND_TEST_SCOPE: ''`, which is the full spelling, so a step says which run it is whatever it
inherited. `packages/cli/test/dev-hooks.test.ts` sets `ASCEND_TEST_SCOPE: 'subset'` in the fixture's
own environment on purpose, so the arms below it are the ones that would catch this returning. That
turns the drive's condition into a permanent test, and it makes the fixture deterministic in both
directions rather than in whichever direction `pnpm test` happens to run.

`scripts/mutations/gate-scope.json` carries it as **M12** — remove the step's `env` and the pre-push arm
and the new shape assertion both die.

## Links

- Bead: `asc-qa44`
- Parent: `asc-09wx.14` (cut the pre-commit gate's cost)
- Related: `dogfood/0061` (a check that was present but unwired)
- Evidence record: `docs/evidence/EV-70.md`
