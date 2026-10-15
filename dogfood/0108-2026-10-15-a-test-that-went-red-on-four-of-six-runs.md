# 0108 — A test that went red on four of six runs, written by the session that then trusted it

| | |
|---|---|
| **Bead** | `asc-1t95` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | `pnpm mutate handlers-review` — the mutation runner refuting the spec's own named killers |
| **Entry type(s)** | `intervention` (the rows the spec is about — and `verification_run`, whose green the flake was inflating) |
| **Severity** | P2 |
| **Status** | open |

## What was found

**A test in `packages/cli/test/handlers-review.test.ts` asserted an order that is a random UUID
order, so the suite was red on four runs in six of an unmutated tree.** The case
*"reads a still-open row as the strongest claim on a handler two rows name"* compared the holdings of
`handlers/alpha.yaml` positionally:

```ts
expect(fields.get('row_status')).toEqual(['applied', 'graded']);
expect(fields.get('row_state')).toEqual(['open', 'retired']);
```

`handlerLives` pushes holdings in `ledgerRows` order, and `ledgerRows` sorts by `root` — which is a
UUID v4, freshly minted by `asc record`. Two rows in one ledger therefore print in an order decided at
random per run. The assertion held when the ids happened to fall one way and failed when they fell the
other, and `alpha` is the *only* fixture handler with two holdings, so nothing else in the suite could
notice.

**The second half is worse than the first.** The mutation spec `scripts/mutations/handlers-review.json`
named that test as the sole killer for three of its eight mutants. A killer that fails half the time
kills nothing reliably, and `pnpm mutate` said so before I did — it reported two of those three mutants
as `SURVIVED a named killer`. The spec had recorded *intentions* about three checks and the runner
converted them back into questions.

## How it surfaced

**Nobody was looking for a flaky test.** The task was `asc-09wx.8.5`'s fifth stage — write the mutation
specs, run the gate, drive it end-to-end — and the flake was found by the *check on the check*: a
mutation survivor was investigated as a spec error, the spec error was investigated as a fixture gap,
and the fixture turned out to be random. The path was three levels down from anything the task was
about.

That is the mechanism worth naming: **a surviving mutant is a claim about the killer, and "the killer
is flaky" is one of the answers.** The convention in this repo already says a survivor usually points
at the fixture (`mutation-survivors-point-at-the-fixture`); the extension this record adds is that the
fixture can be non-deterministic, in which case the mutant survives *at random* and a single re-run
will appear to fix it. Two mutants reporting survivors is what made it look systematic enough to chase
rather than re-run.

The full suite had passed at 3755 tests a short while earlier. **That green was luck** — with a
two-in-three failure rate, a single run is a coin flip, and I had already used it to conclude the stage
was green.

## The metric

**The failure rate, measured by running the one test file six consecutive times on the unmutated tree:**

```
$ npx vitest run packages/cli/test/handlers-review.test.ts   # x6
      Tests  8 passed (8)
      Tests  1 failed | 7 passed (8)
      Tests  1 failed | 7 passed (8)
      Tests  8 passed (8)
      Tests  1 failed | 7 passed (8)
      Tests  1 failed | 7 passed (8)
```

**4 of 6 runs red, on identical input.** The same command after the fix:

```
      Tests  8 passed (8)   # six consecutive runs
```

**The two mutants the runner refused a pass**, from `pnpm mutate handlers-review --allow-dirty`:

```
| no-holdings-falls-through             | SURVIVED a named killer | - | reads a still-open row as the strongest claim on a handler two rows name |
| nothing-enumerates-the-directory      | SURVIVED a named killer | 1 | reads a still-open row as the strongest claim on a handler two rows name |
```

**`1` is the number that gave the mechanism away**: `nothing-enumerates-the-directory` had three named
killers and two of them died. A mutant either changes observable behaviour or it does not; two kills
and one survival is only possible if a named killer is *sometimes* not a killer. The verdict table made
"flaky" arithmetic rather than a hypothesis.

