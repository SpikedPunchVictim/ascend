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
and E4.2 complete, including the six `asc types` subcommands; E4.3 next.** The stages are specified
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
`inOwnTransaction(db, caller, ending, body)` with **one** nesting guard — two copies of a rule with
one owner is how the owner stops being one. The `--dry-run` path is the *same work* inside
`withRollback`, so a preview cannot report an outcome the real run would not produce. `transaction.test.ts`
(7 tests) proves both directions, plus the property that makes a batch coherent: **the body sees its
own earlier writes**, which is what lets a duplicate id inside one batch be caught at all.

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
`no-unnecessary-condition` reported the rollback in `inOwnTransaction` as "value is always falsy".
It was reading a **stale narrowing**: `@types/node` declares `readonly isTransaction: boolean`, so
TypeScript narrows it to `false` after the nesting guard and then *keeps* that narrowing across
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

**Status: In Progress** (`asc-dh0`) — `asc-ct3` (streaming reader) **complete**; `asc-qib` (derived
type definitions) **complete**; `asc-ycl` (`asc ingest claude-code`) **complete**; `asc-sx7`
(backfill across stores) next.

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
