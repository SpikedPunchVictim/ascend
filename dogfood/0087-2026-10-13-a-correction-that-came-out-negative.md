# 0087 — A design correction that came out negative, and the sign was the whole signal

| | |
|---|---|
| **Bead** | `asc-n168` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | writing the `asc stats --cluster-by` correction, and running the first version of it on a hand-built two-cluster 2×2 fixture |
| **Entry type(s)** | `stuck_event` (derived) — the entry this record is built from |
| **Severity** | P2 |
| **Status** | open — the formula was abandoned rather than fixed, so nothing in the tree is wrong; the lesson is the class, not a patch |

## What was found

The first-order Rao–Scott design correction, transcribed from a search summary of the SAS
`PROC SURVEYFREQ` documentation, is **not the formula SAS implements**. On a 2×2 table whose two
clusters each straddle both columns it returns a correction of `D = -20`.

The bead had named Rao–Scott as the correction `--assoc` and `--correlate` needed, and the
transcription reproduced both anchors that could be hand-checked — a partition of singleton
clusters gives `D = n/(n-1)` exactly, and a single cluster gives `D = n`. It was wrong anyway.

**A design correction is a variance inflation and cannot be negative.** That is the entire signal:
not a failure to converge, not a refusal, not a test with a tight tolerance — one number whose sign
is impossible. Everything else about the module looked finished.

## How it surfaced

The order matters. The two anchors were checked FIRST and both passed, which is what made the
transcription credible enough to build on. They pass because they are the two degenerate corners:
with one row per cluster every cell's design effect is the same and the marginal terms cancel; with
one cluster there are no contrasts for the marginals to be wrong about. The fixture that broke it
was the first one with two clusters that are internally **mixed** — which is the only shape where a
cell's design effect and its marginals' design effects differ, and therefore the only shape where
the weighting between the four cell terms and the four marginal terms can be wrong at all.

**Nobody was looking for it.** The fixture was built to exercise the new code, not to audit the
formula, and the code's own refusal — "a variance inflation below 1 would report precision the
sample does not have" — is what turned an arithmetic surprise into a recorded stop rather than a
clamped-to-1 number quietly printed under a p-value.

The three attempts are in the entry, in the words they were made in:

1. Implement the transcribed formula. `D = -20` on the mixed fixture.
2. Fetch the SAS page itself. The formula is an **embedded image** (`statug_surveyfreq0205.png`
   through `0207.png`); the prose says only that `D` "is computed by using the estimated proportions
   as", and the page says nothing at all about zero cells. The sign convention is not recoverable.
3. Search for the formula in text form, and separately re-derive it from the eigenvalue
   characterisation `X² ~ Σ λᵢ χ²₁` with `d = Σλᵢ / df`. No source reproduced the expression
   verbatim; re-deriving `Σλᵢ` needs the design-based covariance of the cell proportions restricted
   to the independence contrasts, which is **a derivation, not a citation** — and every value
   produced that way would be an invented statistic of the kind this repo refuses to print.

At the third strike the owner was asked, and chose the other mechanism entirely: a
cluster-preserving permutation null, which needs no closed form and whose marginal is exact by
construction.

## The metric

Pasted from the `stuck_event` (`d978ac9a-1220-45e0-8959-b0c43070dffa`), `error_text` verbatim:

```
D = -20 on the fixture
rows  = ['a','a','a','a','a','a','a','a','a','a','b','b','b','b','b','b','b','b','b','b']
cols  = ['x','x','x','x','x','x','y','y','y','y','x','x','x','x','y','y','y','y','y','y']
clust = ['s1' x 10, 's2' x 10]

cell deffs: ax 13.3333 (p .4), ay 2.2222 (p .1), bx 2.2222 (p .1), by 13.3333 (p .4)
marginal deffs: a+ 20, b+ 20, +x 20, +y 20
sum_cells (1-p)deff = 20.0000
sum_rows  (1-p)deff = 20.0000
sum_cols  (1-p)deff = 20.0000
numerator = 20.0000 - 20.0000 - 20.0000 = -20.0000
df = 1
D  = -20.0000
```

The arithmetic is worth reading twice: every marginal's design effect is **20**, which is larger
than every cell's, because each cluster's rows land entirely in one column — the marginal is
perfectly explained by the cluster, so the four `(1-p)·deff` cell terms sum to exactly the same 20
as the row terms and the column terms, and the numerator is `20 − 20 − 20`. A transcription can be
wrong only where two terms of a difference can cancel to the same magnitude, and that fixture is the
smallest one on which they can.

The two anchors that passed, and their measured results, are also in the entry: a partition of
singletons gave `D = n/(n-1)` exactly, and one cluster gave `D = n` at `rhoSource
'assumed-perfect'`.

**One anecdote, named as one.** The corpus this was implemented against is a single hand-built
fixture of twenty rows — well under `MIN_N` (20, `packages/analysis/src/proportion.ts`) — so nothing
here is a statement about how often a mis-transcribed formula bites. The `stuck_event` is the sample
of one, and it is reported as one.

## The pattern

**A transcription is checked against the cases that are cheap to check, and those are exactly the
cases where it cannot be wrong.** Both anchors that passed are degenerate: one row per cluster, and
one cluster. In both, the structure that the mis-transcribed terms describe — the relationship
between a cell's design effect and its marginals' — has collapsed, so any weighting of them gives
the right answer. The general form was never exercised until a fixture had two internally-mixed
clusters.

The transferable rule: **when a formula is taken from prose rather than from a derivation, the
fixture that validates it has to be built to make its terms DISAGREE**, not to make them easy to
compute. A hand-computable anchor and a discriminating anchor are different objects, and the
hand-computable one is usually the degenerate one.

The second transferable thing is what made it visible at all: the module **refused** rather than
clamping. `D = -20` was reachable as a number; a version that had taken `max(D, 1)`, or that had
skipped the correction when `D < 0`, would have shipped and printed an uncorrected p under a flag
whose entire purpose is to prevent exactly that — which is the failure mode the whole feature exists
to close.

## Why nothing else would have caught it

A review would plausibly have caught the missing citation — "where does this come from?" is a fair
question about a formula in a source file — and that is an argument for citing derivations rather
than summaries. What no review would have caught is the sign: the expression is plausible, it
reproduces the textbook anchors, and its defect is a weighting between terms that only shows when a
marginal's design effect exceeds every cell's. The test that would have caught it is the test that
did — an assertion that the correction is at least 1 on a fixture built so its terms disagree — and
that assertion was written only *after* the number came out impossible.

## Consequences and constraints

The proposed module (`packages/analysis/src/rao-scott.ts`) was **not** kept, so there is nothing in
the tree to fix and no data to correct. What survives is a design constraint on `asc-n168`:
`--assoc` and `--correlate` are corrected by a cluster-preserving permutation null, whose marginal is
exact by construction and which has no closed form to get wrong.

That choice carries its own cost, stated where it is made: the corrected p is **order-dependent**,
because the null's block order is first-appearance in the store's `(recorded_at, id)` order. The
same content stored in a different order shuffles the same deals in a different sequence and lands
on a different point in the same tail. The CLI test for this feature therefore asserts a *range*
derived from the enumeration rather than a recorded literal, and says why.

No entries are invalidated: nothing about this finding is about recorded data.

## Links

- Bead: `asc-n168`
- Entries recorded at the time: `stuck_event d978ac9a-1220-45e0-8959-b0c43070dffa`
- The surface the abandoned formula was for: `asc stats --cluster-by`, and the mechanism that
  replaced it, `clusterPermutationNull` in `packages/analysis/src/association.ts`
