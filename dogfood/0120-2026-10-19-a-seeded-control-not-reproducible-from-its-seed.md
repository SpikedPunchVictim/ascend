# 0120 — a seeded control that is not reproducible from its seed alone

| | |
|---|---|
| **Bead** | `asc-407m` |
| **Surfaced** | 2026-10-13 (re-measured), fixed 2026-10-19 |
| **Surfaced by** | the suite going red on a commit that touched nothing statistical |
| **Entry type(s)** | none — this is about a test fixture's determinism, not the store |
| **Severity** | P2 |
| **Status** | fixed |

## What was found

`packages/analysis/src/association.ts`'s permutation control documents two claims in one sentence:
*"REPRODUCIBLE FROM ITS PARAMETERS AND ITS INPUT ORDER, and only from both."* The stats fixture honoured
the first half — it never overrode the seed — and not the second. One `asc record` call gives every
entry the same `recorded_at`, so the store's `(recorded_at, id)` order was whatever ids happened to be
minted, and `permutationNull` walks the array it is given. Different run, different draw.

The assertion compared that draw against a **pinned constant**:

```
expect(shuffled['p_permuted']).toBeGreaterThan(plain['p'])   // plain.p = 0.0061698993205439034
```

`p_permuted` is `k/501` at 500 iterations, and `k` moved across runs.

## How it surfaced

**Nobody was looking for it.** It arrived as a red suite — three failures in a corpus test, not one in
the stats file — and was first written off as a load artifact. Re-measured standalone with no gate in
flight, it failed once in twenty.

## The metric

`k` observed on the same fixture across runs, before the fix:

```
k = 6   0.011976047904191617   (the test's own MEASURED comment)
k = 3   0.005988023952095809   (rep 11 of a 20-rep standalone sample)
k = 2   0.003992015968063872   (the gate drive)
```

The bound `0.0061698993205439034` sits between `k=4` (0.00798) and `k=3`, so the assertion passed at
`k=6` and failed at `k=3` and `k=2` — a one-in-twenty failure, measured, not an artifact.

After naming the fixture's ids — `block-00 … block-29`, so the store's order is the plan's order:

```
k = 7   0.013972055888223553   (pinned; 10 consecutive runs, 10 passes)
```

The fixture now pins the value with `toBeCloseTo(…, 12)` and keeps `> plain.p` as the semantic claim.
Ten consecutive runs of the pinned test: **pass=10 fail=0**.

## The pattern

**A seed is half of a reproducibility claim.** The other half is the order of the input the seeded
generator walks, and it is the half that a fixture quietly leaves to chance. The source file said so —
in a docblock, with a measured example — and the test that exercises it did not.

The second-order lesson is about the first diagnosis: "it passed 20 of 20 standalone, so the failure
must be load" was wrong, and it took re-measuring to find the one-in-twenty. A rare failure under load
is not evidence that load is the cause; the failure rate has to be measured on an idle machine.

## Links

- Bead: `asc-407m`
- The docblock that predicted it: `packages/analysis/src/association.ts`, `permutationNull`
- The sibling assertion that already tolerated the hazard: the block control one test above, bracketed
  0.25 to 0.5
