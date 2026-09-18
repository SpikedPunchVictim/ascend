# EV-11: what does the real corpus contain once ingested — the day-one dataset

> **Project identifiers were redacted after publication.** This repository is public. Private
> project, user and MCP-server names in this record were replaced with the stable pseudonyms used
> throughout `docs/evidence/` (`<user>`, `<org-B>`, `<project-A>` ..). The same pseudonym always
> means the same thing in every record, so every count and comparison below stays checkable. Only
> identifiers changed; no measured value was altered. The store behind these numbers was scrubbed
> to match — see `dogfood/0004-2026-09-18-the-corpus-records-identity.md`.


**Question**  `asc-sx7`'s accept is to run the ingest against the real corpus and report **N per
              type, date range, and per-field population rate** — "the day-one dataset for E6/E7".
              The three numbers are the deliverable; the question behind them is what in this
              dataset would **mislead** a profiler or an analysis that assumed a derived corpus
              looks like a hand-recorded one. E6 (`asc explore`) profiles a store; E7
              (`packages/analysis`) computes intervals and flags small groups. Both are built
              against these shapes, so the shapes had better be stated before they are assumed.

**Method**    A fresh empty store (`asc init` in a scratch directory), then
              `asc ingest claude-code` from that directory against the real `~/.claude/projects`
              — **read-only on the transcripts**, as `TASKS.md` requires. Ingest took **6,245 ms**
              and exited 0.

              The store was then read back with `node:sqlite` opened `readOnly: true`. Two
              deliberate choices in the census:

              - **The field list comes from the registered `spec_json`**, not from a list typed by
                hand. A census over a hand-typed list reports on my memory of the type rather than
                on the type the store actually enforced.
              - **Key existence uses `json_type(properties_json, '$.field')`**, which is `NULL`
                when the path is absent and `'null'` when the key exists holding a JSON null.
                `json_extract` collapses those two into one `NULL`, and that distinction is the
                entire reason this product has three states instead of two.

              Provenance was measured separately by sweeping the whole corpus twice with
              `streamCorpus` — **counts only, no prose**, so nothing from a transcript entered this
              document.

              Reproduce: `asc init` in a scratch dir, `asc ingest claude-code`, then query the
              store. The scratch store used here was `/tmp/sx7/corpus` and is not durable; the
              command is the durable artifact.

## Measurement

2026-09-15, `~/.claude/projects`, **844** transcript files, 0 malformed lines. The record count is
not one number: the corpus is live and it grew between every sweep taken for this document — the
ingest read **432,374** records, and three later measurement sweeps read **432,471** (twice) and
**432,496**. Each figure below is therefore "as measured at that moment", and the ratios are quoted
against the sweep they came from rather than against a single corpus size.

**Totals.** 1,491 entries, 1,491 distinct ids, 1 source value (`derived:claude-code`), 12 distinct
encoded projects, 34 distinct sessions, **41 distinct calendar days with data**. Date range
`2026-08-02T23:15:37.650Z` … `2026-09-15T17:54:58.656Z` — a span of **44 days**. Every entry shares
one `recorded_at`, which is one clock reading for the run, as designed.

**N per type, with date range and spread:**

| type | N | sessions | projects | first | last |
|---|---|---|---|---|---|
| `verification_run` | **486** | 26 | 10 | 2026-08-02 | 2026-09-15 |
| `tool_denial` | **457** | 23 | 10 | 2026-08-02 | 2026-09-15 |
| `context_compaction` | **441** | 24 | 11 | 2026-08-13 | 2026-09-15 |
| `skill_activation` | **87** | 21 | 11 | 2026-08-02 | 2026-09-14 |
| `user_correction` | **20** | 10 | 6 | 2026-08-10 | 2026-09-12 |

**Per-field population rate.** Every declared property of every registered type was censused.
`na` is **0 for every field of every derived type** — all 1,491 entries. So the table below is
measured / unmeasured only.

