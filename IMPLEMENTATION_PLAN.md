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
found in E3's own output, `asc-865.1`, now fixed (see below). **E4 (`asc-baj`) In Progress — E4.1
and E4.2 complete, including the six `asc types` subcommands; E4.3 next.** **E12 (`asc-i5tj`, the
git-native JSONL store) In Progress — E12.1, E12.2 and E12.3 as built (the seam and its `asc-i5tj.3.1`
settlement), E12.4 next; `EV-32` and `EV-33` in hand.** The stages are specified
below; cold start is already measured and needs no fast path. 343 tests pass, `align check` is green,
and the CLI suite drives the built binary rather than the handler.

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
| **E4.2** | `asc-6m6` | `asc types define\|list\|show\|brief\|deprecate\|import\|export`. `import` preserves `type_hash`; `brief` is the hook payload and stays one line per type. **Delivered** — see below. |
| **E4.3** | `asc-kwr` + `asc-pcy` | The four starter types (shapes from ARCHITECTURE.md), then `asc init`: `.ascend/`, an **appended** `.gitignore` entry, starter types, and an *offer* of the recall hook — never a settings write (that is `asc-1q9`, E10, behind explicit consent). **Delivered** — see below. |
| **E4.4** | `asc-gvr` | `asc record <type>`: `--json -` primary, flags for convenience, `--na`, batching, and a shape that keeps `Bash(asc record:*)` a valid allowlist prefix. **Dogfooding starts here.** **Delivered** — see below. |
| **E4.5** | `asc-6ct` | `asc query "<sql>"` read-only, `--json\|--table\|--csv`, `--across <glob>`. **Delivered** — see below. |
| **E4.6** | `asc-2gy`, `asc-9y1`, `asc-brt` | Define-time duplicate detection, strictness set by `EV-drift`'s numbers and carrying no similarity threshold (the bead's suggested FTS5 trigram was rejected on those numbers). **Delivered** — see below. The record-cost measurement (`asc-9y1`) and JSONL export/import (`asc-brt`) remain open. |

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

#### E4.2 (`asc-6m6`) — decisions taken before writing it

**`type_hash` is preserved automatically, so `import` verifies it instead of carrying it.** Measured
in the source rather than assumed: `type_hash = sha256(canonicalJson(definitionShape(canonicalize(
spec))))` (`core/hash.ts:221`, `store/registry.ts:166`) — a pure function of the canonical shape,
`name` included. The same definition therefore hashes identically in any repo, so the risk is not
that import *loses* the hash but that the document round-trip is lossy in a field the hash covers,
which would break cross-repo comparability silently and permanently. The exported document carries
`type_hash` and **import recomputes and refuses on mismatch**: ARCHITECTURE.md:279's "preserving
`type_hash`" becomes a check that can fail loudly rather than a property assumed.

| Decision | Choice | Why |
|---|---|---|
| Document format | **one format for define, import and export** | `asc types export \| asc types import -` is then the identity, and there is no second shape to keep in sync. Prose rides in the same document (`description`, `record_when`, `prose`), because it must survive a move between projects and flags are a poor fit for paragraphs. |
| Where a spec is read from | a **file path, or `-` for stdin** | Matches the Unix convention and `asc record --json -`. No default: a missing operand is a usage error naming the fix, never a hang. |
| `asc types show` | **flat key/value rows** (`field`, `value`) for all three formats | The canonical document is `export`'s job. Keeping `show` rows-based preserves `Output`'s single-projection invariant, and a human gets a scannable list instead of a JSON blob elided at 60 characters. A script that wants the document runs `asc types export <name>`. |
| `asc types brief` | **active types only**, one line each, `name — record_when` | The digest tells a model what it may record. Listing a deprecated type invites recording into a retired definition, and `asc types list` is still there for a full inventory. |
| Bare `asc` | prints the **brief** — decided here, **implemented at the entry point, not by oclif** | ARCHITECTURE.md:429: recall is pull-only, so `asc` with no args is the discovery path. The `oclif.default` key this row originally proposed **does not exist in oclif 5.0.0** — see the correction below. |
| `--dry-run` on define/import | **real work, then rollback** — a new `dryRun` option in the store, not CLI-side transaction plumbing | `registerType` already joins a caller's transaction (`store/registry.ts:229`), so nothing new is invented: the same validation, bump diff and view generation run and are then discarded. The store owns transaction semantics; the CLI composing `BEGIN`/`ROLLBACK` would put that knowledge in two layers. |
| `define` on an already-registered shape whose prose changed | **update the prose and say so** | `registerType` returns `unchanged` without writing, so edited prose would otherwise be dropped while the command reported success — a silent no-op in the severity-zero class. `updateTypeProse` exists for exactly this. |
| `deprecate` on an unknown name | **error, exit 1, listing the known names**; already-deprecated is **success reporting no change** | `deprecateType` returns a changed-row count and `0` means two different things. Reporting "deprecated" for a name that does not exist, or for one already retired, is a change that did not happen. |

#### E4.2 (`asc-6m6`) — delivered

`packages/cli/src/commands/types/{define,show,brief,deprecate,export,import}.ts`, plus
`packages/cli/src/{document,input,register-document}.ts` and `packages/store/src/db.ts`'s
`withRollback`. 28 tests in `packages/cli/test/types.test.ts` and 5 in
`packages/store/test/rollback.test.ts` take the repo to **344**. Six mutations, each with a
hash-verified restore — and one of them is the reason the mutation rule exists (below).

**Three severity-zero defects, all found by driving the built CLI rather than by reading the code.**

1. **`--json` silently dropped `dry_run`.** Measured, not guessed: oclif's parsed `flags` object
   carries a key **only when the flag was passed** — `Object.keys(flags)` is `[]` for a bare
   invocation and `['dry-run']` when given — so an absent boolean arrives as `undefined` while
   oclif's own type declares it `boolean`. `JSON.stringify` then omits the property, and a
   consumer cannot tell "not a dry run" from "this command does not report it". Fixed at the
   boundary with `BaseCommand.flagValue`, whose parameter is deliberately `boolean | undefined`
   — the naive `?? false` inside the callers was rejected by lint as redundant, which was the
   compiler correctly reporting that the declared type was a lie.
2. **`import --dry-run` reported version 1 twice where the real run produces 1 then 2.** Per-document
   rollback meant the second document never saw the first, so the preview computed its version as
   though document 1 did not exist. A preview that misdescribes the real run is worse than no
   preview. Fixed by promoting `withRollback` into the store — **one caller-owned transaction for
   the whole list**, so the preview sees its own earlier writes and then discards all of them.
3. **`asc types export | asc types import -` — the pipeline in `import`'s own help text — failed
   every time.** `readInput` called `readFileSync(0, 'utf8')`, and `read(2)` on a **stdin pipe with
   nothing in it yet** returns `EAGAIN`; `readFileSync` surfaces that as a failure rather than
   waiting. Not a race: the CLI's startup is **0.13–0.15 s** (5 runs) while `export` must open a
   database first, so the pipe is always empty at read time. Confirmed deterministic with a
   producer that sleeps before writing — 0.3 s and 1.5 s both fail. Fixed by reading
   `process.stdin` as a stream, where the stream machinery waits for readability. **The suite was
   green throughout, because `spawnSync(…, {input})` buffers the whole input before the child
   starts** — the child never sees an empty pipe. Both pipeline tests now drive a real `sh -c`
   pipeline with a delayed producer, and both fail against the old read (verified by mutation).

**One measurement overturned a decision taken before implementation.** The row above originally
said bare `asc` would be an oclif `default` entry. It is not: **oclif 5.0.0 has no `default`
config key at all** — it does not appear in `config.d.ts` and is read nowhere in `lib/` (grepped in
full). The three measurements that rule out every in-framework alternative are recorded in
`packages/cli/src/bin.ts` beside the fix, which is three lines at the entry point where argv is
already decided.

| Mutation | Result |
|---|---|
| `withRollback` commits instead of rolling back | caught (4 store tests + 2 CLI tests) |
| `import` reverts to per-document rollback | caught (the preview-versions test) |
| `flagValue` returns the raw `undefined` | caught (2 tests, both JSON-contract) |
| `refusal` becomes a usage error (exit 2) | caught (4 exit-code tests) |
| `brief` inverts its active filter | caught (3 tests) |
| stdin read reverts to `readFileSync(0)` | caught (both pipeline tests) |

**The mutation harness caught a false positive in itself, which is the finding worth keeping.**
The first `brief` mutation was `status === 'active'` → `status !== 'never'`. It reported CAUGHT,
but the suite never ran a test: `tsc -b` rejects the comparison as having no overlap, `beforeAll`
threw, and all 27 tests *skipped*. A skipped suite and a failing suite both exit non-zero, so
"CAUGHT" was printed for a build error. Re-run with a mutation that type-checks
(`!== 'active'`), the same three tests failed for the right reason. **A mutation harness must
distinguish "the test failed" from "the run failed"** — otherwise it launders build breakage as
behavioural coverage. The harness prints `failing: (see output)` when it cannot parse a failing
test name, and that line now means **unverified**, never caught: every mutation in the table above
was re-run until the harness named the tests that failed. That, not the code, is what this pass
bought.

**Verification beyond the suite.** The round trip was checked at the database level with `sqlite3`:
`entry_types` in a target project is **byte-identical** to the source (names, versions, majors,
hashes) including the v1→v2 replay, and a re-run reports `unchanged` for both documents and leaves
exactly 2 rows. Dry-run inertness was confirmed in the store itself — 0 `entry_types` rows and 0
generated views for both `define` and `import` — and both partial-failure stories were driven:
the real run leaves 1 committed row with a warning naming the failing document and exits 1, the
dry run leaves 0 rows, emits no rows, and says the preview was discarded.

**Still unproven, and labelled as such:** the EPIPE guard's *installation* (`E4.1`'s surviving
mutation M8) — no `types` command prints enough to fill a 64 KiB pipe buffer, so the trigger still
belongs with `asc query` (`asc-6ct`).

**Two observations from driving, recorded rather than filed.** `dist/bin.js` has **no executable
bit** (`-rw-r--r--`): `tsc` preserves the shebang byte-for-byte but not the file mode, so
`./dist/bin.js` gives *Permission denied*. npm and pnpm set the mode from the package's `bin` field
at install time, so this affects running from the repo rather than the published package — and the
tests invoke through `node` on purpose. Separately, the no-store error tells the caller to run
`asc init`, which **does not exist until E4.3**; it is a forward reference to the next stage rather
than a stale one, and it is called out here so it is not mistaken for a working suggestion.

#### E4.3 (`asc-kwr` + `asc-pcy`) — the one decision that went to the user

