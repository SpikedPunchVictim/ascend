# `ascend` — Build Task Breakdown

Companion to `ARCHITECTURE.md` (in the repo). That document is **what** to build and **why**.
This one is **the work**, ordered, with acceptance criteria and required empirical proofs.

Handing target: a fresh agent with no memory of the design conversation. Read `ARCHITECTURE.md`
first; it is the source of truth for every design decision. This file never overrides it.

---

## Rules of engagement (non-negotiable)

1. **Empirical before assertive.** Any decision that can be settled by running something MUST be
   settled by running it. See "Empirical protocol" below. A task tagged **[EMPIRICAL]** is not done
   until its measurement exists in `spike/FINDINGS.md` or `docs/evidence/`.
2. **Never invent a number.** Every measurable claim in a commit message, doc, or task note carries
   the measured value and how it was obtained. "Faster" is not a finding; "180ms -> 24ms, n=50" is.
3. **Stage 0 gates everything.** Do not start E2 until `asc-spike-findings` is closed with a
   recorded GO/NO-GO. A NO-GO on pattern emergence or recording rate changes the project.
4. **Three attempts, then stop** (per the global `CLAUDE.md`): document what was tried, the exact
   error text, and why it failed; then reassess rather than attempt #4.
5. **Every commit compiles and passes tests.** No `--no-verify`. No disabled tests.
6. **Core stays pure.** `packages/core` and `packages/analysis` have zero `fs`, zero `Date.now()`,
   zero network. Time and IDs are injected. A test enforces this, and so does `align check` --
   `align` is installed locally as a devDependency (`./node_modules/.bin/align`). See
   `asc-align-rules`.
7. **Omitted, never fabricated.** When a value does not exist, omit it. Never write `0` for unknown.
   This is the single most expensive mistake available (see ARCHITECTURE.md, three states).
8. **Dogfood from the moment it runs.** See "Dogfooding" below.
9. **Update `IMPLEMENTATION_PLAN.md`** stage status as you go; delete it when all stages are done.

---

## Empirical protocol

Every **[EMPIRICAL]** task produces a numbered evidence record, committed, in this exact shape:

```markdown
### EV-<n>: <question being decided>
**Question**    One sentence. The decision that hangs on it.
**Method**      What was run, against what data, how many times. Real data, not toy fixtures.
**Measurement** The numbers. Raw, with n. Include the losing arm's numbers too.
**Decision**    What was chosen, and the threshold that decided it.
**Confidence**  What this does NOT establish. Limitations stated plainly.
```

Rules:
- **Name the questions before running.** An experiment that decides its own question post hoc proves
  nothing.
- **Run against real data**: the 829 real transcripts in `~/.claude/projects/`, a real model, the
  real CLI. Not a fixture you control. Read-only on the transcripts -- never write there.
- **Report the losing arm.** A bake-off with one reported number is not a bake-off.
- **A negative result is a successful task.** If the measurement kills the design, that is the task
  succeeding. Say so plainly and stop.

---

## Dogfooding directive

ascend records its own construction, starting the moment `asc record` works (E4).

- On close of `asc-record`, immediately run `asc init` in the repo and define the build entry types
  (`asc-dogfood-types`).
- From then on, **every** task closed records entries: at minimum a `stage-transition`, plus a
  `stuck-event` whenever the 3-attempt rule fires and a `decision` for each non-obvious choice.
- Every **[EMPIRICAL]** task additionally records its evidence record as an entry.
- This makes ascend's own build the first corpus, and `asc-dogfood-analysis` (E11) the first real
  test of the analysis layer against data nobody manufactured for it.

If recording during the build feels expensive, that is a finding -- record it as a `stuck-event` and
raise it. Recording friction is a first-class risk in ARCHITECTURE.md.

---

## Epics

| Epic | Title | Gate |
|---|---|---|
| **E0** | Empirical spike (throwaway) | gates everything |
| **E1** | Repo foundation | after E0 GO |
| **E2** | Core -- spec, zod, hashing (pure) | after E1 |
| **E3** | Store -- SQLite, views, FTS5 | after E2 |
| **E4** | CLI -- oclif, record, query | after E3 -> **dogfooding starts** |
| **E5** | Adapter -- Claude Code transcripts | after E4 |
| **E6** | Explore -- LLM-consumable access | after E5 |
| **E7** | Analysis -- statistical layer (pure) | parallel with E6 |
| **E8** | Annotation + rule classification | after E6, E7 |
| **E9** | Doctor + cross-project | after E8 |
| **E10** | Skill, slash command, recall hook | after E8 |
| **E11** | Dogfood analysis | last |

