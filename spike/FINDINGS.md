# Stage 0 spike — findings and verdict

**Status:** CLOSED. **Verdict: GO-WITH-CHANGES.**
**Date:** 2026-09-11 · **Corpus:** 809 real transcripts / 388,054 lines / 1.14 GB, read-only.

This is the gate. No task in E2 or later starts until this document closes with a recorded verdict.

Six empirical questions were named **before** running, each producing a full EV record in
`docs/evidence/`. The spike code is throwaway and quarantined in `spike/` — it is not the
foundation, and it is deleted or archived at E1.

| Question | Record | Verdict |
|---|---|---|
| Can an entry type be extracted at N in the hundreds? | [`EV-corpus.md`](../docs/evidence/EV-corpus.md) | **GO** — N=409 |
| Do independently-authored type definitions converge? | [`EV-drift.md`](../docs/evidence/EV-drift.md) | **GO-WITH-CHANGES** — they do not |
| Do patterns emerge at single-user volume? | [`EV-patterns.md`](../docs/evidence/EV-patterns.md) | **GO** — 14/16 survive |
| Which storage shape carries runtime-defined types? | [`EV-storage.md`](../docs/evidence/EV-storage.md) | **GO-WITH-CHANGES** — needs index emission |
| Which FTS5 tokenizer for prose? | [`EV-fts.md`](../docs/evidence/EV-fts.md) | **GO-WITH-CHANGES** — trigram, not inherited |
| Is oclif + `node:sqlite` acceptable? | [`EV-runtime.md`](../docs/evidence/EV-runtime.md) | **GO** — both confirmed |

---

## The verdict: GO-WITH-CHANGES

**Build it.** Every question that could have killed the project came back survivable, and the
central premise — the one the whole thing rests on — is confirmed on real data.

**But four decisions in `ARCHITECTURE.md` are overturned or incomplete, and three of them are
load-bearing.** They are listed below with the numbers that decided them.

---

## What the evidence overturned

### 1. The bounded vocabulary does not control type drift (load-bearing)

`ARCHITECTURE.md` controls drift with a bounded property vocabulary, on the assumption that
constraining the *types* makes independently-authored definitions of the same concept converge.

**Five independent specs, one brief, one type name → 44 distinct property names, of which 4 are
shared. Intersection/union 9.1 %. Mean pairwise Jaccard 0.300.** Naming convention split 3 snake_case
vs 2 camelCase, so `review_kind` and `reviewKind` coexist as different properties. One author marked
all 14 properties `required`. `outcome` had 9 enum values across specs and 2 in common.

The vocabulary is necessary but **not sufficient**. Define-time canonicalization must be added to E2:
name normalization, a registry-level canonical property vocabulary, enum canonicalization, and a
`required` sanity rule. `asc-types-dedupe` is currently specified from the assumption that drift is
mild; it needs to be strict, and `asc-spec-types` needs the canonicalization layer the architecture
does not currently describe.

*Limitation:* this proves convergence fails without the mechanisms. It does not prove the four
proposed remedies fix it — that needs re-running the same five-author experiment **with**
canonicalization active.

### 2. The generated view alone is not fast enough; the registry must emit indexes (load-bearing)

`ARCHITECTURE.md` specifies a generated per-type view projecting `json_extract` into typed columns,
and is **silent on indexing**. Measured at 250k rows: the unindexed view is **3.10× slower** than a
per-type table and **superlinear** (2.5× the rows → 4.04× the latency).

**The obvious index is worse than none.** A bare expression index
`(json_extract(prop))` cannot carry the `type_name` predicate, so SQLite scans the entire index: the
crosstab went from 231.0 ms to 239.1 ms.

**A composite covering index `(type_name, prop1, prop2)` reverses it: 206.1 ms against the per-type
table's 217.1 ms — shape A *wins*.** So the shape is right, but the registry must emit composite
expression indexes as part of type registration, and the architecture must say so.

Also corrected: **`ALTER TABLE ADD COLUMN ... STORED` is rejected at one row or more** (accepted only
on a zero-row table), so the generated-column path is closed on a populated corpus. Only `VIRTUAL`
generated columns (0.2 ms, metadata-only) and expression indexes are available at runtime.

### 3. `trigram` is confirmed — but for the opposite reason to mast's (load-bearing)

KICKOFF.md warns against inheriting mast's trigram choice by assumption, since mast tuned it for
*code identifiers* while ascend indexes *prose*. **The measurement says ascend should use trigram
anyway — and that the prose argument for a word-based tokenizer does not hold.**

