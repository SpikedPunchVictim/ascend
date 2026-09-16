# ascend

A local, per-project store that LLM workflows write structured **entries** into — so that after
hundreds accumulate, you can query the corpus, discover patterns no single entry revealed, and act
on them.

The CLI is `asc`.

## The idea

LLM workflows don't record what they do in a form that supports later analysis. When a workflow does
change its process, there's no way to tell whether the change helped.

A worked example. A software workflow runs a review at each stage, and logs each review as an entry.
No single review says anything. After a few hundred, a query shows that a large share of findings
cluster on one theme — and *that* is what justifies building tooling to address it.

**The defining property is that analysis is deferred.** Entries are recorded without interpretation;
classification happens retrospectively, once a pattern is visible. This is not a metrics or
time-series system and there is no baseline to compare against.

A corollary that shapes everything else: **the LLM logs, it does not score.** It populates fields. It
never grades its own work. Pattern-finding is a separate, user-initiated pass, which removes the
conflict of interest that comes from asking a model to judge itself.

## Requirements

- **Node ≥ 22** (the store uses `node:sqlite`)
- **pnpm 11**

## Install

```bash
git clone <this repo> && cd ascend
pnpm install          # runs `prepare`, which builds every package
```

`pnpm install` builds; there is no separate build step to remember. If `dist/` is ever missing,
`pnpm build` restores it.

Nothing links an `asc` binary onto your `PATH` — the package is not published to npm, and this
repo does not install itself globally. Run it by path:

```bash
node packages/cli/dist/bin.js --help
```

A shell alias makes that pleasant:

```bash
alias asc='node /path/to/ascend/packages/cli/dist/bin.js'
```

## Quickstart

Everything below is real output from the commands as they ship today.

```bash
cd ~/some/project
asc init
```

```
action     target                                       outcome
---------  -------------------------------------------  ----------------------
store      /Users/you/some/project/.ascend/ascend.db    created
gitignore  /Users/you/some/project/.gitignore           created
type       review_completed                             created
type       stuck_event                                  created
type       stage_transition                             created
type       decision                                     created
hook       SessionStart: asc types brief                offered, not installed
```

`asc init` creates the store, adds `.ascend/` to `.gitignore`, and installs four starter types. It
**never edits your settings** — the recall hook is offered, not installed.

Record something:

```bash
asc record review_completed --prop verdict=approved --prop stage="E2 store"
```

```
index  id                                    type              version
-----  ------------------------------------  ----------------  -------
0      d607d266-aeb2-4419-ad73-a177e709cc7a  review_completed  1
```

Record a batch from a document — one object is one entry, an array is a batch, and a batch is
all-or-nothing:

```bash
cat reviews.json | asc record review_completed -
```

Ask the corpus a question:

```bash
asc query "SELECT verdict, count(*) AS n FROM v_review_completed_v1 GROUP BY verdict"
```

```
verdict            n
-----------------  -
approved           1
changes_requested  1
```

For scripts, every command emits a versioned envelope:

```bash
asc query --json "SELECT count(*) AS entries FROM entries"
```

```json
{"ascend_output":1,"rows":[{"entries":2}],"row_count":1}
```

The envelope's shape is a contract — `ascend_output` is its version. Human-readable output is not a
contract and may change.

## Core concepts

| Term | Meaning |
|---|---|
| **entry** | One structured record of something that happened. The unit of storage. Immutable once written. |
| **entry type** | A named, versioned definition of an entry's shape, with a declared type per property. |
| **registry** | The store of entry type definitions. Writable at runtime, including by the LLM. |
| **annotation** | A classification attached to existing entries *after the fact*. Never mutates the entry. |

### Three states, not two

Every property of every entry is in exactly one of three states, and the difference is the point:

| State | Meaning |
|---|---|
| **measured** | A value was recorded. **`0` is a measurement**, not an absence. |
| **not_applicable** | The property explicitly does not apply to this entry (`asc record --na`). |
| **not_measured** | Nothing was recorded, and nothing was declared. Shown as a blank cell. |

`required` on a property means "this needs a **decision**" — a value *or* an explicit N/A. It never
means a value must be invented. Where a value does not exist, it is **omitted, never fabricated**,
and never filled with `0`.

This exists because the failure it prevents is silent and permanent: a `cacheHitRatio = 0` that means
both "nothing was cached" and "caching does not apply to this run" has lost the distinction forever.

### Entry types are defined at runtime

The set of types is not fixed at build time. Define one with a JSON document:

```bash
asc types define my_type.json
```

