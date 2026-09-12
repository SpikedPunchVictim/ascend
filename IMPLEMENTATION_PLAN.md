# ascend — Implementation Plan

Stage definitions are `ARCHITECTURE.md`'s (Stage 0–5). Epics are the `bd` issues that implement
them. Per the global workflow this file is deleted when every stage is Complete.

**Status key:** Not Started · In Progress · Complete · Blocked

Evidence records live in `docs/evidence/`. Where a stage has a constraint that was *measured* rather
than designed, it is called out as **EV-constraint** — those are not suggestions; they are what the
spike settled, and re-litigating them requires new measurements.

---

## Stage 0: Spike (throwaway, quarantined)

**Goal** — Answer the 7 empirical questions in `ARCHITECTURE.md` before building any of it, and
surface a negative result loudly if Q2 (does a pattern emerge?) or Q6 (does recording happen?) fails.

**Success Criteria** — `spike/FINDINGS.md` carries measured numbers with a verdict; every question
has an `EV-<n>` record in the fixed shape (Question / Method / Measurement / Decision / Confidence).

**Tests** — N/A; the deliverable is evidence. Each harness is throwaway and quarantined under
`spike/`, excluded from lint (`eslint.config.js` ignores it) and from the build.

**Status: Complete** — verdict **GO-WITH-CHANGES**. Records: `EV-storage`, `EV-corpus`, `EV-drift`,
`EV-patterns`, `EV-fts`, `EV-runtime`. Required changes are owned by later stages and repeated below.
Q6 (does recording happen?) is **NOT answered** — it cannot be, until the CLI exists; it is carried
into Stage 4 as `asc-9an [EMPIRICAL]`.

---

## Stage E1: Repo foundation (pre-stage)

**Goal** — pnpm workspace, TS strict, Vitest, ESLint, `align` as the conformance oracle, mast index,
and the quality gates that every later stage must pass.

**Success Criteria** — `format:check`, `typecheck`, `lint`, `test` and `align check` all exit 0; the
purity contract is machine-enforced at both edit time (ESLint) and check time (align), and is *proven
to fire* against a deliberate violation.

