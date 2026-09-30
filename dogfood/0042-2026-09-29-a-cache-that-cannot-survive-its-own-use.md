# 0042 — a cache that cannot survive its own use

| | |
|---|---|
| **Bead** | `asc-n4eg` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | reading `.ascend/ingest-cursor.json` while looking for something else — the vestigial `ingest_cursor` table in the derived index |
| **Entry type(s)** | none — the finding is in `asc ingest claude-code`'s cursor write, not in a recorded entry |
| **Severity** | P2 — a wrong answer is impossible; the cost is time, paid at every SessionStart, and the mechanism's purpose fails on every other run |
| **Status** | fixed in the working tree, uncommitted as of 2026-09-29 |

## What was found

`asc ingest claude-code` replaces `.ascend/ingest-cursor.json` with the files **it** read on that run,
discarding every row it had just used to decide what to skip. The cursor therefore collapses to the
size of one run's work, and the next run has nothing to skip against.

The SQL version could not do this, and that is the whole finding. `recordIngestCursor` was one
statement per file:

```sql
INSERT INTO ingest_cursor (path, mtime_ms, size, ingested_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size,
    ingested_at = excluded.ingested_at
```

A row for a file this run did not mention was **untouched**. `asc-i5tj.14` moved the cursor out of
the database and into a file beside the tree, which is right for the reasons that bead gives — and
`writeIngestCursor` is documented as *"Replace the cursor with `cursor`"*, which is right for a file.
Per-row upsert became whole-file replace, and the caller was left passing only `readFiles` ("every
file this sweep actually streamed to completion"). Nothing in the new contract says the write must
also carry the rows it relied on, and the caller has no way to learn that from the signature.

## How it surfaced

`asc-i5tj.4.3`'s remaining work is the retirement of SQLite as a source of truth, and one of its
loose ends is cosmetic: the derived `index.db` still creates an `ingest_cursor` table, which now
holds **0** rows while the real cursor lives in the sidecar — a table that answers and is empty. So
the next file read was the sidecar, to see what the real cursor held.

It held **one** row, for this session's own transcript. `~/.claude/projects` holds 1,080 `.jsonl`
files.

**Nobody was looking for this.** It was not a hypothesis being tested, not a pre-registered
prediction, and not the thing the file was opened for — the vestigial table was. The finding arrived
because the sidecar was read as an artifact rather than as a code path, and the artifact disagreed
with what the code's own documentation says it should contain.

## The metric

Two consecutive real runs, before the fix — the collapse and the recovery cost, both verbatim:

```
cursor rows BEFORE:  1
$ asc ingest claude-code            exit=0  elapsed=16s
cursor rows AFTER:   1080

$ asc ingest claude-code            exit=0  elapsed=1s
Warning: 1079 transcript file(s) unchanged since the last ingest (mtime and size
both matched the stored cursor) and were skipped without being opened.
cursor rows AFTER:   1
```

And the same two runs after the fix, on the same corpus:

```
cursor rows now: 1
=== run 1: exit=0 elapsed=17s      rows after run 1: 1080
=== run 2: exit=0 elapsed=0s       rows after run 2: 1080
```

`grep -c "unchanged since the last ingest"` on the second run's stderr: **1**. The skip still happens
— it now survives the run that made it, so the run after that skips too instead of re-reading 1,080
files. Before the fix every other run was a full read; the corpus is 1,080 files today and grows.

**Load-bearing, checked by mutation:** replacing `[...carriedFiles, ...readFiles…]` with
`[...readFiles…]` — the original expression — fails the new test with `- [] / + Array []` at the
`cursorRows(dir)` equality. Restored, the suite is green (36 tests).

**Why no existing test caught it, which is the sharper half.** `ingest.test.ts`'s cursor block is
thorough — skip-on-unchanged, re-read-the-changed-file, `--dry-run` cannot poison it, `--full`
ignores it, deleting it reproduces a full read — and every one of those runs against a corpus of
**one or two files**. With one file, a run that skips everything writes a cursor with the same
number of rows whether it keeps them or throws them away. The fixture could not distinguish the bug
from the fix, so the block was green through the whole regression.

## The pattern

**A replace is not an upsert, and a caller that does not know the difference will not find out from
the signature.** The move from SQL rows to a file preserved the *content* of the cursor and silently
changed its *semantics* — from "here are updates" to "here is everything" — and both spellings take
the same argument of the same type. This is a class the repository has hit before in another form:
`dogfood/0032` is a `merge=union` merge that duplicates a shared record, which is the same
"the storage layer's guarantees are not the ones you assumed" shape.

The companion lesson is about where a cache's contract lives. `writeIngestCursor`'s doc spends a
paragraph on what a caller must **not** pass (never a file that was not streamed to completion) and
none on what it must pass, because the destructive obligation was invisible from the writing side.
A destructive write needs its doc written from the **reader's** side: what must still be true in this
file after I am done?

## Why nothing else would have caught it

A test could have, and the missing one is one line of fixture: a corpus with a file that is skipped
and a file that is not. The suite had the skip test and the re-read test, both on a one-file fixture,
so neither could tell a merge from a replace.

A review plausibly could have — "what does `writeIngestCursor` do to rows the caller did not pass?"
is one question about a function whose name says *write* and whose doc says *replace*.

What actually caught it was reading the artifact: a cache is one of the few places where the state of
the system is visible as a file, and the file was three orders of magnitude smaller than the thing it
describes.

## Consequences and constraints

The fix carries `carriedFiles` (the rows the run is about to rely on) into the write ahead of this
run's own rows, so a path present in both keeps the newer stat — `writeIngestCursor` already keeps
the last row it is given for a path. `carriedFiles` is empty exactly when `knownFiles` is, which is a
full read: `--full`, or a new handler hash forcing one. Those runs read everything, so their
`readFiles` already **is** the whole cursor and appending would be wrong.

A row for a file that no longer exists is carried forward. That matches the old SQL behaviour — a
deleted file's row was equally untouched — and it is harmless, because the caller only consults a row
for a path it found by stat. Stated rather than fixed: nothing prunes the cursor.

The measurement is one corpus, on one machine, before and after. `docs/evidence/EV-34` and the
module's own doc quote a larger one (977 files, 1.63 GiB, 7.965 s), which is the number that says how
much the alternation cost.

## Links

- Bead: `asc-n4eg`; the bead whose fix introduced it: `asc-i5tj.14` (the cursor's home), commit `61b90fe`
- Related: `dogfood/0039` — a build that reported success from half a store, found the same way, by
  reading a number that did not describe the thing it claimed to; `dogfood/0032` — a `merge=union`
  merge that duplicates a shared record, the same "the layer's guarantee is not the one you assumed"
- Source: `packages/cli/src/commands/ingest/claude-code.ts` (`carriedFiles`, the cursor write),
  `packages/store/src/ingest-cursor.ts` (`writeIngestCursor`), `packages/cli/test/ingest.test.ts`
- Entries recorded at the time: none — surfaced by reading a file on disk