---

## E0 -- Empirical spike (throwaway, quarantined)

Purpose: answer the questions that could invalidate the design, before building the design.
All of E0 lives in `spike/` and is **deleted or archived** at E1. It is not the foundation.
Throwaway quality is allowed here; throwaway *honesty* is not.

**asc-spike-setup** - task - P0
Create `spike/` with a scratch SQLite DB and read-only helpers for `~/.claude/projects/*.jsonl`.
Never write to the transcript directory.
*Accept*: a script can stream all 829 transcripts without loading them into memory.

**asc-spike-corpus** - task - P0 - deps: spike-setup - **[EMPIRICAL]**
*Question*: Can a single entry type be extracted from existing transcripts at N in the hundreds?
*Method*: extract `userFeedback` (user corrections) and `toolDenialKind` events across all projects.
*Measure*: N per candidate type, per project and total; date range; field-population rate.
*Decision*: pick the highest-N candidate as the corpus for `asc-spike-patterns`.

**asc-spike-patterns** - task - P0 - deps: spike-corpus - **[EMPIRICAL]** - **GO/NO-GO**
*Question*: At that N, does an actionable pattern actually emerge, or is it noise?
*Method*: profile the corpus, group by every available dimension, read a stratified sample by hand.
*Measure*: Do any groupings show a concentration a human would act on? State the concentration with
a Wilson interval. Compare against a shuffled-label control -- if the "pattern" survives shuffling,
it is an artifact.
*Decision*: **This is the project's central premise.** If no actionable pattern emerges at realistic
single-user volume, say so and stop. Do not proceed to E2 on a negative without raising it.

**asc-spike-drift** - task - P0 - deps: spike-setup - **[EMPIRICAL]**
*Question*: Does LLM-authored type definition actually drift?
*Method*: in 5 independent sessions (no shared context), ask a model to define a `review-completed`
entry type against the same one-paragraph brief. Diff the resulting specs.
*Measure*: property-name overlap, type disagreements, cardinality of the union vs intersection.
*Decision*: sets how strict `asc-types-dedupe` must be, and whether the bounded vocabulary is
sufficient or needs to shrink further.

**asc-spike-storage** - task - P1 - deps: spike-setup - **[EMPIRICAL]**
*Question*: JSON + generated views, EAV, or per-type tables?
*Method*: build all three against the spike corpus at N=10k synthetic + real entries. Run five
realistic ad-hoc analysis queries against each.
*Measure*: query latency, query authoring ergonomics (line count, whether the query is writable
without reading the schema), schema-change cost.
*Decision*: ARCHITECTURE.md proposes JSON + views. **Confirm or overturn it with numbers.**

**asc-spike-fts** - task - P1 - deps: spike-corpus - **[EMPIRICAL]**
*Question*: Which FTS5 tokenizer for prose `evidence_text`?
*Method*: mast uses trigram, but on **code**. Test trigram vs `unicode61` vs `porter` against the
real prose corpus with 15 realistic search queries.
*Measure*: precision@10 against hand-judged relevance, index size, query latency.
*Decision*: do not inherit mast's choice by assumption -- it was tuned for identifiers.

**asc-spike-runtime** - task - P2 - deps: spike-setup - **[EMPIRICAL]**
*Question*: What does `asc record` cost, and is oclif acceptable?
*Method*: measure oclif cold start (n=50) vs a bare Node script; measure `node:sqlite` vs
`better-sqlite3` insert throughput.
*Measure*: p50/p95 cold start in ms; inserts/sec; dependency count.
*Decision*: if oclif cold start exceeds ~300ms p95, specify a fast path for `record` only.
ARCHITECTURE.md assumes `node:sqlite` needs no native dep -- confirm.

