# asc-6ola.3 — can a knowledge workflow tell in advance whether its comparison will ever resolve? Pre-registration

Written 2026-09-23 before computing anything below. Sealed by sha256 in the bead notes.

**Data.** The frozen corpus (1,007 transcripts, frozen 2026-09-23T06:46:47Z), normalized by
`spike/replay/replay.mjs` into `replay-out/events.jsonl` (all 50 projects) and scoped to this project.

**Two metrics**, chosen because the parent's workflows name them and their base rates differ by
roughly an order of magnitude:

- **M1 search miss.** Unit: a `search.run`. Outcome: `search_miss/empty-then-found` matched it.
  Known before sealing: 206 of 9,886 searches pooled; 18 of 1,236 in this project.
- **M2 failing test run.** Unit: a tool result containing a vitest summary (`Test Files …`).
  Outcome: that summary reports `failed`. Read from transcript text, not the Bash exit status,
  because a test command piped to `tail` exits with `tail`'s status. Base rate unknown before sealing.

**What "can separate" means.** The comparison ascend would run is a holdout (control) vs delivered
(treatment) difference in proportions, at 95%, powered at 80%, for a stated relative reduction:
50% for M1 and 30% for M2. Holdout is assigned per session (asc-6ola.2), so the session is the
randomized unit and the within-session correlation inflates the required n by the design effect,
`deff = 1 + (m̄ − 1)·ICC`, estimated from the sessions in the corpus.

**Questions.**
- Q1 What is each metric's eligible-unit rate per active day (a day with ≥ 1 unit), in this
  project and pooled?
- Q2 How clustered are the outcomes within sessions (deff)?
- Q3 How many active days until each arm clears MIN_N (20), and until the comparison is powered?
  Naive and cluster-adjusted; holdout 50% and 20%; this project and pooled.
- Q4 Is the base rate stable enough to plan from, i.e. does the first half of active days predict
  the second?
- Q5 Does the analytic sample-size formula agree with the power a simulation measures?

## Predictions

| # | prediction |
|---|---|
| W1 | M1 deff ≥ 1.5: search misses cluster in sessions. |
| W2 | M1, this project, 50% holdout, cluster-adjusted: > 90 active days to 80% power. Pooled across all projects: still > 30. |
| W3 | M2 base rate ≥ 10%, and M2 in this project is powered in < 30 active days (50% holdout, cluster-adjusted). |
| W4 | M1 is not stationary: the Wilson intervals of the first and second half of this project's active days do not overlap (low confidence). |
| W5 | At the analytic n, a seeded simulation (10,000 reps, unclustered) measures power within ±5 points of 80%. |
| W6 | In ≥ 1 of the 8 cells (metric × scope × holdout) the arms clear MIN_N long before the comparison is powered (≥ 5× sooner). MIN_N alone would tell a workflow it is "ready" when it is not. |
