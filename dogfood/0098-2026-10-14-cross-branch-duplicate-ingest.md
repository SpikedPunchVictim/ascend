# 0098 — two branch-line ingests derived the same events, and a rebase put both in one tree

| | |
|---|---|
| **Bead** | `asc-jijx` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | the first `asc ingest git` run on the project's own store, whose index rebuild refused |
| **Entry type(s)** | verification_run, context_compaction, tool_denial (all derived) |
| **Severity** | P1 |
| **Status** | tree repaired by hand; prevention is two layers: `scripts/gate-duplicate-ids.mjs` (not yet wired into `scripts/gate.mjs`) and a reader that tolerates a clock-only pair |

## What was found

The project's own tracked store held 70 entry ids twice. `buildIndex` refuses a tree in which one
entry id appears twice with different content, so every write that has to rebuild the index failed
in this project, `asc ingest git` included. Every pair differed only in `recorded_at`, so each was
one event recorded on two days, not two accounts that disagree. The store's write-time duplicate
check never fired, because it can only see the lines of the tree it is run in.

## How it surfaced

Two `asc ingest claude-code` runs on two branch lines each derived the same events from the same
transcripts. A derived id is `session:key`, so both runs wrote the same ids, and neither could see the
other's lines, so `DuplicateEntryError` never fired. Both runs appended to the same JSONL file. A
GitButler rebase of the two lines combined the appends, inserting the second run's lines beside the
first's. The first moment both lines were in one tree was the commit that combined them, and nothing
checks a tree at that point.

Nobody was looking for it. It surfaced when `asc ingest git` was first run on the project's own store
and the index rebuild refused.

## The metric

Count of duplicated ids, from the bead's measurement of the tree holding the two sides (commits
`89c4577` and `da387e6`): 70 duplicated ids of 11,806 distinct ids. By type: 36 verification_run,
33 context_compaction, 1 tool_denial. Every pair differed only in `recorded_at`.

The repair kept the earlier-recorded line of each pair. After it, on a copy of the tree,
`asc index build` gave `11833 records in 4.90 s`.

The first `asc ingest git` on the real store wrote 382, with 0 present and 0 changed. 15 of 226
graded commits were flagged as top-tenth in size.

The new check, run with `node scripts/gate-duplicate-ids.mjs --rev <rev>`:

- `da387e6`: exit 1, `70 entry ids appear more than once in the .ascend/ tree this commit would hold:`
- the repaired tree as committed: exit 0, `duplicate ids: none in 23 record files`

## The pattern

A uniqueness rule enforced where one writer can see it, and violated where two writers meet. Each
ingest was correct alone. The defect exists only in the union, and a rebase or merge is the operation
that makes the union without running either writer.

## Why nothing else would have caught it

The write-time check cannot: it sees one tree. The reader refuses the combined tree, but only once
something reads it, and by then the duplicate is already committed. A reader that tolerated a
`recorded_at`-only difference was prototyped, and the owner chose it as the second layer: it leaves
the pair on disk, so it cannot be the only one. The commit-time check is the first place both lines are in one tree and a human is
still in the loop. Anything that breaks tests would also have been a reason to catch it earlier, and
nothing here did.

## Consequences and constraints

Entries are immutable, so the repair was a hand edit of the files before they reached a published
history, not a store operation. The check refuses a byte-identical pair too, though the reader
collapses those, because the owner asked for any id more than once, and it is deliberately independent of the store reader, which now tolerates a `recorded_at`-only pair; the reader is the backstop for one that gets past the gate (a rebase that bypasses hooks). It reads the index, and under
GitButler the index is the workspace commit's tree, so what it sees may not be what `but commit`
records; that is a property of every staged-tree step in the gate, and `dogfood/0095` is the related
finding about the gate not running for commits.

## Links

- Bead: `asc-jijx`
- Check: `scripts/gate-duplicate-ids.mjs`, mutation spec `scripts/mutations/duplicate-entry-ids.json`
