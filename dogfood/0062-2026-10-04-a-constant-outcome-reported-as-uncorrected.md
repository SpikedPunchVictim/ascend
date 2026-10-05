# 0062 — a constant outcome was reported as an uncorrected one, in the anticonservative direction

| | |
|---|---|
| **Bead** | `asc-n007` |
| **Surfaced** | 2026-10-04 |
| **Surfaced by** | `asc explore tool_denial --cluster session_id`, driving the built binary while writing the Stage 3 CLI test |
| **Entry type(s)** | `tool_denial` (derived) |
| **Severity** | P2 |
| **Status** | fixed in the asc-0hys Stage 3 work commit |

## What was found

`clusterDesignFromGroups` has two routes to a `rho` it cannot estimate, and only one of them was
recognised. One cluster is the obvious route (`k < 2`: no within-cluster degrees of freedom at all).
The other is a **constant outcome** — every observation carrying the same value, so the total sum of
squares is zero and both mean squares are exactly zero — and the branch that caught it returned
`rho = 0`, `rhoSource = 'estimated'`.

`rho = 0` is the one answer that must not be given there, for two independent reasons. It reads as
*"the correction does not apply"*, so a caller has no way to learn that the estimator ran out rather
than measured; and `'estimated'` is a false claim about where the number came from. Worse, it moves
in the **anticonservative** direction: `deff` becomes 1, `effectiveN` becomes the raw count, and the
interval comes out *narrower* than the one the bound produces — precision invented out of a 0/0.

## How it surfaced

Nobody was looking for it. It surfaced because Stage 3 required *driving the built binary* rather than
asserting the arithmetic — the estimator's unit test suite (23 tests, hand-derived anchors) was fully
green before and after, and it never builds a population in which the outcome is constant across all
clusters. The CLI surface is what makes such a population ordinary rather than exotic: a property's
`not_applicable` row is 0 successes out of the declared count by definition, and *every* property of
`tool_denial` has such a row. So the 0/0 case is not an edge case on a real map; it is a quarter of
the corrected rows.

The shape of the mechanism, recorded because it repeats: **a value that two different situations
share, where the shared value is the wrong one for one of them.** `rho = 0` is correct and meaningful
under `'inapplicable'` (every cluster a singleton — the correction is 1 for any rho, so rho carries no
information) and is exactly wrong under a constant outcome. One branch had the honest spelling; the
other had borrowed the dishonest one.

## The metric

Measured 2026-10-04 on this repo's own `tool_denial` store, clustered by `session_id`, by driving the
built binary and counting the designs it produced:

```
$ node packages/cli/dist/bin.js explore tool_denial --cluster session_id --json > /tmp/asc-dd.json
$ node -e '<count rhoSource over rows[].proportion.design>'
rows with a design : 71
assumed-perfect, k>=2 (the 0/0 branch): 24
assumed-perfect, k=1 (one cluster): 0
designEffect == 1 exactly: 14  of which estimated: 14
```

`rhoSource === 'assumed-perfect'` with `clusters >= 2` is *exactly* the 0/0 set — the one-cluster route
contributes 0 rows on this map — which is how the 24 is obtainable from the shipped build rather than
from instrumentation of the old one. **24 of 71 corrected rows**, i.e. a third of the map. The 14 rows
still at `deff == 1` are all `rhoSource: 'estimated'` with `rho === 0`: genuine measurements that this
outcome is independent of its session, and they must stay distinguishable from the 24. That is what
`rhoSource` is for.

Same row, same count, before and after the fix — the uncorrected rendering (which is what the old
`rho = 0` produced for these rows) against the bound:

```
$ node packages/cli/dist/bin.js explore tool_denial
property.denial_kind.not_applicable                           0.0% (95% CI 0.0-0.5%, n=764)

$ node packages/cli/dist/bin.js explore tool_denial --cluster session_id
property.denial_kind.not_applicable                           0.0% (95% CI 0.0-27.1%, n=764,...at as anecdote, not estimate]
```

The design behind the corrected row, from the same `--json` read:

