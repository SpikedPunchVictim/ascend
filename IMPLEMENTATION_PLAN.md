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

**Status: In Progress** — **E2 complete** (7/7, epic `asc-72s` closed). **E3 7/7 complete**, epic
`asc-865` closed: `asc-0j0`, `asc-z73`, `asc-2jf`, `asc-fso`, `asc-uy7`, `asc-l00`, and the P1 defect
found in E3's own output, `asc-865.1`, now fixed (see below). **E4 (`asc-baj`) In Progress** — the
stages are specified below; cold start is already measured and needs no fast path.

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
- **`union.ts`** — the cross-project union, reading N project databases as one corpus. Keys on
  `type_hash`; **refuses** when one name resolves to more than one hash, naming which project holds
  which, and offers the way through (`typeHash`) only to a caller who names a definition explicitly.
  One project is attached at a time, so the corpus is not capped at `SQLITE_MAX_ATTACHED` = 10.

### E3 delivered: `asc-l00`, the cross-project union

**Why the refusal is the feature.** `type_version` is assigned by *local* registration order, so
"version 1" in one project and "version 1" in another are unrelated claims — and the generated view
name `v_<type>_v<major>` derives from that same local history, so the view names are not comparable
either. Only `type_hash` is computed from the definition itself. Measured on two stores while
designing this: unioning by name alone put `count: 3` beside `count: 250` in one result set —
findings next to milliseconds — with nothing marking the boundary. EV-drift makes that the *expected*
case, not an edge case: five independently authored specs of one concept shared **9.1 %** of their
property names.

**The refusal has to have a way through, or `--across` is unusable.** `UnionOptions.typeHash` selects
one definition explicitly, and then every project reports `entryCount`, so a project holding the other
shape is *visibly* contributing zero rather than invisible — without that count, a hash-pinned union
over two projects reads as the whole corpus when it is half of it.

**A consequence worth stating: the union cannot produce `not_declared`.** Refusing to mix hashes means
every row shares one definition, so every property is declared by every row; `stateCase` is called
with `null` and the CASE has three arms. The four-state model still has four states — this query
simply cannot ask the question that separates the fourth. That is why `stateCase` lives in `sql.ts`
with the reason recorded, rather than being written twice.

**Five error classes for the five ways it refuses** — not-a-store, missing file, the same store named
twice, a type no project defines, and a hash no project holds. Two of them prevent a *write* on a read
path: `ATTACH` **creates** a database file when the path is absent and its directory exists (measured),
so a mistyped `--across` would leave a stray empty file behind and then report an empty corpus; and
two paths can name one file (a symlink, or `/var` vs `/private/var` — measured), which would count
every entry in it twice.

**Mutation testing found a real gap, and it was the important one.** Twelve defects were planted;
**eleven were caught on the first pass, and dropping the `type_hash` predicate from the row query
SURVIVED** — because no test had a project holding rows recorded against *both* definitions of one
name. That is the only case the predicate covers (the per-project filter already excludes projects
that do not hold the hash), and it is a real scenario: a project that drifted across majors and has
entries against each. Added the drifted-project test; it is now caught, 12/12. Recorded as a bd
memory, because the general form is not specific to this module.

### A defect found in E3's own output, filed rather than quietly fixed: `asc-865.1`

Writing the union exposed a bug in `views.ts` (closed as `asc-fso`). The view projects each property
as a bare identifier, so a property whose canonical name equals one of the envelope columns collides
with it and **SQLite silently renames the loser to `<name>:1`** — no error anywhere. Reproduced on the
real code path with a type carrying `source` and `id`:

```
SELECT source, id FROM v_note_v1  ->  {"source":"self", "id":"e1"}
```

The envelope values are returned for names the author used for their own properties. The exact query
`ARCHITECTURE.md` prescribes for the view (`SELECT <prop>, COUNT(*) FROM v_<type>_v<n> GROUP BY 1`)
therefore returns a **wrong answer with no error** — the plausible-wrong-number class this product
exists to prevent. Plausible colliding names include `id`, `source`, `actor`, `repo`, `branch`,
`workflow`, `run_id`. The union does not have this bug: its columns are prefixed `p.`/`s.`, with a
regression test.