| type | property | measured | % | unmeasured | % |
|---|---|---|---|---|---|
| `tool_denial` (457) | `denial_kind` | 457 | 100.0 | 0 | 0.0 |
| | `tool_name` | 457 | 100.0 | 0 | 0.0 |
| | `tool_use_id` | 457 | 100.0 | 0 | 0.0 |
| | `session_id`, `project`, `occurred_at` | 457 each | 100.0 | 0 | 0.0 |
| `context_compaction` (441) | `trigger` | 441 | 100.0 | 0 | 0.0 |
| | `pre_tokens` | 441 | 100.0 | 0 | 0.0 |
| | `post_tokens` | 441 | 100.0 | 0 | 0.0 |
| | `cumulative_dropped_tokens` | 441 | 100.0 | 0 | 0.0 |
| | `duration_ms` | 441 | 100.0 | 0 | 0.0 |
| | **`discovered_tools`** | **283** | **64.2** | **158** | **35.8** |
| | `session_id`, `project`, `occurred_at` | 441 each | 100.0 | 0 | 0.0 |
| `verification_run` (486) | `runner` | 486 | 100.0 | 0 | 0.0 |
| | `verdict` | 486 | 100.0 | 0 | 0.0 |
| | **`previous_verdict`** | **134** | **27.6** | **352** | **72.4** |
| | `session_id`, `project`, `occurred_at` | 486 each | 100.0 | 0 | 0.0 |
| `skill_activation` (87) | `skill` | 87 | 100.0 | 0 | 0.0 |
| | **`agent`** | **51** | **58.6** | **36** | **41.4** |
| | `session_id`, `project`, `occurred_at` | 87 each | 100.0 | 0 | 0.0 |
| `user_correction` (20) | `tool_name` | 20 | 100.0 | 0 | 0.0 |
| | `session_id`, `project`, `occurred_at` | 20 each | 100.0 | 0 | 0.0 |

**Envelope columns across all 1,491 entries:**

| column | populated |
|---|---|
| `run_id`, `workflow`, `actor`, `cwd`, `repo`, `git_sha`, `branch` | **0** |
| `evidence_text` | **20** — exactly the `user_correction` rows, and no others |

**Value cardinality, for the top-K and enum work E6/E7 will do:**

| field | distinct | top values |
|---|---|---|
| `tool_denial.denial_kind` | 4 | `permission-rule` 228, `user-rejected` 160, `automode-unavailable` 39, `automode-blocked` 30 |
| `tool_denial.tool_name` | 11 | `Bash` 412, `AskUserQuestion` 13, `Write` 12, `ExitPlanMode` 11 |
| `context_compaction.trigger` | 2 | `auto` 361, `manual` 80 |
| `verification_run.verdict` | 2 | `passed` 419, `failed` 67 |
| `verification_run.previous_verdict` | 2 | `passed` 67, `failed` 67 |
| `skill_activation.skill` | 12 | `fullstack-dev-skills:the-fool` 26, `<org-B>` 18, `empirical-planning` 15, `bug-hunt` 12 |
| `skill_activation.agent` | 2 | `general-purpose` 34, `Explore` 17 |
| `user_correction.tool_name` | 3 | `AskUserQuestion` 11, `ExitPlanMode` 8, `Bash` 1 |

**Provenance, measured over the whole corpus (counts only):**

| | |
|---|---|
| records carrying a string `cwd` | 340,137 / 432,471 — **78.6%** |
| records carrying `gitBranch` | the same 340,137 — the two co-occur exactly |
| distinct **real** `cwd` values | **282** |
| distinct encoded project labels in the corpus | **15** |
| distinct `gitBranch` values | 15, including `HEAD` and real feature branches |
| records that **trigger** a derived event, carrying `cwd` | **100%** — `toolDenialKind` 457/457, `compactMetadata` 441/441, `userFeedback` 20/20, `attributionSkill` 6,395/6,395, `attributionAgent` 69,698/69,698 |

## Decision

Five things E6 and E7 must be built against, each of which would otherwise be discovered as a bug:

1. **The corpus is 44 days deep, not the "two years" `derived-types.ts:69` assumes.** The comment
   reads *"during a backfill of two years of transcripts"*; the measured span is 2026-08-02 to
   2026-09-15. That is a **~17×** overestimate, and it is load-bearing for E7: CUSUM changepoint
   detection over 41 days of data is a very different proposition from over two years. The prose
   needs correcting, and E7's changepoint work should be sized against days, not years.

2. **`na` is never used by a derived type.** 0 across all 1,491 entries and every declared property.
   The three-state model's middle state is exercised by `asc record`, not by the adapter. An
   `asc explore` profile reporting an N/A ratio of 0.0% everywhere for a derived corpus is
   **correct, not broken** — and a test that expects a non-zero `na` share would be wrong.

