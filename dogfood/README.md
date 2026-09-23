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

## The records

Each finding has its own record under `dogfood/`. This page is the index and the shared
context; the depth lives in the numbered files.

| # | finding | bead | surfaced by |
|---|---|---|---|
| [0001](0001-2026-09-17-explore-omits-wilson-intervals.md) | `asc explore` reports proportions as bare counts | `asc-5x7` (P1) | a pre-registered prediction, tested against real output |
| [0002](0002-2026-09-17-benchmark-temp-dirs-ingested.md) | ascend's own benchmark wrote into ascend's own corpus | `asc-80m` (P2) | the unclassified remainder — nobody was looking |
| [0003](0003-2026-09-17-recording-is-never-one-step.md) | recording an entry is never one step | `asc-ttg` (P2) | the discipline task auditing itself |
| [0004](0004-2026-09-18-the-corpus-records-identity.md) | the corpus records who and where you are | `asc-37x` (P1) | a direct question, widened into a scan of every column |
| [0005](0005-2026-09-18-evidence-text-carries-tool-boilerplate.md) | `evidence_text` is 43 words of tool boilerplate before it is the user | `asc-m4u` (P2) | hand-reading merges from a measurement about something else |
| [0006](0006-2026-09-18-recorded-at-is-the-ingest-clock.md) | `recorded_at` is the ingest clock — 94.7% of entries share one instant | `asc-bn0` (P2) | a refusal whose stated reason did not survive a check against the data |
| [0007](0007-2026-09-18-the-suite-races-itself.md) | The gate's red was the suite competing with itself, on a deadline a growing corpus sets | `asc-3x1` (P2) | a hypothesis that predicted "quieter is faster" meeting a quieter run that was slower |
| [0008](0008-2026-09-20-the-key-claimed-a-scope-its-guard-did-not-cover.md) | the derived key claimed uniqueness over a scope its guard did not cover | `asc-iq6` (P0) | a red gate read as known flakiness, until a quiet re-run named a value instead of a deadline |
| [0009](0009-2026-09-22-the-installer-cannot-install-into-us.md) | the installer we shipped cannot install into this repository | `asc-cjm` (P2) | asking whether to dogfood a just-shipped hook, then checking whether the destination file was tracked |
| [0010](0010-2026-09-23-the-segmenter-runs-program-text.md) | the command segmenter reads multi-line program text as commands | `asc-7gz2` (P2) | eyeballing a matcher's input distribution before trusting it — nobody was looking |
| [0011](0011-2026-09-23-a-session-is-not-a-randomization-unit-here.md) | a per-session holdout has about two units per arm in a long-session project | `asc-6ola.4` (P1) | a power check printing a count nobody asked for (`sessions 4`) beside an ICC that clamped to 0 — nobody was looking |

Ten findings, each with its own mechanism. The mechanism is the part that repeats even when
the findings do not, so each record states its own explicitly.

## The convention

**One record per finding**, named `NNNN-YYYY-MM-DD-short-name.md`, copied from
[`0000-template.md`](0000-template.md). `NNNN` is the next free sequence number and gives beads
a short stable citation (`dogfood/0002`); the date is when the finding *surfaced*, not when the
bead was filed or fixed. Both sort keys are kept deliberately — the number to cite, the date to
scan — at the cost of a little redundancy.

**What belongs here, and what belongs in `docs/evidence/`.** The distinction is whether anyone
asked the question:

- **`docs/evidence/EV-N.md`** answers a question **named in advance**. EV-19 pre-registered its
  question and five numbered predictions in a separate commit *before* measuring, so each could
  be marked hit or missed rather than reinterpreted.
- **`dogfood/NNNN-*.md`** records something that **surfaced on its own**, where nobody had asked.
  `asc-80m` exists because a rule failed to classify two rows.

If you wrote the question down first, it is an EV record. If the tool handed it to you, it is a
dogfood record. A finding can cite both — 0001 does.

**The one file here that is not a record.** [`types.json`](types.json) predates this convention
and stays: it is the replayable definition of the two types this project defined for itself,
`evidence_record` and `note`, exported by name so a fresh `asc init` reproduces them at
byte-identical `type_hash` values (`f2f796ca`, `96880b60`, verified in commit `8fbabef` against a
throwaway store). Schema only — a fresh clone gets the types and none of the corpus. It belongs in
this directory for the same reason everything else here does: the types exist because dogfooding
needed them.

**The one required section is "The metric."** A finding without a measurement is an impression,
and impressions belong in a bead comment. Every measurable claim carries the measured value and
how it was obtained; where a value does not exist it is omitted, never written as `0`. Groups
under `MIN_N` (20) are named as anecdotes rather than dressed up as estimates — including when
the anecdote is about us, which 0003 is.

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