On common whole words all three arms tie (98–100 % precision, 100 % coverage). There is **no
measurable prose penalty** to trigram. The arms separate on **partial tokens**: `unicode61` and
`porter` fail to retrieve a single correct document for **40 % of query terms** (coverage 60 %) where
`trigram` gets **100 %**. A search that silently returns nothing is indistinguishable from "no such
entry exists" — disqualifying for an agent-facing query.

`unicode61` is **rejected as dominated**. `porter` goes to the Design Reserve (its win is confined to
stem-changing inflections: `configuring` 2 → 173 documents).

### 4. `toFtsMatch` is mandatory, and a naive port is not sufficient

**8 of 14 realistic queries (57 %) throw a raw SQL error against `MATCH`** — `unterminated string`,
`no such column: bar` — from ordinary input like `"unbalanced quote`, `foo -bar`, `col:value`,
`C++ templates`. The sanitizer port is a hard requirement, confirmed on real data.

And the obvious implementation fails: wrapping the whole query in one quoted phrase throws 0/14 but
**returns empty for 9–13 of the 14**. That trades a crash for a silent zero-result, which the same
measurement shows is the worse failure. `toFtsMatch` must **tokenize into terms and build a
disjunction**.

---

## What the evidence confirmed

- **The central premise holds.** 14 of 16 candidate associations survive the shuffled control, and an
  actionable pattern emerges that no single entry reveals: **Bash is 92.7 % of all denials (95 % CI
  89.7–94.8 %, n=409); within Bash, `permission-rule` is 58.6 % (222/379) while every non-Bash tool
  is 100 % `user-rejected` (AskUserQuestion 12/12, ExitPlanMode 11/11).** Permission-rule denials mean
  a missing allowlist entry, not a user disagreement — the action is `Bash(<prefix>:*)` entries,
  exactly what `ARCHITECTURE.md` prescribes. The corpus shows the *kind* of fix and its *scope*.

- **The shuffled control earns its place, decisively.** `tool_name × project` scores
  **χ²=153.11, p=8.61e-8** asymptotically — a result any conventional analysis would report as a
  strong finding. Its shuffled p is **0.1272**: it is an artifact of the marginals. **Without the
  control, ascend would have shipped a false finding carrying a p-value below 1e-7.**

- **Shapes A and C survive; EAV is eliminated.** EAV is no faster than JSON+views and costs **3.2×
  the SQL** (a two-property filter is a 5-line self-join).

- **oclif is fast enough as-is.** p50 123 ms / **p95 169 ms** against a bare-node 59/72 ms (2.10×
  overhead), inside the 300 ms threshold — so the "fast path for `record`" escape hatch stays in the
  Design Reserve, unbuilt. **`node:sqlite` beats `better-sqlite3`** at 1,201,616 vs 988,435 rows/sec
  *and* needs no native dependency, so the engine choice is confirmed on the merits.

- **Streaming works.** 1.14 GB read at **213 MB peak RSS** in 11.2 s.

---

## Required changes, with owners

| # | Change | Task affected |
|---|---|---|
| 1 | Define-time canonicalization: name normalization, canonical property vocabulary, enum canonicalization, `required` sanity rule | `asc-spec-types`, `asc-types-dedupe` |
| 2 | Registry emits composite expression indexes `(type_name, json_extract(prop))` per type; covering indexes for known query shapes | `asc-store-views`, `asc-types-define` |
| 3 | `trigram` for `evidence_text`; `porter` in reserve with a named promotion condition | `asc-fts` |
| 4 | `toFtsMatch` port must be term-based; E3 test asserts zero throws **and** non-empty results | `asc-fts` |
| 5 | E7 adds a **tautology check** and a **temporal-block control** (see below) | `asc-analysis-*` |

**Change 5 needs its own justification**, because it comes from this spike's failures rather than its
successes. The shuffled control has **two blind spots the spike demonstrated but did not solve**:

- **Tautologies.** `project × repo` scores **V=0.761** — the strongest association in the corpus — and
  *survives* the control. It is definitional (a project path determines its repo). Shuffling destroys
  the identity and the result still looks significant.
- **Temporal confounds.** The "Thursday 41.1 %" result is one burst: **2026-09-03 alone is 143 of 409
  denials (35 % of the corpus)**, across 35 distinct days. `project × weekday` and
  `skill_name × weekday` are largely "which sprint happened when".