**`json` was added to the property vocabulary, and it is a fork because it ships.** Three of the four
starter types carry a list — a review's `findings`, a stuck event's `what_was_tried`, a decision's
`options_considered` — and ARCHITECTURE.md's shapes write them as arrays of objects. The vocabulary
had nine types and none of them could hold that: `text` cannot distinguish a JSON array from prose,
and `string`/`enum` are scalars. The alternatives were to flatten each list into N entries (changing
the document's shape and the meaning of "one entry per event"), to declare the list a `text` holding
JSON (a validator that validates nothing, which is the same as having no validator), or to add a
tenth type. Per `empirical-planning`, this is a schema question with no cheap empirical test — it is
decided by what the product means — so it was the user's to make, and the user chose the tenth type.

**The type is `array-or-object` and refuses scalars, which is its entire reason to exist.** `text`
accepts `"two high-severity bugs"` and the failure surfaces much later, inside some future
`json_each`, nowhere near the entry that caused it — precisely the deferred-failure class this
project treats as severity-zero. `json` refuses it at record time. There is deliberately **no inner
schema** (no per-key types): a nested definition language would not stay small enough for an LLM to
invent correctly at runtime, which is the product's whole premise. That is a real limitation and the
consequence is that the inner shape is *convention*, stated in each property's prose — which is why
the `asc types show` defect below mattered.

**It cost the store nothing, and that was checked before it was built.** The store is type-agnostic
by construction: every property is projected identically as `json_extract(e.properties_json,
'$.<prop>')` (`store/views.ts:202`) with `stateCase` deciding the three-state value (`store/sql.ts:52`)
and one composite expression index per property. `json_type()` returns `'array'`/`'object'` — both
non-NULL, so both read as `measured` and the absent-vs-null-vs-measured model is untouched. **Zero
lines of `packages/store/src` changed.** `canonicalJson` sorts object keys but never reorders arrays
(`core/hash.ts:196`), which is load-bearing here: `what_was_tried` reversed is a different fact, and
a canonicalizer that sorted it would silently rewrite the sequence.

| Decision | Choice | Why |
|---|---|---|
| `json` accepts | **arrays and objects only** | Refusing scalars is the type's reason to exist over `text` (`core/spec.ts`). A scalar is either a `string`, a `number` or a `boolean`, and those types already exist. |
| Inner shape | **unconstrained, guidance in prose** | A nested definition language does not stay small enough for an LLM to invent. The prose is shown by `asc types brief` and is the only place the convention lives. |
| Verdict values | `['approved','changes_requested','rejected']` | ARCHITECTURE.md names the property and not the values. `changes_requested` vs `rejected` is the distinction worth forcing: "the approach holds" and "the approach is wrong" lead to different next actions. |
| `resolution` | five values, **optional** | "Leave it out ENTIRELY if still open" — an open problem is a different claim from `unresolved`, which means stopping for good. Making it optional is what lets the absence carry that meaning. |
| `STATUS` | `['not_started','in_progress','complete']` | Taken from the plan format the projects using this tool already write (`[Not Started\|In Progress\|Complete]`). Reusing a vocabulary someone already types beats inventing a tidier one. |
| `attempt_count` | **required**, and may exceed `what_was_tried`'s length | The count of attempts MADE, not of attempts written down — some are not worth writing down, and forcing the two to agree would make the number wrong to satisfy a test. |
| `tests_passing` | **optional boolean** | `false` asserts the tests were failing; omitting it asserts nobody ran them. A required boolean would collapse those two. |
| Starter prose | **free to change**, and `init` re-registers | `definitionShape` drops prose before hashing, so improved wording lands as `prose-updated` instead of being dropped as `unchanged` — which is why `init` goes through `registerDocument`, not `registerType`. |

#### E4.3 (`asc-kwr` + `asc-pcy`) — delivered

`packages/cli/src/starters.ts`, `packages/cli/src/commands/init.ts` (new), the `json` type in
`core/spec.ts` + `core/schema.ts`, and a fix in `commands/types/show.ts`. **Suite 344 → 365**: 15 in
`cli/test/init.test.ts`, a 4-test `json` block in `store/test/views.test.ts`, one each in the two
`core` vocabulary suites, and a `show` regression test. Six mutations, all caught, all restores
hash-verified.

**Two defects found by driving the built CLI, both silent.**

1. **`asc types show` never printed a property's description.** `registry.ts`'s `toStorage` harvests
   every prose field into its own column *before* the spec is hashed and stored, so
   `row.spec.properties[].description` is **always `undefined`** — the branch rendering it was
   unreachable, and had been since E4.2, whose own test asserted the row's `description` *key* and
   therefore passed while the value was absent. Measured on a real registration: the description
   round-trips through `asc types export` under `prose`, while `show` printed `json` with no
   description at all. Fixed by merging the prose column back before rendering. This is not tidiness —
   with `json` added, a property's description is the **only** place its inner shape is written down,
   so the command was dropping exactly the guidance the starter types depend on.
2. **A guard that could not fire.** `ignoresStore` was written with `if (trimmed.startsWith('!'))
   return false;` to skip re-includes. It is dead: every line is compared by *equality* against four
   spellings, and `!` prefixed onto any of them is unequal to all four. Verified with a one-liner
   before removing it, per the project's own defect class — *"a rule that never fires looks identical
   to a rule that passes."* The behaviour it was meant to guarantee is still correct, and
   `init.test.ts` asserts it (`!.ascend/` must be treated as *not* ignoring the store).

| Mutation | Result |
|---|---|
| dry run creates the store it previews (`:memory:` → the real dir) | caught (`writes NOTHING at all on --dry-run`) |
| `.gitignore` entry glued onto a line with no terminator | caught (`preserves an existing .gitignore`) |
| only one spelling of the ignore entry recognised | caught (`recognises the store in every spelling`) |
| the recall offer printed to stdout instead of stderr | caught (`NEVER writes settings`) |
| the ancestor branch never warns | caught (`warns when an ancestor already has a store`) |
| the shadow check looks at the working directory, not its parent | caught (`is idempotent`) |

**The last two rows are one finding, and it is E4.2's lesson repeating in a new form.** The ancestor
mutation had to be written three times. `if (false)` failed to compile — dropping the condition drops
the block's only use of `ancestor`, which `noUnusedLocals` rejects. `if (ancestor !== undefined &&
false)` *also* failed to compile: **TypeScript treats the true branch as unreachable and drops
narrowings there**, so `ancestor` widened back to `string | undefined` and the `join` inside the
block errored (TS2345, measured). Both forms produced `build=1`, which makes `beforeAll` throw and
**all 15 tests skip** — and a skip list parses as "no failures". The harness caught this only because
E4.2 taught it to, and it printed `MISSED … unverified=1`, not caught. The third form —
`ancestor !== undefined && storeExists`, a semantically real bug — compiles and fails the right test.
The sixth mutation was then added because the first five left the *re-run* case untested: a shadow
check that inspected cwd would find the store it was re-initialising and warn on every run. A warning
that fires always is one nobody reads.

**Four harness facts, measured rather than assumed**, all now recorded in `init.test.ts` beside the
helpers they justify:

- **oclif wraps `this.warn` at the terminal width**, and a warning containing `asc install-hook`
  arrives as `asc` then ` ›    install-hook` — so `toContain` fails on a phrase that is plainly there.
- **It breaks mid-token** when there is no space to break at, inserting the `›` glyph *inside* a
  path. So the flattener has to strip the glyph **before** collapsing the newline that anchors it:
  collapsing first leaves `<tmpdir-id-pre›suffix>`, stripping first without collapsing leaves a
  phantom space. Both orders were measured.
- **`tmpdir()` on macOS is `/var/folders/...`, a symlink to `/private/var/folders/...`**, and the CLI
  prints the resolved form — the same distinction `verifyPragmas` has to survive.
- **Table cells elide at 60 characters**, so prose assertions read `--json`, which `output.ts`
  documents as the untruncated copy.

**Verified beyond the suite**, on the real binary: the four starter types canonicalize with no
renames or warnings and all four views build; `asc init` reports `prose-updated` when a starter word
changes; `--dry-run` leaves a fresh directory **absent** (not empty) and leaves an existing registry
byte-identical; the export → import round trip reports all `unchanged`; and the no-store refusal's
`Run 'asc init'` suggestion now *works* — the loop from E4.2's forward reference is closed and
asserted. The brief is **1,189 bytes over 4 lines**, asserted against ARCHITECTURE.md's ~4.9 KB
`bd prime` benchmark so a later starter cannot quietly double a per-session context tax.

**Two things carried forward rather than fixed.**

- **`tests_passing: true` projects out of a view as `1`.** SQLite has no boolean, so the generated
  view stores the integer. Not a wrong answer — `1` does mean true — but the renderer has to know a
  column is boolean to print `true`, and only the declared type says so. `asc query` (`asc-6ct`) owns
  that decision, and it is the first command with a spec in hand at render time.
  **[CORRECTED at E4.5 — the last clause is false. `asc query` does not have a spec in hand and
  never consults `entry_types.spec_json`: `StatementSync.columns()` reports `type: null` for every
  property-derived column of a generated view, so there is no declared type to render from. The
  problem is re-filed as `asc-6wn` and belongs where the spec IS available — `asc explore` (E6).]**
- **EPIPE installation is still unproven** (`E4.1`'s surviving M8). `asc init` prints more than
  `types list` does but still nowhere near a 64 KiB pipe buffer. The trigger remains `asc query`.

---

#### E4.4 (`asc-gvr`) — delivered, and the one spelling the spec could not have

**The deviation, stated first because it is a deviation.** ARCHITECTURE.md specifies
`asc record <type> [--json -]`. That spelling cannot ship. `--json` was already the versioned-output
contract on **every** command by E4.1 (`base.ts`, `output.ts`), and E4.2 ships a test asserting the
JSON contract — so on `asc record`, `--json` would carry two meanings, and `asc record x --json -`
versus `asc record x --json` would differ by an *operand that changes what the flag means*.

**Resolution: the document is an operand.** `asc record <type> [file|-]`. Nothing the spec asked for
is lost — stdin is still the primary path, `readInput` still handles `-`, flags are still the
convenience — and it matches `asc types define|import`, which have read their document from an
operand since E4.2. One convention for "read a document from stdin" across the whole CLI is worth
more than the exact spelling of one flag, and `asc-6ct` (`asc query`) does not read a document at
all, so the convention has no second chance to diverge.

**Decisions taken here, with the reason they are not forks.** Same standard as E4.1/E4.2: a fork is
something load-bearing *and* expensive to reverse. None of these are — each lives inside one file or
one function body.

| Decision | Choice | Why |
|---|---|---|
| `--prop=<name>=<value>` split on the **first** `=` | first, never last | `core/state.ts`'s `recordCommand` writes that exact spelling into **every** validation error it generates. A parser accepting anything else would make ascend's own suggested fix a command that fails. Splitting on the last `=` breaks the moment a value contains one (a URL, an expression, base64), and the test drives `depth = path.length` through it. |
| Flag values | **JSON when they parse, the raw string otherwise** | `--prop=rounds=3` sets the integer 3 without the caller learning a convention. A value cannot be silently mistyped: every property type refuses a wrong shape (`core/schema.ts`), so a bad guess is a loud refusal, never a plausible wrong value in the ledger. Cost: a `string` property holding exactly a JSON literal needs `--prop=note='"3"'` — documented in the code, because it is the correct direction to fail. |
| Entry flags vs. call-level flags | **two kinds, only the first conflicts with a document** | `--prop`/`--na`/`--evidence` describe *an entry*, so document + any of them is two answers to one question: a **usage error**. `--type-version`, `--run-id`, `--workflow`, `--actor` describe *the call*, so they are defaults for a batch — a caller recording ten entries should not repeat the run id ten times. A flag is a default an entry may override; the test asserts both directions. |
| `source` | always `'self'`, never settable | An entry's document may not name it (`entry-document.ts` carries the reason). Only the thing doing the deriving may claim derived provenance. |
| `recorded_at`, `id` | **minted in the command** | `TASKS.md` #6: core and store are pure and take both injected. One clock reading per call, so a batch's entries differ by what the caller said rather than by how long validation took. |
| `cwd` | read from the process; `repo`/`git_sha`/`branch` **deferred to E5** | Same deferral E4.1 recorded: they mean spawning `git` on the exact path `asc-9y1` exists to measure. |
| A batch | **all-or-nothing** | See `withTransaction` below. |

**`withTransaction`, and why the store grew a function.** SQLite's default is autocommit, so without
a transaction a batch whose fourth entry fails validation leaves the first three **permanently**
written — entries are immutable and cannot be deleted — while exiting non-zero and naming one
failure. The caller then holds a partial batch it was told failed and cannot even re-run it, because
the ids it would reuse now collide. With the transaction, the exit code describes the whole store:
**0 means every entry is there, 1 means none is.**

`withTransaction` is `withRollback`'s commit half, and the two now share a private
`inOwnScope(db, ending, body)` — one owner for the opening, the ending and the failure path, because
two copies of a rule with one owner is how the owner stops being one. The `--dry-run` path is the
*same work* inside `withRollback`, so a preview cannot report an outcome the real run would not
produce. `transaction.test.ts` proves both directions, plus the property that makes a batch coherent:
**the body sees its own earlier writes**, which is what lets a duplicate id inside one batch be
caught at all.

This paragraph used to name `inOwnTransaction(db, caller, ending, body)`, to call the shared thing
"one nesting guard", and to claim 7 tests. All three stopped being true at E12.4b3, which retired the
guard when it needed a preview to sit **inside** a write's transaction; the file has 11 tests now.
The argument above is unchanged and is why the shared half exists at all.

**`json-fields.ts` exists so two wire formats cannot disagree.** `isJsonObject`, `describeValue` and
`fieldError` moved out of `document.ts` (`asc types`' format) so `entry-document.ts` reports a bad
field *identically*. `fieldError` is annotated `(...) => never`, which is load-bearing for narrowing,
not decoration.

**Two defects found by driving, not by the suite.**

- **A batch failure did not name the failing entry.** A two-entry batch whose second entry was
  invalid produced the store's message — precise about the *problem*, silent about *which entry* —
  leaving a fifty-entry caller to bisect it. The store cannot know the index (it records one entry
  and has no idea it was called in a loop), so `withEntryIndex` adds it where it is known, and
  deliberately does **not** wrap `UnknownTypeError`, which is about the call rather than any entry
  and already lists the types that exist.
- **A command class named `Record` shadows TypeScript's built-in `Record<K,V>` for the whole file**
  (`TS2315: Type 'Record' is not generic`, plus cascading errors). Renamed `RecordEntry`; oclif takes
  the command id from the **filename**, so `asc record` is unchanged.

**A consequence worth stating, because it is real and was measured.** Entries in one batch **tie** on
`recorded_at`, and `stored()` orders by that column — so a test asserting the batch's *insertion
order* would be asserting a tie-break. The first version of
`lets a call-level flag act as a default` did exactly that and failed with `['entry-level','call-level']`.
The assertion is now keyed by `chosen`. This is correct rather than a limitation: one call recorded
them as a **set**, within-set order was never a claim this command made, and the report's `index` is
the only place the caller's order exists.

**Mutation-verified — 13 mutations, caught 13, unverified 0.** Because a check that has never been
shown to fail is not evidence:

| Mutation | Caught by |
|---|---|
| Real path uses `withRollback` instead of `withTransaction` | `writes an entry from flags…` |
| No transaction at all (batch commits piecemeal) | `is all-or-nothing` |
| `withTransaction` ends with `ROLLBACK` | `keeps what the body wrote…` |
| The shared guard never rolls back a failed body | `keeps NOTHING when the body throws` |
| A failed entry is not named in a batch | `says WHICH entry failed` |
| Every entry prefixed, even a lone one | `does not prefix the index onto a single entry` |
| Flag values are always strings | `stores an empty json array as a measurement` |
| `--prop` splits on the last `=` | `splits --prop on the FIRST =` |
| The document's `id` is ignored | `honours an id the document names` |
| Call-level flags overwrite what an entry said | `lets a call-level flag act as a default` |
| `cwd` is recorded as something else | `fills in the provenance it can read` |
| Document + entry flags are merged instead of refused | `refuses a document and entry flags together` |
| An empty `--na` name is accepted | `refuses --na with an empty name` |

**Three mutation forms were rejected because they fail the BUILD, and a build failure skips every
test in the file — which parses as "no failures."** This is E4.2's lesson recurring, so each was
measured rather than guessed:

- `cwd: undefined` → `TS2375` under `exactOptionalPropertyTypes`. Rewritten as `cwd: ''`, which
  compiles and fails the test on its merits.
- `if (true || error instanceof UnknownTypeError)` → `TS18046: 'error' is of type 'unknown'`, one
  line below. TypeScript treats the branch as unreachable and **drops the narrowing** there — the
  same unreachable-branch narrowing family E4.3 hit, and the second time it has invalidated a
  mutation in this repo. Rewritten using both parameters (`total <= 0 || index <= total`), which is
  still semantically never true.
- `if (false) {` for the document+flags guard, guarded by `noUnusedLocals` in E4.2's case; here it
  compiles and was caught.

**A lint rule was the false signal this time, and it was fixed rather than suppressed.** eslint's
`no-unnecessary-condition` reported the rollback in `inOwnScope` as "value is always falsy". It was
reading a **stale narrowing**: `@types/node` declares `readonly isTransaction: boolean`, so
TypeScript narrows it to `false` after the check above and then *keeps* that narrowing across
`db.exec('BEGIN')`, unable to see that a method call changed the property. The branch is
load-bearing — deleting it fails `keeps NOTHING when the body throws` (CAUGHT above). There is **no
`eslint-disable` anywhere in this repo's source**, so the fix is a `hasOpenTransaction(db)` helper
whose function boundary is outside the narrowing's reach, documented with that measurement.

**Verified beyond the suite**, on the real binary: flags, stdin and file documents all produce the
same stored row; all three states survive into `properties_json`, `na_json` **and** the generated
`v_*` view; a refused value writes **nothing**; the suggested fix regex-extracted from stderr
actually works; a failed batch leaves **0 rows**; `--dry-run` reports rows while storing none;
provenance is `cwd` = the process's resolved directory and `source` = `self`; and `stored()` reads
`v_<type>_v<version>` spelled literally, so a naming change is noticed.

**Gates:** `format:check` ✅ · `typecheck` ✅ · `lint` ✅ · **406 tests** (365 → 406; +34 `asc record`,
+7 `transaction`) · `align check` **green, 19 baselined — 0 new debt**.

**Carried forward to `asc-6ct`, all three now measured rather than predicted.**

- **`tests_passing: true` projects out of a view as `1`** (E4.3's item, unchanged). SQLite has no
  boolean; only the declared type tells a renderer otherwise.
- **A `json` property projects as a JSON *string*.** Found by dogfooding, not by the suite: the
  `options_considered` column of `v_decision_v1` reads back as
  `"[\"Keep --json - …\",\"…\"]"` — `json_extract` returns the JSON *text* for an array or object, so
  a consumer must `JSON.parse` it. `1` and `"[…]"` are the same defect shape: **the view holds
  SQLite's representation of a value, and the declared type is the only place the intended one
  exists.** `asc query` is the first command with a spec in hand at render time, so it owns both.
  **[CORRECTED at E4.5 — "has a spec in hand" is false; see the same correction under E4.3. The
  declared-type question is `asc-6wn`, and the fix belongs in `asc explore` (E6).]**
- **EPIPE installation is still unproven** (E4.1's surviving M8). `asc record` prints one row per
  entry — nowhere near a 64 KiB pipe buffer. The trigger remains `asc query`.

**Dogfooding has started**, as this bead's close requires: `asc init` was run in this repository
(`.ascend/` created, four starter types registered, `.gitignore` already ignored it), and the first
real entry is this stage's own `--json` decision — recorded through the primary stdin path with
`--run-id e4.4`, then read back **independently of `asc`** through `node:sqlite` to confirm the
envelope, the `source: self`, the process-read `cwd`, and the `v_decision_v1` projection.

---

### E4.5 — `asc query`, and the store's first read-only connection (`asc-6ct`)

**Delivered.** `asc query "<sql>"`, one read-only statement (table / `--json` / `--csv`), plus
`--across <glob>` which `ATTACH`es every matching project under its own name and reports the names
on **stderr**. The read-only open is the command's design, not a flag: `Bash(asc query:*)` is a
defensible `settings.json` allowlist entry **only because the connection has been shown unable to
mutate**, so it is asserted against the file through a second connection rather than trusted from a
refused statement.

Supporting changes: `OpenOptions.readOnly` + `StaleStoreError` (`packages/store/src/db.ts`),
`attachStore` / `detachStore` / `databaseNames` / `AliasInUseError` (`union.ts`), `statementCount`
(`packages/cli/src/sql.ts`), `normalizeValue`/`normalizeRow` (`query-values.ts`), and
`openQueryProject` (`project.ts`) which falls back to an **in-memory** store when there is no project.

**Two overturns. Both are records of the design being wrong, kept rather than smoothed over.**

1. **`asc query` does NOT have a declared type in hand — E4.3/E4.4 carried that forward twice, and it
   is false.** Measured: `StatementSync.columns()` gives `type: "TEXT"` for `entries.id` read through
   `v_decision_v1` (SQLite resolves a view column's decltype when it is a direct reference to a real
   column), but **`type: null` for all 8 property columns of that view**, for every expression
   (`1+1 AS two`), and for `json_extract(...)`. So there is no declared type to render from, and the
   command reports SQLite's representation — `1`/`0` for a boolean, JSON **text** for a `json`
   property, a hex literal for a blob, a decimal **string** for an integer outside `Number`'s safe
   range. `--help` states this, because it is not discoverable from a row. The carried-forward claim
   that `asc query` "owns" the declared-type problem is withdrawn; the problem stays open and is
   re-filed rather than inherited.

2. **E4.1's stated reason for M8 surviving is refuted.** M8 (the stdout EPIPE guard) was said to
   survive because no command fills a 64 KiB pipe buffer. Measured: `@oclif/core/lib/command.js:57`
   installs **its own** `process.stdout.on('error', …)` at module load, commented *"this occurs when
   stdout closes such as when piping to head"*. Removing ascend's guard changes nothing observable on
   stdout. The test now asserts **what it can actually show** — that the pipeline works — and says in
   as many words that it is not evidence ascend's own guard is installed. M8 **stays open with a
   corrected, measured explanation**. (Its stderr half remains untriggerable: no command can put
   64 KiB on stderr.)

**A real correctness bug found by measurement, in two parts, and the half-fix was caught before it
shipped.** `SELECT 1 AS x, 2 AS x` is legal SQLite. `columns()` reports two columns named `x`, and
`all()` returns `[{x: 2}]` — the row is built as an object keyed by SQLite's own column names, so the
first value is **gone**, with no error anywhere. Severity-zero class. The first attempt renamed the
duplicate column (`x`, `x_2`), which is necessary but **not sufficient**: the collision happens
*inside the driver*, so the header then advertised `x_2` over an empty cell — a column that does not
exist, in place of a value that was dropped. Measured on the real binary, which is how it was caught.
The fix is both halves together: `statement.setReturnArrays(true)` (same statement, same query:
`[[1, 2]]` instead of `[{x: 2}]`) plus the rename, with `zipRow` applying the disambiguated names.
The test asserts the **table** line as well as the JSON keys, which is the assertion that would have
caught the half-fix.

**Measured driver facts recorded, not fixed:**

| Fact | Value |
|---|---|
| `setReadBigInts(true)` is mandatory, not an optimisation | a default statement doing `SELECT 9223372036854775807` **throws** `RangeError: Value is too large to be represented as a JavaScript number`; with the flag it returns `bigint`. It costs: every integer becomes a `bigint`, and `JSON.stringify` then **throws** — which `normalizeValue` pays off |
| `SQLITE_READONLY` | `errcode: 8`, masked with `0xff` to catch SQLite's extended codes |
| `Math.max(...rows.map(...))` | dies at ~124,179 arguments; `asc query` hit `Maximum call stack size exceeded` at ~119,726 rows. Fixed by folding with `reduce` in `output.ts` — a latent bug only `asc query` could reach |
| `db.prepare()` runs only the FIRST statement | `'SELECT 1 AS a; SELECT 2 AS b'` → `[{"a":1}]`, silently. This is what `statementCount` refuses |
| A comment-only string is not a statement | `db.prepare('/* c */')` throws `statement has been finalized` |
| `column.name` is never null | an unnamed column is named after its expression text (`SELECT 1` → `"1"`), so a null guard there is dead code |
| `@types/node` does not follow `setReturnArrays` | `all()` stays declared `Record<string, SQLOutputValue>[]`, so the cast goes through `unknown`. The type is **silent**, not wrong |

**Mutation testing: 11/11 killed.** Every guard in the new code — `columnNames`, `setReturnArrays`,
`setReadBigInts`, `requireSingleStatement`, `statementCount`, the readonly `errcode` check, the CLI
and store duplicate-project checks, `AliasInUseError`, the read-only open, and the stale-store check.

**The mutation harness itself reported a false green, twice, and both were fixed rather than noted.**
A `-t` filter that matches no test *name* runs **zero** tests and vitest **exits 0** — indistinguishable
from a surviving mutation. So the harness now refuses a zero-testrun. Its first guard parsed the first
number on the `Tests` line (measured: a no-match run prints `Tests  11 skipped (11)`, so it read 11 and
never fired); its second parsed `N passed` (measured: a killed *single* test prints
`Tests  1 failed | 10 skipped (11)` with no "passed" at all, so it read 0 and mis-reported every kill).
The guard now sums the non-skipped counts, which is the only quantity that means *something was
exercised* — and it is proved to fire by a `--control` mutation whose whole job is to be unrun.

**Gates:** `format:check` ✅ · `typecheck` ✅ · `lint` ✅ · **444 tests** (406 → 444; +27 `asc query`,
+11 read-only store) · `align check` **green, 19 baselined — 0 new debt**.

**Carried forward, re-filed with the corrected statement above:**

- **The declared-type problem is unsolved and now correctly located.** A `json` property and a
  boolean property both project as SQLite's representation, and `columns()` cannot tell them apart.
  What can: the **type spec** (`entry_types.spec_json`), which `asc query` does not consult. Any fix
  belongs where the spec is available — `asc explore` (E6) or a `--typed` projection — not in a raw
  SQL runner. Filed rather than left as a sentence in this plan.
- **M8 (EPIPE proof) stays open**, with the oclif handler named as the reason it cannot be closed by
  observation from stdout.
- **`--across` reads only the store file**; it does not consult `unionEntries` (E3), so a project
  whose type is defined elsewhere is attached but not unioned. Deliberate for a raw-SQL runner.

---

### E4.6 — Define-time duplicate detection (`asc-2gy`)

**Delivered.** `confusableNames` / `nameTokens` / `ConfusableName` in the **pure** core
(`packages/core/src/names.ts` — no `fs`, no clock, no database), and `registeredNames(db)` +
`vocabularyNotes(db, spec)` in `packages/store/src/registry.ts`. The notes leave on
`registerType(...).warnings`, the array `asc types define` and `asc types import` were **already**
printing, so the detection arrived with **no new CLI surface and no new flag**: a caller who never
learns the mechanism still sees the warning. "Search before you define" as an instruction would have
failed; this is the search, in the tool.

**Strictness is set by `EV-drift`'s numbers, not by taste — and the numbers argued against the
obvious design.** Five agents, one brief, one type name, one bounded vocabulary: **44 distinct
property names of which 4 were shared by all five** — intersection/union **9.1 %**, mean pairwise
Jaccard **0.300**. The thresholds that would have confirmed the vocabulary as sufficient are
intersection/union ≥ 0.70 and Jaccard ≥ 0.6. So two independent definitions of the *same* concept
agree on 0.300 of their names: a refusal threshold high enough to mean anything sits **above** the
same-concept score and refuses legitimate work, and one low enough to admit same-concept definitions
admits everything. **At a 0.300 signal, similarity cannot separate "same concept, new name" from
"different concept."** The mechanism therefore **warns and never refuses, and carries no similarity
threshold at all** — it reports a known name when it shares a **whole token** (`review_kind` against
`kind`), which is a *certain* relation, so there is no floor to pick and therefore no number to
invent. What genuinely can be refused is already refused elsewhere and needed no threshold to get
there: a name colliding with a reserved envelope column (`reservedPropertyName`), and two properties
folding to one name inside a single spec (`canonicalizeTypeSpec`). The second of those two was
asserted here before it was true -- the collision warn-and-registered until asc-4if moved it to
`errors` -- which is the reason both sites are now named rather than described.

**The bead's proposed mechanism was not built, and the rejection is on measured grounds.** `asc-2gy`
suggested the cheap version be *"FTS5 trigram (mast precedent)"*. A trigram index answers "which
stored strings are *similar*", which is the question the numbers above just ruled out — it would
need exactly the cutoff that cannot be chosen, and it would be a second structure to keep in sync
with names `canonicalName` has already folded. Measured scale of what replaced it: the entire
vocabulary on the real corpus is **44 names**, and the widest match set any name produces is **6**.
At that size a linear scan over a sorted list is free, and it is checkable by reading it.

**The check reads `entry_types` BEFORE the insert, and the ordering is load-bearing rather than
tidy.** Read after, this spec's own name is already in `entry_types` (so `isNewName` is false and the
type-name half never fires) and its own properties are already in the stored specs (so they are
skipped as "already registered" and the property half is inert) — a check that reports nothing looks
exactly like a check that found nothing wrong. Two tests distinguish the two orderings instead of
describing which one was chosen.

**The type-name half is gated on the name being genuinely new.** `registerType` returns `created`
for a new *version* too, so without the gate every future bump of `stage` would reprint "shares
`'stage'` with `'review_stage'`" — a true sentence, on every bump, until the author stopped reading
the channel. The property half is the mirror image: a new property whose name is **already
registered** is silent, because reusing a registered name *is* the outcome `EV-drift`'s remedy
asked for, and warning about it would train the author to ignore the channel on the behaviour the
mechanism exists to encourage.

**Three defects found by driving the real binary — none of them by a test.** All three are now
asserted.

1. **`Warning: warning: …` on every store warning.** oclif's `this.warn` already renders a
   `Warning:` prefix, so the CLI's own `warning: ` doubled it. Present at `define.ts:67` and
   `import.ts:119` since E4.2/E4.3 — **shipped for three stages because no test asserted the shape of
   the rendered line.** A warning channel nothing asserts is a channel that can be broken without
   anyone noticing, which is the false-green class this project treats as severity-zero.
2. **A message that named three matches when there were six.** An earlier `confusableNames` took a
   `limit` and sliced internally, so the one caller that formats a message could not tell "there are
   exactly three" from "there were three and I was not shown the rest". The matcher now returns
   everything it found and the presenter decides how much to print **and says when it truncated**
   (`… 'stage_a', 'stage_b' and 'stage_c', and 2 more`). A matcher returns; a presenter presents.
3. **`'a', and 'b'` for two matches.** The serial comma is right for three and reads worse than the
   plain conjunction for two.

**A real instability, found by asking the result to be stable.** The reported spelling of a folded
name originally depended on the caller's array order — reversing the corpus returned `started_at`
where it had returned `startedAt`. Fixed structurally by walking candidates in canonical-then-spelling
order inside `confusableNames`, so the promise rests on a contract in this module rather than on
`registry.ts` happening to sort. Same pass: `localeCompare` with no locale argument collates by the
runtime's default locale, so the same name set orders differently under a different `LANG` —
environment-dependent output is the ambient-state problem, not stability. Replaced with a code-unit
comparator at both sites.

**Mutation testing: 14/14 killed**, including the check never being called; **the read deferred to
after the insert**; the registered-property skip removed; the `isNewName` gate removed; a
latest-version-only registry read; exact matches no longer skipped; dedup removed; tokens taken from
the raw spelling; candidate order not sorted; the most-shared-first sort dropped; the matcher capping
its own list again; truncation not reported; the printed list unbounded; the two-name conjunction
taking a comma. The harness's zero-test guard (carried from E4.5, where it was itself a false green
twice) was proved to fire by a `--control` mutation whose whole job is to be unrun.

**One harness hazard, recorded because it cost a confusing re-drive cycle.** The CLI test file's
`beforeAll` runs `tsc -b`, so a mutation script that mutates a **CLI** source file and runs a **CLI**
test has `dist/` rebuilt from the mutant; restoring only the source leaves a stale mutant `dist/`.
The doubled-prefix fix appeared not to work on the real binary for exactly this reason. Restoring
requires `pnpm build`, not just the source restore.

**Gates:** `format:check` ✅ · `typecheck` ✅ · `lint` ✅ · **479 tests** (444 → 479; +14 core
`names`, +15 store `vocabulary`, +6 CLI) · `align check` **green, 19 baselined — 0 new debt**.

**Still open in E4.6:**

- **`asc-9y1` (P1, empirical)** — *what does one `asc record` call cost?* Tokens (command + output)
  and wall-clock across 20 **real** recordings; p50/p95; and confirmation that no permission prompt
  fires with the allowlist entry. Decision rule fixed in advance: *if a record costs more than a few
  hundred tokens, simplify the surface BEFORE E5.*
- **`asc-brt` (P2)** — `asc export` / `asc import` (JSONL) as the durability escape hatch.

---

### E12 — the git-native JSONL store (`asc-i5tj`), in stages

**Goal** — records live in git as per-type append-only JSONL with `merge=union`, read through a
storage-neutral layer, with a **derived, rebuildable** index behind it. `asc-i5tj` blocks four other
beads (`asc-2ezs`, `asc-98e1`, `asc-8uzh`, `asc-3ow4`), each of which guards files that do not exist
yet, so this is the item everything else in the storage line waits on.

**The owner ruling, and why a derived index does not contradict it.** `asc-i5tj` carries an owner
decision: *"either/or, never both. JSONL is the store (developers branch and merge it); SQLite does
not coexist as a second source of truth."* The index is **derived and rebuildable**, which is not a
source of truth — it can be deleted at any moment and reconstructed from the JSONL alone. It is a
cache with a correctness invariant attached (it must never hold anything the JSONL does not). The
rule this must respect is therefore: **no write may ever land in the index that is not first in the
JSONL**, and a test must assert it.

**EV-constraints carried in (`EV-32`, measured 2026-09-28 at full scale):**
- **A cold rebuild costs 3.02 s at this project's 6,329 entries (7.77 MB JSONL → 22 MB index) and
  40.27 s at 63,290 (71 MB → 206 MB).** 13.3× the time for 10× the records. Rebuild-on-open is out;
  the index persists and is rebuilt only when its inputs change.
- **Hashing the whole JSONL set costs 0.05 s at 7.8 MB and 0.24 s at 71 MB** — affordable on every
  open. Use a **content hash, not mtime**: `git checkout` stamps mtimes with the current time even
  when content returns to an already-indexed state, so mtime forces a spurious multi-second rebuild
  on every branch switch.
- **Because the rebuild is wholesale-cheap, there is no incremental path.** Wholesale-or-nothing
  behind the fingerprint: no partial rebuilds, no per-record index bookkeeping.
- **A single write costs 0.19 s end-to-end at both 21 MB and 208 MB** — below process startup, i.e.
  invisible. A write is "append one JSONL line, then apply that one record to the index".
- **The 20 MB rollover cap is near-dead code at measured sizes** (entries mean 840 B; 5,000 records =
  4.1 MiB; the cap binds only above a 4,194 B mean, against a 2,697 B p99). The record-count
  threshold binds first by ~5×. Carried into `asc-8uzh`.

**Layout** (a decision made here, `git mv`-reversible but committed, so recorded rather than assumed):

```
.ascend/
  .gitattributes              records.jsonl merge=union   (and the other record files)
  types/          0001.jsonl  append-only: `type` lines, content-addressed
  entries/<type>/ 0001.jsonl  append-only, rolled at 5,000 records
  annotations/<scheme>/0001.jsonl
  index.db                    DERIVED. gitignored. delete it and it rebuilds.
```

`.ascend/` stays the marker directory — `findProjectRoot` already keys on it and `STORE_DIR` is
already `.ascend` — so the change is to **un-ignore a subtree** of it rather than to move the store.
The directory names mirror the corpus's four `kind` values, so `asc export` remains the same shape
as the store itself.

**Stages:**

- **E12.1 — the record layer, standalone.** `serialize`/`parse`/`append`/`read` over the four line
  kinds, the `.gitattributes` emission, rollover at the 5,000-record threshold, and `(recorded_at,
  id)` read ordering. No index, no CLI wiring. Green when the spike's S1–S4 fixtures round-trip
  through it line-for-line.
  - **As built (2026-09-29, `packages/store/src/jsonl-files.ts`).** The acceptance sentence above is
    not literally executable: the spike's layouts are `records.jsonl` / `records/<day>.jsonl` under a
    flat `types.jsonl` (`spike/git-layout/run.mjs:65-69,115`), which is NOT the layout this stage
    implements, so its fixture FILES cannot round-trip through this layer as files.
    **The criterion was not met in substance either, and the first version of this note claimed it
    was.** That claim — "rewritten in substance rather than in letter" — was refuted by a review: the
    spike's record generators are pure, layout-independent data and ARE replayable, and for a
    `merge=union` layout "round-trip" means *survives a MERGE*, which is where the design's whole risk
    lives. The substitute (scenario structures plus a real-corpus round trip) never performed one. The
    gap was not academic: a real merge duplicates a shared derived record, and the reader returned it
    twice. What exists now is `spike/git-layout/merge-replay.mjs` — it writes a tree WITH the layer,
    merges it with real git, and reads it back WITH the layer: **exit 0, 0 conflicts, the shared
    record twice on disk, 3 distinct records read, none lost and none duplicated.** The same run also
    refuted a simpler story: git's union merge emits an identical line ONCE when both sides add it as
    one aligned region, and TWICE when they interleaved it with their own work differently — so the
    duplication is positional, and a reader cannot delegate this to git.
  - **Two deviations from the text above, both evidence-driven.** (1) `<type_name>`/`<scheme>` path
    segments are a readable slug plus a 12-hex digest of the name, not the name and not an assumption
    that it is canonical: `requireName` (`annotations.ts:394`) refuses only the empty string and the
    reserved name, so a scheme name is ANY string and the real corpus holds `hand-denial`. A refusing
    guard threw on this project's own store the first time it saw real data; a percent-encoding draft
    replaced it and was not injective (`'\uD800'` and `'�'` encode to the same bytes), not
    bounded (29 CJK characters → a 261-byte directory → ENAMETOOLONG mid-write), and not case-safe
    (`Review`/`review` are one directory on APFS and two on Linux). (2) `(recorded_at, id)` ordering is
    applied to annotations as well as entries -- they partition by name exactly as entries do, so a
    union merge can reorder them, and nothing about an annotation's meaning depends on file order. The
    bead named entries only; this applies its rule by its own reason.
  - **Nine findings from an adversarial review, all fixed.** The review ran on the same model as the
    authoring session and its findings were recorded through `ReportFindings`, so they are countable
    rather than prose. Two were false greens (reversing the reader's file sort, and deleting the head
    cache, each left the suite green), and each was fixed by making its test able to fail — then
    verified by re-running the mutation and watching it fail. The others: `merge=union` duplicates a
    shared record and the reader did not dedupe; the partition segment's three defects above; a bare
    `catch` swallowing EACCES so an unreadable partition vanished; a record file directly under
    `entries/` never being opened; and a non-positive `maxRecordsPerFile` silently starting at 0002.
- **E12.2 — the index.** Build `index.db` from a JSONL tree; store the fingerprint; on open, hash →
  compare → rebuild-wholesale or use. The invariant under test: **an index holding anything the
  JSONL does not is a failure**, asserted by deleting and rebuilding.
  - **As built (2026-09-29, `packages/store/src/jsonl-index.ts`), 21 tests.** Deliverables: a content
    `treeFingerprint(root)`; `buildIndex(root, dbPath, { now })` — a fresh store, migrated, replayed
    from the tree line by line and published atomically; and `openIndex(root, dbPath, { now })` —
    fingerprint → match, return; differ, rebuild wholesale. Shared with the reader: one traversal
    (`recordFiles`) decides which files exist for BOTH the reader and the fingerprint, and the
    line→row mappers moved into `replay.ts` so `asc import` and the index cannot drift into two
    spellings of one record.
  - **The drift that sharing prevents is guarded by a test of the RELATION, not of either side.**
    `packages/cli/test/import-vs-index.test.ts` runs both drivers over one corpus — the index build
    from a laid-out tree, `asc import` as the real binary in a real project — and compares every
    observable row of the two stores. Neither driver's own suite can catch a divergence between them
    (each is green on its own), and the failure mode is not a crash: it is two stores that both report
    success, hold different rows, and disagree about `asc kappa` while every count looks plausible.
    **Verified by mutation, twice**, watching it fail both times: collapsing the two annotation passes
    into one timestamp (caught, via the store's own "already has a pass at this timestamp" refusal) and
    dropping one `note` in the index's replay only (caught by the row comparison, with no error
    raised — the silent-value class this file exists for). `entry_types.created_at` is excluded by
    name for the reason below; `asc import` is driven into a store with NO starter types, because an
    `init`ed target carries four `entry_types` rows the tree does not and the comparison would fail
    over a difference that is not a divergence.
  - **Five decisions taken here, each recorded with its reason rather than assumed.**
    (1) **The index is opened READ-ONLY.** This is what makes the bead's invariant structural rather
    than conventional: if no caller can hold a writable handle, then no write can land in the index
    that is not first in the JSONL, because the only thing that writes the index is a rebuild *from*
    the tree. The test asserts the refusal (`attempt to write a readonly database`) rather than
    relying on callers to behave. Precedent: `openStore`'s own `readOnly` doc — the permission is
    defensible because the handle has been shown unable to mutate.
    (2) **The fingerprint lives in the index's own `meta` table, not a sidecar file**, because a
    sidecar can desync from the index it describes — a fresh fingerprint beside a stale index is
    exactly the false-green this stage exists to prevent. Written LAST, and the whole build is
    published by `renameSync` from a temp file, so a build that dies half-way leaves the previous
    index untouched rather than a partial one claiming to be current. Probed before adopting:
    `node:sqlite`'s `close()` checkpoints and removes the `-wal`, so the renamed file is complete and
    self-contained (no residual `-wal`/`-shm`), and it still reads back as `journal_mode = wal`.
    (3) **The fingerprint is over the record files' BYTES, keyed by relative path**, not over the
    parsed records. EV-32 measured the cost this buys and the reason it must be content rather than
    mtime; hashing bytes keeps that cost on a cache HIT, which is the path that runs on every command.
    The price is conservatism: a re-partition or a union-merge concatenation changes the bytes and
    forces a rebuild even though the record SET is unchanged. That is the correct direction to be
    wrong in. **EV-33 re-measured it in-process: 0.01 s at 7.84 MB and 0.04 s at 71.13 MB warm**
    (0.20–0.24 s cold), against EV-32's 0.05/0.24 measured by invoking a hasher as a process.
    (4) **A non-ascend file at the index path is REFUSED, not overwritten**, while an ascend file
    whose fingerprint disagrees is rebuilt. `openIndex` never repairs an index, only replaces it —
    and the existing `ForeignStoreError` guard exists precisely so ascend does not write into a file
    it did not create. The cost of refusing is one `rm`, and the index is derived, so that is cheap.
    (5) **Three claims a line makes are verified against the store's own answer, and a disagreement is
    refused rather than silently taken.** `registerScheme` numbers from the store's history (so a
    line's `version` can be reinterpreted), `registerScheme` computes `scheme_hash` from the spec it
    was handed (so a line's `scheme_hash` can too), and `recordEntry` writes the hash of the resolved
    definition (so a line's `type_hash` can). Each would produce an index holding something the JSONL
    does not, invisibly — the row count and every query still work. This is the narrow version of the
    merge guard `asc-98e1` owns; the wide net is E12.5.
  - **A constraint the package's own guard imposed, and it changed the API.** The first draft of
    `replayType` called `new Date()` for `entry_types.registered_at`, and `recorder.test.ts`'s "reads
    no clock and draws no randomness, in any module" scan caught it — the guard working exactly as
    designed. The clock is injected at the command boundary (`BaseCommand.now()`), so both functions
    take `IndexOptions.now`. It is required rather than optional so there is one signature, and
    documented as consulted only when a build actually happens.
  - **The measurement EV-32 explicitly left open, now taken (`docs/evidence/EV-33.md`).** EV-32 timed
    the rebuild through `asc import` as a *proxy* and guessed it was an upper bound; it is not, by
    about **1.2×** (user time 45.4 s real vs 38.1 s proxy at 10×). **EV-32's absolute 10× figure is
    not reproducible on this machine today** — its own proxy re-run on the same corpus shape takes
    63.19/67.98 s where EV-32 recorded 40.27 s — which is why both arms were re-run same-day rather
    than cited. The architectural decisions are unchanged and rest on firmer numbers: cold build
    **2.97 s at 6,387 entries** and **~75 s at 63,870**; cache-hit open **0.01 s / 0.05 s**; index
    **2.86×** its JSONL at both sizes.
  - **One thing EV-32 could not have seen, and it is a design input for E12.3.** A rebuild is ~75 s at
    10×, and `openIndex` on a fingerprint miss rebuilds with **no signal, no progress and no warning**.
    A user running a read would sit through it unable to tell "working" from "hung". At EV-32's 3.02 s
    this was invisible, and the cache-hit path (0.05 s) is fine in isolation — the defect is the
    *silence*, not either number. E12.3 must settle it before the index is on a read path: either the
    build becomes an explicit command a read will not run, or a rebuild announces itself first.
  - **One column the tree cannot determine, and it is not ignored.** `entry_types.created_at` is taken
    from the caller by `registerType` and is carried by no `TypeLine`, so a rebuilt index stamps it
    with the build time (the injected `now`) and is therefore not a *pure* function of the tree. This
    is already true of `asc import` (its module doc says so) and it is the same shape as `dogfood/0031`,
    which filed the neighbouring gap as `asc-i5tj.6`. It does not weaken the invariant — a timestamp is
    not a record the JSONL is missing — but the equivalence test has to exclude it, and excluding a
    column silently is how a real divergence gets hidden. So it is excluded by name, with the reason in
    the test.
- **E12.3 — the read layer.** Extract the interface the store package does not have today: every
  public function takes `db: DatabaseSync` (107 mentions across 14 modules) and
  `interface Store { db: DatabaseSync }` (`db.ts:302`) is the only boundary. `align check` must stay
  green — this is the structural change most likely to redden it.

  **As built (2026-09-29), in progress.** Five decisions, taken before the change rather than
  discovered during it, because the shape of this seam is the deliverable and it is expensive to
  reverse:

  - **(1) The seam is a SQL port, and that is narrower than the epic's phrase — deliberately.** The
    epic says "storage-neutral", and this port is not that: it names `prepare`, `exec` and a row's
    shape, so a non-SQL backend could not implement it. The reason is that two things on the public
    surface cannot be made neutral — `asc query` hands the user raw SQL as a stable feature, and
    `--across` ATTACHes other projects onto the connection — so a domain-level interface would have a
    SQL-shaped hole in it either way. What the port buys is real and narrower, and the docs say the
    narrower thing: **the store's own modules stop naming the driver.** Claiming storage neutrality
    for a port whose only implementation is SQLite is the overselling this plan's measurement
    discipline exists to forbid, and the phrase is corrected where it appears rather than repeated.
  - **(2) The port is STRUCTURAL, not a wrapper class.** `DatabaseSync` already satisfies it, so the
    runtime path is byte-identical, there is no adapter to drift from the driver, and the stage's
    evidence that nothing changed behaviourally is the 2,719 tests already in the suite. A wrapper
    with exactly one implementation behind it would be the premature abstraction the project's own
    rules warn against; the port is a *type* the store's signatures name, and that is the whole of it.
  - **(3) The port lives in its own leaf module, and that is forced rather than stylistic.** `db.ts`
    imports `schema.ts`, so declaring the port in `db.ts` would make all 13 other modules import
    `db.ts` *through* the schema edge they already have — `align`'s `noCycles()` would redden, and it
    would be right to. `sql-port.ts` imports nothing at all.
  - **(4) Its surface is exactly what ascend uses, enumerated from the source rather than from the
    driver's documentation.** On the handle: `prepare`, `exec`, `close`, `isTransaction` — 43, 43, 4
    and 11 call sites. On a statement: `run`, `get`, `all` — 13, 52, 39. Plus `columns`,
    `setReadBigInts` and `setReturnArrays`, which exist for `asc query` alone and for measured
    reasons recorded in `query-values.ts` (a `RangeError` on a legitimate large integer; a
    duplicate-column value the driver has already discarded by the time JS sees it). Absent because
    nothing uses them: `iterate`, `expandedSQL`, `open`, and the named-parameter overloads — measured
    by grep, `.(run|get|all)({` occurs 0 times in the package.
  - **(5) The guard is a source scan in this repo's established idiom, plus a runtime pin.** Exactly
    one module in `packages/store/src` may name `node:sqlite`, and the test asserts *which* one rather
    than only counting, so a second import landing in a new file is a failure with a name. The same
    file pins the port's members against a real `DatabaseSync` at runtime, so a `node:sqlite` upgrade
    that drops or renames one fails in one place with a clear message instead of at whichever call
    site runs first.

  **What this stage does NOT claim.** Nothing here makes a second backend possible, and the store's
  functions still require something that speaks SQLite's dialect. The source of truth does not move in
  this stage — that is E12.4. A reader who takes "storage-neutral" from the epic at face value will
  expect more than is delivered, which is why (1) is written down.

  **`asc-i5tj.3.1` is settled here as its own step, and settled in a stronger form than the option's
  own description.** EV-33 found that `openIndex` rebuilds silently on a fingerprint miss (`~75 s` at
  10×), and the settlement chosen is that **a read never builds**. The option as written proposed an
  `onMissing: 'refuse' | 'build'` mode; what was built is a **two-function split**, because a parameter
  is something a later caller sets differently and an absent code path is not: `openIndex(root, dbPath)`
  *is* the refusing read — no `IndexOptions`, therefore no clock, therefore nothing a build needs — and
  `buildIndex(root, dbPath, { now })` remains the only builder, reachable only from the new
  `asc index build`. That deletes the silent-rebuild path from the API rather than gating it, which is
  what the bead's "otherwise the guard is a convention and the next caller re-introduces it" asked for.
  `OpenedIndex` is gone with it: `rebuilt` was a claim the function made about itself, and
  `fingerprint` was definitionally the tree's own hash.
  - **The guard is two tests in two files, and each one's hole is the other's job.** `openIndex`'s
    refusal is asserted *behaviourally*, on all three shapes of not-current index, by requiring the
    filesystem to be unchanged afterwards (`index.db` absent or byte-identical, no `.tmp`) — that is the
    only test that can catch a rebuild put back *inside* `jsonl-index.ts`, where a source scan for calls
    to `buildIndex` cannot tell defining it from calling it. `packages/cli/test/index-build-is-explicit.test.ts`
    scans every package's `src` and pins the set of modules that can *call* `buildIndex` to two by name
    (its definition and the command), which is what catches a read path in a module that has not run —
    including the `openIndex` caller E12.4 will add. The scan carries a positive *and* negative control,
    on the argument `purity-enforcement.test.ts` makes: a rule that never fires looks identical to a
    rule that passes.
  - **A guard moved, and the move was not a formality.** `asc-63v`'s `ForeignStoreError` reached
    readers through `openIndex`, because `openIndex` was what replaced a not-current index and so the
    read path was the only thing that could clobber the file. Now `buildIndex` is the only writer, and
    it publishes by `renameSync` — so without a check the build path would replace a stranger's
    SQLite file at `index.db` wholesale, with no file to recover and no error to explain it. The guard
    is now `assertReplaceable` inside `buildIndex`, asserted by bytes on both halves: a read refuses a
    foreign file, a build refuses it, and a merely *unreadable* index (truncated, corrupt, newer
    schema) is still replaced by a build because it is derived and disposable. Driven end to end:
    clobbering a built `index.db` into an 11-table foreign shape makes `asc index build` exit 1 with
    the file byte-untouched.
  - **What it does not do, by decision.** There is no progress line and no pre-build banner: the
    bead's option 2 was "a rebuild announces itself", and printing one as well would leave it
    ambiguous which settlement was taken. Option 1 removes the *unexpected* wait rather than narrating
    it — the caller typed `asc index build`.
  - **Driven end to end, and the command has a test of its own.** `packages/cli/test/index-build-cli.test.ts`
    drives the real binary in a real project (4 tests): it builds where the layout says and reports what
    it replayed, it is idempotent over an unchanged tree (same fingerprint, no `.tmp` left), it refuses a
    foreign `index.db` byte-untouched, and it refuses where there is no project rather than falling back
    to the working directory. That file exists because the command does three things no unit test of
    `buildIndex` covers — resolves the root by walking up, joins it to `STORE_DIR`/`INDEX_FILE`, and
    reports — and a wrong join in either half would exit 0, print a plausible path, and build nothing
    anyone will read. One measured surprise, asserted rather than normalised away: the reported path is
    RESOLVED (`/private/var/...` for a `/var/folders/...` temp path on macOS), because the command prints
    the path it actually wrote. First driven by hand in a scratch project before the test existed: 4
    records → a 118 KB `index.db`, exit 0, and `openIndex` refusing before the build and returning 3
    entries after it.
- **E12.4 — the cutover and the migration.** This repo's corpus moves from the 22 MB SQLite store to
  the tracked JSONL tree; `asc export`/`asc import` keep working; the old store is retired, not kept
  alongside. **6,404 entries as measured 2026-09-29 (`EV-34`)**, not the 6,329 this section has
  carried since it was written — the count only ever grows, so it is quoted with its date, and the
  stage's acceptance uses a number it computes rather than one quoted here.

  **The work is not a redirect, and the Explore map is what established that.** There is no existing
  tree path to point elsewhere: **`openIndex` has zero production callers**, `openRecordWriter` and
  `writeGitattributes` are unwired, and all 22 `withProject` call sites get a **writable SQLite
  handle**. So E12.4 builds the read path and the write path; it does not re-point them. What E12.3's
  settlement contributes is the constraint they must respect — `openIndex` cannot build, so
  **something other than a read has to keep the index current**, and that something is the write.

  **Decision taken 2026-09-29, before any of it was built (owner): *a write replays its own lines into
  the index, and only when the index was already current.*** The mechanism is in the box above. The
  fast path is O(new lines); the fallback is E12.3's refusal, by construction rather than by a second
  code path.

  **This reverses a recorded decision on evidence, which is why it is written down instead of
  quietly taken.** `EV-32` concluded: *"Because the rebuild is wholesale-cheap, there is no incremental
  path. Wholesale-or-nothing behind the fingerprint: no partial rebuilds, no per-record index
  bookkeeping."* `EV-33` then measured the premise at 10×: **40.27 s** for a cold rebuild at 63,290
  records against **2.97 s** at 6,387. "Wholesale-cheap" is true at this repo's size and false at ten
  times it, so the premise is now measured false — and the two rejected alternatives are rejected on
  those same numbers rather than on taste. **Rebuild-on-write** would put 3.39 s (measured at 6,404
  entries, `EV-34`) on every `asc record`, and 40.27 s at 10× — the cost `EV-32` used to kill
  rebuild-on-*open*, moved onto the hot path. **Leave-it-stale** is simplest and truest to "a read
  never builds", but it makes the product's basic loop *record → refused read → build → read* at
  3.39 s a turn. The replay path is not new machinery: it is the same `replay` the build already
  calls, with a currency check in front of it, which is also what keeps the two from diverging — an
  incremental writer implemented separately from the builder is the shape that produces a silent
  difference between two indexes.

  **The guard this needs is the false-green class the dogfood series is about.** A silently stale
  index is an index that answers wrongly, and E12.3's refusal is a guard only if the write path cannot
  slip past it. So the write asserts, after every write, that the index's stamp equals the tree's — and
  the negative control is a write performed against an **already-stale** index, which must leave it
  stale rather than stamp it current. That second test is the one that can fail for a real reason.

  **Stages.** Each lands green on its own; **b and c are one commit**, because a half-flipped store
  reads one source and writes the other, and there is no ordering of the two that is not wrong.

  - **E12.4a — the migration, and the archive.** `asc export` → tree in the project root through the
    real writer, not a bespoke path; the SQLite store archived to `.ascend-archived/` (its home by the
    `ascend-archive-location` memory), never left beside the new store as a second source of truth.
    **Success:** `EV-34`'s check is promoted from throwaway spike into a test that asserts the corpus
    survives — every line round-trips, every observable row of the four kinds is equal, invalidations
    equal as rows *and* one by one through `listInvalidations()`, and the two known gaps
    (`ingest_cursor`, the two `meta` keys) are named as dropped **in the migration's own report**
    rather than silently absent. **Tests:** the equivalence check over a corpus fixture holding all
    four kinds **and at least one invalidation**. The existing 9-line fixture in
    `import-vs-index.test.ts` carries annotations — three of them, under scheme `review` — but **not
    one invalidation**: its only scheme is `review`, not the reserved `invalidation` one, so it is
    green by construction for the single kind that rides as two others (`invalidation` is not a `kind`
    at all; it is a scheme line plus annotations, so nothing that compares *kinds* can see it). The
    check to add is the one `EV-34` used on the real corpus: the invalidation annotations as rows,
    **and** per entry through `listInvalidations()`, which is what "still strikes the same entries"
    means. **Status:** In Progress (2026-09-29). The operation exists as `migrateStoreToTree`
    (`packages/store/src/migrate.ts`, 9 tests) and the equivalence fixture carries three invalidations
    now. Two facts only building it could establish:
    - **`corpusLines` moved out of the CLI into the store** (`packages/store/src/corpus-lines.ts`),
      because the migration needs the same lines for the same reason `asc export` does and a second
      spelling would let a store migrate into a tree its own export does not reproduce. `export.ts`
      loses 130 lines and keeps its behaviour; `corpus.ts`'s shim re-exports it, so no other importer
      changed.
    - **The archive convention is the CALLER's**, not the function's: `migrateStoreToTree` takes
      `archiveDir` and refuses one inside the record directory (the layout's `.gitignore` work
      un-ignores the record subtree, so a database left there gets committed). Nothing names
      `.ascend-archived/` yet — **that, and a production caller, are what remains**: the operation has
      no command surface, which is the one thing this stage did not wire.

    Also established by writing it: the write is **verified by reading the tree back before anything
    is archived**, compared as SETS of canonical lines (`readRecordTree` imposes its own order on
    entries and annotations, so a sequence comparison would report a difference where there is none),
    and every refusal fires **before any write** so a failed migration strands no half-tree.

    **That read-back check is what caught the format's own defect, on its first real run
    (`asc-i5tj.16`, `dogfood/0040`).** The comparison is only as good as the canonical text, and a
    scheme's nested `spec.rules` was not being ordered: the store hands back `spec_json` as
    registered while `parseSchemeRule` rebuilds each rule as `{label,kind,query}`, so the check read 3
    lines of a perfectly good migration as *"3 missing and 3 that should not be there"* and refused.
    Fixed in `orderedLine` (`orderedSpec`) and both suite fixtures now carry a rule — neither did, and
    a scheme fixture with `rules: []` cannot hold the shape that breaks. The refusal is the reason this
    was cheap: nothing was archived, and the same run was 4.43 s once the format agreed with itself.
  - **E12.4b — the write path.** Every writer appends to the tree and maintains the index by the
    decision above. **Success:** a write is visible in the tree and in the index, and a read
    immediately after a write is a cache hit (`0.05 s`) rather than a refusal. **Tests:** both
    branches of the currency-guarded replay; a write against an already-stale index leaves it stale;
    the stamp the read compares is the one the write wrote. **Status:** In Progress (2026-09-29).

    **Three sub-stages, and the order is by dependency rather than by layer.** b2 was built first
    because it is the heart and it needs no writer surgery — it composes `replay`, `treeFingerprint`
    and `FINGERPRINT_KEY`, all private to `jsonl-index.ts`, so it is testable against hand-written
    lines and nothing else has to move. b1 then gives the writers a way to produce those lines
    without inserting, and b3 wires the five `src` write sites to the new path. Only b1 depends on
    b2's existence; b3 depends on both.

    - **E12.4b2 — the guarded write.** `openIndexForWrite` (a currency-checked, read-write index
      handle — the read path's own handle stays read-only, which is what keeps "a read never builds"
      structural) plus the operation that appends lines to the tree and replays them into the index
      when it was current. **Success:** a read immediately after a write is a cache hit, and the
      crash window is closed by ORDER rather than by luck — the tree is appended before the stamp is
      written, so a death between the two leaves a tree the stamp does not describe and every read
      refuses until a build. **Tests:** both branches; a write against an already-stale index leaves
      it stale; the stamp the read compares is the one the write wrote. **Status:** Complete
      (2026-09-29). `writeLines` (`packages/store/src/jsonl-index.ts`, 8 tests in
      `index-write.test.ts`), and the writable handle is PRIVATE to that module — reachable from one
      caller, the same construction `buildIndex` has.

      Three things only building it established. **The order claim is verified by mutation**: a
      faithful reversal (replay in both branches, append after) failed exactly the refused-replay
      test and passed the other seven — `1 failed | 7 passed`, so that test is the one place the
      ordering is load-bearing rather than decorative. **A foreign file at `index.db` refuses the
      write BEFORE the append**, propagating `ForeignStoreError`: a tree written while the index
      cannot be touched would be records no read of the project can see. And **the stale branch
      returns rather than throws**, because the write itself succeeded — the JSONL is the store —
      so the caller is told `stale: true` and can say so.

      **This reverses EV-32's "no incremental path", and the module doc was corrected rather than
      left contradicting its own code.** EV-32 concluded wholesale-or-nothing from a cold rebuild of
      3.02 s; EV-33 measured 40.27 s at 10×, which kills wholesale-*on-write* (3.39 s on every
      `asc record`, measured at 6,404 entries by EV-34) while leaving every other part of the
      design standing. The bookkeeping EV-32 refused is now the build's own `replay` with a
      currency check in front of it — not a second writer, which is the shape that produces two
      indexes that disagree with nothing reporting it.
    - **E12.4b1 — the line producers.** Each writer gains the half that computes its line(s) against
      a reader rather than the half that INSERTs: entries, types, schemes and annotations, the
      invalidation pass included. **Success:** the line a producer returns is byte-identical to the
      line `corpusLines` returns after the same write has been performed — the equivalence that
      makes the split survivable, because a producer that disagreed with the reader would mint a
      tree the export does not reproduce. **Status:** Complete (2026-09-29) — the equivalence holds
      for a single call AND for a sequence, which is the only way b3 calls it. Five productions in
      `packages/store/src/line-producers.ts` behind one exported entry point, `produceLines`;
      18 tests in `line-producers.test.ts`, all green.

      **The defect this stage found, kept because the mechanism generalizes.** The first version
      exported five functions that each opened their own `withRollback`, and it was green — 14 tests,
      all passing — while being unusable for the only thing it exists for. A sequence does not see
      itself when each production rolls back before the next. Ran as a throwaway probe (3 tests,
      since deleted), one call per sequence, all three failing:

      ```
      annotate: scheme then the pass that needs it
        SchemeError: annotation scheme 'screening' has no version 1. Its versions: (none).
      import: two type versions in one sequence
        expected [ 1, 1 ] to deeply equal [ 1, 2 ]
      invalidate: two claims in one sequence
        expected [ 2, 2 ] to deeply equal [ 2, 1 ]
      ```

      Three different symptoms, one cause, and each a real b3 write site: `annotate.ts` registers a
      scheme and the pass that belongs to it in ONE transaction, so the pass producer must see the
      scheme the scheme producer just produced; `import.ts` replays a corpus where each type and
      scheme version depends on the one before it, so every version would come out 1; and
      `invalidate.ts`'s batch would re-emit the reserved scheme line per claim — a duplicate in a
      `merge=union` tree, which is the exact failure the "no second scheme line" test covers for
      separate CALLS and cannot cover for a batch.

      **A single-call equivalence test is structurally unable to see any of that, so the fix is a
      shape and not a test.** `produceLines(db, body)` opens ONE rollback and hands `body` the only
      way to produce — an object whose five methods are the productions — so the single-production
      functions are private and the mistake is unspellable rather than documented. It is
      `withRollback`'s own warning ("a preview of registering three documents would have each one
      rolled back before the next, so the second would compute its version as though the first had
      never happened") arriving one layer up; this module is the caller that sentence was written
      about.

      **The two candidate fixes the defect note named were both rejected, and on the same ground.**
      A `withRollback` that JOINS an enclosing rollback silently makes a per-call rollback legal
      again, which is the footgun restored. Producers that REFUSE to run outside a caller-opened
      rollback leave the caller free to wrap in `withTransaction` instead, where the probe would
      COMMIT and the damage would surface later as `DuplicateEntryError` at the replay — and
      `SqlDatabase.isTransaction` cannot tell a rollback from a commit, so no guard in this package
      could catch it. Both also change `db.ts`, a shared primitive; the fix that shipped changes
      nothing outside this module.

      **Measured by mutation, not argued.** Reverting `produceLines` to one rollback per production
      fails exactly the four sequence tests and nothing else (`4 failed | 14 passed`), with the
      symptoms above verbatim — and the invalidate one as
      `[ 'scheme', 'annotation', 'scheme', 'annotation' ]`, measured because the throwaway probe had
      counted scheme VERSIONS (`[ 2, 2 ]` vs `[ 2, 1 ]`) while the test counts line kinds, and where
      the duplicate sits was a guess until that run showed it interleaved rather than grouped.

      **The producer is its writer, run and undone** (`withRollback`, the idiom `registerType`'s
      `dryRun` and `import --dry-run` already use) rather than a second implementation of the
      validation or a no-INSERT half threaded through `recorder.ts`, `registry.ts` and
      `annotations.ts`. The two rejected alternatives and their costs are argued in the module doc;
      the property that made the choice is that the producers are additive, so a write that does not
      want a line cannot be affected by them.

      Three things only building it established. **A write that wrote nothing produces no lines**:
      `registerType` and `registerScheme` answer `'unchanged'` and `recordInvalidation` answers
      `created: false`, and in each case the export already carries the line — emitting it again
      would append a duplicate to a `merge=union` file on every re-run. **The first invalidation
      produces TWO lines**, a scheme line and an annotation line, because the reserved scheme is
      registered by the same call and `import` rebuilds it from a scheme LINE
      (`restoreInvalidationScheme`); a producer that emitted only the annotation would mint a tree
      the store's own import refuses. And **`annotationLines` sorts by `id`**, `corpusLines`' own
      tiebreak within a pass, not the `(created_at, entry_id)` that `annotationRows` returns: a pass
      holds one label per entry so the two orders hold the same rows, but the tree is bytes and
      "holds exactly what the export would write" is a claim about bytes.

      The equivalence is measured as a **multiset difference against the corpus the real write
      added**, which is order-sensitive and catches both directions — a producer line the export
      would not write, and a write that added a line the producer never mentioned.

      One gate note: a `TypeSpec` fixture held in a `const` needs the annotation spelled out, because
      away from the call site the literal's `type: 'text'` widens to `string`. `tsc -b` does not
      typecheck tests, so `tsc -p tsconfig.eslint.json` is the gate that caught it.
    - **E12.4b3 — the write sites.** `record.ts`, `annotate.ts`, `invalidate.ts`,
      `register-document.ts` and `import.ts` move off `recordEntry(store.db, …)`-shaped calls onto
      the new path, each handing `writeLines` the lines it produced. **Status:** Complete
      (2026-09-29, uncommitted) — and the count in this heading is wrong, which is itself a finding.
      There were **seven** sites, not five: `ingest/claude-code.ts` was found by exploration while
      this plan was being written (`asc-i5tj.14`), and `types/deprecate.ts` was found by a defect
      living in it — a retirement that existed only in the derived index and was erased by the next
      rebuild (`dogfood/0038`). The lesson is recorded there rather than here: a survey of write
      sites is a survey of the sites someone thought of, and `writer-callers.test.ts` could not catch
      the seventh because its list came from the same survey. It carries all seven names now.
      The write lock half is done and committed (below); each site is a single `produceLines`
      call around a body that makes its writes in order — `import.ts`'s four loops and
      `annotate.ts`'s scheme-plus-pass both fall out of the one transaction the producers now share.
      What each site gains is that its dry run and its real run differ only in whether `writeLines`
      is called.

      **The write lock needs the preview to nest, so that landed first (`db.ts`, its own change).**
      `annotate.ts` must read, produce and append under ONE lock — `asc-q4p`: the read has to be
      inside `BEGIN IMMEDIATE`, or two concurrent `asc annotate` processes compute the same
      `nextSpec` and append two scheme lines with the same version and different specs, the open P1
      `asc-i5tj.6` / `dogfood/0031` class. But `produceLines` opens `withRollback`, `writeLines`
      opens its own transaction, and `withRollback` **refused** to run inside a transaction it did
      not open. So the lock that spans them could not exist.

      The refusal was retired rather than softened, because its own argument does not apply to what
      replaced it. It said *neither function may end a transaction that belongs to the caller* —
      true of a second `BEGIN`/`ROLLBACK`, false of a SAVEPOINT, which ends only its own scope. So
      `withRollback` and `withTransaction` now open a transaction at the outermost level and a
      savepoint whenever one is already open, **by any means**, not only when the other helper
      opened it. `BEGIN IMMEDIATE` stays at the outermost level and that is the whole reason
      `inOwnScope` has two shapes: a savepoint with no enclosing transaction is itself a DEFERRED
      transaction, so a savepoint-only implementation would take the lock at the body's first write
      and reintroduce the `SQLITE_BUSY_SNAPSHOT` failure measured at 1 ms, in the scenario
      `withTransaction`'s own doc names. `produceLines(db, body)` and
      `writeLines(root, dbPath, lines, opts)` keep their signatures: the alternative was to thread a
      transaction object through every caller, and this is the same nesting with nothing new to pass.

      Verified by mutation twice, because four tests that replaced a refusal have to be worth
      something. Dropping `ROLLBACK TO` from the nested discard and keeping `RELEASE` fails exactly
      `withRollback ... sits inside a real write`, `1 failed | 9 passed`. Replacing the nested
      `RELEASE` with `COMMIT` — the mutation that makes a nested scope genuinely durable, which no
      other test in the file can see — fails three, `3 failed | 7 passed`, `does not make a nested
      commit durable` among them. The second run also **corrected a test**: the first version
      asserted a nested `withTransaction`'s row was absent, which is the meaning of a ROLLBACK and
      not of a COMMIT. `[ 'after', 'caller', 'nested' ]` is what it measures now.

      `registerType`'s own `dryRun` refusal (`registry.ts:453`) is untouched, and now reads as the
      opposite of the idiom that nests: it uses its own `BEGIN`/`ROLLBACK`, so it genuinely cannot
      promise an unchanged store inside a caller's transaction, while `withRollback` now can — which
      is why `produceLines` uses `withRollback` and not `dryRun`. Two previews, one of them nests.

      **The write site survey is done (2026-09-29), and four of the five paths are under
      `commands/`.** `commands/record.ts` (672 `recordEntry`, batched, `withRollback`/`withTransaction`
      chosen at 744), `commands/annotate.ts` (560 `registerScheme` + 562 `recordAnnotations`, one
      `withTransaction`), `commands/invalidate.ts` (267 `recordInvalidation`, batched, 278),
      `commands/import.ts` (178 `registerDocument`, 209 `recordEntry`, 231 `restoreInvalidationScheme`
      /`registerScheme`, 255 `recordAnnotations`, four loops under one wrapper at 289/299), and
      `register-document.ts` (69 `registerType`, 83 `updateTypeProse`, no wrapper of its own).
      `Project` exposes only `{ root, store }` and **only `commands/record.ts` destructures `root`**,
      so the other four sites need the project root threaded to them — which the read-path flip
      should carry, since it is the same `openProject` that knows it.

      **The write command must ensure a current index before it can probe** (owner, 2026-09-29:
      *build, then write*). The probe is its writer run and undone, so it reads `entry_types` and
      `entries`; after the flip the only database is the index, and `openIndex` refuses when it is
      absent or the tree has moved — which includes a checkout or a merge, routine in this design.
      So the write command builds when the index is not current, then probes, then appends. **This
      widens E12.3's source scan** (`asc index build` is the only builder, pinned by the module
      allowlist) from two modules to three; it does not add a second builder, because the same
      `buildIndex` is called. `writeLines`'s stale branch then stops being reachable from the CLI and
      becomes the re-check that makes "a write cannot slip past the guard" structural — which is why
      it stays, and why its test stays.

      **There is a SIXTH write site, and the ingest cursor has to move before the flip can happen at
      all (2026-09-29, `asc-i5tj.14`).** `asc ingest claude-code` is not in the five above: it calls
      `recordEntry` (`claude-code.ts:738`) as well as `recordIngestCursor` (`:714`) and
      `recordAppliedHandlers` (`:717`). After the flip the read handle is read-only, so those INSERTs
      fail with *attempt to write a readonly database* — the command breaks outright, and it is the
      one command `.claude/ascend-hook.sh` runs at **every SessionStart**.

      Fixing that surfaced the real problem, which is that the cursor has no home in the new layout.
      `EV-34` measured it: `ingest_cursor` is 1,070 rows in the live store and **0** in an index built
      from the tree, and `ingest.applied_handlers` is a `meta` key present in the store and absent
      from the index. Neither is one of the corpus format's four line kinds, so the index cannot
      rebuild them — and the index is rebuilt wholesale whenever the tree has moved, which from E12.4
      is a checkout, a merge or a hand edit. Rows kept there would be erased by a routine operation
      with nothing reporting it.

      So the cursor becomes a **gitignored JSON sidecar** at `.ascend/ingest-cursor.json`
      (`ingest-cursor.ts`, rewritten), holding the per-file rows and the handler ledger in ONE file so
      the two cannot disagree — they used to be two writes to two places with a rule saying the second
      had to sit beside the first. `index.db` stays a pure function of the tree, which is what keeps
      deleting it safe. The `ingest_cursor` table was **kept at the time, not dropped by a migration
      7**: it still holds a real store's progress, which is exactly the gap `migrateStoreToTree`'s
      report exists to name. Full reasoning and both rejected alternatives are the `decision` entry
      `61a1e2e9`. **Superseded 2026-09-30 (`asc-i5tj.4.3`, migration 4 deleted):** "kept" was right
      about the report and wrong about the mechanism — the report is derived from `sqlite_master`
      (`droppedTables`, `migrate.ts`), not from `MIGRATIONS`, so deleting migration 4 cannot silence
      it. Driven end to end rather than argued: a legacy store holding 1,070 rows, `asc init`, still
      reports *"the migration could not carry the ingest_cursor table: 1070 row(s)"*. What the table
      had instead was a cost — a `DROP` migration would RAISE `SCHEMA_VERSION`, invalidating every
      index on disk to remove a table nothing opens, so it was deleted outright and 5 and 6 kept
      their numbers.

      **Both `meta` keys `EV-34` could not carry are disposed of, and neither is a silent drop**
      (`asc-i5tj.14` criterion 4, recorded here 2026-09-30). `ingest.applied_handlers` is **given a
      home** — the sidecar's `handlers` key, written into the same atomically-renamed file as the
      rows so the two cannot disagree, which is the reason the sidecar is one file rather than two.
      `created_by_ascend_version` is **deliberately dropped**, and it is *redundant* rather than
      merely unread: every entry line already carries `ascend_version` (`jsonl.ts:168`, read back at
      `replay.ts:48`), so the tree records which ascend version wrote each entry — finer-grained than
      one store-level key, which is why dropping it loses no information. Measured rather than
      assumed: the only writer is `db.ts:801` (`INSERT OR IGNORE`, on every non-read-only open), and
      no `src` reader exists — `meta` is read in exactly two places and both ask for
      `index_fingerprint` (`jsonl-index.ts:594,735`). The read path had already stopped stamping it
      (`project.ts`: *"There is no `ascendVersion` parameter, and its absence is the flip made
      visible"*), and `openIndex` opens read-only, so an index is never born with the key.

      **Criterion 3 — the cost of losing the cursor — is measured, and it is `EV-36`.** A
      cursor-less `asc ingest claude-code` on this machine costs **17.56 s / 16.51 s** (n=2) over
      **1,083 files / 2,146,378,468 bytes**; the next run, with the cursor it rebuilt, costs
      **0.369 s**. The same-day ratio is **46×** and is the number to quote, because `EV-33`'s 1.6×
      two-day drift makes the 7.965 s baseline from 2026-09-22 unusable for a cross-day comparison —
      the corpus grew 977→1,083 files and 1.63→2.00 GiB in the interval, so the +114% is not
      separable from drift and is not claimed as a regression. Criterion 2 was re-confirmed at 1,083×
      the fixture's scale: a full re-read of every transcript minted **2 new entries and 0
      duplicates**, and the rebuilt cursor came back at the same 1,083 rows.

      **This landed as its own commit, BEFORE the flip, green while the world was still all-SQLite**
      (2026-09-29) — it is independently verifiable and it is a prerequisite rather than part of the
      flip. The one thing it costs, stated in the code rather than discovered later: a file cannot
      join the entry transaction, so the cursor is written AFTER the entries commit, and a run that
      dies between the two under-claims and re-reads. That direction is chosen — the reverse would let
      the cursor claim files the store holds no entries for, turning a missing read into a missing
      entry. The `--dry-run` guarantee is correspondingly weaker than the rollback it replaced
      (position rather than rollback) and `claude-code.ts`'s header now says so instead of keeping the
      old claim.
      The `.gitignore` entry for the sidecar is the one part deferred to E12.4d: `.ascend/` is still
      ignored wholesale today, so a rule for the future layout would be a rule nobody can verify.

      **And moving it to a file changed its semantics, which was measured rather than argued
      (`dogfood/0042`, `asc-n4eg`, fixed 2026-09-29).** `recordIngestCursor` was one
      `INSERT … ON CONFLICT DO UPDATE` per file, so a row for a file a run did not mention was
      untouched; `writeIngestCursor` replaces the whole file, while the caller still passed only the
      files it read that run. The cursor collapsed to one run's work: on the live corpus, rows
      **1080 → 1** across two runs, the skip run reporting *"1079 transcript file(s) unchanged since
      the last ingest … and were skipped without being opened"* and then writing a one-row cursor —
      so every run was either a 16 s full read or a 1 s skip, alternating, forever. Fixed by carrying
      the rows the run relied on into the write, with this run's rows last. The suite was green
      throughout because every cursor test runs against a one-or-two-file corpus, where a kept cursor
      and an emptied one have the same row count.

      **The store's half of the flip landed first, as its own commit, because it is additive and
      independently green (2026-09-29).** The approved plan had stages A–F as one commit, on the
      argument that every intermediate state is a store that reads one source and writes the other —
      which is true from stage B onward and false of stage A, where nothing reads or writes
      differently. So three things landed: `writeProducedLines`'s body now takes the transaction's own
      `db` as a second argument (`(produce, db) => Result`), a new `previewProducedLines(root, dbPath,
      body)` runs the writers under a rollback without building, appending or stamping, and
      `writer-callers.test.ts` pins the modules allowed to call the six writers plus `updateTypeProse`.
      Splitting it bounds the blast radius of the rest: stages B–F touch 6 write sites, 11 fixture
      suites and the read path, and an interrupted one of those is a half-flipped store, where an
      interrupted stage A is nothing at all.

      The preview is the one behaviour change in that commit and it is deliberate: it REFUSES a stale
      index rather than building one, naming `asc index build`. `writeProducedLines` still builds —
      the owner's *build, then write* — because a write has to happen and a preview does not. The
      first currency check also happens before the writable opener, which is not tidiness: `openStore`
      migrates on the way in, so checking after opening would leave a brand-new empty `index.db`
      behind a `--dry-run` that reported writing nothing.
  - **E12.4c — the read path.** Production readers open `openIndex(root, indexFile)`; `openStore` on
    `.ascend/ascend.db` becomes unreachable from `src`. **Success:** the whole suite's reads go
    through the index and every existing read test passes unchanged — this is where E12.3's seam pays
    for itself, and the map says by how much: the flip is **two functions**, `openProject`
    (`packages/cli/src/project.ts:151`) and `openQueryProject` (`:191`), because every reader reaches
    the store through `withProject`/`withQueryProject` in `base.ts` and none of the 22 `src` call
    sites names a database file at all. `Store` exposes no read API — `{ db, dir, file, migrations,
    close }` and nothing else, with reads as free functions over `store.db` — so `openIndex` already
    returning a `Store` means the call sites do not learn a new type. **Tests:** the flip driven end
    to end through the real binary, plus a source scan pinning the modules that may name the old store
    file, the same instrument `index-build-is-explicit.test.ts` uses. **Status:** Complete
    (2026-09-29, uncommitted) — and it took a seventh write site with it (`asc-i5tj.4.1`), because a
    read flip and a write migration cannot be separated: the read handle is read-only, so every site
    still writing through it fails with *attempt to write a readonly database*.

    **The flip needed one guard with it, and the guard is the reason this section is not just a
    rename (`asc-i5tj.15`, `dogfood/0039`).** `buildIndex` reads the TREE, so during a migration it
    builds an index from whatever part of the corpus the tree holds and reports success — measured,
    with the guard removed: a 6,473-entry `ascend.db` with no tree at all built to `records 0`, exit
    0, and this repo's own 2,917-line tree beside that store built to `records 2917`, exit 0, listing
    six plausible type rows with **3,562 entries missing**. `assertNoLegacyStore(root)` refuses before
    the read, so a refusal cannot be preceded by the `.tmp` removal or the `renameSync`, and it names
    `asc init` (never a deletion) as the remedy. It is a refusal rather than a warning because a
    warning here would be indistinguishable from a healthy build: the fingerprint covers the tree, so
    the index genuinely IS current for it. The remedy takes two hops when a tree is already there —
    measured: `asc init` then refuses with *"already holds a record tree (2917 line(s))"* and names
    the next step — so the message says so.
  - **E12.4d — retire the source of truth.** The SQLite store stops being a store; `asc export`/`asc
    import` keep working against the tree. **`asc init` is part of this and is easy to miss: it is
    the thing that creates the source of truth today** — `.ascend/` plus `ascend.db` through
    `openStore` (`packages/cli/src/commands/init.ts:126`), and it appends the literal `.ascend/`
    (`IGNORE_ENTRY`, `:60`, managed at `:240-302`) to `.gitignore`. In the new world it lays out the
    tree instead, un-ignores the record subtree (the layout section's "un-ignore a subtree", which is
    a `.gitignore` edit and not a move), and emits `.gitattributes` — which **nothing in `src` writes
    today**: `writeGitattributes` exists in the store package with no production caller. The store's
    own tests that asserted SQLite-as-store are retargeted rather than deleted. **Success:** the owner
    ruling (*"JSONL is the store; SQLite does not coexist as a second source of truth"*) becomes
    checkable by a test that fails if a production module opens a non-derived database. **Status:**
    Complete (2026-09-30, `asc-i5tj.4.3`) — the **`asc init` half** landed with the flip rather than
    here, and it had to: the starter types lived only in `ascend.db`, so after the flip a fresh
    project's index would be built from an EMPTY tree and the first `asc record` would fail
    `UnknownTypeError` while every flip test passed. What remains here is the retirement itself (the
    source scan over `openStore` callers, and the `ascend.db` file leaving this repo in E12.4e).
    **The retirement landed 2026-09-30 (`asc-i5tj.4.3`), and the two things it named as remaining were
    both already done or not real.** The source scan exists and is green — `store-names.test.ts` pins
    the five modules allowed to call `openStore` and the four allowed to name `STORE_FILE`/`index.db`.
    `.ascend/ascend.db` has already left this repo
    (`.ascend-archived/2026-09-30T02-22-35-351Z/`). And "the store's own tests that asserted
    SQLite-as-store are retargeted" named work that does not exist: a classification of all **133**
    `openStore(` call sites across 21 `packages/store/test/*.ts` files found **zero** legacy-store
    tests — their subject is live derived-index machinery, and they inherit the filename `ascend.db`
    from `openStore`'s default without asserting the store lives there. So the retirement was two
    concrete things instead: `MIGRATIONS`' `version: 4` (which created the never-read `ingest_cursor`
    table) deleted, and six comments that still called a derived SQLite file "the store" corrected.
    Verified by mutation (re-adding `version: 4` fails four assertions) and by driving the real
    binary (a fresh `asc init` index has no `ingest_cursor`; a legacy store holding 1,070 rows is
    still reported with its count).
  - **E12.4e — the cutover, on this repo.** Run it on `.ascend/` and drive the real loop on the real
    corpus: record, query, ingest, search. **Success:** `EV-34`'s numbers reproduce — 10,316 lines,
    0 lost, ~4.65 s end to end — and the two gaps are reported rather than absorbed. **Status:**
    Complete (2026-09-29; re-verified 2026-09-30 on the current build, `asc-i5tj.4.4`). **Measured, and the staging the plan gave is wrong in one
    step.** `asc init` on this repo's store (23,273,472 bytes, 6,473 entries, 7 schemes / 17 types /
    3,889 annotations) wrote **10,386 lines in 4.43 s** — EV-34's 10,316 lines were taken before the
    corpus grew, and the shape reproduces exactly. It reported the two gaps rather than absorbing
    them: `ingest_cursor` **1,079 rows** and `meta` **3 rows**, both named in the archived store's
    path. But **archiving the partial tree first loses the 39 entries only the tree held** —
    measured by id: the tree's 2,911 entry lines are 2,872 in the store and **39** that are not. All
    39 are `derived:claude-code`, and a cursor-less `asc ingest claude-code` re-derives them (11–17 s
    over ~1,000 transcripts, ids stable: the store's and the tree's agree on 2,872 of them). So the
    verified order is: archive the partial tree, `asc init` (migrating all 6,473 with their legacy
    ids), then re-ingest with the cursor absent — measured twice, on a copy and on this repo, both
    ending at **6,515 entry lines with all 2,911 archived ids present and 0 missing**. The 6 starter
    type lines the partial tree held are byte-identical to the migrated ones by hash, so archiving it
    costs no type line either. Done here: the tree sits in the working set as **23 untracked files**
    — 22 `*.jsonl` plus `.gitattributes`, measured 2026-09-29 — with `index.db` (+ `-wal`/`-shm`, which
    a rebuild rewrites) and `ingest-cursor.json` ignored. Nothing is committed; the conservative profile
    applies. `.gitignore`'s `.ascend/` line was replaced by the seven derived/local paths — and the hook
    loop was driven (`asc types brief` 3,284 bytes, `asc doctor`, `asc explore`, `asc search`). **The first
    write to the cut-over store is the last check, and it passed**: two `decision` entries recorded at
    02:29 read back through the rebuilt index and the generated view. That write also produced a
    finding about the read path rather than about the cutover: the second entry was a duplicate the
    store already held, and nothing applies the `superseded` strike it was given — `asc types list`
    reports decision **92** with 1 of those 92 struck, the same 92 as before the strike, and
    `asc search` listed the duplicate and its superseder as two peers. Filed as `asc-9xi0` (P2) and
    recorded as `dogfood/0041`.

    **Re-verified 2026-09-30 on the current build (`asc-i5tj.4.4`), and the reason it needed
    re-verifying is `asc-i5tj.4.3`:** deleting migration 4 changed the schema version list, which is
    exactly what the index is opened against. Two measurements, both on the real corpus.

    **The live index, rebuilt by the current build, loses the retired table.** `asc index build` on
    this repo's tree wrote **10,445 records in 3.22 s**, and the result's `sqlite_master` has **no
    `ingest_cursor`** while `user_version` stays **6** and `meta` stays `cwd_convention,
    index_fingerprint`. So the deletion is confirmed against the live tree rather than only in tests,
    and no version number moved anywhere.

    **The migration reproduces, driven on a COPY of the archived store** (23,273,472 B, in a temp
    project, so the live tree is untouched): `asc init` exit 0, **10,386 lines in 4.147 s**, and the
    tree parsed by kind gives `{type:17, entry:6473, scheme:7, annotation:3889}` — **every kind equal
    to its source table, 0 lost and 0 gained**, which is what the criterion's "0 lost" means.
    **`EV-34`'s 10,316 is the same formula on its own store** (17 + 6,404 + 7 + 3,888 = 10,316); the
    70-line difference is the corpus growing 6,404 → 6,473 entries, which `EV-34` itself anticipated.
    So the criterion is met as an arithmetic identity that reproduces exactly on both sides, **not**
    as the same bytes migrated twice — `EV-34`'s store no longer exists and that is stated rather
    than glossed. Both gaps are still reported verbatim: `could not carry the ingest_cursor table:
    1079 row(s)`, and `meta` with all three key names.

    **The loop was driven on the reproduced store, not just on this repo's**: `asc record note` wrote
    `2eab8413` (entries 6,473 → 6,474), `asc search note "freshly migrated"` returned it at bm25
    −14.078, `asc types brief` returned all 15 types, and `--across` attached the copy from one
    statement (`this_repo 6531 / migrated_copy 6475`). The freshly built index of that store has no
    `ingest_cursor` either.

    **What is still not measured, and it is the criterion's weak half:** no foreign repository was
    migrated. Everything here is home-field — this repo's corpus, and a copy of it on the same
    machine — so `EV-34`'s own "n=1, and it is the corpus the migration is FOR" caveat still stands.
- **E12.5 — the guards the blocked beads own (done 2026-10-02, below).** `asc-2ezs` (one id, two
  contents, refused at read), `asc-98e1` (id-set superset of each parent — EV-31 measured that the
  markers-and-parse half alone passes exactly the resolution that loses a record), `asc-8uzh`
  (per-record size limit, byte-bounded rollover). **`asc-2ezs` and `asc-8uzh` are complete;
  `asc-98e1` is not in that stage** and stays open.
- **E12.6 — the version a type line states about itself (`asc-i5tj.6`, done 2026-09-30).** A
  `TypeLine` carried no version, so a type's version was read from the line's POSITION — and
  `.ascend/.gitattributes` is `*.jsonl merge=union`, a writer that interleaves without asking, so the
  *"no writer may interleave them"* rule the layout rested on was one no code could enforce. The hole
  was measured first and is narrow: reordering a multi-version type that has **zero** entries is
  silently renumbered with exit 0, because an entry's `type_hash` catches a renumber everywhere an
  entry references the moved version. Two owner decisions, taken before the work: **every type line
  states its own `version`** (and existing trees are rewritten once), and **a version-less type line
  is a hard parse error naming the rewrite** — one rule, no order-dependent fallback. `version` is
  outside `documentSpec`, so it moves no `type_hash` and invalidates no entry; the corpus line
  REQUIRES it while the `asc types define`/`export` *document* keeps it optional, because the two
  share a type and only one of them is a stored registration. `asc store rewrite` is a command, not
  part of `asc index build`: the index is derived and a read path that rewrites the tree is a writer.
  Full measurement in `docs/evidence/EV-37.md`.

- **E12.7 — a build and a writer at once (`asc-tyl7`, P1, measured 2026-09-30).** A build publishes by
  `renameSync` and takes no lock, and EV-35's *build, then write* ruling put a build on the write path,
  so the two can overlap. `EV-38` measured it with two real processes on a copy of this tree: the
  defect is **not** the rename but a gap **inside** `buildIndex` — it reads the tree with
  `readRecordTree` and then re-reads the same files with `treeFingerprint`, so an append landing
  between the two is absent from what is replayed and present in what is stamped. **4.2% of races
  publish an index that reports current while missing the writer's record** (window 165 ms of a 3.9 s
  build; random-timing n=24 agreed at 1/24), the omission survives every later write, and a read
  returns it happily. The other ~96% leave the index stale — a refusal, the safe direction — but
  `writeLines` reported `stale: false` for a replay that had gone to a replaced inode. The owner chose
  the shape from `EV-38`'s options: close the window by construction, and make the writer's report
  honest.

  **Stage 1 — one traversal.** *Goal*: a build's fingerprint describes exactly the lines it replays.
  The per-file fold moves into one helper shared by `treeFingerprint` and a new fused read, so the fold
  cannot drift between them and **the fingerprint's value is unchanged** (no forced rebuild).
  *Tests*: an append placed between the two traversals must land in one of them and not the other —
  the red test drives `writeLines` from inside a traversal to make the interleaving deterministic, and
  the existing equivalence suite (`matches a from-scratch build after a sequence of appends to the
  tree`, `builds the same index when deleted and rebuilt`) must stay green.
  *Status*: **Complete (2026-09-30).** What was planned did not survive contact: `writeLines` cannot be
  driven from *inside* a build's traversal, so no in-process test can produce the interleave — the
  suite is blind to this defect by construction, the same way `dogfood/0044`'s trigger was. What was
  built instead is a **read trap**: `jsonl-index.test.ts` mocks `node:fs` and turns the *second* read
  of any record file into a racing append, which is exactly and only what a second traversal is. It
  asserts `trap.fires === 0`. The mutation check is the evidence that the trap is a measurement and
  not a decoration — with `treeFingerprint(root)` put back beside `readRecordTree`, it reports
  `expected 1 to be +0` — and a trap that never fires passes silently, so the check is recorded with
  the fix rather than described here. The seam itself is pinned in `jsonl-files.test.ts` by three
  tests, including one that performs the *old* two-call sequence and asserts the two describe
  different instants (the hazard as an executable fact). Verified end to end on this repo's own tree:
  22 files, the fingerprint the new code computes is byte-identical to the old formula's
  (`1ba57791e9469e44…`), so no existing index is invalidated; `asc index build` then `asc types brief`
  on the real binary, exit 0. Gate green at 124 files / **2831** passed (+4).

  **Stage 2 — the writer's report.** *Goal*: a write whose replay went to a replaced inode says so.
  After the transaction, compare the stamp the write put there against the stamp the **path** now
  holds (a fresh by-path read, not the handle — the handle is the whole problem). *Tests*: a write
  that commits into an index a build has replaced reports not-current; one that does not, reports
  current.
  *Status*: **Complete (2026-09-30).** One helper, `indexAtPathCarries`, asked after the handle is
  closed and **by path**. `writeProducedLines` throws `IndexStaleError` — it has no `stale` field and
  its contract is refuse-never-proceed, so a refusal naming the truth (*"the file at that path was
  replaced while this write held it, so the records are in the JSONL and not in the index"*) is the
  honest report; `writeLines` returns `stale: true`, and `WriteReport.stale`'s doc now states both
  causes rather than only the pre-write one. The test drives the **real `buildIndex`** from inside the
  write's own transaction — the body is the injection point, so the race is deterministic instead of
  timed — and it was red first: `expected function to throw an error, but it didn't`. Two things the
  writing of it found:
  - **A bare `renameSync` over `index.db` is NOT the race.** With the sidecars left alone the write's
    frames reach the file at the path anyway (its `-wal` is at the path and is recovered onto whatever
    sits there — `dogfood/0044`'s mechanism, seen from the other side), so a stamp comparison cannot
    see it, and the index left behind is the *other* tree's rows plus this write's, stamped current.
    Only a publication that removes `-wal`/`-shm` first — which `buildIndex` has done since `asc-pwv7`
    — produces the orphan this fixes. **Named as a limitation, not fixed**: detecting that mixture
    needs more than a stamp, and the only writers of that path are builds, which no longer do it.
  - **`writeLines`' branch of this is unmeasured**, for the reason `EV-38` already gives: it has no
    caller outside tests and no injection point, so its post-check is shared code verified through
    `writeProducedLines`. Stated rather than implied.
  Gate green at 124 files / **2832** passed.

  **Stage 3 — the class, and what is deliberately not fixed.** `EV-38` names two members it argued
  about and did not measure: `openIndex` (hashes then reads the stamp — argued to be a point-in-time
  answer rather than a published artifact, and reads cannot afford a full parse per open) and
  `writeLines`' own fingerprint-then-append (a two-writer race, which can produce the same permanent
  omission). *Goal*: each is either measured and fixed, or recorded as a decision with its reason, so
  neither is left looking like an oversight.
  *Status*: **Complete (2026-09-30) — two decisions, neither fixed, and the second is no longer merely
  argued.** The interleaving EV-38 labelled *argued* is written out and checked against the code, and
  it holds — `replayInto` (`:690-702`) stamps in the same transaction as the replay, so the stamp left
  behind is the last replayer's, and that is what makes this reachable:
  ```
  1. writer 1  before = T0; index stamp T0  -> current, branch (a)
  2. writer 1  appends its line             -> tree T1
  3. writer 2  before = T1; index stamp T0  -> NOT current, branch (b): append, report stale, replay nothing
  4. writer 2  appends its line             -> tree T2
  5. writer 1  treeFingerprint (135 ms)     -> T2, which INCLUDES writer 2's line
  6. writer 1  replays its OWN line, stamps T2 -> index carries writer 1's line, not writer 2's, and
                                                 the stamp equals the tree. A read succeeds.
  ```
  The window is writer 1's second `treeFingerprint` — the same traversal-length window as Stage 1's
  4.2%, and `writeLines` is the only function with that shape. **Not fixed, and the fixes considered
  and rejected:** a third traversal comparing the stamp against a fresh fingerprint *narrows* the
  window rather than closing it (nothing stops a move after the check) and costs another 135 ms per
  write; replaying from the tree closes it and turns every write into a mini-build; taking the index
  lock across the append is what `writeProducedLines` already does — and that is the reason this is
  acceptable to leave: `writeLines` has no caller outside tests, and the real write path's version of
  this race does not produce an omission, it produces a *build* (`:534-536`, writer 2 sees a
  not-current index and builds), which is the orphan race Stage 1 and Stage 2 close. `openIndex` is a
  decision for the reason `EV-38` gives and one more: the answer it returns is *as of* the hash it
  took, which is what a read of a derived index is, whereas `buildIndex` PERSISTS an artifact
  certifying a tree. The three-way distinction — persisted claim (defect), as-of answer (not), and a
  report about a handle (defect, fixed in Stage 2) — is the shape of the class.

  **Stage 4 — records and the gate.** `EV-38` (written), the `dogfood/` record for what a build racing
  a writer hands a user, the `evidence_record` and `decision` entries, and the gate.
  *Status*: **Complete (2026-09-30) — with one item deliberately not done, and the reason.** **No
  `dogfood/` record was written.** The convention's own test is *"did anyone ask the question first?"*,
  and here the bead named both the question and the experiment, so the finding belongs in
  `docs/evidence/EV-38.md` and a dogfood record of it would be the ask-first case wearing the other
  series' clothes. The one thing the fix work handed over unasked — that a rename leaving the sidecars
  in place is *not* the orphan, and that `buildIndex`'s `rmSync` pair is load-bearing for a second
  reason — is **the same mechanism `dogfood/0044` already records** (a `-wal` recovered onto whatever
  file sits beside it), so `0045` would have been a duplicate, and the series is worth more without it.
  It lives in Stage 2's status above and in the code comment on `indexAtPathCarries`, which is where
  the next person to touch that line will be.

  Store entries, recorded with `asc record` against this repo's own tree — which also exercised the
  fixed write path end to end:
  - `evidence_record` **`0bdcc6be-e72e-4739-bd3e-9d9ae114e0c6`** — EV-38: question, method, the
    verbatim measurement blocks, arms `{stale 23/24, false-green 1/24}`, decision, confidence.
  - `decision` **`5fba1dba-e938-4658-b8ac-b9fae438735b`** — the fix shape: one traversal plus an honest
    writer report, against the lock and the no-rename build, with the measured reason each lost.
  - `decision` **`6dd91d44-b285-46ce-8686-62346b8cefc4`** — `openIndex` stays an as-of read, and the
    persisted-claim / as-of-answer / report-about-a-handle split the class turns on.
  - `decision` **`d76e50bd-4d9b-474b-b818-a050cdf2086b`** — `writeLines`' two-writer omission left
    unfixed, with the interleaving and the three rejected fixes.
  - **A mistake, recorded rather than smoothed over:** the first `asc record` wrote an entry and a JSON
    field probe on its output printed `None None`, which was read as a failure — so the command was run
    again and the store held two identical `evidence_record`s. Entries are immutable and cannot be
    deleted, so the duplicate `a0f7557f-ab66-42d5-abda-12ed4834ab09` was struck with
    `asc invalidate --label superseded --superseded-by 0bdcc6be…`
    (`inv-d5ad43478903fc5cf25e1d764ceae928c374f588548724ae6c6d87af6257f50c`). The probe was wrong, not
    the write — a tooling mistake worth one line, since it is a second instance of the shape
    `dogfood/0041` records: a strike is written and **no read path consults it**, so the duplicate still
    counts in every listing (`asc-9xi0`, open). Verified rather than repeated: `asc types list` reports
    **43** `evidence_record` entries and the struck id is **still present** in `entries` (1 row), so the
    strike removed nothing from the count.
  Final gate **green**: 124 files / **2832** passed, 2 skipped; `align` verdict green (parse,
  architecture, security all 0 violations).

- **E12.8 — an invalidation, read as well as written (`asc-9xi0` + `asc-4wx6`, done 2026-09-30).** A
  strike is the store's only durable claim about why an entry stopped counting
  (`ARCHITECTURE.md:600`), and two defects meant the claim held in neither direction. **Written:**
  `recordInvalidation` refuses an empty reason, but `asc import` reaches the reserved scheme through
  `recordAnnotations`, whose only note gate was `note !== undefined && note === ''` — so an *absent*
  note became SQL NULL and a *whitespace-only* note was stored verbatim, both exiting 0, and
  `listInvalidations`' `reason: row.note as string` then read back a `null` the type says cannot
  exist. **Read:** `listInvalidations` had exactly one caller, `asc invalidate --list` — the command
  that *writes* strikes. Every other surface counted struck entries as ordinary.

  This is the one entry in E12 whose repair moves a **number a person reads**, so it is worth stating
  what the decision was and not only what was built. The owner's ruling, taken before the work
  (**"a count is an answer; a row is data"**): *counts move* where they answer "how much do we still
  have that stands"; *rows stay raw and MARK*; nothing is hidden, so the struck count sits beside
  every count that moved; and the four raw doors — `asc query`, the `v_<type>_v<version>` views,
  `unionEntries` and `explore`'s population — stay raw. Three recorded decisions survive untouched by
  construction: `asc-88m`, `sql.ts`'s "invalidated rows are NOT filtered out of the view", and
  `listTypes`' "deprecated types are NOT filtered out here".

  **Stage 1 — a reasonless strike cannot enter.** The refusal went where E12.6 put its version rule:
  the corpus parser, not the writer, so `asc index build`, `asc import` and `asc store rewrite`
  inherit it and no writer can get behind it. `requireInvalidationReason` (`jsonl.ts`) is called from
  the `annotation` branch beside the version check; `RESERVED_SCHEME` arrives through the already
  type-only `annotations.ts` import, so no cycle. The message names the **hand-edit**, because there
  is no automated repair — `store rewrite`'s whole reason for relaxing a rule is that it can repair
  an old tree, and a missing reason is not reconstructible. Two false comments in `annotations.ts`
  were corrected in place, including one that named the wrong writer.
  *Measured*: `spike/e12-invalidation-reason.mjs` — the probe that found the defect — re-run, **both
  arms refused**, and the probe now asserts the refusal *names the reason rule*, because its first run
  after the fix reported a green produced by E12.6's version rule and not by this one. The
  measurement's own tool became the regression check. Pre-flight: this repo's tree holds **3,144
  invalidation lines, 0 reasonless** (0 absent, 0 whitespace-only), so the refusal cannot brick it.

  **Stage 2 — one predicate, and the counts move.** `invalidationExistsSql` (private) with
  `struckSql`/`standsSql` over it in `sql.ts` — the module that already exists so readers agree about
  invalidation — replacing the predicate `openEntriesByVersion` had been re-spelling. `entryCount`
  becomes live and gains `struckEntryCount`; `listTypes` carries both aggregates in its derived table
  so the live number is literally `entryCount`'s expression; `TypeSummary` gains `struckCount`.
  `entryCount`'s **meaning** moved rather than gaining a live sibling, and the reason is failure mode:
  an opt-in name would leave every forgotten consumer silently printing the old total — the exact
  defect class this entry exists to close — whereas a moved meaning makes a forgotten consumer print
  the new number and the required `struckCount` field names every literal at compile time.
  **One thing the plan did not foresee:** `annotations.ts -> sql.ts -> annotations.ts` is a cycle and
  `align` refused it. Broken by moving the one constant both need, `RESERVED_SCHEME`, into the new
  leaf module `packages/store/src/reserved.ts`, imported and re-exported by `annotations.ts` so every
  existing importer is untouched — a real fix rather than an exemption.

  **Stage 3 — the surfaces.** `asc types list` gains a `struck` column between `entries` and
  `review_after` (null when zero, so the column set does not vary with the data). `asc types brief`'s
  marker carries the struck count **inside the existing `review_after` marker and nowhere else**, so
  for an unstruck type the bytes are identical and the SessionStart budget is untouched — and for a
  struck type below its `review_after`, identical too, a limitation the doc comment states rather
  than leaves to be discovered. `asc doctor` reads the live count and tells *"every S recorded
  entries struck"* from *"never recorded"*, and `exportStatus(live, struck)` guards on the **sum**, so
  an all-struck store is not told it has nothing to lose. The plan's named risk — that `record.ts`'s
  advisory arithmetic assumed the count was the row count — was measured rather than assumed, and the
  arithmetic holds: the baseline IS the live count, so a strike moves the `review_after` point back
  and the advisory is owed again.

  **Stage 4 — search marks a struck value.** `PropertyValueHit` gains `struck` as a **count, not a
  boolean**, because a group aggregates entries and a value carried by two entries where one is
  struck must say so: `(3 entries, 1 struck)`, `(1 entry, 1 struck -- all struck)`. `SearchScope`
  gains `struck` with `entries` and `indexed` left **raw** and documented as such — `indexed` is what
  a search can actually return, and `assistReason` keys `type-empty` on `entries === 0`, which would
  falsely tell an all-struck type it has no entries. The coverage sentence leads with what stands:
  *"This type has 94 entries that stand (95 recorded, 1 struck), of which the index holds 60"*.

  **Stage 5 — the door to the other half.** `explore` keeps its whole population on purpose — its
  `invalidated` row is a share *of* `count` (`asc-k6p.1`), so a live population would make that row
  always zero — and gains `--struck` instead, threaded into the same scope `--filter` already owns so
  the two compose as one predicate over one projection rather than two that could disagree. It
  reaches the map, `--page`, `--sample` and `--group-by`; `--group-by` discloses the narrowing
  through the existing `filter` coverage row, whose job is already "which population were these
  counts computed over". `--dump --struck` is refused for exactly the reason `--dump --filter` is — a
  dump's manifest has nowhere to record what thinned it — so the two share one check.

  **The finding this turned up unasked, and the record it produced.** `asc explore decision --filter
  "invalidated is not null"` → `no such column: invalidated`. The command prints an `invalidated` row
  and cannot be asked to select the rows that row counts: the predicate is evaluated over the type's
  own projection (`type-filter.ts`, `asc-56k`) and `invalidated` is a value the command *computes*,
  not a column. **3,144 of 6,596 entries (47.7%) had stopped counting and no invocation could show
  one of them by that fact.** Recorded as `dogfood/0045`, whose "nobody was looking for it" line is
  inverted — I *was* looking, at struck rows, and the tool named the column and refused it.

  `dogfood/0045` also carries **a correction to `dogfood/0034`**, which claims `asc import` enforces
  *neither* of the two things `listInvalidations`' casts assume. That is wrong for the **label** half:
  `restoreInvalidationScheme` (`annotations.ts:452`) refuses any scheme line whose `schemeHash`
  differs from `INVALIDATION_SCHEME_SPEC`'s, so the closed label vocabulary *is* protected and only
  the reason cast was false. The claim was corrected rather than left, because a record of false scope
  is what a later reader cites to justify changing code that is already correct.

  *Tests*: the suite moved **2832 → 2879 (+47)**, across `store/test/registry.test.ts`,
  `store/test/search.test.ts`, `store/test/jsonl-files.test.ts`, `store/test/jsonl-index.test.ts`,
  `cli/test/types.test.ts`, `cli/test/cli.test.ts`, `cli/test/record.test.ts`,
  `cli/test/doctor.test.ts`, `cli/test/search-assist.test.ts`, `cli/test/search-cli.test.ts`,
  `cli/test/corpus.test.ts` and `cli/test/explore.test.ts` — the last set driving the real binary
  through record → invalidate → list/search/explore/doctor. Two of the Stage 3 suites were written
  after their implementation, which is not a RED, so their binding was established **by mutation**
  instead and the mutation is recorded rather than the claim: unmarking `struck` in
  `list.ts`/`brief-text.ts` fails 3 of the 6; making `entryCount` raw fails the `record` advisory
  test.

  *Verified end to end on the built binary*, on this repo's store and on a scratch project carrying
  the whole path: `asc index build` 0 (10,516 records); `verification_run` now reads **1440 live /
  3000 struck** where it read 4440; `asc doctor` reads `6601 entries (3457 live, 3144 struck)`;
  `asc search` leads with the standing count and marks the struck value; `explore probe` profiles all
  3 (`33.3%`) while `--struck` profiles the 1 (`100.0%`); and `asc export | asc import` restores the
  strike — the imported store reads back the same `entries 2, struck 1` and `invalidate --list`
  intact. Final gate **green**: 124 files / **2879** passed, 2 skipped (+47); typecheck 0, lint 0,
  `format:check` 0, `align` green (parse, architecture, security all 0 violations).

- **E12.9 — a guard that stops at the top level (`asc-y9ut`, P2, done 2026-09-30).** Three
  source-scanning guards enumerated a package's `src/` tree with a single non-recursive `readdirSync`,
  so the first subdirectory added under any of those trees would have been read by nobody while the
  guards stayed green — the "reports success wrongly" class, because a scan that sees less is
  indistinguishable from a scan whose subjects are clean. The bead named two:
  `store/test/recorder.test.ts` (the one-write-path and no-ambient-clock guards over `store/src`) and
  `adapter-claude-code/test/reader-source.test.ts` (the adapter's read-only promise). **A sweep of
  every `readdirSync` over a package `src/` tree in `packages/*/test` found 3 of 7 flat** — the third,
  `store/test/sql-port.test.ts`, carries the claim that `db.ts` and nowhere else names `node:sqlite`,
  and the bead did not name it. Nobody was looking for a third.

  *Measured, not assumed*, which is the whole point of the stage: a real
  `src/planted-probe/offender.ts` was written into each real tree — `INSERT INTO entries` + `Date.now()`
  + `import { DatabaseSync } from 'node:sqlite'` into the store's, `import { writeFileSync } from
  'node:fs'` into the adapter's — and only the guards claiming to cover that tree were run. **Before**
  the fix all four reported green with the violations sitting in the tree (`1 passed` ×3 and
  `11 passed`); **after** `{ recursive: true }` on the three walkers the same plant fails six
  assertions, including `reader-source.test.ts`'s enumerated-file list — the mechanism that forces a
  new file to be acknowledged, and therefore exactly as blind as the walk it guards.

  *The permanent tests plant a temp directory, never `src/`* — `writer-callers.test.ts`'s recorded
  reasoning, that a planted file would make the real assertion fail for a reason that is not a defect.
  Three new tests, one per guard, each asserting the walk reaches a nested file; bind checked **by
  mutation**: deleting `, { recursive: true }` from the three walkers and nothing else fails exactly
  those 3 of 60.

  *Recorded as `dogfood/0047`*, under the class `dogfood/0039` already named — a report true about what
  it read and false about what it claims. **The class is closed at three instances and not as a
  class**: the recursion is written three times and nothing enforces it, so a fourth coverage guard can
  be flat again. Two structural remedies were considered and not taken, and the record says why.

  *Tests*: the suite moved **2879 → 2882 (+3)**. Full gate **green**: 124 files / **2882** passed,
  2 skipped; typecheck 0, lint 0, `format:check` 0, `align` green (parse, architecture, security all 0
  violations).

- **E12.10 — a call the harness refused still counted (`asc-2uov`, P2, done 2026-10-01).** The
  deriver read a `ReportFindings` call's **input** and never its **result**, so a call the harness
  refused wrote one `review_finding` entry per finding. The bead had that, and drew the opposite
  conclusion from it: *"arguably correct — the findings were real and only the wrapper's schema was
  wrong — but undocumented"*. The measurement overturned the framing rather than the fact. A refusal
  is followed by a **corrected retry carrying the same findings**, so the defect did not add a stray
  row, it **doubled the count** — and the number it doubled is the per-lens count this type exists to
  produce. This store held **18 `reported` entries for 9 distinct findings**: `call_0o92cyc2`
  (refused; 6 of 9 `short_summary` over the tool's 60-character maximum, longest **79**) and
  `call_p374n0av` (accepted; longest **57**) differ in **0 of 9** `(file, line, summary)` triples and
  **0** lens values. *Nobody was looking for the doubling.*

  *The decision was forked to the owner*, because one candidate was a schema change and hard to
  reverse: **do not emit for a refused call**, versus document-only, versus stamp the entry so counts
  could exclude it, versus dedupe by finding identity. The measurement is what settled it, and it
  settles the cost side too — across every transcript on this machine, **35** calls, **3 refused
  (8.6%)**, **26** findings carried by them, **25 of the 26 (96.2%)** duplicated by a later accepted
  call; the single finding with no twin is in an **ephemeral** project ingest skips, so suppressing a
  refusal loses **nothing** in any transcript the store actually reads. The 3 refused calls are under
  `MIN_N`, so those two figures are recorded in `dogfood/0049` as an **anecdote, not a rate**.

  *The fix is the join the rule's own comment refused*, and the comment is worth reading because every
  clause of it is true: *"No join is needed, which is why this rule sits here rather than in the
  pending-result machinery: the findings are an ARGUMENT to the call, not a result of it."* It is true,
  and it is the bug. Findings are held in a per-file `pendingReports` map and resolved when the call's
  own `tool_result` arrives — the shape `invocations` already had one level up, for the same reason
  (`tool_denial`: *"a denial and the invocation it refused are on DIFFERENT records"*). `is_error ===
  true` is the **only** suppressing value: an unresolved call is EMITTED, so the delta is strictly
  "stop writing what we can prove was refused" and can lose nothing that exists today, and every
  pre-existing unit test — all of which build a `tool_use` with no result — stays green unchanged.

  *No `derivationVersion` bump*, and this is load-bearing rather than an omission. `@n` exists so a
  stale entry cannot suppress a differently-meaning new one under the same key; here **no surviving
  key changes meaning** — 121 keys still derive identically and 9 simply stop being produced — so a
  bump would mint **121 duplicate ids** and `dogfood/0024` is the record of exactly that failure for
  exactly this type (a version change that left the old rows counted beside the new, 47 struck by
  hand). The 9 already on disk needed the same remedy, for the same reason the store gave on
  2026-09-30: **`openRecordWriter` appends** (`jsonl-files.ts:659`) and never rewrites, so a re-ingest
  removes nothing. Each phantom was struck `superseded` with `--superseded-by` naming its
  index-matched survivor; `asc types list` now reads `review_finding 2 13 74 56` where it read
  `83 / 47`. The counter `refusedFindings` was added AND wired to the ingest output — a count nobody
  prints is the silence the counters exist to prevent.

  *Driven end to end*, which is the only evidence that counts here: the real binary, `--root` at a
  scratch corpus holding a copy of the real 77 MB session transcript, into a fresh store —
  `entry review_finding 9 new`, with `Warning: 9 reported finding(s) came from a ReportFindings call
  the harness REFUSED`. Nine, not eighteen.

  *Recorded as `dogfood/0049`*, under the class `dogfood/0039` named and `dogfood/0047` was the third
  instance of — a report true about what it read and false about what it says — and named a
  **false-green** on the project's own severity-zero terms. *Tests*: 5 in `derive.test.ts` (RED first,
  all 5 failing on the absent counter and the emitted entry), 1 in `cli/test/ingest.test.ts` driving
  the real binary through a refused-call-plus-retry fixture and reading the store back. The suite moved
  **2882 → 2888 (+6)**. Full gate **green**: 124 files / **2888** passed, 2 skipped; typecheck 0, lint
  0, `format:check` 0, `align` green.

- **E12.11 — a preview that mints an id it will not use (`asc-mw1u`, P3, done 2026-10-01).**
  `asc record` mints a random UUID for any entry whose document does not name one
  (`record.ts:692`), and `--dry-run` runs the same body, so **it mints its own**. The id a preview
  reports is therefore not merely usually different from the id the write produces — it **cannot**
  be the same, because the two are two calls to `randomUUID`. `--dry-run --json` returns a row with
  the same `type_hash`, a `recorded_at`, a `states` map and `dry_run: true` as its only marker, so
  the `id` reads as a preview of the id. It is a preview of nothing. Found while dry-running three
  decision documents before recording them, for their *warnings*; the ids were incidental, and
  *nobody was looking*. Recorded as `dogfood/0046`.

  *The class was hunted and the count is **one**.* `annotate.ts:589` also mints annotation ids, and
  `annotate --dry-run` does not report them in either arm — its row carries
  `scheme/outcome/considered/labelled/unclassified/dry_run` and no id at all. So there is no second
  instance to fix, and a source scan across `packages/*/src` finds exactly two `randomUUID` call
  sites. Stated as a measured count rather than as "this is the only one", because the second site
  is one line away from having the same defect.

  *The decision was forked to the owner* — the finding record itself concluded that, calling it
  *"a small user-facing contract question ... the owner's to settle, not a mechanism to be inferred
  from the code"*. Three real options: omit the id when it was minted; keep it and add a
  `id_provisional` marker; keep the key and set it to `null`. **Chosen: omit the id when it was
  minted** (dry-run arm only — a named id is still reproduced exactly, and a real run always reports
  a real one). The argument that settled it is the house rule this codebase already writes down at
  `output.ts:207`: *"`evidence_text` is omitted when the entry has none rather than rendered as an
  empty string, for the same reason every other absent value in this CLI is (`TASKS.md` #7): an
  empty evidence field and a missing one are different facts."* A specimen UUID is that same failure
  with a louder voice — a value wearing a value's clothes — and the project has refused exactly that
  shape once already, when it declined to stamp a placeholder reason on a reasonless strike
  (`asc-4wx6`). The escape hatch costs nothing and already exists: **name the id in the document and
  the preview reproduces it faithfully**, which is also the only way to make the *write* use a
  chosen id.

  *Measured before choosing, so the cost side is a number rather than a worry*: **no consumer reads
  `record`'s row id** — a scan of `packages/cli/src` finds `.id` reads only on `explore`, `annotate`
  and `import` rows, never on a record row.

  *The cost, stated plainly*: a key that is always present becomes absent in one arm, which is a
  breaking shape change by the contract's own rule (*"Increment only for a breaking shape change"*),
  so **`ascend_output` goes 2 → 3**. That is why this is a fork and not a default — the alternative
  reads cost no bump. Two tests pin the literal (`output.test.ts:329`, `help-cli.test.ts:151`) and
  both move with their comment naming this reason, which is what they ask for.

  **Stages.** 1 — the contract bump, in `output.ts` and both pinning tests. 2 — `record.ts` omits
  `id` when the document named none and the run is a dry run; the row is built from `merged.id`,
  which is already in scope, so no new state is threaded. 3 — tests, RED first: a dry run with a
  minted id has no `id` key; a dry run with a **named** id still reports it; a **real** run reports
  an id that equals what the store holds. 4 — records and the full gate.

  *Built.* The implementation is one spread — `...(mintedHere ? {} : { id: result.entry.id })` —
  where `mintedHere = dryRun && merged.id === undefined`. The flag description and the file header
  both say the omission, because the honest sentence has to be where a caller reads it and not only
  in the JSON. The four arms were driven on the **real binary** rather than inferred from the
  suite: a dry run with no id named prints `{"ascend_output":3,"rows":[{"index":0,"type":"decision",
  …,"dry_run":true}]}` — no `id` key anywhere; a **named** id still prints
  `"id":"named-by-the-caller"`; a real run prints `"id":"732387f6-49a0-4335-8f4a-c5d9a640af84"` and
  that is the id the store holds; and the **table** renders a blank id cell with the string
  `undefined` absent from stdout, which is the one way this fix could have made the human view
  worse. *Tests*: RED first — exactly the target assertion failed (`expected { index: +0, …(10) } to
  not have property "id"`) while the three controls were already green, which is what a control is
  for. 4 new in `record.test.ts`, and the two version pins moved with their comments naming this
  reason (`output.test.ts` — *"If you are here to change this number, say in the comment why"* —
  and `help-cli.test.ts`, which writes the literal a second time). The suite moved **2888 → 2892
  (+4)**. Full gate **green**: 124 files / **2892** passed, 2 skipped; typecheck 0, lint 0,
  `format:check` 0, `align` green. `dogfood/0046`'s Status and its index row both moved to *fixed in
  the working tree* — the two are kept in step in every record checked.

- **E12.12 — a no-op transition is a real entry (`asc-xvz5`, P2, done 2026-10-01).**
  `asc record stage_transition` accepts a document whose `to_status` equals its `from_status`, and
  stores it. The field's own description already says what that is — *"Equal to `from_status` is
  legal and usually a mistake -- record the transition, not the state"* — and nothing enforced it.
  The mistake lands as a durable entry (entries are immutable, so the strike that answers it costs a
  **second** entry), inside the count this type exists to produce. Recorded as `dogfood/0037`, found
  2026-09-29 while probing the enum, because `asc types show` truncated the list mid-word
  (`dogfood/0036`) and writing an entry was the only other way to ask what was legal.

  *Measured before choosing, on this store's own tree* — 51 `stage_transition` entries, **4 of them
  no-ops (7.8%)**, and the four do not agree about what a no-op means:

  | entry | `evidence_text` | struck |
  |---|---|---|
  | `bbc13728` · in_progress→in_progress | *"to_status stays in_progress because the bead is 'asc kappa' and no asc kappa command exists yet"* | no |
  | `616f9174` · in_progress→in_progress | *"to_status stays in_progress because asc-8tv needs asc annotate … and neither command exists"* | no |
  | `9b8e9d6d` · in_progress→in_progress | (none) | no |
  | `df58e059` · in_progress→in_progress | (none) | **yes**, `wrong_value` |

  **Half the no-ops in this store are deliberate, and the recorder wrote a paragraph saying why.**
  That number is what makes the choice non-obvious, and it is why a **hard refusal is measurably
  wrong here**: it would have made `bbc13728` and `616f9174` unwritable — two entries whose whole
  content is a plan stage that was worked and did not move, which is information a plan wants.

  *Where the check may live is decided by a second measurement, not by taste.* Every writer funnels
  through `recordEntry` → `validateEntry` — `asc record`, `asc import`, `asc ingest`, and
  `asc index build`'s replay (`jsonl-index.ts:969`) — so a **refusal raised in that funnel would make
  `asc index build` throw on this tree's four existing no-op lines**. The precedent does not transfer:
  `asc-4wx6` put its refusal in the corpus parser for exactly this reach, and its pre-flight measured
  **0** existing violations. Here the pre-flight measures 4, two of them deliberate. So the guard goes
  on the **write command's own path** — `asc record`, which is also where the mistake was made — and
  this tree stays reindexable and importable exactly as it is.

  *The owner chose the door.* Three options were put with the numbers above: refuse outright; refuse
  unless the entry gives a reason; warn and write anyway. **Chosen: refuse unless a reason is given**,
  and the acknowledgement is `evidence_text`, the store's own field for *"why is this true"*. The
  measured fit is why that is the recommendation rather than a compromise: **the two deliberate
  no-ops already carry one, unprompted, and the mistake does not** — so nothing about how the
  legitimate entries were recorded changes. Refusing outright would have refused the two; warning
  would have refused neither and left the mistake durable.

  **Stages.** 1 — the guard, declared in `starters.ts` beside the type it guards (`stage_transition`
  is a CLI starter; core and store are generic and one starter's name belongs in neither), as
  `starterEntryIssue(typeName, properties, evidenceText)`. It compares only when BOTH statuses are
  present strings — `undefined === undefined` is not a no-op, it is two absent decisions, and the
  required-property rule already owns that — and treats a whitespace-only reason as no reason, which
  is the `asc-4wx6` rule applied again (*"a value wearing a value's clothes"*). 2 — `record.ts`
  consults it per document **before** `produce.entry`, so nothing is ever appended and the refusal is
  an ordinary `EntryRejectedError` naming the batch index; it fires on `--dry-run` too, because a
  preview that green-lights what the write refuses is the `asc-mw1u` failure in the other direction.
  3 — tests, RED first. 4 — the record, the decision entry, and the full gate.

  *Built.* The guard is `starterEntryIssue(typeName, properties, evidenceText)` in `starters.ts`,
  beside the type it is about, and `record.ts` consults it once per document before `produce`. It
  throws the ordinary `EntryRejectedError`, so the batch index and the *"so nothing was recorded"*
  line come from machinery that already did them. **The test suite caught a hole in the guard and a
  mutation check caught a hole in the test.** The suite's RED run was exactly the four refusal arms
  against three controls already green. The mutation check then found that deleting the `typeof`
  half of the comparison left all seven tests green — the arm written for that case used
  `--na from_status`, which leaves `to_status` present, so the naive `undefined === undefined` path
  was never reached. The arm was replaced with the one that reaches it (both statuses absent, where
  the honest refusal is the two **required** errors and not `'to_status' is 'undefined'`), and the
  mutation now fails exactly one test. That is the whole argument for mutating rather than trusting a
  green run: the suite was green, and the line was unbound.

  *Driven end to end on the real binary*, five arms plus the placement counterfactual. A no-op with no
  reason exits **1** naming both statuses and the door; the same no-op with `--evidence` exits **0**
  and the reason is in the row; a transition to `complete` with no reason exits **0** and its
  `evidence_text` is null; the no-op on `--dry-run` exits **1**, so the two arms agree; and two absent
  statuses report the two required errors. Then the placement, measured rather than argued: a corpus
  exported from a legal no-op and stripped of its `evidence_text` **imports** (`entry stage_transition
  1 restored`, exit 0) and **indexes** (exit 0, 5 records), while `asc record` of the same no-op exits
  1 — the asymmetry the four existing lines in this tree required. *Gate* **green**: 124 files /
  **2900** passed (2892 → 2900, +8), 2 skipped; typecheck 0, lint 0, `format:check` 0, `align` verdict
  green, baselined debt 20 → 20. `dogfood/0037`'s Status and its index row both moved, and the Status
  carries the correction for two sentences in the record's own body that this change made stale — the
  body stays immutable, per `asc-4wx6`.

**Status: E12.1 and E12.2 built; E12.3 built as the seam and its settlement** (2026-09-29) — the record
layer exists (37 tests), the derived index exists (26 tests after `asc-i5tj.3.1`), the store names a SQL
port instead of the driver (3 tests, one module may import `node:sqlite`, pinned by name), and
`asc index build` is the only way an index is built (4 real-binary tests, plus a source scan pinning the
two modules that may call `buildIndex`). `align` green with no `store -> cli` edge, and the full suite
green. **The gate's typecheck is `tsc -b && tsc -p tsconfig.eslint.json`, and `tsc -b` alone is not
it** — the second project is what covers test files, so "`tsc -b` clean" is not a typecheck and was
reported as one here until the first commit attempt was blocked. What it was hiding: three store test
files still named `DatabaseSync` where the store now hands back a `SqlDatabase`, and the new
`index-build-cli.test.ts` left a property's `type` to inference (where it widens to `string`, so the
document stops being a `TypeDocument`) and read its JSON report through a `Record<string, unknown>`
index signature. Every fix was to name the type; none was a cast. E12.1 is validated by a real-git
merge replay, not only by its own suite, and E12.2 by
`docs/evidence/EV-33.md`, which re-times the real build path and records a correction to EV-32. Two
plan-level findings came out of E12.1 and are filed as beads rather than fixed here (they are format
questions, not layer questions): a scheme name is any string, and a type line carries no version of its
own. The design input E12.2 surfaced — a silent ~75 s rebuild — **is settled: a read never builds**
(`asc-i5tj.3.1`), by a two-function split rather than a mode, and the `asc-63v` foreign-file guard moved
with the write path when the build became a command. **E12.4 is next: the cutover**, and its two open
questions were settled before it started rather than during — the migration's fidelity, by `EV-34`
measured 2026-09-29 (10,316 lines, 0 lost, 0 gained; every row of the four kinds equal; ~4.65 s for the
whole migration; two things the format cannot carry, filed as `asc-i5tj.14`), and the index-currency
question, by the owner's decision above, which reverses `EV-32`'s "no incremental path" on `EV-33`'s
measurement. Plan-level findings from E12.1 are still beads rather than edits here (a scheme name is any
string; a type line carries no version of its own), because they are format questions and not layer ones.
**E12.6 settled the second of those two, measured 2026-09-30 (`EV-37`)**: a type line states its own
`version`, readers sort by `(name, version)`, and a version-less line is refused naming
`asc store rewrite`, which upgraded this repo's own tree in one run — 1 of 22 record files changed, the
other 21 byte-identical, 17 lines numbered `note`/`review_finding`/`verification_run` v1+v2 and eleven
more at v1. The plan's own Stage 2 placed the "a stated version must continue the sequence" check inside
`registerType`; **that placement is overturned by a red test** and recorded in `EV-37`, because the
registry cannot see the target store's history and the message it produced blamed the caller's
well-formed file. The check lives at the two call sites that can see both sides instead.

---

### E12.5 — the two guards the blocked beads own: a contradiction refused, and a record that cannot grow without bound (`asc-2ezs` + `asc-8uzh`, P1 + P2, planned 2026-10-02)

**Goal** — close the two guard beads `asc-i5tj` was blocking. Both are the *unfinished* half of a rule
E12.1 already shipped half of, which is why they read as smaller than they are: the duplicate half of
`asc-2ezs` is done and only the contradiction remains, and the byte-bounded rollover half of
`asc-8uzh` is done and only the per-record limit remains.

**Both are read/write guards on `packages/store/src/jsonl-files.ts`**, the file layer, and neither
needs SQLite — which is the file's own standing rule (no index, no DB, in this module).

#### Measured before planning (2026-10-02, on this repo's own tree)

| | |
|---|---|
| **Blast radius of the refusal** | `.ascend/entries/*/*.jsonl`: **6,822 lines, 6,822 distinct ids, 0 ids appearing twice at all** — so nothing here is bricked, and `dedupeByIdentity` is currently a no-op on this tree (it exists for merge scenarios, not for this one) |
| **Blast radius of the cap** | entries + annotations: **10,727 record lines, max 9,046 B, p99 2,420 B, p99.9 6,632 B, 0 over 10,000 B, 0 over 1 MiB** — the largest single line is 1/116th of the cap |
| **Can the refusal fire on a normal path?** | No. Annotation ids are random UUIDs (`by_kind` et al.) or content hashes (`inv-<sha256>`), so distinct content already implies a distinct id; derived *entry* ids are `derived:claude-code:<type>:<session>:<key>`, not content-addressed, so a changed re-ingest *can* produce the shape — and the ingest path already catches exactly that before writing, by comparing fingerprints and reporting a collision (`cli/src/commands/ingest/claude-code.ts:829-848`) |

#### Stage 1 — `asc-2ezs`: one id with two distinct contents is refused at read

**What exists.** `dedupeByIdentity` (`jsonl-files.ts:292-302`, applied at `:530-531`) already collapses
byte-identical lines on their **canonical serialization**, which is the whole of the bead's second
half. What does not exist is the refusal: `readRecordTree` returns **both** lines today, and two tests
assert exactly that (`jsonl-files.test.ts:315-330`, `:828-847`). The only refusal anywhere is
incidental and unhelpful — `buildIndex` → `replayEntry` → `recordEntry` throws a content-blind
`DuplicateEntryError` naming **only the id** (`recorder.ts:277-278`), with no file and no line.

**Tests (RED first)** — in `store/test/jsonl-files.test.ts`:
- **S3, both lines in one file** (what a union merge actually produces): `readRecordTree` **throws**,
  and the message names the id *and both coordinates* (`<file>:<line>` for each).
- **S3 across two files** (the rollover variant): both coordinates still named, and they differ.
- **S2 control**: the same id written twice with **identical** canonical text still collapses to one
  line and does **not** throw — the refusal must sit *after* the dedupe, or every re-ingest refuses.
- **Control against over-refusing**: two lines with *different* ids and the *same* content are both
  kept — the rule is one id with two contents, not duplicate content.
- **Annotations too**: same id, two contents, refused by the same rule (annotations dedupe today for
  exactly the reasons entries do, and a hand-edited tree can hold the shape even though no producer
  emits it).
- The test at `:315-330` (*"orders two records that share an id by their text"*) **is replaced by the
  refusal test** — its premise was that the two lines survive to be ordered.

**Implementation**: `readRecordTree` must carry each line's coordinate, which it already computes and
throws with (`parsed.where`, see the kind and partition guards at `:518-534`) but currently discards.
Collect `{line, where}` per kind and have the dedupe function refuse: on a second line bearing an id
already seen **with a different canonical text**, throw naming the id, the first coordinate and the
second. Dedupe **first**, then the id check, so byte-identical duplicates are removed rather than
reported. `rewrite.ts:17` is *"the only code that reads a tree `readRecordTree` would refuse"* — its
doc gains the second class it cannot repair, because a contradiction is not resolvable by a rewrite
either: the repair is a hand-edit, and the message must say so.

**Status**: Complete (2026-10-02). `onePerIdentity` (`jsonl-files.ts`) replaces `dedupeByIdentity` and
carries both halves in one loop, **dedupe first**: a byte-identical line collapses, and an id seen
again with different canonical text is refused naming `item.where`, `earlier.where` and the id.
`readRecordTree` now collects `{line, where}` per kind (`Filed`) instead of discarding the coordinate
it already computed. `inRecordedOrder` lost its third key, because the shape that key existed to order
is now refused, so `(time, id)` is total on its own — and the ORDER bullet that defended the key
(*"content-addressed … ONE id legitimately carries TWO contents"*) was rewritten to say both halves of
that sentence were false. `rewrite.ts`'s header gained the class it cannot repair: a rewrite relaxes a
rule it can satisfy by rewriting, and a contradiction is not one of them. **6 tests** in
`jsonl-files.test.ts` — 5 net new (S3 in one file, S3 across two files, the S2 collapse control, the
different-ids-same-content control, the annotation arm) plus the same-timestamp ordering test that
*replaced* the old orders-by-text one, whose reason to exist went with the shape it manufactured.
`roundTrip` reads the tree back, so a test asserting the refusal's text needs a write-only path —
that is the `write` helper beside it, and both refusal tests moved onto it.

#### Stage 2 — `asc-8uzh`: a record over 1 MiB is refused at write time

**What exists.** `RecordWriter.append` (`jsonl-files.ts:643-675`) already computes the record's exact
byte length at `:655` and accumulates it; the **file** cap deliberately never refuses a record
(`:657-658`, tested at `:512-519`). There is **no per-record check anywhere**.

**The cap, decided by the owner 2026-10-02: 1 MiB (1,048,576 B), refused.** 116× the largest line
measured above.

**Tests (RED first)** — in `store/test/jsonl-files.test.ts`:
- A line over `maxBytesPerRecord` is refused; the message names **the largest field** and its size;
  **nothing is written** (`written` empty, and the file it would have gone into does not exist).
- A line at exactly the cap is written (the boundary is `>`, not `>=`).
- The **default** is the owner's number: `MAX_BYTES_PER_RECORD` is exported and asserted, the way
  `MAX_RECORDS_PER_FILE` already is.
- `maxBytesPerRecord` of `0` and `-1` is refused at writer construction with the existing
  `"... must be positive, but it is ..."` shape (`:610-622`, tested at `:563-571`).
- **The two caps are different rules, and the test says so**: the existing *"writes a record larger
  than the cap instead of rolling forever"* stays **green** — a file cap still never refuses — while a
  record cap does. One asserts the rollover arithmetic, the other the write refusal.

**Status**: Complete (2026-10-02). `MAX_BYTES_PER_RECORD = 1024 * 1024` with `RecordWriterOptions.
maxBytesPerRecord`, validated beside the other two in `openRecordWriter` in the same
`"... must be positive, but it is ..."` shape. The check sits in `append` immediately after `bytes` is
computed and **before the roll and any `mkdirSync`**, so a refusal leaves the tree exactly as it was.
`largestField` walks the line's own strings with a path (`stringsIn`) and returns the longest with its
byte size, so the message names `properties.enormous` rather than only a total; `lineLabel` names the
record by the identity its kind carries. **The file cap's own comment had to change** — *"the cap
bounds how many records share a file, it never refuses a record"* is true of the file cap and was about
to read as true of the writer, so it now says which cap and names the other rule beside it, and the
rollover test's comment carries the same correction. **3 tests** added (over the cap naming the field;
the largest field; exactly at the cap) plus the default assertion in *"defaults to the measured
thresholds"* and the two non-positive arms. Every one of the three went RED first.

#### Stage 3 — what the refusal takes away, and the docs that must stop saying the opposite

**The ORDER rule loses its third key.** `inRecordedOrder` (`:255-268`) sorts entries and annotations by
`(time, id, serialized text)`, and the third key exists *only* because `(time, id)` could tie — which
required one id with two contents, the exact shape Stage 1 now refuses. After Stage 1 at most one line
per id can reach the sort, so `(time, id)` is total and the key is unreachable. **Remove it** and
rewrite the ORDER bullet at `:58-63`, which currently says *"an entry's id is derived and
content-addressed for derived entries, so ONE id legitimately carries TWO contents"* — two claims, and
**both are false**: derived ids are `session:key`, not content hashes, and the shape is now refused
rather than legitimate. The decorate-sort-undecorate structure exists to avoid recomputing the
serialization in the comparator; with the key gone it goes too.

**`dedupeByIdentity`'s doc (`:289-290`) says the opposite of what ships.** *"Distinct content under ONE
id is deliberately not collapsed… owned by `asc-2ezs`"* — after this, it is not collapsed, it is
**refused**, and the sentence must say that and why (collapsing would lose a record; refusing keeps
both coordinates and lets a human choose).

**Status**: Complete (2026-10-02). Both done, and the second one moved rather than edited: the
`dedupeByIdentity` doc was **replaced by `onePerIdentity`**, which states the two rules and why the
order between them is the whole design (dedupe first, or every re-ingest of an unchanged transcript
refuses). The ORDER bullet was rewritten, and the orphaned doc comment above `OrderableLine` — which
claimed *"the serialized text is a final tiebreak"* — had its claim replaced, since after Stage 1 the
tiebreak is unreachable and the reader's total order comes from `onePerIdentity` instead. The
decorate-sort-undecorate structure the plan expected to find at `:255-268` was there and did go with
it: `inRecordedOrder` built `{line, time, text}` per line and sorted the records, deliberately
avoiding a `serializeCorpus` call inside a comparator that runs O(n log n) times. With the text key
gone, the decoration lost its only use and the function is a plain sort on two fields — a slightly
larger edit than "remove a key" suggests, and one `git diff` shows rather than an argued
reconstruction.

#### Stage 4 — gate, records, close

`pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm align`, full output to a file,
never `| tail`. A red `align check` is blocking. Two dogfood records — one per finding: the
contradiction that was loud but unusable (an id, no coordinates) and the unbounded record that no cap
covered, each with its measurement and what was *not* looking. Both beads closed with their reasons.

**Status**: Complete (2026-10-02). Full gate **green** to a file (`/tmp/e125-gate2.txt`): `format:check`
0, `typecheck` 0, `lint` 0, **124 files / 2926 passed / 2 skipped**, `align` green — *"baselined debt:
20 → 20 (0)"*, `verdict: green`. The baseline was 2,919 and the +7 is **9 tests added and 2 removed**:
the old *"orders two records that share an id by their text"* and the old *"S3: one id with two contents
keeps both"* are replaced by the tests that assert the refusal, since both premises were that the
refused shape survives. Two dogfood records: **`dogfood/0053`** (the contradiction that was refused
with one coordinate, and the ORDER rule that documented the shape as legitimate) and **`dogfood/0054`**
(the file that had a cap and the record that had none, with the suite's own green test standing over
the absence). Index reconciled by NUMBER: `grep -c '^| \[0'` **54**, `ls dogfood/ | grep -E '^[0-9]{4}-'
| wc -l` **55** = 54 records plus `0000-template.md`, no gap and no repeat. Both beads closed with the
reason they were open.

**A claim corrected before it shipped.** Stage 3's status first read *"the decorate-sort-undecorate
structure the plan expected to find was already gone"*, asserted from the plan's own prose rather than
from the file. `git diff` showed it was there — `inRecordedOrder` built `{line, time, text}` per line
and sorted the records to keep `serializeCorpus` out of an O(n log n) comparator — so the sentence was
rewritten to say it existed and went with the key. Third instance in this workstream of a claim written
before it was checked.

---

### E12.13 — the recording command is named where a session reads, and the artifact that taught a denied form stops teaching it (`asc-uftd` + `asc-l38f`, P2, planned 2026-10-01)

**Goal** — a session that intends to record reaches a command that is *findable and correct*, from
both routes it actually takes: the `SessionStart` payload, and the install artifacts it reads when
the payload is silent. Recorded as `dogfood/0028`, surfaced 2026-09-28 by `spike/ev16-arms.mjs` arms
F and G, found while a measurement was running and **nobody was looking for it**.

**The finding is a table, and every artifact fails a different cell.** Re-measured on this checkout
2026-10-01:

| artifact a session may read | what it tells you to run | runs? | covered by the documented grant `Bash(asc record:*)`? |
|---|---|---|---|
| `asc types brief` — the `SessionStart` payload | nothing: `asc record` occurs **0** times; only `asc ingest` (6) and `asc query` (1), both in *"Never by hand"* prose | n/a | n/a |
| `README.md` §Install | `node packages/cli/dist/bin.js`; or an alias in the reader's shell profile | yes | no |
| `README.md` §Quickstart | `asc record review_completed …`, offered as literally runnable | **no** — `command -v asc` exits 1 | yes |
| `ARCHITECTURE.md:331` | documents `Bash(asc record:*)` — a grant for a name that resolves nowhere | — | yes |
| `.claude/ascend-hook.sh` | `node "$root"/packages/cli/dist/bin.js` | yes | **no** |

**No artifact names a form that is both runnable and granted**, and that is structural rather than
an oversight in any one file. `asc` is a bare name nowhere in a project: `command -v asc` exits 1,
`node_modules/.bin/asc` does not exist, `@ascend/cli` is `private: true` and unpublished
(`README.md:41-42` says so in as many words). And a `Bash(<prefix>:*)` allow rule matches the
**literal command text**, after compound-command splitting and a fixed wrapper list — it *"doesn't
match the same program invoked in a different form"* — so `Bash(asc record:*)` can never match
`node …/bin.js record …`, relative or absolute, in any layout. Nothing in the shipped hook script can
repair that from inside: the script needs the path form to run *itself*, so the resolution order is
correct as it stands and the defect is **pedagogical** — it is the artifact a lost session reads, and
what it teaches is a form the grant refuses.

**Three corrections to `dogfood/0028`'s account, measured 2026-10-01 before deciding anything.** The
body is immutable, so they land in its Status cell (the `dogfood/0037` precedent):

1. **The "wall" is a headless artifact.** `spike/ev16-arms.mjs:295` sets
   `ALLOWED = 'Read,Edit,Write,Bash(node test.js),Bash(asc:*)'`, and the arms ran
   `--permission-mode dontAsk`, which auto-denies every call that would otherwise prompt. In a real
   interactive session F2's denied `node …/bin.js` would have **prompted**. The finding's severity is
   friction, which is real — `ARCHITECTURE.md:331`'s stated concern is *"A permission prompt per
   record kills the workflow"* — and not unreachability.
2. **The shim was the harness's.** `spike/ev16-arms.mjs:169` creates `.shim/asc` and `:428` prepends
   it to `PATH`. `0028` already says this; what it does not say is that the same file's grant is what
   made `node …/bin.js` denyable at all. On this checkout the hook script's own form is **allowed**,
   by `Bash(node *)` in the untracked `.claude/settings.local.json` — an accident, and not something
   `asc install-hook` writes, since it writes no permissions at all.
3. **The README's alias remedy works, for a Bash tool call.** Claude Code sources
   `~/.zshrc`/`~/.bashrc`/`~/.profile` at session start and applies captured aliases to every Bash
   command. So §Install is not lying and §Quickstart is not wrong *for a reader who did §Install
   first*; the gap is only that the quickstart never says it depends on that.

**The fork was put to the owner and decided: teach it in both places.** The alternative — make the
bare name resolve by shipping a project shim and exporting it onto `PATH` through `CLAUDE_ENV_FILE`
(a documented mechanism: a shell script Claude Code executes, so `export PATH=…:$PATH` really
expands) — is the only fix that makes the artifacts *true* rather than *consistent*, and it is filed
as its own bead rather than carried by two P2 discovery defects, because it costs a new tracked file,
a new hook duty and a folder-trust step.

**Where the line goes is a correctness question, not a preference.** `packages/cli/src/doctor.ts:213`
assembles its size figure from `briefLine` alone and compares it to `BRIEF_CAP_BYTES`, and
`brief-text.ts`'s own doc says the renderer is shared *"so that the size doctor reports is the size of
what the brief actually prints."* A line emitted by the **hook script** would sit outside both the cap
and the doctor's count: the payload would exceed `BRIEF_CAP_BYTES` by an uncounted line and
`asc doctor` would report a number that had stopped being true. The line therefore belongs in
`asc types brief`'s own rendering — one renderer, one cap, one number.

**Stage 1 — the brief names the recording command (`asc-uftd`).**
*Goal*: line 1 of `asc types brief`'s stdout names the command; the whole text still fits the cap and
the doctor's number still equals it.
*Tests, RED first*: `types/brief` emits the command line first and the type lines after it (the
`toHaveLength(1)` shape assertion at `packages/cli/test/types.test.ts:527` becomes a stated two-part
shape, because this is a deliberate reversal of the *"No header, no rule, no counts"* rule and must be
recorded as one); **the cheap detector made permanent** — the brief's text contains `asc record`,
which is the one-line check `dogfood/0028` names as having caught this before it was ever measured
(empirical-planning P7: codify the invariant so the class cannot recur); `doctor.briefSize` counts the
header, driven across the cap boundary so the number moves; a brief over the cap still emits the header
first and drops whole type lines, and the fallback note still claims no file.
*Implementation*: one `briefText`/`briefLines` in `brief-text.ts` used by **both** `types/brief.ts` and
`doctor.ts` — two renderings is the drift the file exists to prevent — with the header outside the
counted line set so `fitBrief`'s `kept`/`total` stay about types. `--json` is left unchanged, and the
asymmetry documented in `output.ts`'s own idiom (`output.ts:468`: *"A consumer knows which command it
ran"*).

**Status**: Complete (2026-10-01). `RECORD_COMMAND` (`Record with: asc record TYPE --json -`, 37
bytes), `briefLines` and `briefText` in `brief-text.ts`; both callers go through `briefText`, so the
number `asc doctor` reports is this text's byte length by construction. In `types/brief.ts` the header
is emitted outside `fitBrief`'s counted set and its bytes come **off the top of the cap**
(`budget = BRIEF_CAP_BYTES - byteLength(header + '\n')`), so the payload is bounded as a whole while
the note's `N of M types` still counts types; the capped `.ascend/brief.txt` write carries `whole`
(header included), and the no-file fallback keeps the header. `briefText([])` is `''`, so a
deprecated-only registry prints nothing and the doctor reads `0 bytes` — the rule lives in one place
rather than in each caller's early return. `--json` untouched (`columns` and `row_count` unchanged),
with the asymmetry argued in the command's own header comment.

RED→GREEN: 13 failed of 99 across the three chosen files. **The full gate then found a fourteenth
assertion of the reversed contract that I had not thought to look for** — `init.test.ts:568` pinned
the brief to exactly 4 non-empty lines. Its budget guard was right and only the line count encoded the
old rule, so it now asserts the header's exact text plus `lines.slice(1)).toHaveLength(4)`, keeping
"a later starter cannot quietly double it" intact. That is the gate earning its place: three files I
chose, four I needed.

**Bind-checked by mutation**: making `briefText` return `lines.join('\n')` fails 3 tests across 3
files, including `doctor-cli.test.ts`'s end-to-end comparison of the printed payload against the
reported size — the test that decided this placement and the only form of the check that can fail.

**Driven live on this repo's own registry**, not only in tests: the payload went **3,381 → 3,419
bytes** (15 lines, `asc record` **0 → 1**) in **4,619 free**, and `asc doctor` reads
`3419 bytes, ~760 tokens of 2000` — equal to the payload's measured length, header included. One
number in the first draft of `RECORD_COMMAND`'s comment was off by one (`3,382`, the trailing newline
`this.log` appends, which the doctor excludes); corrected to the measured 3,381, since a comment
citing a measurement is worthless if the number is nearly right.

Full gate green: **124 files / 2905 passed, 2 skipped**; `format:check`, `typecheck`, `lint` 0;
`align` green.

**Stage 2 — the hook script stops teaching the form (`asc-l38f`).**
*Goal*: a session that reads `.claude/ascend-hook.sh` is told what to run by hand and that the path
resolution below it is the hook's own.
*Tests, RED first*: the generated script carries the comment; `--dry-run` shows it; the byte-equality
currency check at `install-hook.ts:337` still calls a current script current and a stale one stale —
every existing install will read `upgraded`, which is the designed behaviour and not a regression;
end-to-end, install into a scratch project and `sh` the script, asserting stdout is **exactly** the
brief and nothing more.
*Implementation*: a comment beside the resolution in `hookScript`. **No echo**, deliberately: the line
lives in Stage 1, and `install-hook.ts`'s invariant that `types brief`'s stdout is the only payload
`SessionStart` ever sees stays intact.

**Status**: Complete (2026-10-01). `hookScript` emits a four-line comment immediately above
`${resolution}`, and the command inside it is interpolated from **`RECORD_COMMAND`** — which is why
that constant was split from `RECORD_COMMAND_LINE` in Stage 1. The brief and the script now read one
spelling from one place, which is the structural form of the fix: `dogfood/0028`'s defect was two
artifacts naming one program two ways, and a test that merely compared them would catch the drift
after the fact rather than making it unrepresentable. No `echo`; the script's runtime output is
unchanged, byte for byte.

**One plan claim was wrong and is corrected here**: `--dry-run` does **not** show the script.
`install-hook.ts:775` warns `dry run: nothing was written` and the report carries the settings
command and the outcome — so there is no dry-run arm for a comment inside a file the dry run does not
write. The test is the installed file itself.

RED→GREEN: 3 failed of 45 in `install-hook.test.ts`. The fourth test — the script's stdout compared
**byte for byte** against `asc types brief` — passed on RED and is meant to: it guards a property that
already held and could silently stop holding, rather than driving the change.

The staleness test reconstructs the **previous generation** (today's text with the by-hand block
removed, found by the sentence that introduces it, not by line number) and asserts it reads
`upgraded` — so "every existing install upgrades" is measured rather than assumed, and asserted to be
the currency check working rather than a regression.

Driven live in a scratch project, not only in tests: `asc install-hook --yes`, then `sh
.claude/ascend-hook.sh` with `CLAUDE_PROJECT_DIR` and `ASCEND_BIN` set — `cmp` of the script's stdout
against `asc types brief`'s own reports **IDENTICAL**, and the comment sits above the resolution on
disk exactly as written above.

Full gate green: **124 files / 2909 passed, 2 skipped**; `format:check`, `typecheck`, `lint` 0;
`align` green. (Prettier reflowed the comment block on first pass — the gate caught it, which is what
it is for.)

**Stage 3 — README §Quickstart names its dependency.**
*Goal*: the quickstart's bare `asc init` / `asc record` is not read cold.
*Implementation*: one sentence pointing at §Install's alias. **No test asserts prose** — `dogfood/0028`
states plainly that no test can catch an absence in prose and that asserting one would be asserting a
design choice rather than a behaviour; the standing check is Stage 1's detector.

**Status**: Complete (2026-10-01). §Quickstart now opens with the sentence it was missing: the
sections are written as bare `asc`, which is §Install's alias, and without that alias every `asc`
below has to be `node packages/cli/dist/bin.js`. This is the **second** artifact in the same class —
`0028` is about the hook script teaching a form that is refused, and this is the quickstart teaching
a form that does not resolve, with §Install's alias being the only spelling that both runs *and* is
granted. `format:check` clean; no code, so no other gate arm moves.

**Stage 4 — records, the root-fix bead, gate.**
`dogfood/0028`'s Status cell and its README row (three corrections above); a new record for the
§Install↔§Quickstart gap, which `0028` does not contain; a bead for the shim + `CLAUDE_ENV_FILE` root
fix, carrying the measured reason it cannot ride on these two; then the gate.

**Status**: Complete (2026-10-01). `dogfood/0028`'s Status cell is closed and carries the **three
corrections** (immutable body, `0037`'s precedent): the `dontAsk` harness made F2's denials *prompts*
rather than a wall; the shim and the `Bash(asc:*)`-vs-`Bash(node …)` asymmetry were properties of
*that arm's grant* (`spike/ev16-arms.mjs:169`, `:428`, `:295`), not of Claude Code, and the script's
own path form is allowed on this checkout; and the body's *"converts a discovery problem into a denial
problem, which is worse"* is false for the remedy the README already ships, because **an alias does
work in a Bash tool call**. Its README row moves from `(P2, open)` to fixed.

`dogfood/0050` is new — **the same class a third time, with a sub-shape `0028` does not have**: the
mechanism *is* documented, in the wrong section. §Quickstart ran **4** bare `asc` command lines and used
the word *"alias"* **0** times, while §Install (27 lines up) defines it and itself runs **0** bare
`asc` lines. The mechanism that surfaced it is the part worth keeping: E12.13's artifact table had one
row per artifact, so it was **structurally blind to an absence in the seam between two rows**. Written
with the count-of-text discipline — *no user or session is claimed; whether a reader was stopped is
unmeasured and is not asserted.*

`asc-zser` filed for the root fix (put `asc` on `PATH` via `CLAUDE_ENV_FILE`, which is executed as a
shell script, so `export PATH=…:$PATH` really expands) — deliberately **not** ridden on this pair,
because it changes what `install-hook` writes and needs its own measurement.

Index updated by its own procedure — detector run **first** (`grep -c '^| \[0'` returned 49 against a
sentence saying Forty-nine), row added flush, sentence moved to Fifty, both detectors re-run and
agreeing: **50 rows indexed, 51 files on disk** (50 + `0000-template.md`), numbers `0001`–`0050` with
no gap on either side.

**Full gate green: 124 files / 2909 passed, 2 skipped (baseline 2900); `format:check`, `typecheck`,
`lint` 0; `align` green.** Nothing committed — the conservative profile reports and waits.

**Status**: Complete (2026-10-01). Committed as `275bf38`, on top of `fe9135f` which carried the
derived entries the ingest had left uncommitted.

---

### E12.14 — the line E12.13 added names a command that cannot run, and its second half was never delivered (`asc-k0l9` + `asc-q1mm`, P2, planned 2026-10-01)

**Goal** — close the two P2 defects a bug hunt over E12.13 found, and the class behind the second
one. Full record: `.agents/research/2026-10-01-bug-hunt-e12-13.md`; both findings were reported
through `ReportFindings`, so they are in the store as `review_finding` entries as well.

**F1 (`asc-k0l9`, `assumption_audit`) — the advertised command exits 1.** `asc record TYPE --json -`
reads the entry from **standard input**, and the payload supplies none and never says so. Measured in
a scratch project: `record review_completed --json - < /dev/null` → `standard input is not valid
JSON: Unexpected end of JSON input.`, exit 1. `ARCHITECTURE.md:333` writes the same spelling *with*
the qualifier — *"**`asc record <type> --json -`** (stdin) is the primary path"* — and the brief's
rendering dropped it.

**Decided by the owner (2026-10-01): keep the stdin form and restore the qualifier.** The
alternative — advertise the `--prop` form — was offered with its case (it matches `README.md`
§Quickstart and fails prescriptively) and declined, because it overrides `ARCHITECTURE.md:333`'s
designated primary path, and `--prop`'s shell-escaping cost on long `evidence_text` is exactly what
that document chose stdin to avoid. No form is literally runnable with placeholders, so the choice
is which form a session should be *handed*, and the criterion is which failure teaches the next step:
piping `{}` yields *"chosen is required … Supply the value with `--prop=chosen=<value>`"*.

**The note goes in a constant of its own, not appended to `RECORD_COMMAND`.** Both artifacts need
it — the brief's line and the hook script's by-hand comment name the same command — and appending it
to `RECORD_COMMAND` would make that name stop meaning *the command*. So `RECORD_COMMAND_INPUT` is
exported beside it and both sites interpolate it, which is E12.13's own structural argument applied
one level down: the two artifacts cannot disagree about the input requirement either.

**F2 (`asc-q1mm`, `data_lifecycle`) — the fix was never delivered where it was measured.**
`dogfood/0028`'s Status cell asserts present-tense that `.claude/ascend-hook.sh` carries the by-hand
comment. In this repository it does not:

```
$ ls -la .claude/ascend-hook.sh   →  2127 Sep 27 15:30
$ grep -c "To record an entry by hand" .claude/ascend-hook.sh   →  0
$ git status --short .claude/   →  clean
```

`asc install-hook` is the only writer and it is consent-gated and user-triggered, so the general case
is that every existing install keeps teaching the path form until its owner re-runs the command, with
nothing reporting the skew. **The class, not the instance**: a generated artifact whose generator
changed and whose currency nothing checks.

#### Stage 1 — the brief's line names its input (`asc-k0l9`)

**Tests (RED first)** — the assertions the current text fails:
- `cli/test/types.test.ts`: the brief's line 1 is exactly
  `Record with: asc record TYPE --json -  (a JSON entry on stdin)`; and the header appears in
  `.ascend/brief.txt` in the capped case too.
- `cli/test/init.test.ts`: the starter project's line 1, same text.
- `cli/test/install-hook.test.ts`: the script's comment carries the *note* as well as the command,
  so the two artifacts agree on both — asserted as one literal, in both.

**Implementation** — `RECORD_COMMAND_INPUT = 'a JSON entry on stdin'` in `brief-text.ts`;
`RECORD_COMMAND_LINE` gains `  (${RECORD_COMMAND_INPUT})`; `install-hook.ts`'s `byHand` first line
gains the same interpolation. Cost: **63** bytes for the line -- 62 characters plus the newline the
cap charges -- against the **4,581** free at the time of measurement, and it is charged to
`BRIEF_CAP_BYTES` by the same `Buffer.byteLength` expression, so nothing else moves.

> **Corrected 2026-10-01 by the adversarial review of this change.** This paragraph said "62 bytes
> ... the 4,543 free", which is wrong twice. 4,543 subtracts the E12.13 header's 38 bytes a second
> time: the measurement was taken *after* E12.13, when the brief read 3,419 as `asc doctor` counts
> it, so headroom was 8,000 − 3,419 = **4,581** — the figure
> `.agents/research/2026-10-01-bug-hunt-e12-13.md:110` states verbatim. And "62 bytes" silently
> dropped the newline, which is what the cap is charged for; the consistent figure is 63. The plan is
> a record, so the numbers stand as written above only where they were true when written.

**Status**: Complete (2026-10-01). `RECORD_COMMAND_INPUT` exported beside `RECORD_COMMAND`; both
artifacts interpolate it; `doctor.test.ts`'s arithmetic corrected 86 → 111. RED first: 6 failures
across the three suites, every one on the header text, before a line of source moved.

#### Stage 2 — the second half is delivered here, and the record stops overstating (`asc-q1mm`)

**Goal** — this tree matches its own generator, and no durable record claims more than the tree shows.

**No test can assert this** (it is a committed file in this repository, not a behaviour), so the
evidence is the byte comparison: `asc install-hook` in this repository reports the script
`upgraded`, and the regenerated file contains the by-hand block. `dogfood/0028`'s Status cell — the
correction channel, the body staying immutable — is amended to say the *generator* carries the
comment and to name the delivery gap rather than assert the artifact.

**Status**: Complete (2026-10-01). `asc install-hook --dry-run` reported `would upgrade` against the
committed script, and the real run rewrote it: `.claude/ascend-hook.sh` now carries
`# To record an entry by hand, run: asc record TYPE --json -  (a JSON entry on stdin)` above the
resolution block, and git tracks the change. `dogfood/0028`'s Status cell corrected — the claim now
names the generated artifact and records the gap as `(5)`, with `asc-mu20` filed for the guard.

#### Stage 3 — DEFERRED to `asc-mu20` (2026-10-01)

Not done here. The measured defect F2 names — the stale script at its own dogfood site — is closed
by Stage 2, and the general case is *reasoned* from `asc install-hook` being the only writer rather
than measured on a second checkout. The guard is a new capability (moving `hookScript` and friends
out of `commands/install-hook.ts` into a leaf module so `doctor.ts` can reach them, plus a
filesystem read where every existing `doctor` check is pure), so it is filed as `asc-mu20` with its
four arms written down rather than half-built here. **Nothing in E12.14 depends on it.**

#### Stage 4 — gate, records, close

Full gate to a file; `dogfood/0028`'s Status cell amended with corrections **(4)** (the line named a
command that exits 1) and **(5)** (the cell asserted the installed script carried a comment it did
not), the earlier three left intact and the count moved from Three to Five; both beads closed with
their reasons; and this round's F3/F4 reconciled — the pre-change byte count now names its object at
all four sites (`3,382` bytes as a session received them, `3,381` as `asc doctor` counts them), and
`test/types.test.ts`'s local constant is `RECORD_COMMAND_LINE`, the source's own name for the value
it holds.

**Status**: Complete (2026-10-01). Driven live, not only in tests: `asc types brief` prints the new
line and measures **3,445 bytes** on stdout / **3,444** as `asc doctor` reports it (4,555 free);
piping a document per the note records successfully (`{"properties":{"chosen":"a",…}} | asc record
decision --json -` → one entry, index 0) — the probe entry was invalidated afterwards with the
reason, since its values were placeholders and the store's design is that a mistake is struck rather
than deleted; and `asc install-hook --yes` in this repository regenerated `.claude/ascend-hook.sh`,
which now carries the by-hand block (git tracks the change). The one probe write is why Stage 2 is
not "no side effects": driving the real thing writes to the real store.

**Test counts**: Stage 1 RED 6 failed / 129 passed across `types`, `init`, `install-hook`; GREEN
once `doctor.test.ts`'s byte arithmetic moved 86 → 111 (63-byte header -- 62 characters and the
newline the cap charges -- plus `note -- ` (8) plus 40).
Five suites green: **163 passed**.

---

### E12.15 — the line E12.14 added taught the one spelling the rest of the tree had left, and the
review of the fix found its arithmetic wrong at four sites (`asc-fkp1`, P2, planned 2026-10-01)

**Goal** — an adversarial review of the E12.14 change, and the corrections it found. The review was
run by three independent agents reading the same diff; the findings below are the ones that survived
being handed back with the numbers.

**F1 (`asc-fkp1`, the highest-ranked finding) — the fix taught a spelling three other artifacts had
already abandoned.** E12.14 rendered `ARCHITECTURE.md:333`'s spelling literally:
`asc record TYPE --json -`. That document is the design record; three *later* artifacts had all
moved away from it, and the brief is the one a session reads first:

```
$ grep -n 'record ' packages/cli/src/commands/record.ts   # :15-26, "There is no spelling that keeps both."
$ asc record --help                                       # [DOCUMENT]  Path to an entry document, or `-` for standard input
$ grep -n 'asc record' README.md                          # cat reviews.json | asc record review_completed -
```

`--json` is the versioned-**output** flag on every command in this CLI and cannot also mean "read
JSON here", so the two flags collide and `record.ts` chose. The brief was teaching the collision.

**Decided by the owner (2026-10-01): switch the brief to the operand form, `asc record TYPE -`.**
`-` is the operand meaning standard input, which is what `asc record --help` and both `README.md`
examples already teach, so the digest moves to the spelling the rest of the tree uses.

**F2 — the arithmetic mixed its units.** `brief-text.ts`'s byte paragraph read *"The line cost 38 of
them then and costs 62 now"*. Those are not the same object: 38 is 37 characters **plus** the newline
the cap is charged for, and 62 was 62 characters **without** it — the code charges 63. Found
independently three times (my own re-derivation, agent 1's arithmetic, agent 2's measured line
lengths 37/38/62/63). Every figure in the file now states its unit and its newline.

**F3 — the plan asserted a number that was never true.** E12.14's Implementation paragraph claimed
**4,543** free. That subtracts E12.13's 38-byte header a second time: the measurement was taken after
E12.13, so headroom was 8,000 − 3,419 = **4,581**, which
`.agents/research/2026-10-01-bug-hunt-e12-13.md:110` states verbatim. Corrected in place with the
correction visible, because the plan is a record.

**F4 — `dogfood/0028` carried two unreconciled byte counts.** The body measured 3,603 on 2026-09-28
against a larger active registry; the Status cell's 3,381/3,444 were measured on 2026-10-01. Neither
said which registry it measured. Reconciled as claim **(6)**, since the body is immutable and the
Status cell is the correction channel.

#### Stage 1 — the brief and the script teach the operand form (`asc-fkp1`)

**Tests (RED first)** — `RECORD_COMMAND` is interpolated into four expectations, so the change is
red before it is made:
- `cli/test/types.test.ts`: the local constant (named `RECORD_COMMAND_LINE`, matching the source's
  own name for the value) → `Record with: asc record TYPE -  (a JSON entry on stdin)`.
- `cli/test/init.test.ts`: the starter project's line 1, same text.
- `cli/test/install-hook.test.ts`: the `command` constant the loop asserts against the brief *and*
  the script.
- `cli/test/doctor.test.ts`: `111 bytes` → `104`.

**Implementation** — `RECORD_COMMAND = 'asc record TYPE -'` in `brief-text.ts`, with its doc comment
rewritten to name the operand form as `record.ts`'s recorded deviation and to cite `asc-fkp1`; no
other constant moves. Cost: **56** bytes for the line — 55 characters plus the newline — where
E12.14's spelling cost 63, so the operand form takes **7** back.

**Status**: Complete (2026-10-01). RED first: 6 failures / 129 passed across `types`, `init`,
`install-hook`, every one on the header text, before a line of source moved. GREEN: 4 files /
**160 passed**.

#### Stage 2 — four sites state their unit, and the plan's bad number is corrected

`brief-text.ts`'s byte paragraph now gives all three generations with their newlines — 38 bytes when
E12.13 added the line (37 + 1), 63 at E12.14 (62 + 1), 56 now (55 + 1) — and states the served
digest as **3,437 bytes** as `asc doctor` counts it (**3,438** on stdout, the same text plus the
newline `this.log` appends), leaving **4,563** free *on the same basis* as the 4,619 above it, which
is the qualifier E12.14's paragraph was missing. `test/types.test.ts`'s `4,618 bytes free` comment now
names its object and cross-references `brief-text.ts`'s 4,619, and `test/doctor.test.ts`'s figure is
`104` with its arithmetic written out. `IMPLEMENTATION_PLAN.md`'s "4,543" carries the correction
above it. `dogfood/0028`'s Status cell gains claim **(6)**; `dogfood/README.md`'s index row moves
*Five* → *Six*.

#### Stage 3 — the generated script is regenerated, because the constant it interpolates moved

The change moves a constant `install-hook.ts` reads, so the committed `.claude/ascend-hook.sh` is
stale the moment the source is — which is exactly `asc-q1mm`'s defect class, found here by the review
rather than by a user. Regenerated with `asc install-hook --yes` after rebuilding `dist/`.

**Status**: Complete (2026-10-01). Line 23 of the regenerated script reads
`# To record an entry by hand, run: asc record TYPE -  (a JSON entry on stdin)`, and git tracks the
change. The general guard remains `asc-mu20`.

#### Stage 4 — gate, records, close

Full gate to a file (never `| tail`); `asc-fkp1` closed with its reason. Two P3 beads filed for the
findings that did **not** warrant a code change here.

**The review is counted, not just described.** All three agents reported through `ReportFindings`, so
the findings are `review_finding` entries rather than prose: **8** in one batch, every one carrying
`captured_by: reported` and a lens from the frozen nine —
`cross_implementation_divergence` 4, `environment_divergence` 1, `boundary_conditions` 1,
`data_lifecycle` 1, `assumption_audit` 1. That the dominant lens is cross-implementation divergence
is the shape of the round: the defect was a brief disagreeing with `record.ts`, with `--help`, and
with `README.md` about one command, and the arithmetic errors are the same disagreement inside a
single file. **A note that this paragraph first asserted the opposite** — that the agents reported in
prose and the round was uncounted — is left here rather than silently replaced, because it was
written from the assumption that `ReportFindings` output would be visible as tool text in my own
context. It is not: the deriver reads it from the transcripts. *I did not check before claiming.*

**Status**: Complete (2026-10-01). Gate below. Nothing committed — the conservative profile reports
and waits.

### E12.16 — the two findings of that review which are commands ascend itself refuses (`asc-i8cs` +
`asc-kyhh`, P3 ×2, planned 2026-10-02)

