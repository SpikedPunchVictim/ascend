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

---

## Amendment — 2026-10-05: both controls re-run on the live store (asc-h7nq)

**What this is.** The Amendment above ends with *"Neither control has been re-run on the grown
corpus."* This is that re-run. It is also the evidence that the gap `dogfood/0064` found is closed:
both controls were unrunnable against the store, `asc-h7nq` made them runnable, and **every number
below comes from the shipped command** rather than from a spike's own `SELECT`. Where the Amendment
above reports the frozen snapshot, this one reports the live store, and the two are **different
corpora of different sizes** — so this is not a before/after of one corpus. What makes the comparison
worth making is that the two share a number that growth did not move: **2026-09-03 held 143 rows in
the snapshot and holds 143 rows now**, out of 409 then and 774 now.

### The corpus, live

```
N 774
distinct days 52
span 2026-08-13 2026-10-05
weekday counts {'Thu': 249, 'Wed': 134, 'Mon': 100, 'Fri': 90, 'Tue': 69, 'Sun': 68, 'Sat': 64}
thursday 249 32.171
top days [('2026-09-03', 143), ('2026-09-16', 63), ('2026-09-17', 52), ('2026-08-28', 30), ('2026-09-28', 29)]
repo     nonnull 0    levels 0
git_sha  nonnull 0    levels 0
branch   nonnull 774  levels 12
cwd      nonnull 774  levels 45
```

The Thursday share fell from **41.1 % to 32.171 %** and the day count rose from 35 to 52 — the corpus
nearly doubled — while the outlier day's **143 rows are unchanged**. A single day that was 35.0 % of
the snapshot is now 18.5 % of the store, and it is still the largest by a factor of 2.3 over the next
(63). That is the strongest form the confound could take: it is not an artifact of a small corpus
that growth dilutes, because it did not dilute.

### The tautology check, live

`asc stats tool_denial --assoc`, exact output:

```
Warning: 9 pair(s) of 5 properties over 774 entries. q-values are corrected
across a family of 9, which is every pair in THIS run -- asking about ten
properties and asking twice about five are different questions with different
q-values. 2 of those columns are read from the entry ENVELOPE rather than a
declared property (cwd, branch): they vary in this corpus, and no spec can
declare a name the envelope already owns.
Warning: 1 pair(s) SUPPRESSED as DEFINITIONAL, at or above a determinism of 0.5
in either direction -- one property restating the other, so the pair is the same
fact twice rather than two findings: project x branch at 0.876 (n=774).
Determinism is reported for every pair below, so a near-miss can be argued with.
```

`project × branch` is the pair `project × repo` named above, and **it is the same measurement**:
`spike/spike-controls.mjs` derives its `repo` column as `COALESCE(git_branch, '(none)')`
(`spike/spike-controls.mjs:51`), so the snapshot's *repo* was the store's *branch* all along.
Same tautology, two corpora, **0.828 → 0.876**.

The live determinism ranking, from the same run, reproduces the shape the snapshot measured — one
pair far above a gap, everything else below it:

| pair | determinism | verdict |
|---|---|---|
| `project × branch` | **0.876** | **SUPPRESSED, definitional** |
| *— the threshold sits below here —* | | |
| `project × cwd` | 0.499 | **near-miss**, 0.0005 under `DEFINITIONAL_AT` |
| `denial_kind × project` | 0.465 | |
| `cwd × branch` | 0.372 | |
| `denial_kind × branch` | 0.356 | |
| `denial_kind × tool_name` | 0.253 | |
| `project × tool_name` | 0.236 | |
| `denial_kind × cwd` | 0.164 | |
| `tool_name × branch` | 0.140 | |
| `tool_name × cwd` | 0.127 | |

**`project × cwd` at 0.4995 is the number to argue with.** It is 0.0005 below the constant, so the
threshold decides it and the record cannot: a corpus with one more working directory, or a `cwd` that
drifts toward `project`, flips it to SUPPRESSED with nothing else changed. This is the near-miss the
suppression line's own promise — *"Determinism is reported for every pair below, so a near-miss can
be argued with"* — exists for, and it is the first such pair the shipped surface has produced.

### The temporal control, live

`asc stats tool_denial --assoc --temporal occurred_at:weekday --blocks occurred_at:day`. The weekday
is **now derived from the declared `occurred_at` timestamp** — the thing `dogfood/0064` said could not
be named — and the blocks are the 52 distinct days of the same clock. 500 iterations, the CLI's
`BLOCK_ITERATIONS`, seeded with the module's default.