It was filed (`asc-865.1`, P1) rather than fixed inside the union's commit because the fix chooses
between two designs: reserve the envelope names at define time in `@ascend/core` (recommended — it
refuses a name that cannot be projected faithfully, with a rename suggestion) or prefix the view's
columns (correct, but breaks the documented `GROUP BY` ergonomics). That is a decision to take
deliberately, not inside a commit for a different task.

**Resolved: the bead's recommendation, option (a).** The vocabulary now lives in `@ascend/core`
(`ENVELOPE_PROPERTY_NAMES`, `STATE_COLUMN_SUFFIX`, `reservedPropertyName`), canonicalization reports
a reservation in a new **`errors`** bucket beside `renames`/`warnings`, and `registerType` refuses on
a non-empty list. Errors are a different KIND from warnings, not a severity: a warning is a legal spec
someone probably did not mean, an error is one no canonicalization can rescue.

Three things about the shape of the fix are load-bearing:

- **The suffix rule is unconditional, and that is the point.** A collision needs two properties to be
  visible (`error_state` beside `error`), but versions arrive one at a time: admitting `error_state`
  in version 1 would leave a registered family that version 2 could never extend with `error`, and a
  registered definition is immutable. Refusing the pattern up front is the only stable form.
- **`sql.ts` projects from core's list rather than keeping a second copy of it**, so the reserved set
  and the projected set cannot disagree. The guard against them drifting is a test that derives the
  claimed names back out of a real view's declared columns — added because the single-list design
  makes one direction of drift impossible and leaves the others unguarded.
- **`refreshTypeViews` refuses too** (`assertProjectable`, before any DDL). `registerType` is the
  first line; a version row inserted by hand, or a store written before the rule, is the second. The
  mutant that removes this guard rebuilds the original defect exactly — measured
  `["source","source:1","source_state"]` — so the test guards the defect and not merely an error.

**Rejected alternative, recorded on measured grounds so it is not re-proposed from scratch:**
prefixing the view's property columns fixes the whole class for every name, including ones nobody
enumerated, and refuses nothing. It was declined because the property column names ARE the ergonomic
the view exists for (`ARCHITECTURE.md`: real `GROUP BY` ergonomics; a `_state` suffix that is part of
the documented query surface), and a prefix would be paid by every query forever to protect the
minority of names that collide. **Design Reserve, with its promotion condition stated:** if a store
with a pre-gate colliding family ever exists in the wild, `refreshTypeViews` should qualify the
colliding column rather than refuse the family — today that state is unreachable (no released store,
and every fixture in the repo is written by this repo), so building it would be a mechanism for a
directory that is not there.

**The cost is now measured, not hypothetical.** The reservation took one name out of this repo's own
fixtures: `union.test.ts`'s three-state fixture used `actor` as a property, and it had to move to
`denier`. That fixture carries a note saying so, rather than being renamed silently. The refusal
message names the reason and a rename suggestion, so the cost at define time is one round trip.

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
registry's transaction handling, twelve on the union. Four findings came out of that and are worth
carrying forward:
- A test that **cannot fail** is worse than no test. The cross-store column-order test was insensitive
  as first written (both sides were already canonically ordered) and was rewritten to reach the case
  the sort actually protects.
- **A rollback test that runs nested cannot detect a misplaced `COMMIT`.** Moving the view refresh to
  after `COMMIT` passed all 23 tests, because the nested path never takes the commit branch.
- **The search suite catches the naive sanitizer on RESULTS, not on throws.** The naive whole-query
  phrase fix stops every error while returning nothing — and the "never throws" test still *passes*
  under it. Only asserting a non-empty result distinguishes the two, which is exactly what `EV-fts`
  required.
- **A guard can have exactly one case, and a suite can miss it entirely.** Dropping the `type_hash`
  predicate from the union's row query survived all 26 tests, because every fixture had each project
  holding one definition. The predicate covers only a project that holds *both* (its own drift), which
  no test had. The count matters more than the code: 26 green tests said nothing about it.