3. **Three fields are unmeasured *structurally*, not at random.** `previous_verdict` (72.4%
   absent), `discovered_tools` (35.8%), `agent` (41.4%). `previous_verdict` is the sharp one: the
   deriver emits only on a verdict **change** or a first verified pass, so its absence means *"this
   was a first verified pass"*, not *"unknown"*. The 134 present values split exactly 67 / 67
   `passed` / `failed` — i.e. 67 failed→passed and 67 passed→failed transitions. **This is
   informative missingness**: any analysis that drops nulls or imputes a value will bias its own
   answer, and E7's min-N flagging cannot treat these three as ordinary sparse fields.

4. **No derived entry carries envelope provenance, and the only locality signal is lossy.** `cwd`,
   `repo`, `git_sha`, `branch`, `run_id`, `workflow`, `actor` are 0 / 1,491. The `project` property
   is Claude Code's **encoded directory name**, which collapses **282 distinct real working
   directories into 15 labels** — the largest project in the corpus is 115 distinct real `cwd`
   values reported as one. And the true `cwd` and `gitBranch` are on **100% of the records that
   trigger every derived event**, so this is a copy that is not being made, not data that is
   missing. Filed as `asc-5hs`. Until it lands, no E6/E7 question of the form "in which project"
   or "on which branch" is answerable.

5. **Volume is lopsided, and E7's small-group flagging is not a formality.** Three types sit at
   441–486; `skill_activation` is at 87 and `user_correction` at 20. `user_correction` is already
   documented (EV-9, and in the type's own description) as **not an independent corpus** — it
   derives from the same events as the others. So the corpus supports three types at a workable N,
   one at N=87, and one that should not be presented as a type with a rate at all.

## Confidence

**High** on N per type, the date range, and the census: one command, read straight back out of the
store, and the field list taken from the store's own registered definitions rather than typed by
hand. **High** on the provenance counts — a whole-corpus sweep, and the trigger-record figure is
100% / 100% / 100%, which is not a figure a sampling artifact produces.

**One limitation, stated plainly: this is one person's corpus, and it is a dated measurement, not a
constant.** `~/.claude/projects` is **live** — it grew during this session, from 432,011 to 432,374
to 432,471 to 432,496 records across the sweeps taken on the same day, and the derived N moved with
it (1,488 → 1,489 → 1,491). Every number here should be read as "measured 2026-09-15", and none
should be hardcoded as an expectation. **n = 1 corpus**: these rates describe how one person works,
and nothing here generalizes to another user's corpus.

A second limitation, which matters for how this document should be used: the census reports what the
**deriver** produced, so it describes the deriver as much as the corpus. Change a rule and the
population rates change with it — `previous_verdict`'s 27.6% is a property of the emit-on-change
rule, not of the underlying workflow. This document is an oracle for E6 only in the sense that
`asc explore`, run against a store built by **this** ingest, should reproduce these numbers; it is
not a claim about what transcripts contain.

## What this overturned

Three figures that were carried as facts and are wrong:

- **"A backfill of two years"** (`derived-types.ts:69`) — the corpus is 44 days. The reasoning the
  comment supports is still right (the envelope's `recorded_at` genuinely is not the event time),
  but the scale it argues from is off by ~17×.
- **The ~16.6k-entry backfill priced in `EV-write-cost.md:58`** — the real yield is **1,491**, about
  **11× smaller**. That figure came from the loosest of the five `verification_run` rules considered
  in EV-9, before the rule was chosen. The decision it supports is unaffected and in fact
  conservative — the index-set trade was priced at 11× the volume it will ever see — but the number
  should not be reused as an estimate of backfill size.

- **The "829 real transcripts" pointer, in `ARCHITECTURE.md`, `KICKOFF.md`, `TASKS.md` and
  `EV-write-cost.md`** — and in six open beads. The directory holds **844** transcript files as of
  2026-09-15, and it grew during this session by the same mechanism as the record count above. One
  live directory has now been observed at **809, then 829, then 844**; each was true on its date and
  every one of them is a false statement today. The pointers were changed to name the directory
  without a count. A count describing a growing thing belongs in a dated measurement — which is what
  this document is — and not in prose that depends on it being accurate.

And one assumption worth naming, because it was never stated: that a derived corpus resembles a
hand-recorded one. It does not. A hand-recorded corpus would carry `na` values, plausible
provenance, and a history long enough to have a trend in it. This one has **none of the three** —
which is exactly why this document had to exist before E6 was built, rather than after.