A definition carries a per-property type (`string`, `number`, `integer`, `boolean`, `enum`,
`timestamp`, `duration`, `ref`, `text`, `json`), an optional `required`, and `enum_values` where the
vocabulary is yours. Defining a type is **versioned**: `definitionShape` hashes the shape — the
declared properties and their types — while leaving `description` and `record_when` free to improve,
so correcting prose does not mint a new version.

Definitions round-trip: `asc types export` writes JSON documents, `asc types import` reads them back
unchanged. That is the transfer and durability escape hatch for the registry.

## Commands

| Command | What it does |
|---|---|
| `asc init` | Create `.ascend/`, install the starter types, offer recall. |
| `asc record TYPE [DOCUMENT]` | Record one entry, or a batch, from flags or a document. |
| `asc query SQL` | Run **one read-only** SQL statement. `--across <glob>` attaches other projects. |
| `asc ingest claude-code` | Read this machine's Claude Code transcripts, derive entries, write them. Re-running creates no duplicates. |
| `asc types list` | List the types registered in this project. |
| `asc types show NAME` | Show one type: version, hash, properties, prose. |
| `asc types brief` | One line per active type, with when to record each. This is what a model reads. |
| `asc types define DOC` | Register a definition from JSON. `--dry-run` previews it. |
| `asc types deprecate NAME` | Retire a type, keeping the entries already recorded. |
| `asc types export` / `import` | Round-trip definitions as JSON documents. |

Every command supports `--help`. Mutating commands (`init`, `record`, `ingest claude-code`, `types
define`, `types deprecate`, `types import`) support `--dry-run`. Output is `--table` (default),
`--json`, or `--csv`
— and results go to **stdout** while warnings, progress and errors go to **stderr**, so
`asc query ... --csv > out.csv` is always safe.

Exit codes: `0` success, `1` refusal, `2` usage error, `130` on SIGINT.

## How the store is shaped

SQLite, in `.ascend/ascend.db`, **one store per project**, gitignored. Nothing is global and nothing
leaves your machine.

Entries live in one `entries` table with a fixed envelope, plus a JSON column for type-specific
properties. For each registered type, ascend generates a **view** — `v_<type>_v<version>` — that
projects those properties as real columns, so `SELECT verdict FROM v_review_completed_v1` works
without you writing JSON extraction.

Registering a type also emits **one composite expression index per property**, automatically and
uncapped. That is a deliberate trade, and the cost was measured rather than assumed: at 20
properties it adds **0.135 ms** to an `asc record` and **679 ms** to a full backfill — negligible —
but it roughly **doubles the file on disk** (98.1 MB → 204.9 MB at 100k rows). So the index set ships
uncapped and the honest lever is disk, not index count. (`docs/evidence/EV-write-cost.md`.)

Two consequences worth knowing:

- **`asc query` cannot write.** The connection it opens is read-only, so no statement you run can
  change your data — including one you didn't mean to run.
- **Entries are immutable.** `UPDATE` and `DELETE` on `entries` are refused by triggers. Corrections
  are new entries; classification is an annotation. This is what makes a corpus comparable over time.

Values come back as SQLite represents them, not as the declared type: a boolean reads as `1` or `0`,
a `json` property as JSON text (ready to hand back to `json_extract`), and an integer too large for a
JavaScript number as a decimal string. `asc query --help` says so where you'll look for it.

## Packages

| Package | Role |
|---|---|
| `packages/core` | Pure. The envelope, the type-spec model, hashing, validation, the three-state model. Zero `fs`, zero `Date.now()`, zero network — time and ids are injected. |
| `packages/store` | The only package that touches SQLite. Schema, migrations, the recorder, the registry, generated views, FTS5 search. |
| `packages/analysis` | Pure. Statistics — Wilson score intervals, minimum-N flagging, permutation controls. |
| `packages/cli` | The `asc` command line, built on oclif. The only interface in v1. |
| `packages/adapter-claude-code` | Read-only adapter that derives entries from Claude Code transcripts. |

The dependency direction is enforced, not merely documented — see *Development* below. `core` and
`analysis` are pure because a statistical result you cannot reproduce from inputs alone is not
evidence.

## Status

Honest about what exists, because a README that overstates is worse than one that says nothing.

**Built and working:** `asc init`, `asc record`, `asc query` (including `--across`), the whole
`asc types` topic (`list`, `show`, `brief`, `define`, `deprecate`, `export`, `import`),
`asc ingest claude-code`, and `asc search`. `asc explore` is built in five of its modes — the
profile it defaults to, `--page`, `--sample`, `--max-tokens` and `--dump` — which is the set that
answers *what is in this type* and *how do I read it without filling a context window*.
`--select`, `--filter` and `--group-by` are not among them, so reading a type's entries *by
property value* is not yet a command; `asc search` reports where a term occurs as a property value,
but will not retrieve on it.

