# asc-asq — pre-registration

Written before any arm of the accuracy comparison has been run. The only model call made before
this file existed is the **learnability pilot** described at the end, which measured no arm
difference and was run to decide whether the experiment was worth running at all.

**Question** (`asc-asq`): does a stratified sample of labelled examples make a model classify
better than a random sample of the SAME size, on a corpus with a rare category?

**Decision rule, as the bead states it**: *if stratified shows no advantage, DROP the mode rather
than carry it.* This file fixes what "advantage" will mean BEFORE the numbers exist, so the rule
cannot be written to fit whatever came back.

## Corpus

Every finding a reviewer reported through `ReportFindings`, read from the raw transcripts
(`spike/asq/extract.mjs`; 422 rows, 43 duplicates of a resumed session dropped; **n = 379**,
sha256 `f170dbe8…`). Each row carries the reviewer's `summary`, its `failure_scenario`, and the
lens the reviewer filed it under (`class`).

| class | n |
|---|---|
| boundary_conditions | 119 |
| assumption_audit | 74 |
| cross_implementation_divergence | 70 |
| state_machine | 33 |
| error_paths | 31 |
| data_lifecycle | 25 |
| write_read_asymmetry | 13 |
| time_concurrency | 12 |
| environment_divergence | 2 |

**Stated before the run, because it scopes every conclusion**: 340 of the 379 rows are findings
about one file, `packages/core/src/handler.ts`, produced by one review campaign that ran each lens
over copies of that tree. The corpus is real model work on real code, but it is not a corpus of
arbitrary code, and a difference measured here is a difference about findings that look like these.

## Design

- **Split, fixed before any draw** (seed 20261020): half of each class is the test set, the rest is
  the pool. The test set never enters the sampler's store, so no prompt can contain a test item.
- **The sampler is the real one.** The pool is recorded into a scratch store as `asq_item`, and each
  draw is `asc explore asq_item --sample <arm> --by class --limit 20 --seed <seed+d>` — the mode
  under test, not a reimplementation. Draw `d` uses the same seed for both arms.
- **n = 20** examples per prompt, the size EV-12 and `asc-1bd` measure the mode at.
- **Both arms are told the nine lenses.** This is the realistic deployment: the taxonomy is the
  schema, so a missing class in the prompt makes it under-represented, never unknown. The
  alternative (hide the taxonomy) would manufacture a difference by hiding information no user
  would hide.
- **Same test list, same order, one call per (draw, arm)**; label = the reviewer's own `class`.
- **10 draws per arm**, 20 calls, `deepseek-v4.1-flash:cloud`, pinned in the harness.
- The unit of inference is the **draw**, not the test item: the test set is fixed, so the only thing
  that varies is the prompt the sampler produced. Intervals are percentile bootstraps over draws.

## Predictions

- **P1.** Stratified's mean accuracy beats random's, paired by draw, by **at least 3 points**
  (95% CI lower bound > 0).
- **P2.** The gap is carried by the classes random omitted. On test items whose class was missing
  from the random prompt, stratified beats random by **≥ 15 points**. This is the mechanism the mode
  claims, and it is the prediction that fails if the mode's guarantee is decorative.
- **P3.** On the three classes holding ≤10 % of the pool (`state_machine` 8.6 % of 187,
  `error_paths` 8.0 %, `data_lifecycle` 6.4 %), stratified's recall is **≥ 10 points higher** than
  random's.
- **P4.** The cost is real: on the three common classes (`boundary_conditions`, `assumption_audit`,
  `cross_implementation_divergence`), **random ≥ stratified** — it spends the same 20 slots on more
  examples of each.
- **P5.** The task is learnable at all: overall accuracy in **both** arms exceeds **40 %**, against
  the test set's own majority-class baseline of 31.3 % (60 of 192 items are `boundary_conditions`).

## What fires the decision

- **Drop the mode** only if the paired 95 % CI for the accuracy difference lies entirely below
  **+2 points**.
- **Keep it** if P1 holds and the CI's lower bound is above +2.
- **Inconclusive** otherwise — reported as such, with the interval and the draws behind it, and no
  change to the mode.

Both arms are reported in full whatever happens, including the arm that loses. A negative result is
a successful execution of this bead.

## The pilot that came before this file

`spike/asq/pilot.mjs`, one call, three examples per class and five held-out findings per class
(41 items, seed 20261020): **29/41 = 70.7%** correct against a 12.2% majority baseline. It measured
no arm difference — there was only one prompt — and its purpose was to test EV-22's condition (3),
"content the label is inferable from", before deciding that the comparison was worth buying. It
also calibrated the per-call cost for the ceiling below.