Two gate defects fixed during this stage (both false greens, the severity-zero class):
`pnpm typecheck` had been `tsc -b` over `src/**` only, so **test files were never typechecked** at all
(it is now `tsc -b && tsc -p tsconfig.eslint.json`, verified to fail on a planted error in a test
file), and vitest could not resolve `node:sqlite` (aliased to a shim that reaches the real module via
`createRequire`).

Gates at E3 head: `format 0 · typecheck 0 · lint 0 · test 294 passed · align check green (19
baselined, unchanged)`. The 16 added tests are `asc-865.1`: 8 in core (the vocabulary, the refusal,
the boundary of each rule, and that every suggestion it can produce is itself free), 5 in the
registry (the refusal and that it writes nothing), 3 in views (the claimed-names invariant, the
near-miss that must stay legal, and the generator's own refusal). Six mutations were run against
them; each went red, and none of the six survived.

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

### E4 — the CLI (`asc-baj`), in stages

**Goal** — `asc init`, `asc types define`, `asc record`, `asc query` end to end, with the four starter
types installed by `asc init`. **`asc record` closing is what starts dogfooding** (`asc-5ra`).

**Cold start is already settled, and it says *build nothing extra*.** `asc-wkw` measured oclif at
**p50 123 ms / p95 169 ms** against a bare Node script's 59/72 ms — inside the 300 ms threshold that
would have justified a fast path for `record`. So `asc-m8n`'s escape hatch stays in the **Design
Reserve, unbuilt**, and the CLI is plain oclif. Re-open it only if `asc-9y1` measures a real `record`
call over budget.

**Design decisions taken here, with the reason they are not forks** (`empirical-planning`: fork the
user only on choices that are both load-bearing *and* expensive to reverse; these are all reversible
inside one file):

| Decision | Choice | Why |
|---|---|---|
| Project root | **walk up** from cwd for `.ascend/`, like git | A CLI that only works from the project root is wrong the first time an agent `cd`s into a subdirectory. `--across` already implies cwd is not the frame. |
| `asc query` writes | **never — read-only connection** | Measured: `new DatabaseSync(f, {readOnly:true})` refuses writes ("attempt to write a readonly database") and **`ATTACH` still works** on that connection, so `--across` is unaffected. The DB is gitignored, so there is no version control net under a mistyped `DELETE`; and `Bash(asc query:*)` is only a defensible allowlist entry if `asc query` cannot mutate. |
| `--json` shape | a **versioned envelope**, not a bare array | `cli-best-practices` rule 9: the JSON shape is a contract and human output is not. Bare arrays cannot be extended without breaking every consumer. |
| `asc init` on an existing store | **idempotent, not an error** | Running it twice must be safe and must repair a half-built store (the same argument `refreshTypeViews` makes). `--force` would put a flag on the common path. |
| Git metadata in the envelope | **deferred to E5** | `cwd` is free (`process.cwd()`); `repo`/`git_sha`/`branch` mean spawning `git` on the hot path that `asc-9y1` exists to measure. E5's adapter is where derived envelope fields are specified, and the principle recorded in `asc-kwr` — *anything mechanically derivable belongs to the adapter* — applies to the CLI too. |
| Output on a non-TTY | no color, no prompt, ever | Rule 3: never require interactivity that was not asked for. Non-interactive callers get a flag-naming error, not a hang. |

**Stages, in dependency order.** Each is a bead; each ends green on the full gate.

| Stage | Bead | Deliverable |
|---|---|---|
| **E4.1** | `asc-m8n` | oclif wired end to end from `src/bin.ts` (no hand-written `bin/run.js`); `packages/cli/src/{project,output,errors,base,streams}.ts` — root discovery, the three renderers, error→exit-code mapping, EPIPE/SIGINT. Tests drive the **real binary**, not the handler. |
| **E4.2** | `asc-6m6` | `asc types define\|list\|show\|brief\|deprecate\|import\|export`. `import` preserves `type_hash`; `brief` is the hook payload and stays one line per type. |
| **E4.3** | `asc-kwr` + `asc-pcy` | The four starter types (shapes from ARCHITECTURE.md), then `asc init`: `.ascend/`, an **appended** `.gitignore` entry, starter types, and an *offer* of the recall hook — never a settings write (that is `asc-1q9`, E10, behind explicit consent). |
| **E4.4** | `asc-gvr` | `asc record <type>`: `--json -` primary, flags for convenience, `--na`, batching, and a shape that keeps `Bash(asc record:*)` a valid allowlist prefix. **Dogfooding starts here.** |
| **E4.5** | `asc-6ct` | `asc query "<sql>"` read-only, `--json\|--table\|--csv`, `--across <glob>`. |
| **E4.6** | `asc-2gy`, `asc-9y1`, `asc-brt` | Define-time duplicate detection (strictness set by `EV-drift`'s numbers, FTS5 trigram); the record-cost measurement; JSONL export/import. |

**Where the four starter types come from.** ARCHITECTURE.md fixes the shapes
(`review-completed`, `stuck-event`, `stage-transition`, `decision`), and `asc-kwr` carries the
principle that decides what is *not* in them: **anything mechanically derivable is not a property** —
it belongs to E5's adapter. Self-reporting a fact the adapter can read off disk wastes the model's
attention and is less reliable than reading it.

#### E4.1 (`asc-m8n`) — delivered, with the gap stated rather than claimed

`packages/cli/src/{bin,project,output,errors,base,streams}.ts` plus `commands/types/list.ts`. 13
tests in `packages/cli/test/` (10 spawning the **real binary**, 3 on the guard) take the repo to 307.

**The entry point is `src/bin.ts`, compiled to `dist/bin.js` — there is no hand-written
`bin/run.js`.** That is a deliberate deviation from oclif's scaffolding (`oclif generate` writes a
plain-JS `bin/run.js`), and it was chosen for two measured reasons:

- **A `bin/` entry point forces a build-output import.** A hand-written JS file cannot import the
  typed source at runtime, so the pipe guard had to be reached at `../dist/streams.js`. `align` said
  exactly what that costs: *"a dependency routed through one of these is invisible to every
  architecture rule, and a green verdict does not cover it"* — one `unevaluatable-edges` advisory,
  new with this work. With the entry point in `src/`, the edge is `src/bin.ts → src/streams.ts` and
  the advisory is **gone**: `align check` is green with no caveats.
- **A `bin/` entry point cannot be typechecked.** `checkJs` is off, so the error object in its EPIPE
  handler is `any` and `error.code` is an unchecked property read — which is what the typechecker
  caught when the guard lived there.

Cost, stated plainly: `asc` does not exist until the package is built. That is already true of
`main`, `types` and oclif's `commands` directory, and the root `prepare` script builds on
`pnpm install`.

Two facts this rests on, both measured rather than assumed: **`tsc` preserves the `#!/usr/bin/env
node` shebang** byte-for-byte into `dist/bin.js` (so the file stays directly executable), and
**`execute({dir: import.meta.url})` resolves the package root correctly from `dist/`** — version,
command dispatch and help all work from there.

Seven mutations, each applied against the working tree with `shasum`-verified restores (never `git
checkout`, which would have discarded uncommitted work). Re-run after the entry-point change, since
the tests spawn a different file now:

| Mutation | Result |
|---|---|
| M1 default format table → json | caught (1 test) |
| M2 every failure exits 1 | caught (1 test) |
| M3 drop the walk-up | caught (1 test) |
| M4 results → stderr | caught (5 tests) |
| M5 guard exits 1 on EPIPE | caught (1 test) |
| M6 guard swallows every stream error | caught (2 tests) |
| M7 entry point's guard import pointed at a missing file | caught — **by the build, not by behaviour** |
| **M8 `installPipeGuards()` call removed** | **SURVIVED** |

**M8 is the honest gap, and it is measured rather than assumed.** A 64 KiB pipe buffer swallows
everything `types list` can print, so no test spawning the binary can observe the install step. M7
is the weak half of the same fact: it fails because `tsc` cannot resolve the import, which says
nothing about runtime wiring — its behavioural equivalent is M8, and M8 survives. The trigger
arrives with `asc query` (`asc-6ct`), the first command whose output scales with the entry count;
the end-to-end EPIPE test belongs there, and until then the install step is **unproven**.

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