```
"n": 764, "clusters": 40, "largestCluster": 155,
"rho": 1, "rhoSource": "assumed-perfect",
"designEffect": 74.03403141361257, "effectiveN": 10.319578515611187
```

764 entries over 40 clusters, the largest holding 155 — and 764 / 74.03 = 10.3, so the interval is
computed at **10.3 observations' worth of information**, not 764. The upper bound moves from 0.5% to
27.1%: a 54× wider interval, on a row whose count did not change at all.

The store is live and grows as entries are recorded (it read 763 when this was first measured and 764
a few minutes later), so the counts are a reading; the ratio and the direction are not.

**And the same conflation happened one layer up, in the bead.** The first version of `asc-n007`'s
description compared `0.0% (95% CI 0.0-0.5%)` against **`0.0% (95% CI 0.0-27.6%)`**. The `27.6` is a
real number, but it belongs to the aggregate `invalidated` row as measured by
`spike/e22-row-clusters.mjs` at 763 entries — a different row from the zero-success state row the
finding is about, and a different statistic (it moves `0.9pp -> 27.6pp` on a count of 2, not 0). It
reached the bead because it was the nearest bound-shaped figure already in hand. Corrected in place,
and the correction is named in the description rather than silently applied. This is `dogfood/0057`
one layer in: **a number that is real but was measured on a different question carries the same
authority as one that was measured on this one.**

## The pattern

**A fallback value that is also a legitimate value.** `rho = 0` is a real measurement in one branch
and a silent failure in another, and nothing in the type could tell them apart — the `rhoSource` field
was added earlier in this same bead for exactly this reason and the new branch still borrowed the
wrong spelling. The general form: when a function returns a sentinel for "could not compute", check
whether that sentinel is also a meaningful answer, and if it is, add a discriminant rather than
reusing it.

Its mirror image is the severity class the project already names: **reports success wrongly.** This is
not a crash and not an obviously-wrong number — `0.0% (95% CI 0.0-0.5%)` is a perfectly well-formed
interval. It is the *strongest* claim the surface can make (a tight bound around zero) produced by a
computation that had run out of information. A reviewer reading the output could not distinguish it.

## Why nothing else would have caught it

- **The unit tests could not.** They are anchored on hand-derived cells and every anchor is a
  population with variation in it. A constant-outcome population is the one input an
  anchor-by-hand suite is least likely to contain, because it is the least interesting to derive.
  Mutation-checking confirms the direction: reverting the bound fails 2 of the 11 new CLI tests (the
  constant-outcome test and the `--filter` composition, whose filtered `top.draft` row is also 4-of-4
  constant) and 1 of the 23 analysis tests — so a test *can* pin it, but only the one written after
  seeing it.
- **A code review plausibly could have**, and it is worth saying so: the branch has a comment
  explaining itself, and a second reader asking "what is 0/0 here" would have a fair chance. That is
  an argument for review, not against dogfooding — the review did not happen, and the drive did.
- **`align check` cannot see it.** There is no import or cycle here; the module is pure and stays
  pure.

## Consequences and constraints

- **Entries are immutable**, so this is not a cleanup task: no stored interval is edited. The fix is
  prevention at compute time, which is what shipped.
- **The corrected numbers are not comparable to any interval printed before this fix.** Any row that
  carried a design earlier in this same bead read `deff 1` where it should have read `deff 74.0`. No
  such row was ever committed — Stage 3 is one work commit — but the constraint is real for anyone
  reading this series later: an interval printed before 2026-10-04 with `--cluster` is not the
  interval the same command prints now.
- **The estimator's binary-outcome limitation stands**: this branch fires on 0/1 outcomes only, and a
  count-valued outcome still needs a different variance model.

## Links

- Bead: `asc-n007` (open; fix landed in the asc-0hys Stage 3 commit)
- Parent bead: `asc-0hys` (clustering correction, Stages 1–3)
- Template: `dogfood/0000-template.md`
- Estimator: `packages/analysis/src/design-effect.ts`, the `denominator === 0` branch
- The route the branch was conflated with: `RhoSource`, `'inapplicable'`
