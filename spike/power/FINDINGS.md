# asc-6ola.3 — power check at inquiry planning time: findings

Predictions sealed in `PREREG.md` (sha256 `bc800c7b…5c40`, in the bead notes) before computing.
Data: the frozen corpus (1,007 transcripts) through `spike/replay/replay.mjs`. `power.mjs`
prints everything below, runs in 43 s, and reuses `wilson`, `MIN_N` and `mulberry32` from
`packages/analysis`.

## Result

```
== M1 search miss / this project  (relative reduction 50%)
units 1236 successes 18 p 1.46% sessions 4 activeDays 12 perDay 103
icc 0.0000 mbar 309 mtilde 609.6 deff 1 deffTilde 1
  holdout 0.5: MIN_N 0.4 d | powered naive 62.1 d, clustered 62.1 d (mtilde 62.1 d) | units 6395 | ratio 159.9x
  holdout 0.2: MIN_N 1 d | powered naive 88.5 d, clustered 88.5 d (mtilde 88.5 d) | units 9117 | ratio 91.2x
  halves at 2026-09-18: first 9/765 [0.62, 2.22] second 9/471 [1.01, 3.59] overlap true

== M1 search miss / pooled  (relative reduction 50%)
units 9886 successes 206 p 2.08% sessions 46 activeDays 36 perDay 274.6
icc 0.0000 mbar 214.9 mtilde 1169.9 deff 1 deffTilde 1
  holdout 0.5: MIN_N 0.1 d | powered naive 16.2 d, clustered 16.2 d (mtilde 16.2 d) | units 4448 | ratio 111.2x
  holdout 0.2: MIN_N 0.4 d | powered naive 23.1 d, clustered 23.1 d (mtilde 23.1 d) | units 6343 | ratio 63.4x

== M2 failing test run / this project  (relative reduction 30%)
units 853 successes 208 p 24.38% sessions 3 activeDays 12 perDay 71.1
icc 0.0265 mbar 284.3 mtilde 454.8 deff 8.5 deffTilde 13.02
  holdout 0.5: MIN_N 0.6 d | powered naive 13.5 d, clustered 115 d (mtilde 176.1 d) | units 8176 | ratio 204.4x
  holdout 0.2: MIN_N 1.4 d | powered naive 20.4 d, clustered 173.5 d (mtilde 265.6 d) | units 12334 | ratio 123.3x
  halves at 2026-09-18: first 160/620 [22.52, 29.39] second 48/233 [15.90, 26.25] overlap true

== M2 failing test run / pooled  (relative reduction 30%)
units 1925 successes 526 p 27.32% sessions 11 activeDays 32 perDay 60.2
icc 0.0203 mbar 175 mtilde 376 deff 4.53 deffTilde 8.61
  holdout 0.5: MIN_N 0.7 d | powered naive 13.8 d, clustered 62.6 d (mtilde 118.9 d) | units 3765 | ratio 94.1x
  holdout 0.2: MIN_N 1.7 d | powered naive 20.9 d, clustered 94.6 d (mtilde 179.7 d) | units 5689 | ratio 56.9x

W5 simulation, M1 pooled p0, 50% holdout, analytic n 4448 {"n1":2224,"n2":2224,"zPower":0.8101,"newcombePower":0.8079}
```

