# asc-gtnu.8 — reviewer recall per lens class, with seeded defects. Pre-registration

Sealed by sha256 in the bead notes **before any review of the subject runs**. The file has two
parts, and they were fixed at different moments:

- **The predictions (section 1) predate this file.** They are copied verbatim from the bead's
  description, created `2026-09-27T00:43:55Z` with 0 measurements taken, and they are not edited
  here. Only their text is carried over, so a reader can check this seal without the bead.
- **The apparatus (sections 2–8) is what this seal covers.** It was written 2026-09-27, after
  three probe sessions and before any review of `handler.ts`. The probes, stated so the seal does
  not overclaim: (a) a `claude -p` session's tool list, with `ReportFindings` present among 33
  tools; (b) a 4-line fixture reviewed by a session that called `ReportFindings` twice, whose
  transcript ingested into 2 `review_finding` entries in a scratch store; (c) the exact `--tools`
  restriction below, where the init event listed `Bash, Read, ReportFindings`. The probes cost
  $0.2071 in total and reviewed no line of the subject.

**The seeds are sealed separately** (section 3). They do not exist yet, and this file fixes the
rules they must satisfy, not their content. `spike/recall/seeds.json` gets its own sha256 in the
bead notes before the first seeded run.

## 1. Predictions — verbatim from the bead

1. **Recall is under 50% in at least 4 of the 9 lens classes.** At n=25 seeds per class, a class
   whose observed recall is below 0.50 has an upper 95% Wilson bound below 0.70. Falsified if 6 or
   more classes land at or above 0.50.
2. **`boundary_conditions` has the highest recall of the nine; `time_concurrency` and
   `cross_implementation_divergence` are the lowest two.** Falsified if `boundary_conditions` is not
   the maximum, or if neither of the other two is in the bottom two.
3. **A seeded defect that fails a committed test is found far more often than one that does not.**
   Predicted gap: at least 0.30 in absolute recall. Rationale, and it is the mechanism this bead
   suspects: a reviewer can run the suite, so a test-breaking defect is handed to it, while a defect
   the suite does not cover must be found by reading. Falsified if the gap is under 0.15.
4. **Two reviewers on the same seeds overlap far less than they agree with the truth.** Predicted
   Jaccard on the FOUND sets: under 0.40, consistent with the 2-of-12 anecdote (Jaccard 0.09).
   Falsified if the two models' found-sets overlap at Jaccard 0.40 or more.
5. **Seeding changes the reviewer's reporting rate, not only its recall.** Predicted: reviews over a
   seeded repo report MORE findings per run than reviews of the same repo unseeded, because seeded
   defects are findable and a findable defect invites more searching. Falsified if the seeded arm's
   findings-per-run is not higher.

## 2. What is measured, and what is not

Four classes: `boundary_conditions`, `time_concurrency`, `cross_implementation_divergence`,
`error_paths`. **The other five are not measured.** So prediction 1 can only be read over four
classes. It is reported as "k of the 4 measured classes are under 0.50", and it is **not
resolvable** as stated: 4 of 4 under 0.50 is consistent with it, but it cannot confirm "at least 4
of 9". It can be falsified only if 6 or more of 9 land at or above 0.50, which four classes cannot
show. Prediction 2 is likewise read among the four: `boundary_conditions` is the maximum of the
four, and at least one of the other two is in the bottom two of the four. The record states that
it is this restricted reading.

## 3. Seeds — the rules they are authored under

- **Subject:** `packages/core/src/handler.ts`, and only that file. A thin class is **reported short,
  never padded and never widened** to another file. Target 25 seeds per class; a class that ends
  under `MIN_N` = 20 is reported as an interval with `minNFlag` set, not as a rate. The expected
  outcome is `time_concurrency` at about 14–17. That is an acceptable result, and it is stated here
  before the runs.
- **One seed is one localized mutation** of the committed source, recorded as data:
  `{id, class, line, before, after, distinguishingToken, lensRationale, breaksCommittedTest,
  failingTests}`. Here `line` is the 1-indexed line of the changed text in the original file, and
  `lensRationale` quotes the lens definition from `brief.md` that the seed is authored under.
- **Every seed compiles.** A mutation that fails `tsc -p packages/core` is rejected, not counted.
- **Seeds in one class tree sit at least `2R + 1` = 7 lines apart**, so a single finding can match
  at most one seed. All of a class's seeds are applied together in its tree, and the arm A and arm B
  trees of a class are byte-identical in source.
- **`breaksCommittedTest` is measured, never asserted.** Each seed is applied **alone** to an
  otherwise clean tree, and `packages/core/test/handler.test.ts` is run (that file only, not the
  full suite). The seed is `true` only if the vitest output names at least one failing test. A run
  that fails to build, or that reports zero tests run, is **unverified**, not caught. A control
  mutation that no test exercises is run first, to prove the harness can see "no test failed".

## 4. Arms, trees, models, grant

| arm | tree | runnable suite |
|---|---|---|
| A | seeded, one class | yes |
| B | seeded, same class, same source | no: no `node_modules`, and no way to fetch a runner |
| C | unseeded | yes |

- **Tree:** an allowlist slice built by `spike/recall/trees.mjs`: `packages/core/{src,test,
  package.json,tsconfig.json}`, `tsconfig.base.json`, `LICENSE`, plus a generated root
  `package.json`, `pnpm-workspace.yaml` and `vitest.config.ts`. It gets a fresh `git init` with one
  commit and no upstream. The tree lives under the OS temp root with a neutral name (`rv-XXXXXX`),
  **not** under `spike/tmp/` as the plan said: inside this repo, a session inherits ascend's
  `CLAUDE.md` and a `bd` that reaches this bead's seed classes.