**asc-spike-findings** - task - P0 - deps: all spike tasks - **GATE**
Write `spike/FINDINGS.md` containing every EV record. End with an explicit **GO / NO-GO /
GO-WITH-CHANGES** and the list of ARCHITECTURE.md decisions the evidence overturned.
*Accept*: no task in E2+ starts until this is closed.

---

## E1 -- Repo foundation

**asc-rename** - chore - P0 -- Rename the project directory to `ascend`. Verify beads still
resolves (`bd where`, `bd status`) -- config was checked to contain no absolute paths, confirm.

**asc-workspace** - task - P0 - deps: rename -- pnpm workspace, TypeScript strict, Vitest,
lint/format. Packages: `core`, `store`, `analysis`, `cli`, `adapter-claude-code`. Node >=22.
*Accept*: `pnpm build && pnpm test && pnpm lint` green on an empty skeleton.

**asc-align-rules** - task - P1 - deps: workspace -- wire **align** as the conformance oracle.
`align` is installed locally (`./node_modules/.bin/align`, `@spikedpunch/align-cli@0.2.1`). Turn the
purity rules from prose into machine-checked rules: `core`/`analysis` import no `fs`, no
`node:sqlite`, no network; `cli` is imported by nothing; `store` is the only package touching SQLite.
Run `align init` once `packages/` exists, commit `align.config.ts`, seed the baseline **at zero** --
this is greenfield, there is no legacy debt to tolerate.
*Accept*: `align check` exits 0, and it runs in the pre-commit gate. If align and the hand-written
purity test (`asc-core-purity`) disagree, one of them is wrong -- resolve it, don't paper over it.

**asc-mast-index** - chore - P2 - deps: workspace -- run `mast init .` (`./node_modules/.bin/mast`,
`@spikedpunch/mast@0.3.0`) so declaration-exact search works across five packages instead of `grep`
fan-out. Re-index as the tree grows. `.mast/` goes in `.gitignore`.
*Gotcha*: mast needs a compiled `better-sqlite3` binding and `pnpm rebuild better-sqlite3` is a
silent no-op here -- run `prebuild-install` from inside
`node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3`. Native-build allowances live in
`pnpm-workspace.yaml`; pnpm 11 ignores the `pnpm` field in `package.json`.
**Do not inherit mast's trigram tokenizer** -- it was tuned for code identifiers (see `asc-spike-fts`).

**asc-quality-gates** - task - P1 - deps: workspace -- pre-commit hook running typecheck + test +
lint. Never bypassed.

**asc-impl-plan** - chore - P1 - deps: workspace -- create `IMPLEMENTATION_PLAN.md` with the stage
table from ARCHITECTURE.md, status tracked as work proceeds.

---

## E2 -- Core (pure, no I/O)

**asc-spec-types** - task - P0 - deps: asc-spike-findings, asc-workspace
The declarative property spec. Bounded vocabulary: `string | number | integer | boolean | enum |
timestamp | duration | ref | text`. Fields: `name`, `type`, `required`, `enum_values`,
`description`, `unit`. **Narrow it further if `asc-spike-drift` says to.**

**asc-build-schema** - task - P0 - deps: spec-types -- `buildSchema(spec) -> ZodType`.
*Accept*: every vocabulary type round-trips; unknown property rejected; zod is never stored, only
constructed.
*Tests*: one per property type, plus required/optional interaction.

**asc-type-hash** - task - P0 - deps: spec-types -- canonical serialization + `type_hash`.
*Accept*: hash is stable across key order and whitespace; any semantic change changes it.

**asc-three-state** - task - P0 - deps: spec-types -- measured / not-applicable / not-measured
encoding.
*Accept*: all three round-trip distinctly. `required` means "must have a decision" -- a value **or**
an explicit N/A. A required property left silently absent is an error.
*Tests*: the lost-distinction failure mode -- a real `0` and a not-applicable must never compare equal.

**asc-validation-errors** - task - P0 - deps: build-schema -- compact, prescriptive errors.
*Accept*: output names the offending field, its expected type, and a corrected command. Zod's raw
issue tree is never surfaced. Target: under 5 lines for a single-field error.

**asc-version-policy** - task - P1 - deps: type-hash -- classify a spec diff as minor (optional
property added) or major (retype / remove / newly required).
*Accept*: given two specs, returns the bump and the reason.

