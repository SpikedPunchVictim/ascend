# 0002 — ascend's own benchmark harness wrote into ascend's own corpus

| | |
|---|---|
| **Bead** | `asc-80m` |
| **Surfaced** | 2026-09-17 |
| **Surfaced by** | The unclassified remainder of a rule application (`asc annotate`) |
| **Entry type(s)** | `tool_denial` (derived) |
| **Severity** | P2 |
| **Status** | open |

## What was found

Two entries in the corpus carry a `project` that is an ephemeral macOS temp directory, created by
EV-18's own benchmark runs (*"what does one `asc record` call cost the agent that makes it"*). They
were ingested as ordinary tool denials, recorded against projects that can never recur.

They are not corrupt. They are real denials that really happened. They are just denials from a
throwaway directory that existed for the duration of a measurement, and they now sit permanently in
the corpus as singleton strata.

## How it surfaced

**Nobody was looking for this.** No query was written hunting for temp directories; the possibility
had not occurred to anyone.

`asc-2pg`'s ACCEPT criterion is not "reports matches" — it is *"reports match count **AND THE
UNCLASSIFIED REMAINDER** — the remainder is the signal that the taxonomy is incomplete."* A rule
built from an 80-entry sample was applied to all 564 `tool_denial` entries, and the command reported
what it could not classify. Characterising those leftovers by project is what made the temp
directories visible.

This is the mechanism working exactly as designed, on its first real use, against a defect in the
tool that designed it.

## The metric

Rule applied to the full `tool_denial` population:

| | count | share |
|---|---|---|
| labelled | 504 | 89.4% |
| **unclassified remainder** | **60** | **10.6%** |
| of which: ephemeral benchmark temp directories | **2** | 3.3% of the remainder |

The two entries' `project` values are of the form
`/private/var/folders/<redacted>/T-<ev18-benchmark-tmpdir>` — redacted here because this repository
is public.

Scale check, stated rather than implied: 2 of 564 is **0.35%** of the type, and removing them would
not have changed EV-19's conclusion. This is filed for what it becomes, not for what it currently
costs.

## The pattern

**A measurement instrument contaminating the corpus it measures.** EV-18 recorded real entries in
order to time the recording path, and those entries stayed. Any benchmark that exercises the write
path has this property, so the population grows with every future measurement — which is the actual
argument for fixing it, since the present cost is negligible.

It lands directly in the path of the analysis the tool exists to do: EV-19's headline finding is
that denial kind is a property of the **project**, and this injects project values that are noise by
construction.

## Why nothing else would have caught it

- **Not an ingest error.** The ingest did exactly what it was told: it read a transcript and derived
  entries from it. Every one of those entries is faithful to its source.
- **Not visible in any single entry.** One entry with an odd-looking `project` is unremarkable. The
  finding only exists at the population level, as a stratum of size 1.
- **Not a test case.** No test could assert this without someone first having the idea that temp
  directories are different from projects — which is the idea the remainder supplied.

## Consequences and constraints

**This can never be a cleanup task.** `entries_are_immutable` and `entries_cannot_be_deleted` are
enforced by database trigger. The two entries are permanent. The real options are:

1. **Prevention at ingest** — teach the ingest to recognise an ephemeral root. Requires deciding
   what "ephemeral" means, which is not obvious and may be platform-specific.
2. **Invalidation as an annotation** — ascend already treats invalidation as an annotation scheme
   rather than an edit (`RESERVED_SCHEME = 'invalidation'`, owned by `asc-88m`). This marks them
   without pretending they never happened, which is more honest about what occurred.

Worth deciding rather than assuming: a temp-dir project may be legitimately ingestable for some
purposes. The open question is whether the ingest should know the difference, and whether analysis
should be able to exclude them without every caller hand-writing a path predicate.

## Links

- Bead: `asc-80m`
- Evidence record: `docs/evidence/EV-19.md` (finding #4)
- Related: `asc-88m` (invalidation as a reserved scheme), `docs/evidence/EV-18.md` (the benchmark)