- **Runnability, measured by `trees.mjs --dry-run`:** arm A shape: `Tests  100 passed`; arm B
  shape: `npm error ... cache mode is 'only-if-cached' but no cached response is available`. Every
  arm runs with `npm_config_offline=true` and an empty npm cache.
- **Prompt:** `spike/recall/brief.md`, byte-identical in every arm and on stdin. It names the scope,
  the test file's location, the nine lenses (in the bug-hunt skill's own wording, condensed) and
  `ReportFindings`. It says nothing about seeds, arms, or running the tests.
- **Tools:** `--tools Bash,Read,ReportFindings`, `--allowedTools Read, ReportFindings,
  Bash(npx vitest:*), Bash(pnpm test:*), Bash(pnpm vitest:*), Bash(pnpm exec vitest:*),
  Bash(npm test:*), Bash(npx tsc:*)`, `--permission-mode dontAsk`, `--strict-mcp-config`. There is
  no `Task` (so a finding's `session_id` is its reviewer) and no `Skill`.
- **Models:** `claude-sonnet-5`, `claude-opus-5-5`. A run whose `modelUsage` does not name the
  pinned model is a failed run.
- **24 runs** = 4 classes × {A, B, C} × 2 models. Arm C is **4 replicates per model of one unseeded
  tree shape**: the within-model baseline for prediction 4.
- **The pilot** is a Sonnet arm-C run with this exact apparatus. It **counts as Sonnet's first
  arm-C replicate** and fills the C-sonnet slot of the first class in the run order (section 5),
  if nothing in this file changes after it. If anything does change, it is discarded, it is
  reported as discarded, and that slot is run again.

## 5. Spend

The total ceiling is **$40**, set by the repository owner on 2026-09-27. It covers the probes, the
pilot and the 24 runs. Each session is started with `--max-budget-usd min(3, remaining)`. **A cell
the ceiling prevents is reported as not run, never as zero findings.** Run order after the pilot is
fixed so that a ceiling stop leaves whole comparisons standing rather than scattered cells:
`boundary_conditions`, `error_paths`, `cross_implementation_divergence`, `time_concurrency`. Within
each class it runs A-sonnet, A-opus, B-sonnet, B-opus, then C-sonnet, C-opus, until every model has
4 C runs. A run that hits its own budget cap before finishing still counts: its reported findings
score and its unreported ones escape. It is flagged `budgetCut` in the record.

## 6. The scorer — fixed now, run after

- **Findings** are the ReportFindings elements read back from the scratch store's `review_finding`
  entries. The raw stream is read only to cross-check the count, and a mismatch is reported.
- **A hit:** a finding whose `file` ends with `packages/core/src/handler.ts` and whose `line` is
  within **R = 3** of the seed's `line`. With `line` absent or unparseable, a hit is when its
  `summary` or `failure_scenario` contains the seed's `distinguishingToken`. The reviewer's
  `category` and `verdict` are **ignored**: recall is per seed class, whatever the reviewer called
  it. Why R = 3: a finding typically cites the changed line, the condition that guards it, or the
  statement that consumes it. Those sit within a few lines in this file, and 3 keeps the regions of
  seeds 7 lines apart disjoint.
- **Recall per class** = seeds hit / seeds in the class, per (arm, model). The interval is the
  Wilson interval from `spike/lib/stats.mjs` (z = 1.96), printed with `formatProportion` and
  `minNFlag`.
- **Prediction 3:** in arm A, recall of `breaksCommittedTest = true` seeds minus recall of `false`
  seeds, pooled over classes and models. The null is `permutationNull(broken, found, {iterations:
  10000, seed: 20260927})` from `spike/lib/stats.mjs`, a chi-square permutation over seed-runs. The
  same gap is reported for arm B, where the mechanism predicts it shrinks.
- **Prediction 4:** per class, Jaccard of the arm-A found-sets (seed ids) of Sonnet and Opus, and
  the Jaccard pooled over classes. The falsifier is the fixed threshold 0.40, with no null. The
  within-model baseline is arm C: two findings **match** when they share a file and their lines
  differ by at most R. Jaccard between two runs = matched pairs (greedy, one-to-one) / (|a| + |b| −
  matched). It is reported for same-model replicate pairs versus cross-model pairs.
- **Prediction 5:** mean findings per run, seeded (A and B) versus unseeded (C), per model. Every
  element of every ReportFindings call is counted.
- **Kappa:** 40 findings drawn from the seeded runs with `mulberry32(20260927)`, hand-labelled with
  the seed each one targets (or none) **before** the scorer's labels for them are printed. Cohen's
  kappa on hit / not-hit is reported beside every number. The limitation, stated now: the hand
  labeller is the experimenter who wrote the seeds.

## 7. Manipulation checks, reported whether or not they fire

For each run: `git diff|log|show|stash|blame|reflog` commands; the count of tool inputs naming an
absolute home path outside the tree; whether any vitest run printed a test count (it must be false
in every arm-B run, and one that is true invalidates that run); `permission_denials`; the tools in
the init event.

## 8. What is reported whatever happens

Runs started, completed, failed and discarded, each with its count. A rate over survivors alone is a
false green. The effective n is **smaller than 25 per class**, because a class's seeds sit in one
file and are read by one reviewer in one context. The intervals are optimistic for that reason,
and the record says so.