**asc-core-purity** - task - P0 - deps: workspace -- test asserting no `fs`, `Date.now`,
`Math.random`, or network import in `core`/`analysis`. Mirrors align's `network-abstinence.test.ts`.

---

## E3 -- Store

**asc-schema** - task - P0 - deps: E2 -- SQLite schema per ARCHITECTURE.md, WAL, `busy_timeout`,
migrations, `schema_version`. **No empty-string sentinels** -- `''` in a column that also holds a
foreign key is matched by SQLite as a real value.

**asc-registry** - task - P0 - deps: schema -- immutable versioned type rows. A shape change inserts;
it never updates.
*Tests*: attempting to mutate an existing version fails.

**asc-recorder** - task - P0 - deps: schema, three-state -- the single write path. Builds the
envelope; nothing else may write an entry. Time and IDs injected.

**asc-views** - task - P0 - deps: registry -- generated `v_<type>_v<major>` views projecting
`json_extract` into typed columns, plus a `<prop>_state` column per property. Views union across
minor versions; never across majors.

**asc-fts** - task - P1 - deps: schema, asc-spike-fts -- FTS5 over `evidence_text` using the
tokenizer the spike chose. **Port mast's query sanitizer** (`src/search/fts.ts:toFtsMatch`) -- raw
LLM text will contain `(`, `:`, `"`, `OR` and will throw otherwise.
*Tests*: fuzz with FTS5-hostile strings; none may throw.

**asc-attach** - task - P2 - deps: schema -- `ATTACH`-based union across project DBs, identical
schema assumed, `type_hash` used to refuse unioning incompatible definitions.

---

## E4 -- CLI (dogfooding starts here)

**asc-cli-skeleton** - task - P0 - deps: E3, asc-spike-runtime -- oclif app, binary `asc`. Apply the
spike's cold-start decision (fast path for `record` if it exceeded threshold).

**asc-init** - task - P0 - deps: cli-skeleton -- creates `.ascend/`, adds it to `.gitignore`,
installs starter types, offers the recall hook.

**asc-types-cmds** - task - P0 - deps: cli-skeleton, registry -- `define | list | show | brief |
deprecate | import | export`. `import` **preserves `type_hash`** so cross-project entries stay
comparable. `brief` output is the session-hook payload -- keep it minimal, one line per type.

**asc-types-dedupe** - task - P0 - deps: types-cmds, asc-spike-drift -- define-time similarity check
on type name and property names; refuses or warns with nearest matches. Strictness set by the drift
measurement, not by taste.

**asc-record** - task - P0 - deps: recorder, cli-skeleton -- `asc record <type>`.
*Accept*: `--json -` (stdin) is the primary path; flags the convenience; `--na prop,prop` marks
not-applicable; batch accepts multiple entries in one call; **stable command prefix** so
`Bash(asc record:*)` works as a permission allowlist entry.
-> **On close: run `asc init` here and start dogfooding (`asc-dogfood-types`).**

**asc-record-cost** - task - P1 - deps: asc-record - **[EMPIRICAL]**
*Question*: What does one `asc record` call actually cost an agent?
*Method*: measure tokens for the command + its output, and wall-clock, across 20 real recordings.
*Measure*: p50/p95 tokens and ms. Confirm no permission prompt fires with the allowlist entry.
*Decision*: if a record costs more than a few hundred tokens, simplify the surface before E5.

**asc-query** - task - P0 - deps: views -- `asc query "<sql>"` with `--json|--table|--csv`,
`--across <glob>`.

**asc-export-import** - task - P2 - deps: recorder -- JSONL durability/transfer escape hatch. The DB
is gitignored and local-only; this is the only way a corpus survives the working copy.

**asc-starter-types** - task - P1 - deps: types-cmds -- ship `review-completed`, `stuck-event`,
`stage-transition`, `decision` (shapes in ARCHITECTURE.md). Mechanically derivable things are
**not** here -- they belong to E5.

---

## E5 -- Adapter (Claude Code transcripts)

