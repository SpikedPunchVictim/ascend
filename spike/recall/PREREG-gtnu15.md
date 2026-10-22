# asc-gtnu.15 — the rerun: five unmeasured lens classes, and `time_concurrency` at n >= 20

EV-28 (`PREREG.md`, sealed 2026-09-27) fixed the apparatus and measured four of the nine lens
classes. This file pre-registers a second run and **inherits that apparatus unchanged**; sections 2,
6 and 7 of `PREREG.md` apply verbatim and are not restated except where this run differs. It was
written before any review session of the subject ran, and sealed by sha256 in the bead notes with
the seeds' own hash.

## 1. What changes, and why

1. **Six classes, not four.** The five EV-28 never measured — `assumption_audit`, `state_machine`,
   `data_lifecycle`, `environment_divergence`, `write_read_asymmetry` — plus `time_concurrency`,
   which EV-28 measured at n = 11 and therefore reported as an anecdote under `MIN_N` = 20. The four
   EV-28 measured at n >= 20 are **not re-run**: their results stand, and a second sample of them
   would answer a question already answered.
2. **Two arms, not three.** Arm B (seeded, no runner) is dropped. EV-28's own data says A and B
   measure the same thing: the runner actually ran in 1 of 8 arm-A runs, and the seeded-with-runner
   versus seeded-offline recall gap was 0.278 versus 0.274. One seeded arm IS the seeded arm.
   Dropping B takes a class from six runs to four, which is what pays for six classes at 24 runs.
3. **Arms A and C for each of the two models:** 6 classes x 4 runs = **24 runs**, at EV-28's
   measured $0.4817 per run = about **$11.6**. Run order is the class order in `CLASS_ORDER`
   (`spike/recall/arms.mjs`); within a class, A-sonnet, A-opus, C-sonnet, C-opus.
4. **The subject is pinned to commit `25d4504`** (1,312 lines), the file EV-28's 81 seeds were
   measured against, so the new classes are comparable to the old ones and every seed's measured
   `compiles` / `breaksCommittedTest` stays valid. Today's `handler.ts` is a different file;
   `arms.mjs` refuses to apply seeds whose `subjectSha256` does not match, which is the check that
   the pin held.
5. **Ceiling $20** for the 24 runs, with `--max-budget-usd min(3, remaining)` per session. The
   repository owner set no ceiling for this bead (2026-09-28); $20 is a margin over the predicted
   $11.6, not a limit on the design. **A cell the ceiling prevents is reported as not run, never as
   zero findings.**

## 2. Seeds — what the new ones are held to

Every rule in `PREREG.md` section 3 applies unchanged, including `MIN_GAP` = 7 lines within a class,
"every seed compiles", "`breaksCommittedTest` is measured, never asserted", and the control. The
seeds are authored per class and validated by `node spike/recall/seeds.mjs --check` run **from a
worktree at `25d4504`**, because `trees.mjs` copies the subject from the working directory.

**n per class is reported as authored, not as targeted.** Five classes at 20 and `time_concurrency`
at 20. Where a class ends under `MIN_N`, it is reported with `minNFlag` set, not as a rate.

## 3. Predictions — fixed before the first run

1. **Recall is under 0.50 in at least 3 of the 6 classes.** At n = 20, a class below 0.50 has an
   upper 95% Wilson bound below 0.66. Falsified if 4 or more of the 6 land at or above 0.50.
   *This is EV-28's P1, read over six classes instead of nine; it is cited, not re-derived.*
2. **`assumption_audit` has the highest recall of the six; `environment_divergence` the lowest.**
   Rationale: the assumption seeds are literal guards on one line, visible wherever the reader's eye
   lands, while the environment seeds need knowledge about another platform, parser or locale that
   nothing in the tree supplies. Falsified if `assumption_audit` is not the maximum, or if
   `environment_divergence` is not the minimum.
3. **A seed that fails a committed test is found more often than one that does not, by at least
   0.30 absolute recall, pooled over classes and models.** Falsified if the gap is under 0.15. The
   null is `permutationNull` with EV-28's own seed, `{iterations: 10000, seed: 20260927}`.
   *EV-28's P3, carried over: the mechanism it names — a test-breaking defect is handed to a
   reviewer that runs the suite, a non-breaking one must be found by reading — is unchanged by the
   classes measured here.*
4. **The two models' found-sets overlap less than they agree with the truth:** Jaccard under 0.40
   per class, as a pooled figure and per class. Falsified at 0.40 or more.
   *EV-28's P4, carried over.*
5. **Seeded reviews report more findings per run than unseeded ones**, per model. Falsified if the
   seeded mean is not higher. *EV-28's P5, carried over, and the one prediction EV-28 could not
   resolve: its arm-C replicates were too few to separate "seeding raises reporting" from run
   noise. Four C runs per model is a stronger test than that run had, and the result is reported
   either way.*
6. **`time_concurrency` scores above the mean of the other five.** Its seeds are the only ones
   authored against a mechanism a reader can see running (the window state machine), where the
   assumption and environment seeds are single-line guards and type assumptions. Falsified if it is
   at or below that mean.

## 4. What is reported whatever happens

Every number from EV-28 section 8 applies: runs started, completed, failed and discarded; the
effective n smaller than 20 per class because a class's seeds share one reviewer session and are not
independent observations; Wilson intervals that are optimistic for that reason; and the chance floor
measured on the same file (EV-28: 4.0–20.0% of findings match a seed by position alone), which is
reported beside every recall figure so a class's rate can be read against what a reviewer would
score by luck.
