# 0021 — a `--full` re-ingest refuses every row the store holds redacted, and blames a transcript edit

| | |
|---|---|
| **Bead** | `asc-j0vh` |
| **Surfaced** | 2026-09-27 |
| **Surfaced by** | `asc ingest claude-code --full`, run to re-derive `skill_activation` under rule 2 (`asc-gtnu.17`) |
| **Entry type(s)** | `tool_denial`, `context_compaction`, `user_correction` (derived) |
| **Severity** | P3 |
| **Status** | open |

## What was found

The live store holds derived rows whose `cwd` and properties carry redacted labels (`<project-G>`,
`<org-B>`, `<user>`). The transcripts they were derived from carry the real values. So a full
re-derive produces a different entry for the same id, and ingest refuses it. The refusal is
correct, because entries are immutable. The explanation it prints is wrong for this population:
"most often a transcript edited after it was ingested". No transcript was edited. As things
stand, a `--full` re-ingest can never reconcile these rows, and every one of them prints a warning
that sends the reader after the wrong cause.

## How it surfaced

`asc-gtnu.17` needed a `--full` re-ingest, because a derivation-rule change re-keys only the files
that are read, and the cursor skips unchanged ones. The type under change wrote cleanly. Three
types it did not touch printed 994 refusals, and one refused row inspected by hand turned out to
hold a redacted `cwd`. Nobody was looking for it: the re-ingest was a step in someone else's fix.

## The metric

The ingest summary, exact (the lines for the three types):

```
entry   tool_denial         67 already present, 515 collided
entry   context_compaction  196 already present, 465 collided
entry   user_correction     4 already present, 14 collided
```

The store, through `asc query`:

```
n     redacted
----  --------
4675  1346
```

The refused ids were joined to that flag. They were taken from `asc ingest claude-code --full
--dry-run`, which writes nothing:

```
refused ids 994 | redacted among them 994 | not in store 0
```

**994 of 994 refused rows are redacted rows.** 352 redacted rows were not refused. Most likely
their transcripts are gone, so nothing re-derives them, but that is not measured here.

**Not measured:** how redacted content got into the store. `asc export --redact` redacts a stream
that leaves the machine, and nothing measured here shows a path from that back into `.ascend/`.

## The pattern

An error message that names the *common* cause of a condition, written before a second cause
existed. The check is right and its diagnosis is stale. `dogfood/0018` is the same family: a
report whose wording outlived the cases it described.

## Why nothing else would have caught it

Only a `--full` re-derive over a store that already holds redacted rows can produce it. Fixtures
never hold redacted rows, and the everyday ingest skips unchanged files by cursor, so these rows
are never re-read.

## Consequences and constraints

Rows are immutable, so there are two options. One is to name the case at write time: compare
modulo redaction and say "stored redacted". The other is an invalidation annotation. Neither is a
cleanup. Until one of them lands, a `--full` re-ingest prints 994 misleading warnings.

## Links

- Bead: `asc-j0vh`
- Found during: `asc-gtnu.17` (`dogfood/0020`)
