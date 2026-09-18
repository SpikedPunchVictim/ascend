# EV-3: at realistic single-user volume, does an actionable pattern actually emerge?

> **Project identifiers were redacted after publication.** This repository is public. Private
> project, user and MCP-server names in this record were replaced with the stable pseudonyms used
> throughout `docs/evidence/` (`<user>`, `<org-B>`, `<project-A>` ..). The same pseudonym always
> means the same thing in every record, so every count and comparison below stays checkable. Only
> identifiers changed; no measured value was altered. The store behind these numbers was scrubbed
> to match — see `dogfood/0004-2026-09-18-the-corpus-records-identity.md`.


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

                Two types were profiled: `tool-denial` (N=409) and `skill-activation` (N=4668
                — **corrected 2026-09-14: 4,668 is a message-echo count, not a corpus size; the
                true N is ~87 activations. See the Amendment at the end of this file.**).
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
(2,002 / 4,668 not-measured)**, a genuine mixed-population case. *(Corrected 2026-09-14: the
mixed-population claim holds — the 2,002 not-measured rows are real — but the fraction's
denominator is dwell-weighted, not a count of activations. See the Amendment.)*

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
*(Corrected 2026-09-14: all 6 are **void**, not surviving — the rows are non-independent echoes of
session state, so the test cannot separate a real association from dwell weighting, and the
shuffled control is blind to it by construction. See the Amendment.)*

**14 of 16 candidate associations survive.** The pattern machinery works.
*(Corrected 2026-09-14: **8 of 16** actually survive, all from `tool-denial`; 2 are refuted
artifacts of marginals; 6 are void. See the Amendment.)*

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

---

## Amendment — 2026-09-14: the `skill-activation` half is dwell-weighted (asc-xgo.1)

**What was wrong.** The `skill-activation` profile is stated at **N=4,668** (line 20). That is not a
corpus size. `attributionSkill` is session STATE echoed on every assistant message while a skill is
active. Measured 2026-09-14 on the same tree (842 files, 425,234 lines, 1,202 MB; EV-corpus used 809
files, so it has grown), it appears on **6,395 lines across 71 files** but holds only **12 distinct
values** with **6,308 consecutive repeats**. The independent count is **87 value-runs** across 87
file-events. The median run spans **55 messages / ~345 seconds**, and **76 of 86** repeated runs span
more than 60 s — which is what makes this a state and not an event. 4,668 counts *messages that
mention* a skill, not times one was used.

**Consequence: every statistic over those rows is weighted by how LONG a skill stayed active, not by
how often it was used.** A skill activated once in a very long session contributes far more rows than
one used briefly. The dominant value in the corpus (`fullstack-dev-skills:the-fool`, 2,073 lines) is
likely the longest-running activation rather than the most-used skill.

### What this overturns

1. **All six `skill-activation` associations (above) are void as evidence.** Rows within one
   (skill, agent) cell largely come from a single activation, so the chi-square's independence
   assumption is violated, the p-values are optimistic, and the effect sizes — including the largest,
   skill_name × agent_name at V=0.729 — are inflated by dwell weighting. This is **pseudoreplication**.
   The precise label matters: they are not shown to be *false*; the test as run **cannot separate** a
   real association from the dwell-weighting artifact, so they carry no weight in either direction.

2. **The shuffled-label control cannot detect this, by construction.** The control "holds each
   dimension's marginal distribution fixed and destroys only the pairing between them" (Method,
   above). Dwell weighting *is* a property of the marginals; shuffling preserves it. So the control
   is structurally blind to the one defect this profile has, and "all 6 pairs survive" is not
   evidence of anything. This is the sharpest result here: the design's most load-bearing
   methodological bet is confirmed on `tool-denial` and has a blind spot exactly where the second
   profile lives.

3. **The `agent_name` mixed-population claim survives in kind, not in number.** The 2,002
   not-measured rows are real, so the three-state machinery *is* exercised by this profile as
   claimed. But 57.1 % has a dwell-weighted denominator; the true fraction over 87 activations is
   unmeasured, and this amendment does not measure it.

### What survives — the GO does not depend on this profile

The Decision above rests the premise on the **`tool-denial` corpus (N=409, now ~436 as the corpus
grew)**, which is counted per event by distinct `tool_use_id` and is unaffected by any of this.
Specifically unaffected:

- the denial_kind proportions (55.0 % permission-rule, CI 50.2–59.8 %) and the Bash concentration (92.7 %);
- **the actionable finding** — within Bash, permission-rule at 58.6 %, and every non-Bash tool 100 %
  user-rejected — the pattern no single entry reveals, which is the reason this EV says GO;
- `tool_name × project` as the artifact the shuffled control earns its place by catching
  (χ²=153.11, p=8.61e-8 → shuffled 0.1272). This is a `tool-denial` result;
- the `project × repo` tautology (V=0.761) and the 2026-09-03 temporal confound (143 of 409).

**One claim here is independently CONFIRMED, not overturned:** `user-correction` at N=20. Measured
separately on the grown corpus: 20 lines across 10 files. EV-patterns was right where it looked
closely, and its conclusion — register the type, but never use it as a second source of evidence for
the same events — stands.

### A third control E7 now requires

E7 already needs the tautology check and the temporal-block control. This measurement adds a third:
**an effective-sample-size / pseudoreplication check.** When rows are echoes of a session state
rather than independent events, E7 must detect it — a value repeating in long consecutive runs
within a session is the signal — and either collapse to activations or use a clustered method.
Without it, any type whose field is state-like will silently produce dwell-weighted statistics with
confident-looking p-values, and the shuffled control will not flag it.

**Not measured, stated plainly:** the true `agent_name` fraction over 87 activations; whether any of
the six void associations is real; and whether a dwell-aware re-analysis at n≈87 would even have
power (12 skill values across 87 activations is thin — several cells would fall under `MIN_N = 20`
and become anecdotes). This amendment corrects the record; it does not re-run the profile.