I found both **by hand, after the fact**. The tooling surfaced neither. The two controls proposed to
catch them are **untested designs, not measured remedies.**

---

## Findings that are not verdicts, but change expectations

- **`user-correction` is N=20, not the hundreds the plan assumed.** It was expected to be a second
  corpus. It is not independent: all 20 are a subset of the denial records (every one carries a
  `toolDenialKind` sibling), so it cannot corroborate anything from `tool-denial`. Register the type
  — but do not budget on it as a second source of evidence for the same events.

- **`HANDOFF.md` does not exist.** The kickoff document in the repo is `KICKOFF.md`; that is what was
  read and followed. Verified: `ls HANDOFF.md` → no such file.

- **`automode-*` denials (24 of 409) are a distinct population** — they mean the auto-mode classifier
  rather than a permission rule — and were conflated with the rest in the EV-3 profile.

- **Every finding here is n=1** — one user, one machine, one corpus. The "n ≥ 2" test is not met and
  cannot be met until a second corpus exists. This is the largest unaddressed risk in the project.

---

## A false green found in this spike's own harness

Reported here rather than buried, because it is the failure class the methodology ranks
severity-zero: an earlier revision of `spike/storage-indexing.mjs` recorded
*"ALTER TABLE ADD COLUMN ... STORED is ACCEPTED at runtime"* at **0.26 ms**, as the registration cost
of the generated-column path.

**Both numbers were wrong.** The ALTER ran against a table that had just been dropped and recreated —
zero rows — and the timing was measured with `VIRTUAL`, not `STORED`. On any populated table `STORED`
is rejected outright. The test had exercised the one condition that cannot occur in production and
reported it as a general property of the design.

Corrected in `EV-storage.md`; caught only because a *different* experiment (the composite-index test)
happened to re-run the same ALTER on a populated table. **Invariant adopted for E2+: any measurement
of a runtime registration path must assert the store is populated before measuring.**

---

## Limitations of this stage as a whole

- **Six questions, n=1 corpus each**, all dated 2026-09-11. Nothing here generalizes beyond this
  machine, this user, and this nine-week window.
- **The spike never touched a real model.** Type registration, `asc record`, and the analysis layer
  were exercised as *measurements over real data*, not as *running code paths*. The end-to-end flow —
  an LLM registering a type, recording against it, and a human querying the result — **has not been
  driven once.** That is the flagship capability and it remains unproven live.
- **Only categorical association was tested.** The lexical clustering, FP-growth, CUSUM/Pettitt,
  near-duplicate and Cohen's-kappa machinery in `ARCHITECTURE.md` is entirely unexercised.
- **The storage and FTS numbers were measured at 250k rows and 40k documents** — three orders of
  magnitude above the stated use case ("hundreds of entries"), to prove nothing falls over. At the
  design's own scale every variant is single-digit milliseconds and these choices are settled by the
  DDL and capability arguments, not by the timings.
- **The spike is throwaway.** `spike/` is not the foundation; its numbers are evidence, not code to
  promote.

---

## Verdict

**GO-WITH-CHANGES.**

The premise holds, the design survives contact with real data, and four corrections are required
before E2 begins — three of them load-bearing. The corpus is real, the pattern is actionable, the
false-positive control works, and the one mechanism that would have quietly reported a spurious
finding at p<1e-7 is doing its job.

The thing to watch is not any single measurement above. It is that **the flagship end-to-end flow has
never run live**, and that **every number here is n=1**.

---

## Post-gate records

This document is the **closed** Stage 0 gate: six questions named *before* the spike ran, each with a
verdict. Nothing above it has been edited since it closed. Records produced **after** the gate are
listed here instead, so the gate keeps its meaning as a record of what was asked in advance.

| Question | Record | When | Verdict |
|---|---|---|---|
| What does one composite expression index per property cost the WRITE path? | [`EV-write-cost.md`](../docs/evidence/EV-write-cost.md) | E3 | **GO** — emit uncapped; the cost is disk (2.1×), not time |

**EV-8 was named during E3, not during the spike.** `EV-4` explicitly left the write side of its own
index rule *unmeasured* — "how many indexes to emit, and whether index count degrades the write path"
— and E3 was about to implement that rule. It is recorded here rather than retro-fitted into the
gate's table, because adding a question to a table of "questions named before running" after the fact
would make the gate report a rigour it did not have. The same distinction applies to any future
post-gate record.
