# 0114 — a refusal whose prescribed remedy cannot clear it

| | |
|---|---|
| **Bead** | `asc-qdkv` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | closing `asc-09wx.8.4`, whose acceptance criteria include that every event carries the new derive version — which raised the question of what the on-disk log holds |
| **Entry type(s)** | none — this is the event log, not an entry type |
| **Severity** | P2 |
| **Status** | open; the checkout's log is stale and the message still points at a re-run |

## What was found

`readEventLog` refuses a log line whose `derive_version` is not this build's, and the refusal ends
with an instruction:

> Re-run `asc ingest claude-code` to rewrite the log.

**That command cannot clear the refusal.** The writer appends and nothing under the tree ever removes
or truncates a stream file, so a re-run writes the new version's lines *beside* the stale ones and
the next read refuses at the same file and the same line it refused at before. The remedy is a no-op
that reports success.

The refusal itself is right and should stay: replaying a mixed history would move every count for a
reason no handler changed. The defect is the one sentence after it. What actually clears the state is
removing the stale stream files, and the message does not say so.

## How it surfaced

**Nobody was looking for it, and the question that found it was an acceptance criterion being taken
literally.** `.8.4` bumps the derive version, so "every event carries the new derive version" is a
sentence about the log, and the log was censused for the first time in this window. It came back with
three versions in one tree, which no reading of the design had predicted — and the two files that
settled the finding were **an 11/12 pair left by the *previous* bump**: proof, sitting in the real
tree, that the last re-derivation appended rather than rewrote and that the log has been unreadable
since `derive_version` moved 11 → 12.

The mechanism worth repeating: **the acceptance criteria of a bead are prose, so one of them can be
checked against the world instead of against the code.** Every other criterion in `.8.4` is a
statement about a deriver, and the tests cover those. This one names a quantity that exists on disk,
and nobody had ever counted it.

## The metric

The census, verbatim — one `node -e` script over `.ascend/events`, reading the **first line** of every
stream file (a stream is `<session>/<agent>/NNNN.jsonl`):

```
event files 6145
11: 2605
12: 3465
13: 75
```

Read as "does this file hold a line at version 13", the same tree gives **84** files — the 9-file
difference is files whose first line is older and whose later lines are not. And **19** files hold
more than one version at all, the pairs being `11/12` (from the previous bump) and `12/13` (from an
incremental ingest run earlier today):

```
files holding MORE THAN ONE version: 19
   .ascend/events/1ec16b2b-5b19-4c70-83c7-b6b65b1c1a38/main/0001.jsonl  11/12  4440
   .ascend/events/2996be0b-5228-4285-8f61-e81dbbf3e10b/main/0013.jsonl  12/13  5000
   ...
```

The harness, verbatim — a throwaway `node --input-type=module -e` against `packages/cli/dist`, which
is the shipped code, on a temp tree holding one version-12 line. It does exactly what the message
says and reads again:

```
this build derives 13
READ BEFORE: /tmp/logfix/.ascend/events/sess-1/main/0001.jsonl:1 was derived at version 12, and this build derives 13. Refused rather
READ AFTER RE-DERIVE: /tmp/logfix/.ascend/events/sess-1/main/0001.jsonl:1 was derived at version 12, and this build derives 13. Refused rather
```

Same file, same line, and the re-run's own line is beside the stale one:

```
{"kind":"prompt.submit",...,"derive_version":12,"text":"old"}
{"kind":"prompt.submit",...,"derive_version":13,"text":"new"}
```

The full refusal, verbatim, so the sentence this record is about is not a paraphrase:

```
/tmp/logfix/.ascend/events/sess-1/main/0001.jsonl:1 was derived at version 12, and this build derives 13. Refused rather than replayed: a count moves when the derive version moves, with no handler changed. Re-run `asc ingest claude-code` to rewrite the log.
```

And the reading that makes "removing the stale files" an unsafe half-fix, verbatim — an empty tree
with no log at all against the same shipped reader:

```
absent log -> {"events":[],"files":0,"unreadable":[]}
```

**The search receipt for the absence claim.** The module that owns the log imports:

```
33:import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
```

`packages/cli/src/event-log.ts` — `appendFileSync`, `mkdirSync`, `readFileSync`, `readdirSync`,
`statSync`. No `unlinkSync`, no `rmSync`, no `rmdirSync`, no `truncate`, no `writeFileSync`: the log's
own module has no capability to delete or truncate anything. Grepping the whole of
`packages/{cli,adapter-claude-code,core,store}/src` for `unlink|rmSync|rmdir` returns no caller that
names the events tree either. Searched 2026-10-15 in this checkout at the working-tree state of
`asc-09wx.8.4`. No file was written by any of the sweeps above.

Both groups are whole-tree counts over all 6,145 files, so neither is an anecdote under `MIN_N`.

## The pattern

**An error message is a claim about the world, and it is the one claim in the codebase that no test
executes.** The refusal is asserted (`event-log.test.ts` drives a line at another derive version and
checks it is refused naming both versions); the *remedy inside it* is prose that was never run. The
class is broader than this instance: any message that tells a reader to run a command to reach a
state is a two-step mechanism whose second step is untested, and the failure mode is the worst kind —
the reader does what they were told, the tool reports success, and the identical error returns with
nothing changed. It reads exactly like a bug in the reader.

Its sibling at the other end of the same file is `dogfood/0111`, where a docblock's supporting
evidence had expired. Both are prose in a place nothing executes; this one is worse, because a
docblock is read once by a maintainer and a refusal is read every time by whoever is stuck.

## Why nothing else would have caught it

- **`event-log.test.ts` cannot**, and the reason is structural rather than an oversight: it drives a
  temp tree with a hand-written stale line, asserts the refusal, and never asks what the reader is
  supposed to do next. Asserting the text of the remedy would be asserting a string, not a behaviour.
- **No test runs the two steps together.** The property is a *composition* — refuse, re-derive, read
  again — and each half is covered on its own.
- **`normalize-real-corpus.test.ts`** reads transcripts, not the log, so no corpus test touches it.
- **The gate cannot see it.** The full suite is green on a tree whose log is unreadable, which is the
  point: nothing in this repo reads `.ascend/events` except the two commands a person runs.
- **Using ascend is what found it**, and the trigger was an acceptance criterion rather than a
  suspicion — the same shape as `dogfood/0113` in this window and `0110` before it.

## Consequences and constraints

**The checkout's log is stale, and it has been since the previous bump.** 2,605 files at version 11
and 3,465 at 12 mean `asc handlers check --source log` and `asc ingest file-changed` have been
refusing in this tree since `EVENT_DERIVE_VERSION` moved 11 → 12, not merely since this window's bump
to 13. `asc-09wx.8.4` does not create the state; it adds a version to it.

**The acceptance criterion is satisfied where it can be, and that half is pinned.** Every event the
deriver *emits* carries the new version — `normalize.test.ts` pins `EVENT_DERIVE_VERSION` as a literal
and `normalize-real-corpus.test.ts` checks the real corpus's events — but the **on-disk log at
`.ascend/events` is not at 13 and re-deriving does not put it there.** That is this record, not a
`.8.4` gap.

**Re-deriving without clearing first is worse than doing nothing.** It appends a second full
generation beside the first and leaves the log unreadable either way, at roughly double the bytes.

**And clearing without re-deriving is worse still, which is the constraint that shapes the fix.**
`readEventLog` over an absent events tree returns `{ events: [], files: 0 }` rather than refusing —
so an empty log is a **silent zero**: every handler count falls to zero and no read says why. The
loud refusal is the safe state, and any fix that removes stale files must re-derive in the same step,
never leave the tree without one. `.ascend-archived/` is the repo's convention for moving a
generation aside rather than deleting it (`.gitignore` names it), and the log is gitignored derived
data.

## Links

- Bead: `asc-qdkv`
- The other end of the same file, prose nothing executes: `dogfood/0111`
- The same window's class, a claim about the world checked against the world: `dogfood/0113`
- The bump that raised the question: `asc-09wx.8.4`
- The log's writer and reader: `packages/cli/src/event-log.ts`