```
Warning: the block control ran on every pair containing occurred_at:weekday:
those labels were permuted among the 52 distinct blocks of 'occurred_at:day'
over 500 iterations. A HIGH p_blocked means the observed association is inside
what the block structure alone manufactures.
```

| pair | observed χ² | null median | p95 | p_blocked |
|---|---|---|---|---|
| `project × occurred_at:weekday` | 551.61 | **802.13** | 951.17 | **1.000000** |
| `branch × occurred_at:weekday` | 422.93 | **608.98** | 746.10 | **0.994012** |
| `cwd × occurred_at:weekday` | 530.65 | **657.22** | 790.67 | **0.982036** |
| `denial_kind × occurred_at:weekday` | 257.25 | **416.32** | 544.88 | **0.976048** |
| `tool_name × occurred_at:weekday` | 159.22 | 135.76 | 183.40 | 0.183633 |

Against the snapshot's table above: `project` 0.9432 → **1.000000**, `repo`/`branch` 0.9594 →
**0.994012**, `denial_kind` 0.6225 → **0.976048**, `tool_name` 0.2667 → **0.183633**. **Four of the five sit below the null median**, against three of four before, and the one pair whose
observed value sits above the median is the same pair in both corpora — `tool_name × weekday` — which
remains the only weekday pairing the block structure does not explain either way.

The null medians are not printed by the command; they come from `node spike/h7nq-null-median.mjs`,
which imports `blockPermutationNull` from the built package and passes only the columns, so the seed
and iteration count are the shipped ones. **Its observed χ² and p_blocked reproduce the command's
table exactly** (551.61 / 1.000000, 422.93 / 0.994012, 530.65 / 0.982036, 257.25 / 0.976048,
159.22 / 0.183633), which is the check that the two runs are the same run.

### Correction 3 — "All four weekday pairings collapse" overstates its own table

The Amendment above says, in bold, *"**All four** weekday pairings collapse."* Its own table lists
`tool_name × weekday` at **p = 0.2667**, which is above 0.05 by any conventional level, so the
sentence claims more than the measurement supports. The paragraph's **next** sentence gets it right
— *"the observed statistic sits BELOW the null median in three of the four cases"* — and the live
re-run agrees with the table rather than the bold line: `tool_name × occurred_at:weekday` is
**0.183633**, still not significant, and still the only one of the five whose observed value is
**above** the null median.

The correction does not change the finding. Three weekday pairings collapse decisively in both
corpora, and `tool_name × weekday` was **never a finding** — it is an ARTIFACT row in the
2026-09-14 Amendment's own reconciliation. What the overstatement costs is precision about *why* the
actionable pair survives: `denial_kind × tool_name` survives the block control because **it has no
temporal column at all**, not because its weekday behaviour was tested and cleared.

The same overstatement, with a stronger claim attached, sat in `packages/analysis/src/association.ts`
— *"collapses EVERY weekday pair, and the observed statistic sits BELOW the null median in each
case"*, when `tool_name` is neither. That comment **also published twelve values**
(310.58 / 355.55 / 0.8594 and three more rows) that `spike/spike-controls.mjs` does not produce and
that `IMPLEMENTATION_PLAN.md:4377` already records as WRONG. Both are corrected in place and recorded
as `dogfood/0065`.

### The re-issued finding list, re-checked against the live store — and one thing it cannot classify

The three survivors the Amendment above names are **still the three survivors**, at larger n and with
the same ordering:

| pair | snapshot V | live V | live determinism | status |
|---|---|---|---|---|
| `denial_kind × project` | 0.465 | 0.536 | 0.465 | SURVIVES both controls |
| `denial_kind × branch` *(snapshot: `× repo`)* | 0.445 | 0.479 | 0.356 | SURVIVES both controls |
| `denial_kind × tool_name` | 0.343 | 0.227 | 0.253 | SURVIVES both controls |

The GO stands, on the same pair it stood on before: `denial_kind × tool_name`, which neither control
touches and which the 2026-09-14 Amendment names as the actionable one.

**What the live run adds is a column the snapshot's list never had, and it cannot say what to do with
it.** The snapshot's five dimensions were `denial_kind`, `tool_name`, `project`, `weekday`, `repo`;
the live store's are `denial_kind`, `tool_name`, `project`, `cwd`, `branch`, and `cwd` is new. **Six**
live pairs carry `p_adjusted` at or near zero and no temporal column, so **neither control applies to
any of them**. Three are the survivors named above; the other three are new to this corpus:

| pair | p_adjusted | determinism | the controls say |
|---|---|---|---|
| `project × cwd` | 0 | 0.499 | nothing — 0.0005 under the definitional threshold |
| `cwd × branch` | 0 | 0.372 | nothing — no temporal column |
| `denial_kind × cwd` | 2.96e-8 | 0.164 | nothing — no temporal column |