**Goal** — close the two findings of the E12.14 adversarial review that survived it as beads. They
are one class: a message ascend prints that the caller cannot act on from where ascend printed it.
`asc-i8cs` hands back a flag the command refuses beside the document it was reached from; `asc-kyhh`
prints nothing at all, because `asc record -` at a prompt waits for a document nobody is sending.

**Neither defect is in the new line, and that is the point of fixing both now.** E12.14's brief moved
to the operand form; both defects sit underneath it, on the document path every session reaches by
default. The brief did not create them — it made a human far more likely to meet them.

#### Stage 1 — `asc-i8cs`: a fix names the form the entry was supplied in

**The measurement.** `asc record decision -` with `{}` on stdin — the form the brief advertises —
answered:

```
Error: 1 problem(s) with this decision entry, so nothing was recorded:
  chosen: 'chosen' is required and has no decision recorded
    Supply the value with --prop=chosen=<value>.
```

Applying that advice to the form it was reached from:

```
Error: a document (-) and entry flags (--prop/--na/--evidence) cannot be combined
```

exit **2**. The recovery ascend prescribed is refused by the command ascend printed it from — and
`IMPLEMENTATION_PLAN.md:2478-2480` records *that recovery* as the criterion for preferring stdin over
the flag form, so the rationale rested on a dead end. The `--na` half is the same: a real command in
general, equally refused beside a document.