Underneath all of them the store, the registry, generated views and the three-state model are
complete.

**Not built yet:** `asc explore --select/--filter/--group-by`; `asc stats` and the analysis layer
behind it; `asc annotate` and `asc kappa`; `asc doctor`; `asc install-hook`; the analysis skill and
its slash command. Nothing distributes derived entries *across* projects either — the ingest reads
the whole transcript corpus and writes it into the store of the project you run it in, so a second
project's store gets its own full copy.

### What `asc search` does, and what it does not

It searches **`evidence_text` and nothing else**. Properties, the type name and the envelope are
not indexed, so a term that lives in a property is invisible to it however often it occurs — and
because `evidence_text` is set only when a workflow records evidence, most entries in a
transcript-derived store carry none. Measured on the development corpus, 1,471 of 1,491 entries are
unsearchable, and they are four of the five populated types *in full*: for those, every query
returns zero.

That makes a bare `[]` a bad answer, so a search that finds nothing reports **why** — whether the
type is empty, whether its entries carry no evidence text (in which case no query can ever match),
or whether the term is genuinely absent — along with the counts behind that, and any property
values that actually occur and contain a term of the query:

```
$ asc search verification_run "cargo"

no matches.
This type has 486 entries, and the index holds none of them: the index covers
'evidence_text', and no entry of this type carries any. No query can match, so retrying
with different words will not help -- the type's properties are where its content is.

The query terms do occur as property values, which a search does not cover:
  runner = "cargo test"  (127 entries)
  runner = "cargo clippy"  (88 entries)
```

`--json` carries the same thing as an `assist` block, present only when the result is empty.

### What `asc ingest claude-code` does

It reads `~/.claude/projects` — **read-only, always** — and derives five entry types from what is
already on disk: `tool_denial`, `context_compaction`, `verification_run`, `skill_activation` and
`user_correction`. Nothing is asked of a model, because a transcript is a better record than a
model's memory of one.

**Re-running creates no duplicates.** Every entry's id is a pure function of the event it came
from, so a second run proposes the ids the first run wrote and reports them as already present. A
re-run is not an error and exits 0.

Two limits worth knowing, both measured. Each derived type's N is its count of **distinct events**,
not of transcript lines — a skill active across 54 consecutive messages is one activation. And the
`verification_run` filter is a **judgement**, not a reading: the same corpus yields 486 entries
under the shipped rule, 6,940 if every newline ended a command, and 16,352 under a broader one.
The rules, the five-way comparison and what each choice cost are in `docs/evidence/EV-derived.md`
(EV-9); the ingest design and its measurements are `docs/evidence/EV-ingest.md` (EV-10).

On the corpus this machine holds, the ingest yields **1,491 entries** (486 `verification_run`,
457 `tool_denial`, 441 `context_compaction`, 87 `skill_activation`, 20 `user_correction`) spanning
**44 days**. The full census — N per type, date range, per-field population rate, value cardinality,
and three things about that data that would otherwise be mistaken for bugs — is
`docs/evidence/EV-baseline.md` (EV-11). Worth knowing before you query it: no derived entry carries
`cwd`, `repo`, `git_sha` or `branch`, and `project` is Claude Code's *encoded* directory name, so it
is the only locality signal and it is a lossy one.

## Development

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && ./node_modules/.bin/align check
```

All five must be green; `pnpm quality-gate` runs the same chain. Commit hooks run them too.

A few conventions this repo holds itself to, in case you're reading the source:

- **Every assertion is mutation-tested.** A check must be shown to *fail* before it is trusted to
  pass — a rule that never fires looks exactly like a rule that passes.
- **Measurements, not estimates.** Numbers in comments and in `docs/evidence/` carry the command that
  produced them and the date they were taken. Where a design and the evidence disagree, the evidence
  wins and the record says what it overturned.
- **`docs/evidence/`** holds one `EV-<n>` record per empirical question, in a fixed shape: Question
  / Method / Measurement / Decision / Confidence. Start there for the *why* behind a design choice.

Design documents: `ARCHITECTURE.md` (what and why), `KICKOFF.md` and `TASKS.md` (the rules),
`IMPLEMENTATION_PLAN.md` (staging and status), `docs/evidence/` (the measurements).

## License

Apache-2.0. See `LICENSE`.