**The live invocation cannot classify these, and the reason is that the marginals control is not part
of it.** The 2026-09-14 reconciliation sorted SURVIVES from ARTIFACT OF MARGINALS with a
**shuffled** null (`permutationNull`); the shipped `--assoc` runs the definitional and block controls
and no shuffled one, because a `--permutations` flag is `asc-jpka`'s subject and was deliberately not
invented in `asc-h7nq` (`stats.ts:167`). Every live pair is additionally flagged
**`asymptotic_valid false`**, so the chi-square p-values above are approximations the run itself says
did not apply. The honest reading is therefore narrower than *"no new finding appears"*: **the three
named survivors are reproduced, and three live pairs are candidates the shipped surface neither
supports nor contradicts.** `denial_kind × cwd` is the one to look at first — `denial_kind` and
`cwd` are the two columns that survive everywhere else in this record.

### What this does not establish, stated plainly

- **The iteration count differs and the p-values are not directly comparable.** The snapshot's table
  used **5,000** iterations; the shipped command hard-codes **500**, because it runs while the user
  waits. At 500 the standard error of a p near 0.05 is about 0.01, which is enough to decide a
  collapse and not enough to quote a p to four decimals against a 5,000-iteration run. The two live
  values nearest any threshold — `tool_name` at 0.183633 and `project` at exactly 1.000000 — are the
  only ones where that matters, and neither is close to a decision.
- **The two corpora are not the same corpus.** This is not a re-run of the snapshot's measurement; it
  is a different 774 rows. Every difference between the two tables is confounded with corpus growth,
  and the one number *not* confounded with it — the 143-row day, identical in both — is the reason to
  believe the confound is real rather than a reason to believe any particular p moved.
- **The threshold is still corpus-specific**, and the live store now supplies the case that stresses
  it: `project × cwd` at 0.4995, which the constant decides by 0.0005. This record cannot say which
  way is right, only that a rule resting on a 0.0005 margin will fire differently on a corpus one
  directory different.
- **`repo` is still unformable, and for a reason the Amendment above mis-states.** The pair
  `project × repo` is not formable because **nothing writes `repo`** (`asc-mqgy`), not because no type
  declares it — the store's 774 entries carry `repo` null and `branch` populated on all of them. The
  live analogue of the snapshot's pair is `project × branch`, and the tautology the Amendment names
  is confirmed by it at 0.876.
- **The block null's variance may still be inflated by the single 143-row day**, and the live run
  strengthens the case for saying so rather than settling it: four of five observed values now sit
  below the null median, below a null whose blocks include a 143-row day out of 52.
- **The live run carries two controls where this record used three, so it cannot re-check the finding
  list on its own.** `permutationNull` — the marginals control that produced every SURVIVES/ARTIFACT
  verdict above — is not reachable from the command surface; that is `asc-jpka`, and it is why the
  section above reports candidates rather than verdicts. Every live pair is also flagged
  `asymptotic_valid false`.
- **The third control is still not built.** The pseudoreplication / effective-sample-size check the
  2026-09-14 Amendment names remains unmeasured, and is `asc-qt6r`.

---

## Amendment — 2026-10-06: the shuffled control's iteration count is 400, and the floor is 1/401 (asc-h3sv)

**What was wrong.** This record's **Method** (line 22) says the shuffled-label control ran
*"5,000 iterations, seeded"*, and its **Confidence** section (lines 156–157) draws a floor from that:
*"The 5,000-iteration control floors at p=0.0025 … at 5,000 iterations the smallest achievable p is
1/5001."* Both are wrong. The file this record names as its own method, `spike/spike-patterns.mjs`,
runs the shuffled control at **400**:

```
$ grep -n "iterations" spike/spike-patterns.mjs
86:      const nul = permutationNull(a, b, { iterations: 400, seed: 12345 });
```

That is the only `iterations:` literal in the file, and it has never been anything else:

```
$ git log -p --follow -- spike/spike-patterns.mjs | grep -n "iterations: [0-9]*"
145:+      const nul = permutationNull(a, b, { iterations: 400, seed: 12345 });
```

The line arrives in `2904153` ("E1 + E2: repo foundation and pure core") and is never revised. So
this is not a spike that drifted away from a record that was once right; the record was wrong when
it was written.