| # | prediction | result |
|---|---|---|
| W1 | M1 deff ≥ 1.5 | **refuted as measured**: ICC clamps to 0, deff 1.0. With 4 sessions (this project) the estimate is empty either way (see below). |
| W2 | M1 here > 90 d; pooled > 30 d | **refuted, in the fast direction**: 62.1 d and 16.2 d. |
| W3 | M2 base rate ≥ 10%, powered < 30 d here | half: base rate **24.4%** ✓; powered in **115 d** ✗ (deff 8.5). |
| W4 | M1 not stationary (halves' intervals disjoint) | **refuted**: [0.62, 2.22]% vs [1.01, 3.59]% overlap. |
| W5 | simulated power within ±5 points of 80% | **confirmed**: z-test 81.0%, Newcombe interval 80.8%. |
| W6 | ≥ 1 cell where MIN_N clears ≥ 5× before power | **confirmed in all 8 cells**: 57× to 204×. |

Two of six held, one half held. The miss that matters is not in the table.

## What the result says

1. **MIN_N says nothing about whether a comparison will resolve.** Every arm clears 20 within
   0.1–1.7 active days; the same comparisons need 13.5–265.6. A workflow that treated "each arm
   has n ≥ 20" as readiness would report 57–204× too early. The power check is a separate gate,
   and it must be computed before collecting, from the replayed base rate. The rate is stable
   enough to plan from (W4) and the arithmetic matches simulation (W5).
2. **The analytic formula is good enough, and so is the decision rule it assumes.** The pooled
   z-test and the Newcombe hybrid interval (built from `wilson`, the only interval ascend reports)
   measure the same power at the same n (81.0% vs 80.8%). So a planner can use the closed form,
   and the analysis can report the Newcombe interval without the two disagreeing.
3. **Clustering is where the planning goes wrong, and it depends on the metric.** Search misses
   show no measurable within-session correlation. Failing test runs do (ICC 0.02–0.03), and at
   ~280 units per session that multiplies the required n by 4.5–13 and turns 13.5 days into
   62–176. The same nominal "n ≥ 3,765" hides a 4× spread in calendar time. The planner has to
   estimate ICC per metric from replay; a default of 0 is wrong for M2.

## Nobody was looking for this: this project has 4 sessions

asc-6ola.2 randomizes the holdout per session × intervention, because a model that saw guidance
once carries it for the rest of the session. In this project that unit barely exists:

```
M1 search miss / this project: sessions 4 (active days per session: median 6, max 6); P(no session held out at 20%) 41.0%
M2 failing test run / this project: sessions 3 (active days per session: median 6, max 7); P(no session held out at 20%) 51.2%
M1 search miss / pooled: sessions 46 (active days per session: median 1, max 17); P(no session held out at 20%) 0.0%
```

Sessions here run for days: one transcript holds **94 compactions**, and the 4 top-level
transcripts hold 112. A per-session holdout at 20% has a **41%** chance of holding out *no*
session at all. Even at 50%, it compares 2 sessions against 2: the effective n of a cluster-randomized
comparison is bounded by the number of clusters, however many thousand events they hold. That is
also why W1 means nothing here: an ICC from 3–4 clusters is not an estimate.

**The candidate units, measured (addendum, not pre-registered):**

| unit | count, this project | contamination | notes |
|---|---|---|---|
| session | 4 | none within the unit | unusable here; fine pooled (46) |
| compaction segment | ~116 (4 sessions + 112 boundaries) | the summary can carry guidance forward | not measured: how much of a lesson survives a summary |
| prompt | 235 (M1), 209 (M2) | high: prior prompts' guidance is still in context | ICC at prompt level: M1 0.0, M2 0.026–0.047, deff 1.08–1.27 |

```
M1 search miss / this project: prompts 235 mbar 5.3 icc 0.0000 deff 1 | 50% holdout powered: 62.1 d needing 1216 prompts
M2 failing test run / this project: prompts 209 mbar 4.1 icc 0.0473 deff 1.15 deffTilde 1.27 | 50% holdout powered: 15.5 d (mtilde 17.2 d) needing 270 prompts
```

Randomizing by prompt restores the unit count and takes M2 from 115 days to 15.5. But
contamination biases the comparison toward no effect, by an amount nobody has measured. The
honest design is the **compaction segment**, since it is the moment the context actually
resets. It would also make "does a lesson survive compaction?" a measurable question.

## What the power check must do (settles asc-6ola.3's design)

At planning time, from the replayed log and before any collection:

1. **Base rate and unit rate** of the metric, per active day, in this project and pooled.
2. **ICC at the randomization unit**, estimated from replay, reported with the number of units it
   came from. Below MIN_N units the check reports that the ICC cannot be estimated, rather than
   using 0.
3. **Randomization units available**: sessions, compaction segments, prompts. It refuses a unit
   with fewer than MIN_N per arm expected over the horizon, and says which unit would work.
4. **Days to power** for the stated effect, holdout share and unit, with the multiplier shown.
   Never "days to MIN_N" alone.
5. **The verdict** is one of: *answerable here in D days*; *answerable only pooled in D days*;
   *not answerable at this effect size — the smallest detectable effect in 90 days is X*.

M1 at a 50% reduction is answerable here in about two months, or pooled in about two weeks. That
bounds the grep workflow the user described: which *technique* works best splits the 1.5% base
rate across techniques, and each split divides the per-arm rate.

## Limitations

- One corpus, one user, 36 active days; the rates are this user's.
- M1's outcome is the replay handler's `empty-then-found`, which is a proxy for a search miss (see
  `spike/replay/FINDINGS.md`).
- The simulation is unclustered. It validates the formula, not the design-effect correction.
- Holdout contamination across prompts and across compaction is asserted, not measured.
- Active days are UTC dates.