**Why the store cannot decide this for itself.** An entry offered as a document is byte-identical, at
`RecordRequest`, to one offered as flags. Only the caller knows which it did, so the answer travels
with the request rather than being inferred at the point the error is rendered.

**Implementation.** `EntryInput` (`core/state.ts`) gains `via?: 'flags' | 'document'`; `RecordRequest`
(`store/recorder.ts`) carries it and spreads it into the `EntryInput` literal; `record.ts` reads it
off its own argv, which is the one place that knows. **Absent means flags** — spread, never defaulted
— so every existing caller is unchanged and no caller opts in to the old wording. Three sites in
`validateEntry` branch through one `documentFix` helper: invalid value, measured-and-NA-at-once, and
required-missing. It names the document's `properties` and its `na` array where the flags path names
`--prop` / `--na`.

**Tests (RED first)** — `core/test/state.test.ts` gained a five-test block: one per branching site,
one sweep asserting that across *every* error a document entry produces no `fix` matches
`/--(prop|na|evidence)\b/`, and a control proving the flags path still names the flag. RED measured
before a line of source moved: **4 failed / 67 passed**.

#### Stage 2 — `asc-kyhh`: refuse before waiting

**The measurement, on a real pty.** `asc record <type> -` at a prompt with nothing piped: for both
`bogus_type` and a type that *is* registered, the process was **still running after 6 s, output
empty**. `record` read stdin before it resolved the type, and on a terminal
`for await (const chunk of process.stdin)` never yields — so the unknown type it was about to report
was never reached, and nothing was printed at all. On an open non-TTY pipe it blocked **4.1 s** until
the writer closed. It exits 1 only when stdin is closed, which is what Claude Code's Bash tool does —
so the session path was never affected and a human following the brief's own line was.