**Where the 5,000 came from, and why it looked right.** `spike/spike-controls.mjs:27` really does
define `const ITERATIONS = 5000;` — for the **block** control, which is a different null over a
different column and is what the 2026-10-05 Amendment's Correction 2 is about; that occurrence (line
293) is **correct and is not amended here**. The same file re-uses 400 for its own shuffled re-check
at `:256`. The record lifted one control's count and stated it as another's, and the two floors are
indistinguishable at the precision it quoted them: `1/401 = 0.0024937655860349127`, which is `0.0025`
to four decimal places — the exact figure the record prints. The sentence states `0.0025` **and**
`1/5001` in adjacent clauses, and those two numbers contradict each other.

**What the number actually is.** The floor of a permutation test whose p-value is `(ge + 1) /
(iterations + 1)` is `1/(N+1)`, so at 400 it is **1/401 = 0.0024937655860349127**. Every shuffled
p-value in this record's tables was therefore drawn against a null with 400 shuffles, and the smallest
value any of them could take is `0.0025`, not `0.0002`.

**What this does not change.** The **finding** stands, and the correction **strengthens** it. The
Confidence bullet's claim is that 14 "survivors" are not 14 independent discoveries, because nothing
here corrects for multiple comparisons. That is a statement about multiplicity, not about `N`, and a
floor **twelve times higher** than the record claimed leaves *less* room above it — so the warning the
bullet gives is more warranted after this correction, not less. The verdicts themselves are gated on
`pShuffled < 0.05`, and moving the floor from 0.0002 to 0.0025 moves no decision any table records.

**What is corrected going forward.** The command now prints the floor as arithmetic from the count
actually used rather than as a constant, so the two cannot be separated again:

```
Warning: the shuffled-label control ran on every pair at 400 iterations, so the
smallest empirical p it can report is 0.002494 = 1/(400+1).
```

`asc-jpka` shipped `--permutations N` on `asc stats --assoc` and `--correlate`, which makes the
shuffled control reachable from the command surface for the first time — this record's Confidence
bullet says the live run *"carries two controls where this record used three"*, and that is no longer
the case. `asc-jpka`'s own acceptance repeated the wrong count (*"EV-patterns measured a
5,000-iteration floor of p=0.0025"*); that sentence is left as written and this Amendment is what a
reader can reach.

**Filed as** `asc-h3sv` (P3). **Recorded as** `dogfood/0066`. The same pass found a second instance of
the same class in the same flag — the shuffled control's p depends on the caller's **row order**, which
no surface named — recorded as `dogfood/0067` (`asc-t0x8`).

## Amendment — 2026-10-07: the column this record calls `repo` is the git branch (asc-mqgy)

Every table above that names a `repo` dimension is measuring `git_branch`. The spike defines its `repo`
column as `COALESCE(git_branch, '(none)')` (`spike/spike-controls.mjs:51`), so the name in the record
and the column in the data were never the same field. Counted 2026-10-07 over the live store's 7,133
entries across all 13 registered types:

```
repo       nonnull    0   types 0
git_sha    nonnull    0   types 0
branch     nonnull 6860   types 6
cwd        nonnull 7133   types 13
```

`repo` and `git_sha` are the envelope's only two reserved names that no writer fills anywhere — `asc
record` declines to derive them, and the claude-code adapter's `Locality` is `{ cwd, branch }`
(`packages/adapter-claude-code/src/derive.ts`). So the headline row of the findings table, and
Correction 1's `project × repo` at 0.828, are both measurements of **`project × branch`**.

**What this does not change.** The finding stands, and it is stronger than when written. `asc-h7nq`
put `branch` on the command surface and measured that same pair through the store's own column:
`project × branch` sits at determinism **0.876**, above `DEFINITIONAL_AT`, and `asc stats tool_denial
--assoc` suppresses it as definitional without being asked. The 0.828 above comes from the frozen
2026-09-11 snapshot that every table in this record is measured on, while 0.876 is the live store,
which has grown since; the two are not expected to agree, and the gap is corpus drift rather than a
contradiction. What this Amendment fixes is the **name**, not the number — the tautology the record
identified is real, and it is read off `branch`.

**What is corrected going forward.** `repo` stays a nameable column on `asc stats --assoc`
(`LOCALITY_COLUMNS`, `packages/cli/src/stats-text.ts`) and stays `null` on every entry, because keeping
the name reserved is what stops a type declaring its own `repo` meaning something else. `asc-mqgy`
chose that over filling it (a `git` subprocess per record, and the CLI's own environment written into
durable entries) and over dropping it (reopening the collision `ENVELOPE_PROPERTY_NAMES` exists to
close); `packages/core/src/spec.ts` now states both the measurement and that choice where the
reservation is defined. The variance gate, not a hardcoded prune, is what keeps the empty column out
of a ranking.

**Recorded as** `dogfood/0064`, whose "How it happened" section already carries the spike's SQL. This
Amendment is what puts that fact into the record the numbers are read from.
