# Dogfooding results: three defects ascend found in itself

**Date:** 2026-09-17 · **Epic:** E11 (Dogfood) · **Evidence:** [`docs/evidence/EV-19.md`](docs/evidence/EV-19.md)

On 2026-09-17 ascend's corpus went from **79 hand-recorded entries to 1,790**, and the analysis layer
was pointed at the record of ascend's own construction for the first time. Three beads came out of
that exercise — `asc-5x7`, `asc-80m`, `asc-ttg`. None of them came from planning, a code review, or a
bug hunt. Each was produced by *using the tool on the tool*, and each arrived through a different
mechanism.

This document records how, with the measurement behind each one.

> **A note on names.** Project identifiers are redacted throughout. The corpus spans twelve working
> directories; only this repository is named. Counts and paths that would identify the others are
> replaced with role descriptions.

---

## The setup: what made these findings possible

Before 2026-09-17 the store held **79 entries**, all hand-recorded: `decision` 38,
`stage_transition` 20, `note` 15, `stuck_event` 4, `evidence_record` 2. With `MIN_N = 20`
(`packages/analysis/src/proportion.ts:50`) only two types cleared the threshold for a proportion to
be reported as an estimate rather than an anecdote — and one of those cleared it by a single entry.

`asc ingest claude-code` then derived **1,702 entries from 866 transcript files** (485,235 records,
0 malformed, 0 unreadable). The dry run predicted that count exactly, which was itself the first
real-world exercise of the `asc-vaw` fix — the fix that exists so a preview cannot report a corpus as
clean that the real run would die on.

**Corpus after: 1,790 entries across 10 types. Six clear `MIN_N`, up from two.**

That volume is the precondition. At 79 entries none of the three findings below was reachable.

---

## Finding 1 — `asc-5x7`: the analysis layer ships its own discipline inconsistently

**Mechanism: a pre-registered prediction, tested against the shipped output.**

EV-19 was pre-registered before any measurement ran (commit `8ed2300`, results in `f93a8ad` — the git
log ordering is the receipt). Its fifth prediction, written before looking:

> **P5** The shipped `asc explore` reports tallies as bare counts, without the Wilson intervals or the
> `MIN_N` anecdote flag EV-3 treated as mandatory — so a reader of the shipped profile cannot tell an
> estimate from an anecdote.

### The metric

`asc explore tool_denial --json` was searched for every key that would carry an interval:

| key | present in `explore` output |
|---|---|
| `lower` | no |
| `upper` | no |
| `confidence` | no |
| `wilson` | no |
| `interval` | no |
| `proportion` | no |
| small-group / anecdote flag | no |

Its rows carry exactly two keys: `field` and `value`. So the profile prints a count such as
`automode-blocked 36` with nothing stating whether 36 of 564 is an estimate or an anecdote.

The same run's `asc annotate --backtest`, on the same data, emitted:

```
0.0% (95% CI 0.0-43.4%, n=5) [...treat as anecdote, not estimate]
```

### The pattern

**One project, one discipline, two commands, opposite behaviour.** `--backtest` reports every
proportion as a Wilson interval and flags anything under `MIN_N`. `asc explore` — the command whose
entire purpose is profiling, and the *first* one a user runs — reports neither. `renderProportion()`
already exists in `packages/cli/src/output.ts` and already renders the qualified form, including
`n=0 (no estimate)` for a null. **`explore` simply does not call it.**

This matters because of what EV-3 established a month earlier. EV-3's most statistically seductive
result was an association at **χ²=153.11, p=8.61e-8** — which its shuffled control revealed to be an
artifact of the marginals. EV-3's own words: *"The asymptotic test alone would have shipped a false
finding."* Intervals are the thing standing between a real finding and a seductive one, and the
command most likely to be read casually is the one without them.

---

## Finding 2 — `asc-80m`: ascend's own benchmark polluted ascend's own corpus

**Mechanism: the unclassified remainder. Nobody was looking for this.**

This is the finding that most directly vindicates the design. `asc-2pg`'s ACCEPT criterion is not
"reports matches" — it is *"reports match count **AND THE UNCLASSIFIED REMAINDER** — the remainder is
the signal that the taxonomy is incomplete."*

### The metric

A rule built from an 80-entry sample was applied to all 564 `tool_denial` entries:

| | count | share |
|---|---|---|
| labelled | 504 | 89.4% |
| **unclassified remainder** | **60** | **10.6%** |

Characterising those 60 by project is what surfaced it: **2 of the 60 carried a `project` that was an
ephemeral macOS temp directory**, created by EV-18's own benchmark runs (*"what does one `asc record`
call cost the agent that makes it"*). They were ingested as ordinary denials against projects that
can never recur.

### The pattern

**ascend's measurement harness wrote into ascend's corpus, and the analysis then had to reason about
it.** Two singleton strata that are noise by construction — and directly in the path of EV-19's
headline finding, which is that denial kind is a property of the *project*.

Two things make this worth a bead rather than a shrug:

1. **It grows.** Two entries today, more with every benchmark that records.
2. **It cannot be cleaned up.** `entries_are_immutable` and `entries_cannot_be_deleted` are enforced
   by database trigger. The two entries are permanent. The options are prevention at ingest or an
   invalidation annotation (invalidation being an annotation scheme, not an edit) — never deletion.

The remainder found this without being asked. No query was written looking for temp directories; the
rule failed to classify them, the remainder reported what it could not classify, and the cause was
visible on inspection.