**Implementation — two guards, and their order is the decision (owner, 2026-10-02: type check first,
then the TTY guard).**

1. `refuseBeforeReading` resolves the type before the read, through the existing read-only
   `withProject` pre-open. It **swallows `IndexStaleError`, deliberately**: `openIndex` refuses a
   stale index where `writeProducedLines` calls `buildIndex` first and self-heals — so on a stale tree
   the guard steps aside and the read proceeds to the path that repairs the index, rather than
   introducing a new failure mode on a path that works today.
2. Then `terminalStdinRefusal(operand, isTTY)` (`cli/input.ts`) refuses `-` on a terminal with the
   pipe message. It is **a pure function of the two facts it needs**, so the decision is testable
   without allocating a pty — which is the measurement that found the defect and is not something a
   portable suite can depend on. `isTTY !== true` reads as "go ahead": the flag is `undefined`
   wherever there is no terminal at all, and refusing a read that would have worked is the worse
   error.

Type first because it is the more specific and more actionable failure, and because it does not depend
on the terminal at all; the TTY refusal is what remains for a caller whose type is fine.

**Tests (RED first)** — `cli/test/record.test.ts` gained four: the document path's fix names no flag,
the flags path still names `--prop=rationale` (the control), an unknown type is named **before** the
read, and the stale-index self-heal still records. One **existing** test needed updating rather than
adding: *"does NOT print a runnable command whose value ascend had to invent"* piped `{}` — the
document path — while asserting `--prop=missing=<value>` and `asc record pair --na missing`. Those two
expectations encoded this very defect; the test was green because it asserted the shape of the
message rather than acting on it. Its load-bearing half is kept (never print a runnable
`asc record … --prop=` line, never invent a value, write nothing), the document's vocabulary replaces
the flag's, and **the flag spelling is kept as a control** on a second, flag-driven invocation of the
same type — so the change reads as a branch rather than a replacement.

