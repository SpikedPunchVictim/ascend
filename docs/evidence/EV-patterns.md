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

---

## Amendment — 2026-10-05: the two controls, built and measured (asc-fwpe)

**What this is.** The Decision section above names *"two required additions to E7"* and the
Confidence section says of them, in this file's own words: *"the two controls proposed above are
untested designs, not measured remedies."* They are now implemented — `functionalDependence` /
`DEFINITIONAL_AT` and `blockPermutationNull` in `packages/analysis/src/association.ts`, wired into
`rankAssociations` and surfaced on `asc stats --assoc --temporal … --blocks …` — and measured
against the real corpus. **The finding list is re-issued below with the survivor count stated AFTER
the controls rather than before.** This is a correction to the two tables above, not a fresh
question.

Every number here comes from `node spike/spike-controls.mjs`, which is checked in so they are
**regenerable rather than transcribed**. It reads the same frozen `spike/corpus.db` (2026-09-11) and
reproduces this record exactly where it can be checked: `tool-denial` **N=409**, **35 distinct
days**, Thursday **168/409 = 41.1 %**, 2026-09-03 **143/409**. Its observed χ² for the four weekday
pairings are **identical to the published table above** — 185.50, 327.60, 348.07, 95.88 — so the
before/after is clean, with no corpus growth between them.

### Correction 1 — `project × repo` is not "a deterministic mapping"

The Decision section says *"project path and repo are a deterministic mapping, so the association is
definitional."* **That is not true of this corpus, and it matters, because a detector written to that
sentence would suppress nothing.** Measured across all ten `tool-denial` pairs, with determinism
`U = 1 − H(Y|X)/H(Y)` reported in the stronger of the two directions:

| pair | a→b | b→a | max |
|---|---|---|---|
| **`project × repo`** | 0.752 | **0.828** | **0.828** |
| *— 2.1× gap —* | | | |
| `denial_kind × project` | 0.223 | 0.389 | 0.389 |
| `denial_kind × repo` | 0.190 | 0.365 | 0.365 |
| `denial_kind × weekday` | 0.145 | 0.273 | 0.273 |
| `project × weekday` | 0.233 | 0.250 | 0.250 |
| `tool_name × project` | 0.057 | 0.240 | 0.240 |
| `weekday × repo` | 0.226 | 0.232 | 0.232 |
| `denial_kind × tool_name` | 0.224 | 0.092 | 0.224 |
| `tool_name × weekday` | 0.044 | 0.199 | 0.199 |
| `tool_name × repo` | 0.026 | 0.123 | 0.123 |

Neither direction is functional: `project → repo` is not (align has `main` and `fix`; grizzly-wip has
three) and `repo → project` is not either (`main` spans five projects). **A strict
functional-dependency test — "is this exactly 1.000" — fires on ZERO pairs in this corpus.** The only
true 1.000 available is `day × weekday`, a derived self-pair nobody reports. So the check cannot be
"is it a function"; it has to be "is it *near* one", and the number that decides that has to be
justified by a measured gap rather than chosen.

**The gap is real and the threshold sits inside it**: `DEFINITIONAL_AT = 0.5` separates 0.828 from
0.389 by a factor of 2.1. Exactly one pair in ten is at or above it. `project × repo` is suppressed
— and the verdict above it stands, because this is the tautology the section names, at V=0.761 vs
the runner-up's 0.465.

### Correction 2 — the temporal control, and it flags more than the two pairs predicted

Permuting whole **days' weekday labels** among days — each day keeps its size and its rows, so the
143-row day draws a random weekday and no row is invented or dropped — 5,000 iterations, seeded
(20261005), `+1`-corrected:

| pair | observed χ² | block-null median | p95 | p | verdict |
|---|---|---|---|---|---|
| `project × weekday` | 327.60 | **398.41** | 489.61 | **0.9432** | block confound |
| `weekday × repo` | 348.07 | **439.89** | 543.14 | **0.9594** | block confound |
| `denial_kind × weekday` | 185.50 | **195.39** | 234.68 | **0.6225** | block confound |
| `tool_name × weekday` | 95.88 | **85.68** | 114.37 | **0.2667** | block confound |

