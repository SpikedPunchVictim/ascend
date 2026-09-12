# EV-3: at realistic single-user volume, does an actionable pattern actually emerge?

**Question**    **This is the project's central premise.** At the N a single user actually accumulates,
                does grouping the corpus reveal a concentration a human would act on — or is it noise?
                If no actionable pattern emerges at realistic volume, ascend has no reason to exist.

**Method**      Profile + association analysis over the real corpus extracted in EV-1
                (`spike/corpus.db`), via `spike/lib/stats.mjs` and `spike/spike-patterns.mjs`.

                - Every proportion carries a **Wilson score interval** and its n; groups under
                  `MIN_N = 20` are flagged as anecdotes rather than estimates.
                - Every dimension-pair association is tested **twice**: a chi-square test
                  (with Cramér's V for effect size) **and a shuffled-label permutation control**
                  (5,000 iterations, seeded). A pair is reported as a finding only if it beats
                  **both** — `real = pShuffled < 0.05 && stat.p < 0.05`.
                - The shuffled control holds each dimension's marginal distribution fixed and
                  destroys only the pairing between them, so it answers "is this association more
                  than the marginals alone would produce?"

                Two types were profiled: `tool-denial` (N=409) and `skill-activation` (N=4668).
                16 dimension pairs were tested in total.

## Measurement

### `tool-denial`, N=409, 2026-08-02 .. 2026-09-12 (35 distinct days)

| dimension | value | proportion | 95% CI |
|---|---|---|---|
| denial_kind | permission-rule | **55.0 %** | 50.2–59.8 % |
| | user-rejected | **38.9 %** | 34.3–43.7 % |
| | automode-blocked | 4.9 % | 3.2–7.4 % |
| | automode-unavailable | 1.2 % | 0.5–2.8 % *(n=5, anecdote)* |
| tool_name | **Bash** | **92.7 %** | 89.7–94.8 % |
| | AskUserQuestion | 2.9 % | 1.7–5.1 % *(n=12, anecdote)* |
| | ExitPlanMode | 2.7 % | 1.5–4.8 % *(n=11, anecdote)* |
| weekday | Thursday | **41.1 %** | 36.4–45.9 % |
| project | <project-A> | 37.9 % | 33.3–42.7 % |
| repo | HEAD | 42.8 % | 38.1–47.6 % |

The three-state ratios came back fully measured — `denial_kind`, `tool_name`, `project`, `repo` are
each 100.0 % measured (0 not-measured) for this type, so the three-state machinery is exercised by
the *other* profile rather than this one: `agent_name` in `skill-activation` is **57.1 % measured
(2,002 / 4,668 not-measured)**, a genuine mixed-population case.

### Associations — 14 of 16 survive the shuffled control

`tool-denial` (all values from `spike/spike-patterns.mjs`):

| pair | χ² | df | p | V | shuffled p | verdict |
|---|---|---|---|---|---|---|
| denial_kind × tool_name | 144.19 | 24 | ~0 | 0.343 | 0.0025 | **SURVIVES** |
| denial_kind × project | 265.02 | 27 | ~0 | 0.465 | 0.0025 | **SURVIVES** |
| denial_kind × weekday | 185.50 | 18 | ~0 | 0.389 | 0.0025 | **SURVIVES** |
| denial_kind × repo | 243.02 | 27 | ~0 | 0.445 | 0.0025 | **SURVIVES** |
| **tool_name × project** | **153.11** | **72** | **8.61e-8** | 0.216 | **0.1272** | **ARTIFACT of marginals** |
| tool_name × weekday | 95.88 | 48 | 4.93e-5 | 0.198 | 0.0025 | **SURVIVES** |
| **tool_name × repo** | 84.61 | 72 | 1.47e-1 | 0.161 | **0.1596** | **ARTIFACT of marginals** |
| project × weekday | 327.60 | 54 | ~0 | 0.365 | 0.0025 | **SURVIVES** |
| project × repo | **2130.84** | 81 | ~0 | **0.761** | 0.0025 | SURVIVES *(but see below)* |
| weekday × repo | 348.07 | 54 | ~0 | 0.377 | 0.0025 | **SURVIVES** |

`skill-activation` (N=4,668): all 6 pairs survive — skill_name × project (V=0.573),
skill_name × agent_name (V=0.729), skill_name × weekday (V=0.534), project × agent_name (V=0.561),
project × weekday (V=0.618), agent_name × weekday (V=0.646).

**14 of 16 candidate associations survive.** The pattern machinery works.

### The decisive finding: the shuffled control earns its place

`tool_name × project` is the single most statistically seductive result in the corpus:
**χ²=153.11, p=8.61e-8**. An asymptotic test alone — which is what most analysis code does — reports
this as a highly significant association with full confidence. Under the shuffled control its
p-value is **0.1272**: it is an artifact of the marginals (Bash dominates tool_name at 92.7 %; <project-A>
dominates project at 37.9 %, so the two big marginals co-occur). **The asymptotic test alone would
have shipped a false finding**, presented with a Wilson interval and a p-value under 1e-7.

This is the design's most load-bearing methodological bet, and it is confirmed on real data.

### The actionable pattern

Within Bash (n=379), `denial_kind` splits sharply:

| denial_kind | n | share of Bash |
|---|---|---|
| **permission-rule** | **222** | **58.6 %** |
| user-rejected | 134 | 35.4 % |
| automode-blocked | 19 | 5.0 % |
| automode-unavailable | 4 | 1.1 % |

And every non-Bash tool is the opposite — **AskUserQuestion 12/12 and ExitPlanMode 11/11 are 100 %
`user-rejected`**, never `permission-rule`.

That is a pattern no single entry reveals (each entry says only "a call was denied"), and it is
directly actionable: **permission-rule denials mean a missing allowlist entry, not a user
disagreement.** The action is `Bash(<prefix>:*)` allowlist entries — exactly what ARCHITECTURE.md's
risk section prescribes. The corpus also shows the *kind* of fix (allowlist, not prompting) and the
*scope* (Bash specifically, 92.7 % of all denials).

## Decision

**GO.** An actionable pattern emerges at realistic single-user volume. The central premise holds:
the corpus is large enough (N=409), the concentration is real (55.0 % permission-rule, CI
50.2–59.8 %), the finding is not visible in any single entry, and it maps to a concrete change.

Threshold: the plan required that a grouping show a concentration a human would act on, stated with
a Wilson interval, and survive a shuffled-label control. 14/16 associations and the Bash/allowlist
finding clear it.

**Two required additions to E7 (the analysis layer), from this measurement's own blind spots:**

1. **A tautology check.** `project × repo` scores V=**0.761** — by far the strongest association in
   the corpus — and *survives* the shuffled control. It is not a finding: project path and repo are a
   deterministic mapping, so the association is definitional. Shuffling destroys the identity and the
   result still looks significant. E7 must detect functional dependencies (a dimension that maps
   1:1 onto another) and suppress them before reporting.
2. **A temporal-block control.** The "Thursday 41.1 %" finding is a confound, not a pattern:
   **2026-09-03 alone contributes 143 of 409 denials (35 % of the whole corpus)**, and 35 distinct
   days span the range. `project × weekday` and `skill_name × weekday` are largely "which sprint
   happened when". The shuffled control does not catch this because the marginal concentration is
   real — it is the *pairing over time* that is spurious. E7 needs a block control (e.g. resample
   whole days, or compare within-day) for any dimension involving time.

## Confidence

What this does **not** establish:

- **`user-correction` is N=20, not the hundreds the design assumed** — and all 20 are a *subset* of
  the denial records (every one carries a `toolDenialKind` sibling). It is **not an independent
  corpus** and cannot corroborate anything from `tool-denial`. The plan's expectation that user
  corrections form a usable corpus is **not supported**; a `user-correction` type is worth
  registering, but not as a second source of evidence for the same events.
- **n=1 corpus, n=1 user, n=1 machine.** Every finding here is over-fit to one workflow until a
  second corpus exists. This is the "n ≥ 2" gap and it is not closed.
- **The control's blind spots are demonstrated, not solved.** I detected the tautology and the
  temporal confound **by inspection, by hand, after the fact** — the tooling did not surface either.
  The two controls proposed above are untested designs, not measured remedies.
- **`tool_name × repo` failed *both* tests** (asymptotic p=0.147, shuffled 0.1596), so it is not
  evidence for the control's power — only `tool_name × project` is. That is a single confirming case.
- **The 5,000-iteration control floors at p=0.0025.** With 16 pairs tested there is no
  multiple-comparison correction; at 5,000 iterations the smallest achievable p is 1/5001, and 14
  "survivors" are not 14 independent discoveries.
- **Only categorical dimensions were tested.** No numeric, temporal-trend, or text-similarity
  analysis was run, so the lexical-clustering, FP-growth, CUSUM and near-duplicate machinery in
  ARCHITECTURE.md is unexercised by this evidence.
- **`automode-*` denials (24 total) are a distinct population** — they mean the auto-mode classifier,
  not a permission rule, and they were conflated with the rest in the profile above.