#### Stage 3 — the fixture that proves a message is long enough said it no longer was

**Found by the gate, not by design, and it is the only thing in the suite that could have found
it.** `packages/cli/test/8pp-truncation.test.ts` drives a real `asc record` whose error is large
enough to exceed a pipe, and its first test asserts that the fixture's own message **is** larger
than the pipe's 65,536 bytes — *"below the pipe capacity no truncation is possible, so the tests in
this file would pass without the fix."* The gate reported:

```
AssertionError: the fixture's error message is 61034 bytes, which does not exceed the 65536-byte
pipe. Raise REQUIRED_PROPERTIES: ...
```

**That is `asc-i8cs` arriving from the other side.** The fixture feeds a *document*, so its one line
per missing required property carried the flags sentence
(`Supply the value with --prop=<name>=<value>; ascend cannot invent one.`) at ~314 bytes a line. The
document wording is ~27 bytes a line shorter, and at 240 required properties the message fell
**4,502 bytes under** the pipe. Nothing in the change touched this file; the fixture's relevance
check is what noticed that a message had become too short to be testing anything.

**Fix, and the constant it moves.** Measured at 240/260/280/300 properties: **61,034 / 66,114 /
71,194 / 76,274** bytes (254.0 per property, linear). `REQUIRED_PROPERTIES` moves **240 → 300**,
restoring a margin comparable to the one the old constant had (10,738 bytes against the previous
9,905). Two stale counts in the same file are corrected rather than left: the constant's own comment
(it had reasoned from "roughly 314 bytes a line" and "240 lands at 75,441 bytes") and the present
-tense "this fixture's stderr is 70,154 bytes" in `pipedStderr`, both now marked historical with the
measurement that replaced them. `packages/cli/src/streams.ts` cites 75,441 twice and is **left
alone**: both sit inside sentences already framed as a dated 2026-09-14 re-measurement, so they are
a record of a study rather than a claim about today's bytes.