---

## Finding 3 — `asc-ttg`: recording an entry is never one step

**Mechanism: the discipline task auditing itself.**

`asc-0fp` ("Record every task close from here on") carries an instruction that makes the tool's own
friction a deliverable:

> If recording feels expensive, THAT IS A FINDING - record it as a stuck-event and raise it.
> Recording friction is a first-class risk in ARCHITECTURE.md.

### The metric

**9 entries recorded across one working day**, every one from real work, none retrofitted:

| type | n |
|---|---|
| `stage_transition` | 4 |
| `evidence_record` | 3 |
| `decision` | 1 |
| `note` | 1 |

Measured costs:

- **9 of 9 entries required a scratch JSON envelope file written first.** The prose properties
  (`measurement`, `rationale`, `confidence`, `question`, `method`) are paragraphs and will not go on a
  command line. Recording is therefore always two actions, never one.
- **1 refusal** on a `json` property given a JSON-*encoded string* rather than a real array. Caller
  error, and the refusal named the exact fix — but the envelope/flag duality is where it came from.
- **3 refusals before the first successful record**, earlier the same day: `--file` is not a flag
  (the document is a positional), then document and entry flags cannot be combined, then a wrong
  field name. Each message was clear; none was guessable from `--help` alone.
- **`stage_transition` required an `asc types show` first** to learn its property shape.

### The pattern

The friction is not that any single record is slow. It is that **no record is a single action** —
which is the shape ARCHITECTURE.md's "recording friction" risk actually takes in practice.

### One deliberate deviation, which is itself the finding

`asc-0fp` says to record this **as a `stuck_event`**. It was not, and the reason is the interesting
part. `stuck_event`'s own `record_when` binds it to the three-strike rule firing — and three strikes
never fired. Recording one would have **falsified a type's contract in order to make an instruction
come out true**.

That is the same trade an implementing agent refused earlier in the same work, when it declined to
reuse a counter named `unverdictable` for a meaning that counter's doc comment did not carry. The
instruction and the type disagree, and one of them should change. `asc-ttg` carries that as the thing
to decide; the friction itself was recorded as a `note`, the type of last resort.

---

## Were these the default types?

**Mostly no — and the exceptions are informative.** ascend's types come from three places:

| origin | types | how they arrive |
|---|---|---|
| **Starter** (default) | `review_completed`, `stuck_event`, `stage_transition`, `decision` | installed by `asc init` from `packages/cli/src/starters.ts` |
| **Derived** | `tool_denial`, `context_compaction`, `verification_run`, `skill_activation`, `user_correction` | `asc ingest claude-code`, never recorded by hand |
| **Project-defined** | `note`, `evidence_record` | defined for this project by `asc-5ra` |

Mapping the findings onto that:

| bead | surfacing type | origin |
|---|---|---|
| `asc-5x7` | `tool_denial` | **derived** |
| `asc-80m` | `tool_denial` | **derived** |
| `asc-ttg` | `evidence_record`, `note` / `stage_transition`, `decision` | **project-defined / starter** |

**Both findings about ascend's data and analysis came from a derived type that no human ever recorded
a single instance of.** `tool_denial` is machine-extracted from transcripts. It is also the only type
with enough volume (564) and enough structure (six properties) to support the analysis — the
hand-recorded types are all small, and the hand-recorded types that carry prose are all below
`MIN_N`. The findings came from the part of the corpus a user never types.

**The friction finding is the mirror image**: it could only come from hand-recording, and it spans
both starter types (`decision`, `stage_transition`) and project-defined ones (`evidence_record`,
`note`). The cost is in the properties that hold prose, and that is independent of which of the three
origins a type has.

### A fourth observation, unasked for

**`review_completed` — a starter type, installed by default — has zero entries.**

| type | origin | entries |
|---|---|---|
| `review_completed` | **starter (default)** | **0** |
| `stuck_event` | starter (default) | 4 |
| `stage_transition` | starter (default) | 24 |
| `decision` | starter (default) | 39 |

A month of real work, including a 22-finding bug hunt, a Sonnet-vs-Opus model comparison, and dozens
of code reviews of agent output — and the type built for recording a completed review was never once
used. No bead is filed for this yet: one unused type across one project is an observation, not a
finding, and `MIN_N` discipline applies to conclusions about ourselves too. It is recorded here so
that if a second project shows the same thing, the pattern has a place to attach.

---

## What this says about the premise

E11's bet was that using ascend on ascend would find things that planning would not. The record:

- **`asc-5x7`** came from a prediction written down before looking, then tested against real output.
- **`asc-80m`** came from the unclassified remainder — the mechanism `asc-2pg` exists to provide —
  with nobody looking for it.
- **`asc-ttg`** came from the tool's own ergonomics under sustained real use, which no amount of
  reading the code would have surfaced.

Three different mechanisms, three defects, none of which a code review would have found, because none
of them is visible in the code. `asc-5x7` is an *absence* (a function that exists and is not called).
`asc-80m` is a property of the *data*. `asc-ttg` is a property of *using it repeatedly*.

The acceptance test (`asc-c9h`) returned **GO with one qualification**, the qualification being
`asc-5x7`. Full measurement, including the shuffled control and the scored predictions — one of which
missed and is recorded as a miss — is in [`docs/evidence/EV-19.md`](docs/evidence/EV-19.md).
