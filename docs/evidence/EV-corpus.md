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

---

# Amendment, 2026-09-15: re-measured with the production reader, and one spike finding overturned

The spike's numbers above were produced by `spike/lib/reader.mjs`, a throwaway. The production reader
(`packages/adapter-claude-code`, built for `asc-ct3`) was driven against the same directory on
2026-09-15, and the corpus had grown. Both sets are real; they measure different code on different
days, so the spike's table is left standing rather than edited.

| | spike 2026-09-11 | production reader 2026-09-15 |
|---|---|---|
| transcript files | 809 | **843** |
| lines / records | 388,054 | **429,783** |
| bytes | 1.14 GB | **1,275,740,293 (1.188 GiB)** |
| wall clock | 11.2 s | **6.22 s** |
| peak RSS | 213 MB | **234.0 MB** (baseline 46.3 MB; delta 187.6 MB = **15.4 %** of input) |
| failures / skipped | — | **0 / 0** |
| distinct projects | — | **15** |

Records by file kind: session **307,300**, subagent **122,479**. The streaming design still holds: the
only thing that grows with the corpus is the list of 843 paths.

## What this overturned

**`node:readline` is not a JSONL reader, and the first production version was built on it.** readline
treats **U+2028 (LINE SEPARATOR)** and **U+2029 (PARAGRAPH SEPARATOR)** as line terminators, in
addition to `\n` and `\r`. Both are *legal unescaped* inside a JSON string, so a transcript record
whose text contains one is a valid JSONL line that readline splits in two. The fragments are not
valid JSON, and a reader built on readline reports them as **damage**.

The first end-to-end sweep of the real corpus reported **98 malformed lines and 0 failures**, and the
98 were an artifact of the reader, not of the data.

The decisive control compared the two splitters **on identical bytes**, in one process, across all
843 files:

| | readline | split on `\n` only |
|---|---|---|
| lines delivered | 429,866 | **429,783** |
| malformed | **117** | **0** |
| files where the two disagree | **9** | — |

readline invented exactly **83** line breaks, and the corpus contains exactly **83** occurrences of
U+2028 + U+2029 (50 + 33). The mechanism is confirmed numerically, not inferred: `205 LF + 13 U+2028
+ 7 U+2029 = 225`, and readline yielded 225 lines for that file. The bug was silent and
one-directional — the reader *under*-counted records and *over*-reported corruption, so any derived
type would have been measured against a corpus that had quietly lost rows. It was caught by driving
the real data and not by any fixture: the fixture corpus contained neither character.

The fix splits on `\n` alone, carrying a partial line across chunk boundaries and decoding with a
`StringDecoder` so a multi-byte character cut in half by a chunk boundary is reassembled.
`reader-real-corpus.test.ts` now checks a **conservation law** against the bytes on disk — lines
delivered == `0x0a` count (+1 when the file does not end in a terminator) — which readline violates
by 83 and a `\n`-splitter satisfies by construction. Mutation-tested: the readline behaviour, a
dropped carry, a per-chunk decode, and a phantom line at EOF are each killed by at least one test.

## A second spike error, corrected

`spike/lib/reader.mjs` counted bytes as `line.length + 1`. `String.length` is UTF-16 **code units**,
not bytes, so that undercounts every non-ASCII line and omits the final line's terminator. The
production reader counts off the byte stream. Measured on a 33-byte file containing one 3-byte
character, the spike's arithmetic reports **31**.

## Unchanged

- **The spike's `projectOf` regex was correct** and the production reader reproduces its answer: the
  project is the segment *after* the root, not `basename(dirname(path))`. The latter would have
  returned `subagents` as the project for the **792 of 843** transcripts that live under a
  `subagents/` directory, silently collapsing 94 % of the corpus into one group. Recorded because it
  was caught by measuring the corpus shape and would otherwise have shipped.
- n ≥ 2 still does not hold. One corpus, one user, one machine.