#### Stage 4 — gate, records, close

Full gate to a file, never `| tail`. Both beads closed with their reasons. Two dogfood records
written — `dogfood/0051` (the refused recovery) and `dogfood/0052` (the report that arrives after
the wait) — because filing the bead is not the same as saying how it was found, and the index is
reconciled by NUMBER against disk (52 records, 52 rows, no gap) rather than by arithmetic.

**`brief-text.ts` is not touched, so the SessionStart budget is unchanged** — 3,438 bytes on stdout
/ 3,437 as `asc doctor` counts it (4,563 free), E12.15's figures re-read here rather than assumed.

**Status**: Complete (2026-10-02). Gate **green** to a file: 124 files / **2,918** passed, 2 skipped;
`format:check` 0, typecheck 0, lint 0, `align` **green** (baselined debt 20 → 20). The baseline was
2,909, and the +9 are the five `core/test/state.test.ts` and four `cli/test/record.test.ts` tests
added here — the one *changed* existing test is not a new one. **Driven live on a scratch project**,
not only in tests: `printf '{}' | asc record decision -` now answers *"Give "chosen" a value in the
document's properties, or list it in its "na" array if it does not apply."*, `asc record decision
--prop=rationale=x` still answers *"Supply the value with --prop=chosen=<value>"*, `printf '{}' | asc
record bogus_type -` names the unknown type **without** the terminal message, and under a real pty
(`script -q /dev/null`) `record decision -` returns immediately with *"standard input is a terminal,
so nothing is being piped into it"* where it previously ran past 6 s with empty output. Nothing
committed — the conservative profile reports and waits.

### E12.17 — a scheme name stays any string, and the encoder that files it becomes an invariant (`asc-i5tj.5`, P2, resolved 2026-10-02)

**Goal** — answer `asc-i5tj.5`'s open question (*should* a scheme name be any string?) and, on the
answer, remove the last place where the store's safety still rested on a convention rather than a
test. The bead came out of E12.1 (`dogfood/0030`) carrying two stale claims, which is the same defect
one level up: a written record that describes code it no longer matches.

**Owner decision: keep any string, harden it.** A scheme name stays any non-empty string
`requireName` accepts; nothing narrows, nothing migrates, no user-visible change. Recorded as
decision `0000359f-11a0-4d7d-b575-8c46a74210df` with both options and their costs — narrowing would
make the layout's problem disappear at the source, but `hand-denial`, `rule-denial` and
`shuffled-denial` are already recorded under names outside `[a-z0-9_-]`, so it is a migration over
data this repo holds, and it would make the store the authority on what a person may call a scheme.

**What made the answer cheap: the survey found no second sink.** Every place a scheme name leaves the
store was walked — one protected function (`encodeSegment`); no SQL identifier, shell argument, URL
component, JSON key or regex built from a name; all scheme-name SQL binds `?`; view and index
identifiers come from TYPE/PROPERTY names through `ident()`. Hostile names (`a/b`, `..`, `a b`,
`A-B`, `x;DROP TABLE entries`, `unicode-é`) are accepted, safely encoded, and round-trip through
`asc export | asc import`.

**Two corrections, one of them a comment that described the function below it wrongly.**
`jsonl-files.ts:43-45` said bytes outside `[A-Za-z0-9._-]` "are percent-encoded by `encodeSegment`";
the function folds to a lowercase slug and appends a 12-hex-char digest of a lossless spelling of the
name, and its own header (`:142-166`) records percent-encoding being tried and rejected on three
measured counts. That comment is exactly what sends a reviewer hunting a fourth encoder that does not
exist. Fixed in place. The bead's description repeated the same claim and cited `requireName` at
`:394` rather than `:358-374`; both corrected in a comment rather than by rewriting the description,
so the record of what was found survives beside the correction.

**The coverage that was missing, and the mutation that proves it.** `store/test/jsonl-files.test.ts`
gained *"files two names that fold to one slug separately, and reads both back by name"*: `a/b` and
`a b` fold to the same slug `a_b` and must land in two directories (`a_b-b941543fecce`,
`a_b-faaee53168b5`, measured), **and** both names must read back — the name travels on every line and
nothing is ever decoded from the directory, which is the invariant the round trip pins. Bind-checked
by mutation: dropping the digest from `encodeSegment` fails this test plus three others, while the
older traversal test (*"keeps every name inside one safe, traversal-free path segment"*) stays
**green** under that mutation — the measurement behind the claim that it pins traversal and not
injectivity. **A claim I got wrong first**: I wrote in this test's comment that nothing exercised the
digest's collision role; `keeps two names that differ only in case` does, for case-only collisions.
The comment was corrected before the test was committed, and what is genuinely new is the
punctuation-fold case and the read-back half.

**Status**: Complete (2026-10-02). Gate below; 124 files / **2,919** passed, 2 skipped. Two `.ts`
files changed (`jsonl-files.ts`, `jsonl-files.test.ts`, +1 test). No dogfood record: the finding is
`asc-i5tj.5`'s own and already recorded at `dogfood/0030`, and the stale comment did not become a
bead of its own — it is resolved on the bead it misdescribes. `asc-i5tj.5` closed; all 16 of
`asc-i5tj`'s children are now closed, so **the E12 epic is closeable** — reported, not closed, since
it unblocks `asc-2ezs` and `asc-8uzh` and that is the owner's call. Nothing committed.

---

## Stage 2: Claude Code adapter + backfill — epic E5

**Goal** — `asc ingest claude-code` derives entries from existing transcripts.

**Success Criteria** — re-running is idempotent (keyed on transcript uuid); derived entries carry
`source='derived:claude-code'`; the corpus reaches a queryable N on day one.

**Tests** — idempotency on a fixture transcript; envelope correctness; absent-vs-zero on token fields.

**EV-constraints carried in:** `EV-corpus` measured the real corpus at **809 files / 388,054 lines /
1.14 GB** read in **11.2 s** at **213 MB** peak RSS, yielding **69,276 rows in 7.2 s**. Tool-denial
entries reach **N=409** → GO. `user-correction` reaches only **N=20** and is **not an independent
corpus** — do not present it as one. (The file counts are the 2026-09-11 spike; `EV-corpus`'s own
amendment and `EV-derived` both re-measured on 2026-09-15 at **843 files / 431,039 records /
1.19 GiB**.)

**`EV-derived` (EV-9), 2026-09-15 — all five types GO, with the rules stated:** 1,488 entries
measured against the real corpus, 0 invalid, 0 warnings, 0 duplicate keys — `verification_run` 486,
`tool_denial` 457, `context_compaction` 438, `skill_activation` 87, `user_correction` 20. A derived
type's N is its count of DISTINCT PER-EVENT IDENTIFIERS, never its line count (measured: 6,395
records carrying `attributionSkill` yield 87 activations). `verification_run` was the type where the
rule had to be *chosen*: one corpus yields 16,352 / 10,893 / 6,940 / 6,826 / **486** under five
defensible rules, and the corpus does not pick between them. Heredoc bodies are skipped — proven by a
controlled A/B over one frozen 72,014-command list, where **54 %** of 922,333 segments (497,980) are
file *contents* and skipping them removes **7 fabricated entries** at a cost of 5 unterminated
openers in 12,818. `user_correction`'s non-independence is stated in the type's own description.

**Safety constraint (verbatim from `TASKS.md`):** *"Read-only on the transcripts — never write
there."*

**`EV-ingest` (EV-10), 2026-09-15 — the store needed no change to make the ingest idempotent.**
`recordEntry` takes a caller-supplied `id` and throws `DuplicateEntryError` on a repeat, so a
deterministic id (the deriver's per-event key) plus catching that error gives idempotency with no
upsert, no new `INSERT` site and no time-of-check gap — the alternative would have had to decide
what to do with an existing row that differs, and the answer would be "overwrite an immutable
entry". One `withTransaction` for the whole run, measured twice with the same probe deriving once
and replaying the identical buffer through both arms: **460 vs 678 ms**, then **240 vs 356 ms**. The
atomic choice is also the faster one, on both runs.

**`EV-baseline` (EV-11), 2026-09-15 — the day-one dataset, and three things wrong with what was
assumed about it.** `asc-sx7`'s accept is a report, not a command: N per type, date range, per-field
population rate. Measured by ingesting into a fresh store and reading it back — **1,491 entries**
(`verification_run` 486, `tool_denial` 457, `context_compaction` 441, `skill_activation` 87,
`user_correction` 20), **44 days** (2026-08-02 … 2026-09-15), 34 sessions, 12 projects, 1 clock
reading. Three findings change what E6/E7 must be built against:

- **The corpus is 44 days deep, not two years** — `derived-types.ts:69`'s *"backfill of two years"*
  is off by ~17×, which matters because E7's changepoint work is sized in days.
- **`na` is 0 for every field of every derived type**, so `asc explore` reporting a 0.0% N/A ratio
  on a derived corpus is correct rather than broken.
- **Three fields are unmeasured *structurally*** — `previous_verdict` 72.4% absent means "first
  verified pass", not "unknown" (the 134 present split exactly 67/67). Informative missingness:
  dropping nulls or imputing will bias E7.

Also measured, and filed as `asc-5hs`: no derived entry carries envelope provenance (0/1,491 for
`cwd`, `repo`, `git_sha`, `branch`), and `project` collapses **282 distinct real working
directories into 15 labels** — while the true `cwd` and `gitBranch` sit on **100%** of the records
that trigger every derived event. `EV-write-cost.md:58`'s ~16.6k-entry backfill is also **11×**
the real yield; the decision it supports is unaffected and conservative.

**Status: In Progress** (`asc-dh0`) — the E5 chain is done: `asc-ct3` (streaming reader)
**complete**; `asc-qib` (derived type definitions) **complete**; `asc-ycl` (`asc ingest
claude-code`) **complete**; `asc-sx7` (day-one dataset) **complete**. The epic itself stays open:
five children remain (`asc-5fo` profile mode, `asc-1bd` sampling modes, `asc-wsa` paging and
coverage, `asc-52u` `--max-tokens`, `asc-hg3` `--dump`), and all five are E6 work that was parented
here. `asc-sx7` was the last thing blocking them.


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
competing schemes annotate the same entries and `asc kappa` scores agreement; dropping a scheme loses
no entry data; invalidation works as a reserved scheme; every proportion carries a Wilson interval and
small groups are flagged.

**Amended 2026-10-02, on closing `asc-k6p`.** Verified against the tree. Five of the six hold:
`matchingEntryIds`/`schemeCensus` report matches and the remainder (`annotations.ts:333/1431`, kept
non-negative and ordered biggest-class-first); `backtest` reports Wilson-bounded precision/recall and
writes nothing (`analysis/src/backtest.ts:155`, `annotate.ts:313-465`); `cohenKappa` scores two schemes
over the same entries (`agreement.ts:177`); invalidation is a reserved scheme (`reserved.ts`,
`sql.ts:100`); and Wilson intervals with `[SMALL GROUP]` flagging cover every proportion the module
enumerates (`proportion.ts:199`, `output.ts:181`). Three corrections:

- **"dropping a scheme loses no entry data" is UNBUILT, and vacuously true.** No drop operation exists
  anywhere, so nothing can lose data by dropping — the false-green shape, not a satisfied criterion.
  Filed as `asc-4uex`; the property is deliberate (annotations are additive) but the operation it
  describes was never written.
- **"automatically applied" was never true.** `annotations.ts` claimed a rule is "automatically applied
  to entries recorded next month"; `matchingEntryIds`' only caller is `asc annotate`, and a stored rule
  cannot be replayed without retyping it (`annotate.ts:266-271`). Comment corrected; filed as
  `asc-cx9w`.
- **"simultaneously" is untested.** Two schemes coexist over the same entries and kappa scores them
  (`cli/test/annotations.test.ts:1148`), but by sequential invocations; nothing exercises concurrency.

**Tests** — `packages/analysis` against fixtures with hand-computed expected values (Wilson, kappa,
chi-square, log-odds, FP-growth support/confidence, CUSUM changepoints); scheme isolation;
immutability of annotated entries.

**EV-constraints carried in — AMENDED 2026-10-02, on verifying `asc-xgo` against the tree: two of the
three are UNBUILT, and the third is unmet on the surface it is stated about.** The tautology check and
the temporal-block control required by `EV-patterns` (`docs/evidence/EV-patterns.md:126-138`) exist
nowhere in `packages/*/src` — `grep -rniE "tautolog|temporal.block|functional.depend|within.day"`
returns nothing, and no bead tracked them; filed as `asc-fwpe`. `asc-xgo.1`'s close reason asserts a
"NEW REQUIREMENT FOR E7" for an effective-sample-size / pseudoreplication check; `grep -riE
"pseudoreplic|effective.sample"` returns nothing and no bead tracked it either; filed as `asc-0hys`.
The shuffled-label control that produced the `tool_name × project` verdict **is** present and
test-pinned (`association.ts:509`, `association.test.ts:327-379`), but `asc stats` cannot reach it —
`rankAssociations` takes a single argument at `stats.ts:387`, so `permutations` defaults to 0 and the
report omits `pPermuted`; filed as `asc-jpka`, which also carries the "catches marginal-driven but not
definitional artifacts" limitation that lives only in EV-patterns and not in the module. The finding is
recorded as `dogfood/0055`.

**Empirical gate:** `asc-9an [EMPIRICAL]` — brief size vs recording rate. This was Stage 0's Q6, and
the **primary failure mode** of the whole product: an empty database. Per `empirical-planning` it was
measured against a real model in a real session (EV-16, 2026-09-21) rather than inferred — and it came
back **negative**: 0 of 15 sessions recorded anything, so the brief's causal claim was retired in
favour of its selection job. See the status line below.

**Status: In Progress** (`asc-xgo`, `asc-k6p`, `asc-4so`) — E10 (`asc-4so`) **complete** and E8
(`asc-k6p`) **complete**; each carried a criterion its own resolution named and the shipped text had
not delivered, now either built or recorded. E10: the epic's comment (2026-09-21) said *"E10 should
keep the hook for that job and stop claiming the other one"* — the second half was unfulfilled, and
`ARCHITECTURE.md`'s recall section, its risks row, Stage 0's Q6, `install-hook`'s header and `init`'s
`offerRecall` all now state what EV-16 invalidated (0 of 15 sessions; the brief does not cause
recording) and what survives (the selection job). E8: 7/8 children, with the criteria amended above —
retraction (`asc-k6p.2`) stays **deferred** by owner decision (2026-09-28) on an unfired trigger that
`asc-k6p.3` actively relied on, and the two unbuilt capabilities are filed (`asc-cx9w` replay a stored
scheme, `asc-4uex` drop one). **E7 (`asc-xgo`) — verified 2026-10-02, and not as sound as its 9/9 children
suggest.** The nine children are genuinely complete, test-pinned and CLI-reachable, which is why the
epic read as eligible for close; but the epic's own criteria carry the three EV-constraints above, and
none of the three is built. It was in fact **already closed** (2026-09-18, close reason `Closed`); this
line previously said "left open", which the tracker contradicted, and that is corrected here —
`dogfood/0055`. Re-closed with a reason that names the gaps; the gaps are filed (`asc-fwpe`,
`asc-0hys`, `asc-jpka`).

---

## Stage 5: `asc doctor` + cross-project query — epic E9

**Goal** — keep the registry from fragmenting; make the per-project split analytically harmless.

**Success Criteria** — reports dead types, near-duplicate names, drift across versions, and
per-property na/unmeasured fill (counts, not ratios — see below); `asc query --across` unions multiple
project DBs; `asc types import` round-trips a definition preserving `type_hash`.

**Amended 2026-10-02, on closing `asc-20p`.** Two words in the original criterion were wrong, and the
shipped behaviour is the honest one:

- *"missing exports"* is not reportable. `asc export` writes to stdout and leaves no trace in the
  store, so whether an export exists is not a fact anything holds. `exportStatus` states that it
  cannot see one and how much is at stake (`doctor.ts:249-267`, pinned by `doctor.test.ts:251`), which
  is the whole of what "reporting a missing export" can honestly mean. Detection would mean inventing
  a filename convention and reporting false absences.
- *"ratios"* became **counts**, deliberately: a ratio over 3 entries reads like one over 300, so
  `propertyStates` reports `measured N of M` and names a group under `MIN_N` an anecdote
  (`doctor.ts:172-174`). The denominator is *declared* entries, which is why the fourth profile state
  `not_declared` sits outside it — an entry that never declared the property is a coverage question,
  not a fill-rate one.
- Two checks the design review routed here have **no signal to read**, and `doctor.ts`'s header states
  them as such rather than faking them: types past their threshold but never analysed (`asc stats`
  runs are not recorded anywhere), and whether an export exists.

**Tests** — fixture registry with known duplicates and one dead type; two-DB ATTACH union.

**Status: Complete** (`asc-20p`) — 2/2 children. Verified against the tree 2026-10-02: `deadTypes`,
`nearDuplicates`, `versionDrift`, `propertyStates`, `briefSize` and `exportStatus` are all present and
test-pinned (`doctor.test.ts:80/105/126/187/212/251`); `--across` unions project DBs via ATTACH and
`types import` verifies each document's `type_hash` before writing. Criterion 5 is met as amended
above, not as first written.

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
