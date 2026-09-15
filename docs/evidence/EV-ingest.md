# EV-10: how should `asc ingest claude-code` decide what is already in the store?

**Question.** The command must be idempotent — re-running creates no duplicates (that is
`asc-ycl`'s ACCEPT). Four things had to be settled before it could be written, and each admitted a
cheap empirical test rather than an argument:

1. **Identity.** What makes two runs agree that an entry is the same event? A content hash, a
   timestamp window, or something the deriver already computes?
2. **Transaction shape.** One `withTransaction` for the whole run, or one per entry? A
   transaction per entry is the obvious way to isolate a failure; the question is what it costs.
3. **Buffering.** `withTransaction` takes a synchronous body and the corpus walk is async, so the
   entries must be buffered before the write. How big is that buffer in practice?
4. **Does the store need a new mechanism at all?** An idempotent insert — `ON CONFLICT DO
   NOTHING`, an upsert, an `INSERT OR IGNORE` — is the usual answer to "make this idempotent".

**Method.** `packages/store` and the real corpus, read-only on the transcripts.

- Identity was settled by reading the interface, not by measuring: `recordEntry` takes a
  **caller-supplied, required** `id` (`recorder.ts:237`), and a duplicate throws
  `DuplicateEntryError` whose message is "Use a new id." So the store already has a definition of
  "this is the same entry", and it is the caller's to choose. `DerivedEntry.key` is documented as
  *"what an ingest keys idempotency on"* and is `session + tool_use_id` or `session + record uuid`
  — stable across runs by construction.
- Transaction shape and buffer size were measured by `/tmp/ycl/tx.mjs`: derive once into a buffer,
  then replay **the identical buffered set** through both strategies on a fresh store each. Both
  arms therefore see the same 1,489 entries, so the comparison is not confounded by the corpus
  being live.
- The "does the store need a new mechanism" question was settled by searching the store for one:
  `grep -rn "ON CONFLICT\|INSERT OR" packages/store/src` finds `INSERT OR IGNORE` in exactly one
  place, the `meta` table (`db.ts:603`). There is no idempotent insert for entries.

**Measurement.** 2026-09-15, on `~/.claude/projects` (read-only).

| | autocommit (tx per entry) | one transaction |
|---|---|---|
| run 1, 1,488 entries | 678 ms | 460 ms |
| run 2, 1,489 entries | 356 ms | 240 ms |

Both arms created and stored every entry (`created 1489`, `stored 1489`), so the timing difference
is not a difference in work done. The absolute numbers move between runs — the second was on a
warmer machine — but the direction does not, which is the whole of what the decision needs.

Buffer size: 1,489 entries for the whole corpus on this machine. The count is one higher than the
1,488 recorded in `EV-derived.md` because **the corpus is live** — this session's own transcript is
in it. A derived count is a measurement with a date, never a constant.

**Decision.**

1. **Identity is the deriver's key**, not a hash of the entry's contents. A content hash would
   change the moment a rule changed — improving `runner` or `occurred_at` would orphan every entry
   the old rule wrote and re-ingest the whole corpus as new. Keying on the event means a rule
   change rewrites nothing and re-runs recognise everything.
2. **One transaction**, because it is both atomic and faster, on both runs. There is no trade to
   make, so the atomic choice costs nothing.
3. **Buffer, and say so.** 1,489 entries is nothing; a backfill across many projects is the case
   where it stops being free, and that limitation is written in the command's own docstring rather
   than left implicit.
4. **No store change.** The idempotency mechanism is a deterministic id plus catching
   `DuplicateEntryError` — the store's own definition of a duplicate, with no time-of-check gap, no
   new `INSERT` site (which `recorder.test.ts:855` would flag: the only module allowed to write
   `entries` is `recorder.ts`), and no `INSERT OR REPLACE` (the evasion the immutability triggers
   at `schema.ts:170` exist to close). The alternative — an upsert — would have to decide what to
   do with an entry that already exists and differs, and the answer would be "overwrite an
   immutable row", which is the one thing the store refuses.

**Confidence.** High on (2), (3) and (4): two runs of a direct A/B on the real corpus, and a
mechanism that was read rather than inferred. High on (1) as a *rule* — the id is a pure function
of the event, which is checkable by inspection.

The limitation, stated plainly: **the key is derived, so it is only as stable as the deriver.** The
`#2` disambiguation suffix is content-sensitive — if a still-growing transcript gains a record that
collides with an existing key, the suffix shifts and the run writes one more entry rather than
recognising it. Measured: 6 key collisions in the whole corpus, so the blast radius is a handful of
rows, and the command reports the count rather than absorbing it. A transcript that grows between
two ingests is not a controlled comparison, and this was not measured per-file; what is measured is
the collision count, not the re-ingest delta.

**What this overturned.** The instinct that idempotency needs a store-level mechanism — an upsert,
an `ON CONFLICT`, a dedupe table. It does not, because `id` was already the caller's to supply and
the PRIMARY KEY already refuses a repeat. The store needed no change at all, and the fix that
looked like it required a schema decision required only catching an exception the store already
throws.
