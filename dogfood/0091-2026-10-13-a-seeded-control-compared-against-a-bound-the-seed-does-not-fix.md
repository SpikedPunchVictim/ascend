# 0091 — a seeded control compared against a bound the seed does not fix

| | |
|---|---|
| **Bead** | `asc-407m` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | the end-to-end drive `asc-09wx.14` calls for — the real pre-commit hook, one `packages/store` source file staged |
| **Entry type(s)** | none — this is about a test fixture and an estimator, not the store |
| **Severity** | P2 |
| **Status** | open |

## What was found

`packages/cli/test/stats.test.ts` asserts that the permutation control's p exceeds the row-counted
p, and the fixture pins the row-counted p at `0.0061698993205439034`. The permutation p is an
empirical count — `(1 + #{T_perm ≥ T_obs}) / (B + 1)`, so `k/501` at 500 iterations — and **k moves
between runs on this fixture.** The shuffle is seeded (`DEFAULT_SEED`), so the run is reproducible
given its input, but the input's *row order* is not controlled by the fixture, and a different order
draws different permutations and reports a different p.

The assertion is a comparison between a fixed number and a moving one, which is why it is a commit
blocker rather than an annoyance: when k falls to 2 or 3, `p_permuted` lands below `p` and the gate
stops.

## How it surfaced

**Nobody was looking for it.** It arrived from the plan's own verification step — stage a real
change, run the real hook, read the log. The hook blocked on this test, which is the first time
anything in this work had seen it fail.

The first reading was that it was environment-dependent: the test then passed 20 of 20 times run
standalone, and the failing value was filed as a load artifact. **That reading was wrong, and the
second measurement is the finding.** Re-run 20 times standalone with the suite stopped and no gate
in flight, it fails once. It is not an artifact of the drive's environment; it is a
one-in-twenty flake that the first 20-rep sample happened to miss.

## The metric

Twenty standalone reps, `vitest run packages/cli/test/stats.test.ts -t "finds the correction where
the shuffled control does not"`, verbatim from the rep log:

```
rep 1: pass
rep 2: pass
...
rep 11: FAIL
rep 12: pass
...
rep 20: pass
```

**19 pass, 1 fail.** The failure, verbatim:

```
 FAIL  packages/cli/test/stats.test.ts > asc stats --cluster-by, the clustering correction > finds the correction where the shuffled control does not, because only one of them holds the blocks
AssertionError: expected 0.005988023952095809 to be greater than 0.0061698993205439034
```

Three values of `k`, from three runs, `k/501` in every case:

| run | `p_permuted` | k |
|---|---|---|
| the test's own comment, recorded as MEASURED | `0.011976047904191617` | 6 |
| rep 11 above | `0.005988023952095809` | 3 |
| the gate drive, verbatim from its log | `0.003992015968063872` | 2 |

The fixed side of the comparison is `UNCORRECTED_P = 0.0061698993205439034`, so the assertion holds
at `k = 6` and fails at `k = 3` and `k = 2`. The margin between the two sides is under one part in
a hundred — `6/501` is `0.01198`, `4/501` is `0.00798`, and the bound sits between them.

The mechanism is stated by the fixture itself, in the test above it, verbatim:

```
    // ... the null's block order is first-appearance in the store's own `(recorded_at, id)` order,
    // and this fixture does not control that order, so a corpus that reads the same can shuffle the
    // same six deals in a different sequence and land on a different point in the same tail. What
    // the fixture DOES fix is which deals reach the observation, and that is what is asserted.
```

That comment is attached to the *block* control's assertion, which is written to tolerate the
spread — `toBeGreaterThan(0.25)` and `toBeLessThan(0.5)` bracket it rather than pin it. The
permutation control's assertion, one test over, is written the other way: a strict comparison
against a pinned constant, over a value drawn from the same uncontrolled order.

## The pattern

**A tolerance was reasoned about for one control and not for its sibling.** The fixture's author saw
the row-order sensitivity, wrote it down in full, and made the block assertion robust to it. The
permutation assertion was then written against the same kind of number as if it were fixed — and
the seed made it *look* fixed, which is the part worth generalizing.

**A seed fixes reproducibility, not stability.** Every value the seed produces is reproducible given
its input, so a flake that comes from the input rather than from the draw reads as
deterministic-but-wrong when it recurs, and as noise when it does not. The tell: a seeded estimator
compared against a constant, where the estimator's *input ordering* is not itself pinned.

## Why nothing else would have caught it

Not the suite, which is how it eventually surfaced but only because the drive ran the test inside
the gate's subset with a different corpus build than a standalone run — and even then, at 1 in 20, a
single green gate run says nothing.

Not a review of the fixture: the row-order hazard is documented right above the failing line, which
is exactly what makes the omission easy to miss.

Not the first 20-rep measurement, which is the honest part of this record — the instrument was
pointed at the phenomenon and reported 20 green, and a single sample of 20 cannot resolve a 5% rate
to better than a wide interval. The second sample is what settled it.

## Consequences and constraints

The failure is a commit blocker: this test is in the `cli` subset, so it runs on any commit touching
`cli`, `core` or `store`. It is also load-sensitive in *rate* rather than in kind — the draws depend
on the corpus build, and the corpus build is what varies.

The fix direction is not to widen the permutation bound to match the block control's, because that
would discard the finding the test exists for. The three options are in the bead: pin the fixture's
row order so the permutation count is fixed, lower the assertion to a bound the estimator's spread
cannot cross, or assert the correction's *factor* — which is what the test's own comment says the
result actually is, *"the shuffled control moves the number by a factor of two; the cluster
correction moves it by a factor of fifty"* — rather than the raw p.

## Links

- Bead: `asc-407m`
- Parent: `asc-09wx.14` (cut the pre-commit gate's cost)
- Evidence record: `docs/evidence/EV-70.md`