**asc-transcript-reader** - task - P0 - deps: E4 -- streaming reader for `~/.claude/projects/*.jsonl`.
Read-only, memory-bounded, tolerant of malformed lines (self-healing, never fatal -- align's rule).

**asc-derived-types** - task - P0 - deps: transcript-reader -- derived type definitions:
`user-correction`, `tool-denial`, `verification-run`, `skill-activation`, `context-compaction`.
All carry `source='derived:claude-code'`.
**Token fields must distinguish absent from zero** -- once a corpus loses that distinction it is gone.

**asc-ingest** - task - P0 - deps: derived-types -- `asc ingest claude-code [--since]`.
*Accept*: idempotent, keyed on transcript uuid; re-running creates no duplicates.

**asc-backfill** - task - P1 - deps: ingest -- run against the real corpus; report N per type, date
range, and per-field population rate. This is the day-one dataset for E6/E7.

---

## E6 -- Explore

**asc-explore-profile** - task - P0 - deps: E5 -- default output is a **map, not rows**: count, date
range, per-property cardinality, top-K values with counts, three-state ratios.

**asc-explore-paging** - task - P0 - deps: explore-profile -- stable deterministic cursors; every
output reports `total`, `has_more`, and **coverage** ("showing 40 of 512, 7.8%").
*Tests*: cursor stability under concurrent writes.

**asc-explore-sampling** - task - P0 - deps: explore-paging -- `--sample
random|stratified|diverse|outlier`.
*Tests*: stratified preserves enum proportions within tolerance.

**asc-sampling-eval** - task - P1 - deps: explore-sampling - **[EMPIRICAL]**
*Question*: Does stratified sampling actually improve LLM classification accuracy over random?
*Method*: hand-label a full corpus slice as ground truth. Have a model classify from a random sample
and from a stratified sample of equal size. Compare both against ground truth.
*Measure*: per-category recall, especially for rare categories. Report both arms.
*Decision*: if stratified shows no advantage, drop the mode rather than carry it.

**asc-explore-shape** - task - P1 - deps: explore-profile -- `--select`, `--filter`, `--group-by a,b`
(crosstabs, not just counts).

**asc-explore-budget** - task - P1 - deps: explore-paging -- `--max-tokens N`; fits output to budget
and **reports what it dropped**.

**asc-explore-dump** - task - P1 - deps: explore-budget -- `--dump <dir>` writes many files plus
`manifest.json` (filter, count, token estimate per file) so an agent picks files instead of reading
all.

**asc-search** - task - P1 - deps: asc-fts -- `asc search <type> "<text>"`, BM25-ranked, with
mast-style zero-result assist (nearest actual property values when a filter matches nothing).

---

## E7 -- Analysis (pure functions, testable without a DB)

Each task: pure implementation in `packages/analysis` + fixture tests with **hand-computed** expected
values. Statistics verified against a worked example, not against their own output.

**asc-near-dup** - task - P1 - deps: E2 -- SimHash/MinHash near-duplicate collapse.
**[EMPIRICAL]** threshold tuned on the real backfilled corpus; report false-merge rate at the chosen
threshold.

**asc-clustering** - task - P1 - deps: E2 -- TF-IDF / trigram similarity + agglomerative clustering.
**[EMPIRICAL]**: cluster the real corpus; hand-judge coherence of the top 10 clusters; report the
judged coherence rate and the losing configuration.

**asc-distinctive-terms** - task - P2 - deps: E2 -- log-odds ratio with informative Dirichlet prior.

**asc-correlate** - task - P2 - deps: E2 -- mutual information / chi-square between categorical
properties, ranked.

**asc-assoc-rules** - task - P2 - deps: E2 -- FP-growth with support/confidence.

**asc-intervals** - task - P0 - deps: E2 -- Wilson score intervals + minimum-N flagging.
**Every proportion ascend prints anywhere goes through this.** Non-optional.

**asc-changepoints** - task - P2 - deps: E2 -- CUSUM / Pettitt over entry rate and property
distributions.

**asc-stats-cmd** - task - P1 - deps: all E7 -- `asc stats <type>
[--cluster|--assoc|--correlate|--changepoints|--distinctive]`.

---

## E8 -- Annotation + rule-based classification

**asc-annotations** - task - P0 - deps: E3 -- schemes + annotations storage. Entries stay immutable.
Competing schemes coexist; dropping one loses no entry data.

**asc-rule-engine** - task - P0 - deps: annotations, asc-fts -- **the centerpiece.** The LLM proposes
a rule (SQL predicate or FTS query); ascend applies it deterministically across the corpus.
*Accept*: reports match count **and the unclassified remainder** -- the remainder is the signal the
taxonomy is incomplete. A scheme stores its rule, not just its labels.

**asc-backtest** - task - P0 - deps: rule-engine -- measure a rule against a hand-labelled sample.
*Accept*: reports real precision/recall before the rule touches the corpus.

**asc-kappa** - task - P1 - deps: annotations -- Cohen's kappa between two schemes or two runs.
*Accept*: answers "is this classification reproducible, or is the model guessing?"

**asc-invalidation** - task - P1 - deps: annotations -- invalidation as a reserved scheme, never a
column. Entries survive learning that they measured the wrong thing.

---

## E9 -- Doctor + curation

**asc-doctor** - task - P1 - deps: E8 -- dead types (defined, never recorded -- align's "dead
rules"), near-duplicate type names, definition drift across versions, per-property na/unmeasured
ratios, missing export (the corpus is local-only and gitignored), and **brief size** as a health
metric.

**asc-cross-project** - task - P2 - deps: asc-attach, doctor -- `asc query --across` end to end;
`asc types import` round-trip preserving `type_hash`.

---

## E10 -- Skill, command, recall hook

**asc-install-hook** - task - P0 - deps: asc-types-cmds
`asc install-hook` writing the `SessionStart` hook to project `.claude/settings.json`.
**Must APPEND to the existing `SessionStart` array -- never overwrite the file.** Verified hazard:
`bd init` already registered `bd prime --hook-json` there. Guard with the `[ ! -f ... ] ||` no-op
pattern. Requires explicit consent; never writes settings silently.
*Tests*: installing alongside an existing beads hook leaves both intact and both runnable.

**asc-skill** - task - P1 - deps: E8 -- the analysis-method skill: profile -> sample -> cluster ->
propose rule -> back-test -> annotate.

**asc-analyze-cmd** - task - P1 - deps: asc-skill -- `/ascend-analyze <type...>` slash command.

**asc-brief-budget** - task - P1 - deps: asc-install-hook - **[EMPIRICAL]**
*Question*: How large can `asc types brief` get before a model ignores it -- and does the hook
actually raise the recording rate?
*Method*: real sessions across brief sizes; compare recording rate with the hook installed vs the
brief pulled manually.
*Measure*: entries recorded per session per arm; token cost of the brief.
*Decision*: sets the hard cap on brief size, enforced by `asc doctor`.
*Benchmark*: `bd prime` costs ~4.9 KB (~1.2k tokens) per session for an entire issue tracker.

---

## E11 -- Dogfood

**asc-dogfood-types** - task - P0 - deps: asc-record -- define ascend's own build entry types and
start recording. Opens the moment `asc record` works.

**asc-dogfood-discipline** - chore - P1 - deps: dogfood-types -- every subsequent task close records
a `stage-transition`; every 3-strike event records a `stuck-event`; every non-obvious choice records
a `decision`; every [EMPIRICAL] task records its evidence record.

**asc-dogfood-analysis** - task - P1 - deps: E8, dogfood-discipline - **[EMPIRICAL]**
*Question*: Run against ascend's own build corpus, does the analysis layer surface anything useful?
*Method*: the full method -- profile, sample, cluster, propose a rule, back-test, annotate.
*Measure*: number of actionable findings; false-pattern rate against a shuffled control.
*Decision*: **this is the project's own acceptance test.** If ascend cannot find a real pattern in
the record of its own construction, it will not find one in yours. Report honestly.

---

## Dependency spine

```
E0 spike --GATE--> E1 foundation --> E2 core --> E3 store --> E4 CLI --> dogfooding starts
                                                              |
                                                              +--> E5 adapter --> E6 explore --+
                                                              |                                +--> E8 --> E9 doctor
                                                              +--> E7 analysis ----------------+      +--> E10 skill/hook
                                                                                                      +--> E11 dogfood analysis
```

E6 and E7 are parallelizable. E7 needs no database and can start as soon as E2 lands.

---

## On approval, I will

1. Write `TASKS.md` into the repo with this breakdown.
2. Populate beads: epics + tasks + dependency links + priorities + `[EMPIRICAL]` labels.
3. Produce the kickoff prompt for the implementing agent.