**Tests** — `packages/core/test/purity-enforcement.test.ts` (drives ESLint against a violating fixture
**and** a clean control); `packages/core/test/vocabulary.test.ts`; `packages/analysis/test/min-n.test.ts`;
`packages/cli/test/dev-hooks.test.ts` (hook wiring + the gate's own two-arm behaviour).

**Status: In Progress** — `asc-67s`, `asc-joa.1`, `asc-joa.2` Complete; `asc-l4q` Complete.
**Blocked on user consent:** `asc-joa.3` (dead `core.hooksPath`; all bd + ascend hooks inactive) and
`asc-02u` (gate written and verified, deliberately unarmed). `pnpm test` is currently **red on one
test** — the guard that detects `asc-joa.3`. That red is the honest signal and clears with the fix.

---

## Stage 1: Core + store + record/query — epics E2, E3, E4

**Goal** — `asc init`, `asc types define`, `asc record`, `asc query` end to end, with the four starter
types installed by `asc init`.

**Success Criteria** — an entry recorded via the CLI is queryable through its generated view; the
three value states round-trip distinctly; an invalid entry is rejected with a compact, prescriptive
error naming field, expected type, and corrected command; `asc init` gitignores `.ascend/`.

**Tests** — Core purity; three-state round-trip; type-version immutability; hash stability;
`buildSchema` spec→zod coverage for every property type in the bounded vocabulary.

**EV-constraints carried in:**
- **`EV-storage`** — shape A (one `entries` table + `properties` JSON + generated per-type views) is
  kept, but it is only competitive **with composite expression/covering indexes emitted at
  type-registration time**: A4 covering index 206.1 ms vs per-type tables 217.1 ms. Naive indexing is
  a trap — the bare-expression index measured *slower than no index* (239.1 vs 231.0 ms) because it
  cannot carry the `type_name` predicate. Also: a `STORED` generated column **cannot be added to a
  populated table** (rejected at 1+ rows), which is why the composite index, not a stored column, is
  the mechanism.
- **`EV-drift`** — define-time canonicalization is required, not optional: across 44 real
  LLM-authored property names only **9.1 %** were shared, Jaccard **0.300**, with snake_case and
  camelCase mixed and `reviewer` typed `ref` in one place and `string` in another. `asc-2gy`
  (define-time duplicate detection) is the mitigation.
- **`EV-patterns`** — `AskUserQuestion` 12/12 and `ExitPlanMode` 11/11 were user-rejected; the
  `tool_name × project` association (χ²=153.11) is an **artifact** and does not survive. Two required
  additions to E7: a **tautology check** and a **temporal-block control** — the shuffled-label control
  catches marginal-driven artifacts but *not* definitional ones, and "Thu 41.1 %" is one burst
  (2026-09-03 alone is 143/409 = 35 % of the corpus).
- **`EV-fts`** — FTS5 uses **trigram** as primary. `unicode61` and `porter` retrieve nothing correct
  for **40 %** of partial-token terms (coverage 60 %) where trigram gets **100 %**. `porter` goes to
  the Design Reserve (its win is confined to stem-changing inflections, `configuring` 2→173).
  The `toFtsMatch` sanitizer port is **mandatory**: 8/14 raw LLM-authored queries throw FTS5 syntax
  errors, and a naive whole-query phrase sanitizer is insufficient (returns empty for 9–13/14).

**Status: In Progress** — **E2 complete** (7/7, epic `asc-72s` closed). **E3 5/6** (`asc-0j0`,
`asc-z73`, `asc-2jf`, `asc-fso`, `asc-uy7` closed; `asc-l00` open). E4 (`asc-baj`) not started.

### E3 delivered so far

- **`db.ts` / `schema.ts`** — `node:sqlite`, WAL + `busy_timeout` + `synchronous = NORMAL`, and the
  pragmas that carry a guarantee are **read back and verified** rather than requested. Migration 1 is
  the initial schema; **migration 2 adds FTS5**, which makes it the first real exercise of the
  migration path.
- **`registry.ts`** — the registry. A shape change INSERTs a version row and never UPDATEs; `type_hash`
  is over `definitionShape`, so **prose is not identity** and registering a known shape is idempotent.
  `major` is frozen with the shape because it is the boundary a generated view unions within.
- **`recorder.ts`** — the single entry write path (asserted by a source-scan test, not by convention).
  Time and IDs are injected; `''` is refused everywhere (omit to mean NULL).
- **`views.ts`** — one generated view per **major family**, unioning minors and **never** across
  majors; a `_state` column per property carrying **four** values (`measured` / `not_applicable` /
  `not_measured` / `not_declared`); one composite expression index per property.
- **`search.ts`** — FTS5 over `evidence_text`, trigram, with `toFtsMatch` ported **term-based**.

**The fourth state is a decision taken here, and it is not in the three-state model.** A view spans
versions, so a property introduced by a later minor is not in an earlier entry's definition at all —
neither measured, nor N/A, nor "not measured". Reporting it as `not_measured` would put rows into a
coverage denominator for a question they were never asked. `not_declared` is the view's own value and
never appears in `entries` or in core's model.

**New evidence: `EV-write-cost.md` (EV-8).** `EV-4` left the write side of the index rule
**unmeasured** — *"how many indexes to emit, and whether index count degrades the write path"*. At 20
properties: `asc record` **+0.135 ms**, a full ~16.6k-entry backfill **+679 ms, once**. Both
negligible, so the set ships **uncapped**. The cost that bites is **disk** — the index set takes the
file from 98.1 MB to **204.9 MB at 100k rows (2.1×)** — which makes store size an `asc doctor` report
rather than a registration gate. `EV-8` also corrects a framing: the headline ratio (9.97×) is a ratio
between two sub-millisecond numbers and is the wrong quantity to decide on.

**A measurement that changed a decision, and one that did not.** Two design claims were settled by
running rather than by argument:
- **`VACUUM` and implicit rowids.** An external-content FTS table must key on `content_rowid`, and
  SQLite documents that VACUUM "may change" rowids for tables with no explicit `INTEGER PRIMARY KEY`
  — which `entries` has (its PK is `TEXT`). Measured across four scenarios; **the rowids were stable
  in all four, so the documented caveat did not reproduce.** The standalone table was still chosen,
  but the honest reason is the guaranteed-absent contract plus an owned join key, not a demonstrated
  defect — and that is how it is recorded.
- **The type filter in `search.ts` is a POST-filter.** `EXPLAIN QUERY PLAN` gives the *same* plan with
  and without it (`SCAN entries_fts` then `SEARCH e USING ... (id=?)`); `idx_entries_type_time` is
  never used. The filter is correct but does **not** reduce the FTS scan. The comment was corrected to
  match the plan rather than the other way round.

**Every E3 suite was mutation-tested**, following the project invariant that a check must be shown to
fail before it is trusted to pass. Six mutations on the views suite, five on search, two on the
registry's transaction handling. Three findings came out of that and are worth carrying forward:
- A test that **cannot fail** is worse than no test. The cross-store column-order test was insensitive
  as first written (both sides were already canonically ordered) and was rewritten to reach the case
  the sort actually protects.
- **A rollback test that runs nested cannot detect a misplaced `COMMIT`.** Moving the view refresh to
  after `COMMIT` passed all 23 tests, because the nested path never takes the commit branch.
- **The search suite catches the naive sanitizer on RESULTS, not on throws.** The naive whole-query
  phrase fix stops every error while returning nothing — and the "never throws" test still *passes*
  under it. Only asserting a non-empty result distinguishes the two, which is exactly what `EV-fts`
  required.

Two gate defects fixed during this stage (both false greens, the severity-zero class):
`pnpm typecheck` had been `tsc -b` over `src/**` only, so **test files were never typechecked** at all
(it is now `tsc -b && tsc -p tsconfig.eslint.json`, verified to fail on a planted error in a test
file), and vitest could not resolve `node:sqlite` (aliased to a shim that reaches the real module via
`createRequire`).

Gates at E3 head: `format 0 · typecheck 0 · lint 0 · test 251 passed · align check green`.

E2 delivered, with the evidence that it holds:
- `spec.ts` — bounded 9-type vocabulary + canonicalization. Renames are **reported**, not applied
  silently, and canonical form is a fixed point (idempotence is what lets it be an identity).
- `schema.ts` — `buildSchema`/`propertySchema`, one exhaustive switch with a `never` check, so
  adding a vocabulary member without handling it is a compile error. Test coverage of the vocabulary
  is enforced against `PROPERTY_TYPES`, so it cannot rot.
- `hash.ts` — pure SHA-256 (`node:crypto` is banned in core; a hash that depends on who computed it
  is not an identity). Verified against **published NIST vectors**, not just self-consistency: a
  hand-written hash passes every "same input, same output" test while being wrong. `node:crypto` was
  added to the purity ban as part of this.
- `state.ts` — the three-state resolver. **`required` accepts an explicit N/A**, which is the whole
  point; a measured `0`, an N/A and silence resolve to three distinct states, and a property asserted
  as two at once is rejected.
- `diff.ts` — bump classification on one axis: *can an old entry still be read correctly?* Adding an
  optional property is minor; adding a **required** one is major, since old entries have no decision
  for it.
- Purity enforcement extended to `Math.random`, `performance`, the `crypto` global and `node:crypto`,
  and now proves both that the rules are **configured for core *and* analysis** and that they
  **fire** (store is the negative control).

Two decisions taken during E2 that were not specified, both chosen to avoid manufacturing false
signal: **property order and enum-value order are canonicalized away** (they are authoring artifacts,
and a reordering reported as drift is a false signal), and **the diff canonicalizes both sides first**
so a rename-only difference is correctly *no* bump.

Gates at close: `format:check 0 · typecheck 0 · lint 0 · test 113 passed · align check green`.

---

## Stage 2: Claude Code adapter + backfill — epic E5

**Goal** — `asc ingest claude-code` derives entries from existing transcripts.

**Success Criteria** — re-running is idempotent (keyed on transcript uuid); derived entries carry
`source='derived:claude-code'`; the corpus reaches a queryable N on day one.

**Tests** — idempotency on a fixture transcript; envelope correctness; absent-vs-zero on token fields.

**EV-constraints carried in:** `EV-corpus` measured the real corpus at **809 files / 388,054 lines /
1.14 GB** read in **11.2 s** at **213 MB** peak RSS, yielding **69,276 rows in 7.2 s**. Tool-denial
entries reach **N=409** → GO. `user-correction` reaches only **N=20** and is **not an independent
corpus** — do not present it as one.

**Safety constraint (verbatim from `TASKS.md`):** *"Read-only on the transcripts — never write
there."*

**Status: Not Started** (`asc-dh0`)

---

## Stage 3: `asc explore` + `asc search` — epic E6

**Goal** — make a corpus an LLM cannot fit in context readable anyway.

**Success Criteria** — profile mode maps a type without hand-written SQL; all four sampling modes
work; `--max-tokens` fits output to budget and reports what it dropped; every output carries coverage
and stable entry IDs; `--dump` writes a usable `manifest.json`; FTS5 search survives LLM-authored
query strings containing `(`, `:`, `"`, `OR`.

**Tests** — query-sanitization fuzz against FTS5 syntax errors; stratified sampling preserves enum
proportions; cursor stability under concurrent writes; token-budget truncation reporting.

**Status: Not Started** (`asc-qfk`)

---

## Stage 4: Annotation + statistical layer + skill — epics E7, E8, E10

**Goal** — turn a corpus into findings, reproducibly.

**Success Criteria** — an LLM-authored rule applies across the corpus and reports matches *and*
unclassified remainder; back-test yields real precision/recall against a hand-labelled sample; two
competing schemes annotate the same entries simultaneously and `asc kappa` scores agreement; dropping
a scheme loses no entry data; invalidation works as a reserved scheme; every proportion carries a
Wilson interval and small groups are flagged.

**Tests** — `packages/analysis` against fixtures with hand-computed expected values (Wilson, kappa,
chi-square, log-odds, FP-growth support/confidence, CUSUM changepoints); scheme isolation;
immutability of annotated entries.

**EV-constraints carried in:** the tautology check and temporal-block control required by
`EV-patterns` (see Stage 1). Statistics must include the shuffled-label control that produced the
`tool_name × project` verdict, plus the explicit limitation that it catches marginal-driven artifacts
but not definitional ones.

**Empirical gate:** `asc-9an [EMPIRICAL]` — brief size vs recording rate. This is Stage 0's
unanswered Q6, and it is the **primary failure mode** of the whole product: an empty database.
Per `empirical-planning`, this must be measured against a **real model in a real session**, not
inferred.

**Status: Not Started** (`asc-xgo`, `asc-k6p`, `asc-4so`)

---

## Stage 5: `asc doctor` + cross-project query — epic E9

**Goal** — keep the registry from fragmenting; make the per-project split analytically harmless.

**Success Criteria** — reports dead types, near-duplicate names, drift across versions, per-property
na/unmeasured ratios, and missing exports; `asc query --across` unions multiple project DBs;
`asc types import` round-trips a definition preserving `type_hash`.

**Tests** — fixture registry with known duplicates and one dead type; two-DB ATTACH union.

**Status: Not Started** (`asc-20p`)

---

## Stage E11: Dogfood

**Goal** — drive the real thing, end to end, and find what the suite cannot.

**Success Criteria** — `asc` is used from inside actual Claude Code sessions during real work; the
corpus is grown by that use; an `asc explore` run over the real corpus produces a finding a human
acts on.

**Per `empirical-planning`:** green tests with fixtures ≠ works. The flagship flow — an LLM records
entries unprompted, a human later queries the corpus — **has never run live**. Until it does, every
claim about it is unproven and must be labelled as such.

**Status: Not Started** (`asc-x11`)

---

## Cross-cutting rules (non-negotiable, from `TASKS.md`)

1. Every commit compiles and passes tests. No `--no-verify`. No disabled tests.
2. Core stays pure: `packages/core` and `packages/analysis` have zero `fs`, zero `Date.now()`, zero
   network. Time and IDs are injected. Enforced by test AND `align check`.
3. Omitted, never fabricated: when a value does not exist, omit it. Never write `0` for unknown.
4. Real data only: the real transcripts (read-only), a real model, the real CLI.
5. State limitations plainly. Report failures verbatim.