`n = 6` runs, so the rate is an estimate with a wide interval, and the direction is what matters: the
test was not *occasionally* fragile, it was a coin. Named as an anecdote under `MIN_N` (20,
`packages/analysis/src/proportion.ts`); the mechanism — sort order is root-id order is UUID order — is a
fact about the code, not a rate, and is the part that generalizes.

## The pattern

**A false red is the same defect as a false green, and the mutation runner is what distinguishes
them.** Both are "the check reported something untrue about the tree"; this one reported *failure* on a
tree that was fine. It is less destructive than a false green — it does not ship a bug — but it is
corrosive in the same currency: a suite that is red two times in three teaches the operator to re-run
until green, and a re-run-until-green habit makes every *real* red invisible. `empirical-planning` P7
counts a false green as severity-zero because it destroys trust in every other signal; a check with a
one-in-three signal-to-noise ratio destroys that trust by a slower route.

The transferable rule: **an order-sensitive assertion on a collection of UUID-keyed records is an
assertion about `crypto.randomUUID`.** Where the subject of a test is a set of properties (these two
holdings carry *different* states), the assertion has to be order-insensitive, and where the order
genuinely is the subject — `asc-09wx.8.4`'s root ordering, `asc-wsa`'s pagination key — it must be tested
against rows whose ids are *given*, not generated. `intervention.test.ts` already has the right shape
for that: its order test hands `dueGrades` two literal roots and asserts on the result.

## Why nothing else would have caught it

- **The full suite cannot.** It ran green at 3755 tests minutes before, and would have run red on
  roughly two commits in three afterwards. `scripts/test-baseline.mjs` compares counts, and a flake
  flips a pass into a failure without changing what vitest collected.
- **Type checking cannot** — `expect(A).toEqual(B)` is well-typed for any `B`.
- **The lint rules cannot.** The failure is in the *data*, not the code: `fields.get('row_status')`
  returns a well-formed `unknown[]` in whichever order the rows arrived.
- **Review cannot, cheaply.** The assertion reads as obviously correct, and it would be correct if
  holdings were sorted by anything stable. The bug is one call away, in `ledgerRows`, in a different
  file, and it is *not* a bug there.
- **The mutation runner could, and did** — but only because a survivor sent me looking. Nothing
  reported "this test is unstable"; it reported "this mutant survived", which is a fact about the
  killer only if you follow it home.

## Consequences and constraints

- **The fix is in the assertion, not the sort.** Sorting holdings by root is deliberate — it is the
  order the ledger has, and `asc handlers review` should not invent a second ordering for display. The
  docblock now says why the comparison is sorted, so the next reader does not "simplify" it back.
- **Three named killers had to be re-measured, not just re-run.** The fix changes what the fixture
  observes, so `pnpm mutate handlers-review` had to be run again from scratch — a mutant that was
  "killed" by the flaky test was never reliably killed. A killer list is only as good as its weakest
  entry, and the runner has no way to know an entry is a coin.
- **`no-holdings-falls-through` may have no killer at all.** Its mutant sits in `stateOfLife`'s
  zero-holdings branch, which `reviewRows` short-circuits before reaching — the branch is unreachable
  from the command. If re-measurement leaves it a survivor, the honest entry is `survivor: true` with
  `why`, not a killer borrowed from a neighbouring test.
- **This one is cheap to prevent and hard to detect.** `expect([...values].sort())` is the whole
  remedy, and it costs one line. There is no lint rule for it and none is proposed here; the signal is
  `pnpm mutate`, which is a session practice and deliberately not in the gate
  (`ascend-gate-cost-and-corpus-flake`).
- **Nothing in the tool changed.** `ledgerRows` sorting by root is correct and is what every other
  reader wants.

## Links

- Bead: `asc-1t95`
- The spec that found it: `scripts/mutations/handlers-review.json`
- Built by: `asc-09wx.8.5` (the handler end-of-life listing the test belongs to)
- Related: `mutation-survivors-point-at-the-fixture` (this is that rule with a non-deterministic
  fixture), `empirical-planning` P7 (the false-signal class), `dogfood/0107` (the other finding in the
  same window, from the same stage's end-to-end drive)
