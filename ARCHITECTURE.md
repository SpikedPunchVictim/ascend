# `ascend` — Architecture

## Context

LLM workflows don't record what they do in a form that supports later analysis. When a workflow
does change its process, there's no way to tell whether the change helped. `ascend` is a store that
LLM workflows write structured **entries** into as they work, so that after hundreds accumulate, a
human can query the corpus, discover patterns no single entry revealed, and act on them.

Worked example (user's): a software workflow runs a review at each stage. Every review is logged as
an entry. No single review says anything. After several hundred, a query reveals that a large share
of findings cluster on one theme — and *that* justifies building tooling to address it.

**The defining property: analysis is deferred.** Entries are recorded without interpretation.
Classification happens retrospectively, once a pattern becomes visible. This is not a metrics or
time-series system; there is no baseline-comparison requirement. Those framings were considered and
explicitly rejected.

### Terminology (settled)

| Term | Meaning |
|---|---|
| **entry** | One structured record of something that happened. The unit of storage. |
| **entry type** | Named, versioned definition of an entry's shape, with a declared type per property. |
| **registry** | The store of entry type definitions. Writable by the LLM at runtime. |
| **annotation** | A classification attached to existing entries after the fact. Never mutates the entry. |

Rejected: *metric* (implies a scalar trended against a baseline — wrong frame), *observation*, *event*, *fact*.

### Decisions settled

- **Name**: `ascend`; CLI binary `asc`.
- **CLI framework**: oclif. **Validation**: zod.
- **Interface**: CLI invoked via Bash. No MCP server in v1.
- **Scope**: framework-agnostic core, plus one Claude Code adapter at the edge.
- **Storage**: SQLite, **per-project `.ascend/`**, **gitignored** (added by `asc init`). JSONL
  export/import exists only as a durability and transfer escape hatch.
- **Annotation**: first-class, separate layer over immutable entries.
- **Recall**: a **`SessionStart` hook** injecting the `asc types brief` digest (approved), with the
  digest also available on demand. See "Recall" below.
- **Discovery**: `asc explore` ships in v1, with the **full statistical layer**.
- **Free text**: FTS5 trigram + BM25. **No embeddings** — see "Why no vectors" below.
- **Analysis pass**: ships a skill (the method) + a thin `/ascend-analyze` slash command.
- **Starter types**: a small curated set ships by default.
- **The LLM logs; it does not score.** Field population only. Pattern-finding is a separate,
  user-initiated pass. This removes the self-grading conflict of interest.

---

## Prior art on this machine (study before building)

Two local systems each cover a different third of this. Neither is what we're building.

| Source | Covers | Key files |
|---|---|---|
| **`align`** | How to *record* | `packages/core/src/telemetry/{types,diff,serialize}.ts`, `packages/cli/src/telemetry/*`, `docs/adr/015-2026-07-13-telemetry.md` |
| **`mast`** | How to *find* | `src/search/{fused,fts}.ts` |

Both are **also installed here as devDependencies** — see *Local tooling* below.

Reuse specifically:

- **align's envelope + purity split** — core has zero `fs`, zero `Date.now()`, zero network; `ts`
  and `sessionId` are injected. One recorder class is the only thing that builds an envelope or writes.
- **align's `rulesetIrHash`** → our `type_hash`: a content hash of the type definition, on every entry.
- **align's "dead rules" report** → `asc doctor` flags types defined but never recorded.
- **align's omission doctrine** — a field is *omitted, never fabricated*, when no real value exists.
  ADR 015 legislates it; the counterexample is a real corpus that lost the distinction permanently.
- **mast's `toFtsMatch`** — the query sanitizer, ported in `packages/store/src/search.ts`.

Two failure modes carried forward as rules, both from real corpora that lost data permanently:

- **Never use empty-string sentinels.** `''` sat in a column that also held a foreign key, so SQLite
  matched it as a real value and the table acquired rows pointing at a "parent" that was the absence
  of one. "Unknown" is `NULL`, never `''`.
- **Never let `0` mean more than one thing.** A single `0` came to mean "measured zero", "unknown"
  and "doesn't apply" at once, and no downstream statistic could recover which.

---

## Local tooling (installed in this repo)

Both prior-art tools above are also installed as **devDependencies of this project**, so they are
usable as tools, not just as reading material. They are local binaries — nothing is on `PATH`.

| Tool | Package | Binary | Version |
|---|---|---|---|
| **align** | `@spikedpunch/align-cli` | `./node_modules/.bin/align` | 0.2.1 |
| **mast** | `@spikedpunch/mast` | `./node_modules/.bin/mast` | 0.3.0 |

Install notes (verified, not assumed):

- pnpm 11 **ignores** the `pnpm` field in `package.json`. Native-build allowances live in
  `pnpm-workspace.yaml` under `onlyBuiltDependencies` (`better-sqlite3`, `tree-sitter`,
  `tree-sitter-javascript`, `tree-sitter-typescript`).
- `pnpm rebuild better-sqlite3` was a silent no-op. The binding was produced by running
  `node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/node_modules/.bin/prebuild-install`
  directly, which fetched the prebuilt `better_sqlite3.node`. Without it **mast cannot open a
  database and every `mast` command except `--help` throws.** If a fresh clone shows that error,
  this is the fix.
- Verified working: `mast init` on a scratch directory indexed and reported
  `Indexed 1 files, 1 chunks in 35ms`.

### How each is used during the build

**`align` — architecture conformance.** The purity rules in this document are currently prose plus a
single hand-written test (`asc-core-purity`). align turns them into machine-checked rules: `core` and
`analysis` may not import `fs`, `node:sqlite`, or network modules; `cli` may not be imported by
anything; `store` is the only package that touches SQLite. Run `align init` once `packages/` exists
(it detects components and seeds a baseline), commit `align.config.ts`, and add `align check` to the
pre-commit gate (`asc-quality-gates`). `align export-ir` + `align check --untrusted` is the path for
running conformance without executing the config, if CI ever needs it.

align is also the source of the `type_hash` design (`rulesetIrHash`) and of the dead-rules report
that `asc doctor` mirrors — having it installed means those can be read from the running tool rather
than inferred from the repo.

**`mast` — code search over the growing source tree.** Run `mast init .` after `asc-workspace`
lands, and re-index as the tree grows. It is the fastest way for the implementing agent to find
declarations across five packages without fanning out `grep`. ascend borrows two things from mast's
source (`src/search/fts.ts` `toFtsMatch` sanitizer, `src/search/fused.ts` RRF) — the installed copy
is the reference implementation; `~/projects/mast` is the readable source.

**mast's tokenizer choice is not ascend's.** mast indexes code identifiers and chose trigram for that
reason. `asc-spike-fts` measures trigram vs `unicode61` vs `porter` against real **prose**
`evidence_text`. Do not inherit the choice.

---

## Design

### Zod is the enforcement engine, not the storage format

A zod schema is code; the registry persists definitions an LLM wrote at runtime. Storing zod source
and `eval`-ing it is arbitrary code execution and makes the definition unhashable. Instead:

- The registry stores a **declarative property spec** (JSON).
- `@ascend/core` exposes `buildSchema(spec) → ZodType`, constructing the validator at runtime.
- The **spec** is what gets hashed, versioned, and diffed.

The spec vocabulary is bounded by what the builder supports — **keep it deliberately small**
(~a dozen property types, not all of zod). Constraining what the LLM can invent is the primary
structural defense against drift.

Property spec fields: `name`, `type` (`string|number|integer|boolean|enum|timestamp|duration|ref|text|json`),
`required`, `enum_values`, `description`, `unit`.

`json` is the one compound type: a JSON **array or object**, and nothing else. It exists because
list-shaped facts (`findings[]`, `what_was_tried`, `options_considered`) are real and have no scalar
encoding. Storing them in a `text` property works at query time — `json_extract` projects the array
as JSON text and `json_each` unpacks it into rows for a `GROUP BY` — but validation cannot then tell
a JSON array from prose, so a recorder writing "two high-severity bugs" is accepted and fails later
inside a query, far from the entry that caused it. Declaring the property `json` moves that check to
where the recorder can act on it. It deliberately refuses scalars: a type that accepted them would be
a superset of `text` that validates nothing extra. There is no schema for the contents (no per-key
types, no required keys), which is a real limitation — a nested definition language would not stay
small enough for an LLM to invent correctly at runtime.

### Three-state property values (load-bearing, cannot be retrofitted)

| State | Encoding | Meaning |
|---|---|---|
| measured | key present in `properties` JSON | real value, **including a real `0`** |
| not applicable | name listed in `na` JSON array | meaningless in this context |
| not measured | absent from both | default. Silence never becomes zero. |

`required` means **"must have a decision"** — a measured value *or* an explicit N/A — not "must have
a value." Otherwise `required` pressures the LLM into fabricating a number when the honest answer is
"doesn't apply," which is exactly how a corpus ends up with `0` meaning three different things.
Optional is the default.

Generated views project both `<prop>` and `<prop>_state` so queries can filter on state.

Those two names are the view's, so they are **refused as property names at define time**. A property
named after an envelope column (`id`, `source`, `workflow`, …) or ending in `_state` cannot be
projected faithfully beside the column that already holds that name — measured: SQLite does not error,
it keeps the first and renames the later one to `source:1`, so `SELECT source FROM v_note_v1` returns
the *envelope* value under the property's name. A wrong answer with no error is the failure this
project exists to prevent, so the name is refused while the author can still cheaply rename it
(`@ascend/core`'s `reservedPropertyName`) rather than resolved by the database at query time. Two
names that merely look similar stay legal: `ascend_version` and `schema_version` are `entries`
columns no view projects, and `_state` canonicalizes to `state`, which nothing claims.

### Versioning policy

- Adding an **optional** property → **minor** bump. Backward compatible; views union across minors.
- Retyping, removing, or making a property required → **major** bump. New type version, not unioned.

Definitions are immutable; a new shape is a new row, never an `UPDATE`. This is the direct fix for
the schema-drift confound: schema moving under the data with nothing recording that it moved.

### Storage

`node:sqlite` (built into Node ≥22; Node 24.18.0 installed — **no native dependency**). WAL mode plus
`busy_timeout` for concurrent subagent writes.

```sql
entry_types(name, version, spec_json, type_hash, description, record_when, status, created_at)
  -- immutable; new shape = new version row

entries(
  id, type_name, type_version, type_hash,
  recorded_at, run_id, workflow, actor,     -- actor = model/agent that recorded it
  source,                                   -- 'self' | 'derived:claude-code'
  cwd, repo, git_sha, branch,
  properties_json, na_json, evidence_text,
  ascend_version, schema_version
)

annotation_schemes(name, version, spec_json, created_at)
annotations(id, entry_id, scheme, scheme_version, label, value_json,
            confidence, note, created_by, created_at)
```

- **Per-type SQL views** generated from the registry (`v_<type>_v<major>`) project `json_extract`
  into typed columns — real `GROUP BY` ergonomics without runtime `CREATE TABLE` or migrations.
- **`evidence_text`** holds raw unstructured text beside the typed properties. This is where
  unanticipated patterns hide and what a later classification pass reads.
- **Invalidation is a reserved annotation scheme**, not a column — entries stay immutable when we
  learn one measured the wrong thing.
- **`record_when`** on the type: prose describing when an LLM should record it. Surfaced by
  `asc types brief`.

### Starter types

Governing principle: **anything mechanically derivable should be derived, not self-reported.**
Self-reporting costs LLM attention and is less reliable than an adapter reading the same fact off
disk. So the shipped set covers only judgment-laden entries transcripts cannot see.

Ships as self-reported types (drawn from patterns already in the user's `CLAUDE.md`):

| Type | Trigger (`record_when`) | Notable properties |
|---|---|---|
| `review-completed` | a review finishes at any stage | stage, findings[] (severity, category, file), verdict, evidence |
| `stuck-event` | the 3-strike rule fires | attempt_count, what_was_tried, error_text, hypothesis, resolution |
| `stage-transition` | an `IMPLEMENTATION_PLAN.md` stage changes status | stage, from_status, to_status, tests_passing |
| `decision` | a choice is made between viable approaches | options_considered, chosen, rationale, reversibility |

Explicitly **not** shipped as self-reported — derived by the adapter in Stage 2 instead:
`skill-activation` (transcripts carry `attributionSkill`), `verification-run` (Bash tool results),
`user-correction` (`userFeedback`), `tool-denial` (`toolDenialKind`), `context-compaction`
(`compactMetadata`).

### Recall — how the LLM learns it should record

The failure mode for this system is not bad data, it is an empty database: six weeks from now a
review completes and nothing in context mentions ascend exists.

**Hooks are not used for recording.** A hook is a shell command with no LLM in it, so it can only
capture mechanical facts — and `adapter-claude-code` already does that strictly better: retroactively
across every session already on disk, with richer data, and without mutating user settings. A hook capturing
tool calls adds nothing and only works from install day forward.

**Hooks are used for recall.** Verified against the hooks docs:

- Multiple hooks per event are supported (array of matchers, each with an array of commands).
- Hook entries **merge across settings levels rather than replacing each other** — so ascend never
  needs to know what the user already has installed.
- All matching hooks run **in parallel**; no ordering conflict with e.g. impeccable.
- Failures don't block: only `exit 2` blocks, and a timed-out hook is cancelled with output discarded.
- Only four events inject stdout as context Claude can see: `UserPromptSubmit`,
  `UserPromptExpansion`, `SessionStart`, `PostModelSwitch`.

So: **a `SessionStart` hook running `asc types brief`** — the primary recall mechanism. The digest
lands in context every session with no dependence on the model remembering, and no `CLAUDE.md`
instruction to decay.

Constraints on it:
- Offered by `asc init` and installed by `asc install-hook`, but the settings write always requires
  **explicit consent** — ascend never silently edits a user's settings file.
- Written to project-level `.claude/settings.json`, **not** `settings.local.json`, which impeccable's
  `hook-admin.mjs` rewrites.
- **Must append to the existing `SessionStart` array, never overwrite the file.** Verified: `bd init`
  already registered `bd prime --hook-json` on `SessionStart` in this project's
  `.claude/settings.json`. beads is live proof the mechanism works — and a live collision risk if
  `asc install-hook` writes naively.
- **Budget benchmark**: `bd prime` emits ~4.9 KB (~1.2k tokens) per session. That is what a whole
  issue tracker charges. `asc types brief` is a list of type names and triggers and should cost a
  fraction of it.
- Guarded with the `[ ! -f … ] ||` no-op pattern impeccable already uses, so a missing binary is inert.
- **Tiny output.** It is a context tax on every session in the project; the brief must earn its lines.

Ruled out: a `Stop` hook nagging "you recorded nothing this session." `Stop` is informational and its
stdout is not shown to Claude — it could only intervene via `exit 2`, which would block the session.

### Cross-project analysis (mitigating per-project storage)

Per-project `.ascend/` fragments the corpus, and volume is the scarce resource. Designed in from
the start rather than retrofitted:

- Identical schema in every project DB.
- `asc query --across <glob>` uses SQLite `ATTACH` to union project DBs at query time.
- `asc types import` moves a definition between projects **preserving `type_hash`**, so entries
  recorded in different repos under the same definition stay legitimately comparable.

### Recording cost

Non-zero, and friction matters more than tokens:

- **Stable command prefix** so `Bash(asc record:*)` works as a `settings.json` allowlist entry.
  A permission prompt per record kills the workflow. Design the CLI shape around this.
- **`asc record <type> --json -`** (stdin) is the primary path — avoids shell-escaping misery for
  `evidence_text`. Flags are the convenience path.
- **Batching**: one call accepts several entries.
- **Compact, prescriptive errors.** Zod's default output is verbose and human-shaped. A validation
  failure returns the offending field, expected type, and a corrected command — not an issue tree.
  (Matches the "compact error formats" principle in the user's kinetic ADR-001.)
- **oclif startup** (~200–400ms cold, large dep tree) *is* part of the cost for a frequently called
  command. Measure in Stage 0; if it bites, a thin fast path for `record` with oclif handling
  everything else is the escape hatch.

### Define-time duplicate detection (in the tool, not the instructions)

"Search before you define" as prose will fail. `asc types define` runs a similarity check on type
name and property names before creating, and refuses or warns with nearest existing matches.
Cheap version: FTS5 trigram, already built and proven here for `asc search`. Expensive version:
`sqlite-vec`. Without this you get `review-completed`, `review_complete`, and `code-review-done` as
three unusable half-corpora.

---

## Analysis & discovery

The corpus exists for this moment. Everything below is aimed at one goal: let an LLM reason over
hundreds of entries it cannot fit in context, without fooling itself.

### Why no vectors (decided on local evidence)

`mast` **deleted its vector leg** — IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion", tagged
`mast-pre-vector-delete`. Shipping search is FTS5 + BM25 + a declaration-exact ranker fused by RRF.
The experiment was already run in a sibling project and the vector store lost. ascend uses FTS5
trigram over `evidence_text`; `sqlite-vec` stays unused.

### Borrowed from `mast` (`src/search/{fused,fts}.ts`)

- **FTS5 trigram tokenizer + `bm25()`** (negative scores, ascending = best first).
- **`rrfScore(rank, k=60)`** — four lines; the fusion primitive if a second ranker is ever added.
- **Query sanitization.** mast's `toFtsMatch` exists because raw text hits FTS5 syntax errors on
  `(`, `:`, `"`, `OR`. LLM-authored search strings will contain all of these. Non-negotiable.
- **Scope filters inside each ranker before the candidate cap**, never as a post-filter — otherwise
  the candidate budget is spent on rows about to be discarded.
- **Zero-result assist.** mast answers an empty search with trigram "did you mean" suggestions.
  ascend's analogue: a `--filter` matching nothing returns the nearest actual property values. For a
  tool an LLM drives blind, a dead end that teaches is worth a lot.
- **IN-list batching** around `SQLITE_MAX_VARIABLES`.

### `asc explore` output modes

| Mode | Purpose |
|---|---|
| **profile** (default) | Map before data: count, date range, per-property cardinality, top-K values w/ counts, three-state ratios. The LLM plans its own drill-down instead of reading from row 1. |
| `--page/--cursor` | Stable deterministic cursors; every page reports `total`, `has_more` and its coverage, and `--json` adds `next_cursor`. Keyset on `(recorded_at, id)`, never `LIMIT/OFFSET`: offset shifts under a concurrent insert, so a reader silently sees a row twice or never. |
| `--sample random\|stratified\|diverse\|outlier` | Pagination shows twenty near-identical entries; sampling shows spread. **Stratified** (proportional across an enum) most improves classification accuracy — rare categories are guaranteed to appear. |
| `--select`, `--filter`, `--group-by a,b` | Projection, row filter, and crosstabs (contingency tables, not just counts). |
| `--max-tokens N` | First-class context budget. Fits output to N and **reports what it dropped**. |
| `--dump <dir>` | Many files + `manifest.json` (filter, count, token estimate per file) so the model — or parallel subagents — picks files instead of reading all. |

**Coverage is reported on every output** ("showing 40 of 512, 7.8%"). Without it a model reads page
one and writes "most reviews show X". Any annotation carries the coverage it was derived from.
**Stable entry IDs in every output**, so the LLM cites what it saw and then `asc annotate --ids` —
closing explore → classify → annotate into a loop.

> **As built (`asc-wsa`): coverage is stated in the `--json` envelope on every output, and in the
> table only when the output is a subset.** "Every output" above is read as a claim about the
> contract rather than about each rendering, and `--csv` is the precedent: it carries no footer at
> any size, ever, because a footer after the last CSV record is a row with the wrong field count.
> So the rule the code implements is "the envelope always states it; a rendering states it where the
> format allows". On a complete table the footer is omitted -- `showing 3 of 3, 100.0%` on all
> thirteen commands is a line every reader pays for, and the subset case, which is the one the
> paragraph above is about, is exactly the case that still prints it.

### Statistical layer (full, per decision)

Everything a computer does better than an LLM, computed so the LLM doesn't approximate it.

**Reduction — make the corpus readable at all**
- **Near-duplicate collapse** (SimHash/MinHash over `evidence_text`): one representative + count.
  Stops the model over-weighting the same finding repeated forty times.
- **Lexical clustering** (TF-IDF / trigram similarity + agglomerative): cluster representatives and
  sizes. Turns "read 500 entries" into "read 12 clusters, 3 examples each". Biggest single lever on
  both cost and accuracy. No embeddings required.
- **Distinctive terms per group** — log-odds ratio with informative Dirichlet prior (better than raw
  TF-IDF at small N). Hands the LLM a hypothesis rather than asking it to find one.

**Relationships — so it doesn't brute-force**
- **Mutual information / chi-square between categorical properties, ranked.** 10 properties = 45
  pairs; this says which 5 are worth looking at.
- **Association rules** (FP-growth): *"stage=implementation AND category=async-handling →
  severity=high, 78%, support 42."* Finds cross-property patterns nobody thought to query.

**Honesty — so it doesn't overclaim**
- **Wilson score intervals on every proportion**: `60% (95% CI 44-74%, n=25)`. This is the
  "directional, not controlled" discipline from `COLLECTIVE_BUILD_REPORT.md`, mechanized so it
  cannot be skipped.
- **Minimum-N flagging** — flag small groups rather than printing a seductive percentage.
- **Changepoint detection** (CUSUM / Pettitt) on entry rate and property distributions over time.
  *"Share of category X dropped significantly around 2026-07-14."* Answers "did something improve?"
  **from the data**, with no intervention log to declare in advance.

### Rule-based classification (the centerpiece)

The LLM does **not** label entries one at a time — that is expensive, inconsistent, unverifiable,
and worthless on entry 501. Instead it proposes a **rule** (a SQL predicate or FTS query); ascend
applies it deterministically across the whole corpus and reports the match count and — crucially —
**the unclassified remainder**, which is the signal that the taxonomy is incomplete.

Classification becomes a compiled artifact rather than a transcript: cheap, reproducible, auditable,
and automatically applied to entries recorded next month. Two things follow nearly free:

- **Back-test**: the LLM hand-labels a small sample, writes the rule, and ascend measures
  rule-vs-hand agreement — a real precision/recall number before the rule touches the corpus.
- **Cohen's kappa** between two schemes, or two runs of one scheme, over the same entries. A direct
  measurement of whether a classification is reproducible or the model is guessing.

An annotation scheme therefore stores its rule, not just its labels.

### Skill + slash command

Ships a skill teaching the method — *profile → sample → cluster → propose rule → back-test →
annotate* — plus a thin `/ascend-analyze <type...>` command. The skill doubles as a recall surface,
partially mitigating the pull-only recording risk.

---

### Packages

```
packages/core                  pure: spec types, buildSchema, validation, hashing, entry construction. No I/O.
packages/store                 SQLite: schema, migrations, view generation, FTS5, ATTACH/union queries.
packages/analysis              pure: sampling, clustering, near-dup, log-odds, MI/chi-square,
                               FP-growth, Wilson intervals, CUSUM/Pettitt, kappa. No I/O.
packages/cli                   oclif. `asc`. Only interface in v1.
packages/adapter-claude-code   derives entries from ~/.claude/projects/*.jsonl
packages/cli/skill/            analysis-method skill + /ascend-analyze command (see below)
```

Core never imports store or adapter types. `packages/analysis` is pure functions over plain arrays —
statistics are testable against known fixtures with no database involved.

The skill lives **inside `packages/cli`, not at the repository root**, which this diagram originally
said. The reason is packaging, and it was found by reading `packages/cli/package.json` rather than
by argument: `files` is `["dist", "oclif.manifest.json", "skill"]`, so only paths inside the package
are published. A top-level `skill/` directory would exist in this checkout and be absent from every
install, and `asc install-skill` — which resolves its sources from `import.meta.url` — would refuse
on the one machine where it matters. The file that installs an artifact has to ship with it.

### CLI surface

```
asc init
asc types define|list|show|brief|deprecate|import|export
asc record <type> [--json -] [--prop=v ...] [--na prop,prop]
asc query "<sql>" [--across <glob>] [--json|--table|--csv]
asc search <type> "<text>"            FTS5/BM25 over evidence_text
asc explore <type> [--select|--filter|--group-by|--sample|--page|--max-tokens|--dump <dir>]
asc stats <type> [--cluster|--assoc|--correlate|--changepoints|--distinctive]
asc annotate --scheme <s> --rule "<sql|fts>" [--backtest <sample>] | --ids <id,...>
asc kappa --scheme <a> --scheme <b>   inter-scheme agreement
asc ingest claude-code [--since <date>]
asc export|import <file.jsonl>        durability + transfer escape hatch (DB is gitignored)
asc install-hook                      opt-in SessionStart recall hook (project .claude/settings.json)
asc doctor                            dead types, near-duplicates, drift, na/unmeasured ratios
```

`asc` with no args prints the brief; `asc record` with an unknown type lists near matches. Discovery
is built into the error paths, since recall is pull-only.

---

## Stage 0 — Spike first (throwaway, quarantined)

Per `empirical-planning`: the open questions are empirical, and several can be answered against the
real session transcripts already on disk before any of the above is built.

**Questions:**

1. Can we extract a single entry type from existing transcripts at N in the hundreds?
   (`userFeedback` corrections and `toolDenialKind` — near-perfect negative outcome labels, already on disk.)
2. At that N, does an actionable pattern emerge, or is it noise?
3. What fraction of fields come out *not measured* vs real?
4. **Does LLM-authored type definition actually drift?** Have a model define a "review completed"
   type ~5× in independent contexts; diff the shapes. Core risk of the whole idea, cheap to test.
5. Is SQLite + JSON + generated views genuinely pleasant for ad hoc pattern hunting?
6. **Does recording actually happen?** An empty database is the most likely failure mode. With the
   `SessionStart` hook injecting the brief, does a model record entries unprompted during real work?
   Measure the rate, and how large the brief has to be before it stops being ignored — that number
   sets the context tax the hook imposes on every session.
7. What is oclif's cold-start cost for `asc record` on this machine?

Write results to `spike/FINDINGS.md` with measured numbers, not prose. **If Q2 or Q6 comes back
negative, a large part of this design is invalidated** — surface it rather than proceeding.

## Stage 1 — Core + store + record/query

**Goal**: `asc init`, `asc types define`, `asc record`, `asc query` end to end, with the four
starter types installed by `asc init`.
**Success criteria**: an entry recorded via CLI is queryable through its generated view; the three
value states round-trip distinctly; an invalid entry is rejected with a compact, prescriptive error
naming the field, expected type, and corrected command; `asc init` gitignores `.ascend/`.
**Tests**: Vitest. Core purity test (no `fs`/`Date.now()` in `packages/core`, mirroring align's
`network-abstinence.test.ts`). Three-state round-trip. Type-version immutability. Hash stability.
`buildSchema` spec→zod coverage for every property type.

## Stage 2 — Claude Code adapter + backfill

**Goal**: `asc ingest claude-code` derives entries from existing transcripts.
**Success criteria**: re-running is idempotent (keyed on transcript uuid); derived entries carry
`source='derived:claude-code'`; the corpus reaches a queryable N on day one.
**Tests**: idempotency on a fixture transcript; envelope correctness; absent-vs-zero on token fields.

## Stage 3 — `asc explore` + `asc search`

**Goal**: make a corpus an LLM cannot fit in context readable anyway.
**Success criteria**: profile mode maps a type without hand-written SQL; all four sampling modes
work; `--max-tokens` fits output to budget and reports what it dropped; every output carries
coverage and stable entry IDs; `--dump` writes a usable `manifest.json`; FTS5 search survives
LLM-authored query strings containing `(`, `:`, `"`, `OR`.
**Tests**: query-sanitization fuzz against FTS5 syntax errors; stratified sampling preserves enum
proportions; cursor stability under concurrent writes; token-budget truncation reporting.

## Stage 4 — Annotation + statistical layer + skill

**Goal**: turn a corpus into findings, reproducibly.
**Success criteria**: an LLM-authored rule applies across the corpus and reports matches *and*
unclassified remainder; back-test yields a real precision/recall against a hand-labelled sample;
two competing schemes annotate the same entries simultaneously and `asc kappa` scores their
agreement; dropping a scheme loses no entry data; invalidation works as a reserved scheme; every
proportion carries a Wilson interval and small groups are flagged.
**Tests**: `packages/analysis` against known fixtures with hand-computed expected values (Wilson
intervals, kappa, chi-square, log-odds, FP-growth support/confidence, CUSUM changepoints);
scheme isolation; immutability of annotated entries.

## Stage 5 — `asc doctor` + cross-project query

**Goal**: keep the registry from fragmenting; make the per-project split analytically harmless.
**Success criteria**: reports dead types, near-duplicate names, drift across versions, per-property
na/unmeasured ratios, and missing exports; `asc query --across` unions multiple project DBs;
`asc types import` round-trips a definition preserving `type_hash`.
**Tests**: fixture registry with known duplicates and one dead type; two-DB ATTACH union.

Track these in `IMPLEMENTATION_PLAN.md` in the repo per the global workflow; delete when done.

---

## Verification

- `pnpm vitest` green at each stage; no stage lands without tests.
- By hand: define `review-completed` → record entries mixing measured / N/A / unmeasured properties
  → `asc query` and confirm all three states are distinguishable.
- `asc ingest claude-code` against the real `~/.claude/projects/` corpus (read-only) — confirm
  non-trivial N with correct provenance.
- **Drive the real thing**: use `asc` from inside an actual Claude Code session during real work and
  confirm recording is cheap enough that it actually happens.
- `asc doctor` and `asc explore` against the post-backfill corpus.
- `./node_modules/.bin/align check` exits 0 — the purity split is machine-verified, not asserted
  in prose. This is a commit gate, not a stage gate.

## Risks

| Risk | Mitigation |
|---|---|
| **Nothing ever gets recorded** — the primary failure mode | Stage 0 Q6 tests it before building; optional `SessionStart` hook injects the brief automatically; discovery wired into error paths |
| `SessionStart` hook becomes a context tax on unrelated sessions | Opt-in only; brief output kept minimal; guarded no-op if the binary is absent |
| Runtime-defined types drift into near-duplicates | Small bounded spec vocabulary; immutable versioned types; `type_hash` per entry; define-time similarity check; `asc doctor` |
| Per-project storage fragments the corpus below useful N | `--across` ATTACH union + `types import` with hash preservation, designed in from Stage 1 |
| Pattern discovery needs more volume than one person generates | Stage 0 Q2 tests it before building; transcript backfill supplies day-one N |
| Selection bias — LLM chooses when to record, how to fill fields | `required` = must decide (value or N/A); record boring cases; `source` separates self-reported from derived |
| A past entry measured the wrong thing | Immutable entries + invalidation as reserved annotation scheme |
| Recording too expensive → silently skipped | Stable prefix for permission allowlist; stdin JSON; batching; oclif startup measured in Stage 0 |
| Corpus lost with the working copy (DB is gitignored, local-only) | `asc export`/`import` JSONL; `asc doctor` warns when no export exists |
| **v1 scope is large** — the full statistical layer before there's a corpus to justify it | Stage 0 gates it; `packages/analysis` is pure functions testable against fixtures without data; stages land independently so Stages 1–3 are useful alone |
| LLM reads page one and generalizes to the corpus | Coverage on every output; annotations record the coverage they were derived from; Wilson intervals + min-N flagging |
