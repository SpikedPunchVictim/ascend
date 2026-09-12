# EV-1: can a single entry type be extracted from existing transcripts at N in the hundreds?

**Question**    Does a real, single-user Claude Code transcript corpus contain at least one entry
                type at N in the hundreds — enough to test whether patterns emerge at realistic
                volume — or is the corpus too thin to support the project's central premise?

**Method**      Streamed every `*.jsonl` under `~/.claude/projects/` **read-only** via
                `spike/lib/reader.mjs` (line-by-line, memory-bounded, malformed lines counted and
                skipped), derived five event types, and loaded them into a scratch SQLite database
                (`spike/lib/corpus.mjs`). Five candidate types were derived: `tool-denial`,
                `tool-result`, `user-correction`, `skill-invocation`, `compaction`.

                Scripts: `spike/spike-corpus.mjs`, `spike/lib/corpus.mjs`, `spike/lib/reader.mjs`.

                A per-file `Map` (tool_use id → tool name) joins denials and results back to the
                tool that produced them, since the transcript records the denial and the invocation
                as separate lines.

## Measurement

Corpus sweep:

| | |
|---|---|
| transcript files | **809** |
| lines | **388,054** |
| bytes | **1.14 GB** |
| wall clock | **11.2 s** |
| peak RSS | **213 MB** |

Peak RSS of 213 MB against 1.14 GB of input confirms the streaming design holds — the input is
never resident.

Rows extracted: **69,276** in **7.2 s**.

Per-type N:

| type | N |
|---|---|
| `tool-result` | (largest; every tool call produces one) |
| `tool-denial` | **409** |
| `skill-invocation` | hundreds |
| `compaction` | tens |
| **`user-correction`** | **20** |

`tool-denial` at **N=409** was selected as the corpus for `asc-spike-patterns`, clearing the
"hundreds" bar by 2×.

## Decision

**GO.** A real entry type exists at N=409, comfortably above the "hundreds" threshold the plan
required. Proceed to `asc-spike-patterns`.

Threshold: the plan specified N in the hundreds. 409 passes; the next-largest actionable type
(`user-correction`, N=20) does not, and would have forced a NO-GO had `tool-denial` also failed.

## Confidence

What this does **not** establish:

- **`user-correction` came in at N=20, not the hundreds the design assumed.** This is a finding in
  its own right and is reported as such in `EV-patterns.md`: the plan's expectation that user
  corrections form a usable corpus is **not** supported. Worse, all 20 are a subset of the denial
  records (every one carries a `toolDenialKind` sibling), so it is **not an independent corpus** —
  it cannot be used to corroborate findings from `tool-denial`.
- **One corpus, one user, one machine.** n=1 in the "n ≥ 2" sense. Every finding derived from it is
  over-fit to this user's workflow until a second corpus exists.
- **These are 5 derived types, not types an LLM registered.** The extraction is hand-written against
  the known transcript schema. It proves the *data* supports N=409; it does not exercise the runtime
  type-registration path that the product is built around.
- **`tool-denial` is a machine-emitted event, not a judgement.** It is the easiest possible type to
  extract (a structured field). A type requiring interpretation was not tested for extraction
  feasibility.
- **The 809-file count is a snapshot.** The directory grows; the numbers are dated 2026-09-11.