**All four** weekday pairings collapse. The Decision section predicted two (`project × weekday` and
`skill_name × weekday`); the measurement finds four, and the one it did not name — `denial_kind ×
weekday`, χ²=185.50 p≈0 — is a "SURVIVES" row in the table above. **The observed statistic sits BELOW
the null median in three of the four cases**, which is the finding stated properly: the day structure
alone manufactures *more* weekday association than the data contains, so the weekday is not what
shapes this corpus — 2026-09-03 is, and the weekday is downstream of it.

The null is deliberately **not marginal-preserving**. That is why this is a second control and not a
reuse of the shuffled one: the shuffled control holds the marginals fixed and destroys only the
pairing, and the marginal concentration here is *real* — it is the *pairing over time* that is
spurious. The shuffled control is structurally blind to exactly this.

### The re-issued finding list — **3 of `tool-denial`'s 10 pairs survive**

Reconciled against the 2026-09-14 Amendment rather than restated. That Amendment corrected **14 of
16 → 8 of 16**, all 8 from `tool-denial` (10 pairs, 2 refuted as artifacts of marginals, 6 void).
The two controls now remove 5 more of those 8:

| pair | before | removed by |
|---|---|---|
| `denial_kind × project` | SURVIVES | — |
| `denial_kind × repo` | SURVIVES | — |
| `denial_kind × tool_name` | SURVIVES | — |
| `project × repo` | SURVIVES *(but see below)* | **definitional, determinism 0.828** |
| `denial_kind × weekday` | SURVIVES | **block confound, p 0.6225** |
| `project × weekday` | SURVIVES | **block confound, p 0.9432** |
| `weekday × repo` | SURVIVES | **block confound, p 0.9594** |
| `tool_name × weekday` | SURVIVES | **block confound, p 0.2667** |
| `tool_name × project` | ARTIFACT of marginals | *(unchanged, shuffled p 0.1272)* |
| `tool_name × repo` | ARTIFACT of marginals | *(unchanged, shuffled p 0.1596)* |

**`denial_kind × project`, `denial_kind × repo` and `denial_kind × tool_name` are the three that
survive both controls** (shuffled p 0.0025 each; no temporal column in any, so the block control does
not apply). This is not a loss of the record's substance — it sharpens it. The actionable finding
above (`permission-rule` denials mean a missing allowlist entry, not a user disagreement; and every
non-Bash tool is 100 % `user-rejected`) rests on **the `denial_kind` × `tool_name` pairing**, which is
one of the three survivors, and on within-Bash proportions that neither control touches. **The GO
stands.** What does not stand is any suggestion that four weekday pairings were findings: they were
the day structure, restated.

### What this does not establish, stated plainly

- **The threshold is corpus-specific.** 0.5 sits in a 0.389–0.828 gap measured on one 409-row corpus,
  from one user, on one machine. Another corpus may have no gap at all, in which case the constant is
  the wrong instrument. The mitigation is disclosure rather than pretense: the coefficient is
  reported for **every** pair, so a near-miss is visible to a reader who disagrees.
- **Suppression can hide a real association.** A genuinely causal 0.83-deterministic pair would be
  suppressed. The suppressed pairs are named on stderr with their coefficients for exactly this
  reason, and that is only a mitigation if the line is read.
- **The block null's variance may be inflated by the single 143-row day.** An observed value below
  the null median is odd, and a within-day comparison is the named alternative if that turns out to
  matter. This amendment does not settle which is right.
- **The frozen snapshot.** These numbers describe `spike/corpus.db` as of 2026-09-11 — the same
  snapshot the tables above were published from, which is what makes the comparison clean. The live
  corpus has grown (~436 denials per the 2026-09-14 Amendment). Neither control has been re-run on
  the grown corpus.
- **The third control is still not built.** The pseudoreplication / effective-sample-size check the
  2026-09-14 Amendment names remains unmeasured and was out of `asc-fwpe`'s acceptance. It is filed
  as a bead rather than absorbed, because it is a genuinely different mechanism — run-length
  detection over session state, not a resampling scheme.

