# 0044 — A build that replaces its file and not its WAL

| | |
|---|---|
| **Bead** | `asc-pwv7` |
| **Surfaced** | 2026-09-30 |
| **Surfaced by** | `asc store rewrite` → `asc index build` → `asc types brief`, driving the real binary on this repo's own `.ascend/` tree |
| **Entry type(s)** | none — found on the command line, not in a recorded entry |
| **Severity** | P1 |
| **Status** | fixed in the working tree, uncommitted as of 2026-09-30 |

## What was found

`asc index build` reports a fingerprint and a record count that the file it just wrote does not
contain. `buildIndex` writes a staging database, closes it — which checkpoints and removes the
**staging** handle's `-wal` — and renames the staging file over `index.db`. It never removes the
`-wal` and `-shm` belonging to the **previous** database. When a writer committed and then died
before its `close()` checkpointed, those frames are committed rather than rolled back, so the next
reader recovers them onto the freshly renamed file and restores the old `meta.index_fingerprint`.
The build exits 0 and prints the new fingerprint; the file holds the old one.

The absence is the finding: **nothing in the build's publication path considers the target file's
own `-wal`.** The module doc argues publication is atomic and cites *"no `-wal`/`-shm` residue"* as an
asserted property, but that reasoning covers the staging handle's close and stops there. The
assertion passes because the test builds into a fresh directory, where no prior `-wal` exists.

## How it surfaced

I was verifying `asc-i5tj.6` on this repo's own tree, which is the first time this tree has been
built and read in the same session as a live `asc ingest claude-code` hook. The sequence:

1. `asc store rewrite` rewrote `.ascend/types/0001.jsonl` (17 lines gained a `version`), so the tree
   fingerprint moved from `08b9c9ac…` to `7e6b236b…`.
2. `asc index build` reported **10455 records / `7e6b236b…`**, exit 0.
3. `asc types brief` refused: *"the index at …/.ascend/index.db is not current for this tree (the
   tree has changed since it was built) … Run `asc index build` to rebuild it."*

The named remedy did not work. I ran `asc index build` four more times; each printed `10455` and
`7e6b236b…`, each was followed by the same refusal. The first hypothesis was a fingerprint mismatch
in the rewrite; that was wrong, and what killed it was reading the fingerprint back out of the
database instead of trusting the build's own report — `stored 08b9c9ac…`, `tree 7e6b236b…`, and
`entry_types` 17 rows, which is the rewritten tree's count. The file was new and its contents were
old. That is what pointed at `-wal`.

`ls -la .ascend/` showed `index.db-wal` at 675,712 bytes stamped `00:44` and `ingest-cursor.json` at
`00:44` — a hook that committed and never checkpointed. Moving `index.db-wal` and `index.db-shm`
aside and rebuilding produced `stored == tree == 7e6b236b…` and every read succeeded.

**Nobody was looking for it.** I was verifying a wire-format change, and this arrived as an obstacle
to that verification. It is also not what the search would have found: the phrase "the tree has
changed since it was built" is accurate and complete as an error message, and it is *false* here.
The message names a remedy that is a no-op, which is the only reason it was noticed at all.

The first repro attempts failed, and the failures are what located the mechanism. Killing a writer
*mid-transaction* (`process.exit(0)` without `COMMIT`) does not reproduce it — uncommitted frames are
rolled back during recovery. The reproduction needs a **committed** transaction whose process died
before `close()`, which is exactly what a hook timeout produces.

## The metric

All lines below are verbatim output from the built binary and from `node:sqlite` reading the file
back, on a scratch project at `/tmp/asc-wal4` (2026-09-30).

Step 1 — build at tree A:

```
/private/tmp/asc-wal4/.ascend/index.db  5        5bd1a4ced4b411c3e7243eb432ba97…35176f40dce0ca564fe483e2900ae
```

Step 2 — a writer commits and dies before its close() checkpoint. Produced:

```
-rw-r--r--@ 1 spikedpunchvictim  wheel   32768 Sep 30 00:53 index.db-shm
-rw-r--r--@ 1 spikedpunchvictim  wheel    8272 Sep 30 00:53 index.db-wal
```

Step 3 — the tree moves (fingerprint `7f65a4b8f6003674…`).

Step 4 — `asc index build`:

```
/private/tmp/asc-wal4/.ascend/index.db  6        7f65a4b8f6003674f89c1a86dbe22b…f5435fc82f32d32c0ec03feb72eba
```

Immediately after, read back from the file:

```
  stored: deadbeefdeadbeef
  tree  : 7f65a4b8f6003674
```

Step 5 — a read:

```
Error: the index at /private/tmp/asc-wal4/.ascend/index.db is not current for
this tree (the tree has changed since it was built), and a read does not build
one: a rebuild is ~75 s at 63,870 entries and must be asked for. Run `asc index
build` to rebuild it from the JSONL tree.
```

Step 6 — the named remedy, run a second and third time. Both printed
`6  7f65a4b8f6003674f89c1a86dbe22b…`, and `stored` remained `deadbeefdeadbeef`. The loop does not
terminate.

Step 7 — `rm .ascend/index.db-wal .ascend/index.db-shm`, then rebuild:

```
  stored: 7f65a4b8f6003674
  tree  : 7f65a4b8f6003674
```

and reads succeed.

On the real tree, before the fix: `asc index build` reported `10455 / 7e6b236b…` while reads answered
`08b9c9ac…`; **0 of 5 read attempts succeeded**.

The failure is a refusal loop rather than a wrong answer, and the reason is measured rather than
argued: ascend's own write path stamps `meta.index_fingerprint` inside the same transaction as its
records (`replayInto`, `jsonl-index.ts`), so the replayed frame is always present and the fingerprint
is always *wrong* rather than *partly right*. A silent wrong answer needs a committed stale `-wal`
that dirtied data pages but not the meta page. **That variant is not measured**, and is not reachable
through ascend's own writers for the reason just given.

n = 1 corpus. The scratch repro is one machine and one project; the mechanism is in `node:sqlite`'s
WAL recovery rather than in this repo's data, but it has not been tried on a foreign store.

## The pattern

An invariant asserted at the level above the one that carries it. `buildIndex` reasons correctly
about the file it *creates* — staging close checkpoints, so the renamed file is self-contained — and
never about the file it *replaces*, whose sidecars it inherits by not deleting them. The doc's claim
is true of the staging handle and reads as if it were true of the publication.

The same shape as `dogfood/0039` (a build that reports success from half a store): both are a build
reporting a state it did not produce, and both were found by *reading back the thing the report was
about* rather than by reviewing the report. Here the read-back is one `SELECT` against `meta`.

## Why nothing else would have caught it

`jsonl-index.test.ts` asserts *"no `-wal`/`-shm` residue"* and it is right — the staging handle's
residue is gone, and the test builds into a fresh directory where no prior `-wal` exists to be
inherited. The assertion is not weak; it is scoped to the wrong file.

A code review would plausibly have caught it, and that should be said rather than claimed away:
`renameSync` replacing a SQLite database without touching its `-wal`/`-shm` is a recognized hazard,
and the fix is two lines next to the existing `rmSync` of the staging file. What a review would not
have supplied is the trigger — the *committed and uncheckpointed* writer — which is what makes the
symptom an unbreakable loop rather than a transient.

Nothing in the suite could have produced the trigger, because producing it means leaving a committed
`-wal` behind and the test helpers close everything they open.

## Consequences and constraints

- The tree was never at risk: only `index.db` and its sidecars are affected, and both are derived
  and rebuildable (`IndexStaleError` already says so).
- The remedy currently reachable by a stranger is `rm .ascend/index.db` plus the sidecars, then
  `asc index build`. The error message names only `asc index build`, and that was wrong only because
  the build was broken: with the build fixed, the named remedy is the working one, and the message
  needs no change. A reader who hits this on an older build still needs the `rm`, which is why the
  measurement above keeps that step.
- This arrived while verifying a wire-format change and is **not caused by it**: the diff to
  `packages/store/src/jsonl-index.ts` on that branch is a single 20-line hunk in `replayType`, and
  `buildIndex` is byte-identical to `HEAD`.
- No entries were recorded for this finding — it is a defect in the indexing path, not an entry in
  the store, so there is nothing here subject to `entries_are_immutable`.

## The fix

Two lines in `buildIndex`, immediately before the `renameSync` that publishes:

```ts
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
```

Placed after the store's `close()` and before the rename, so the window between deleting the old
sidecars and publishing the new file holds no database that either belongs to. The module doc's
*"Publication is atomic"* section was the false half of the finding and now says which handle its
`close()` accounts for.

**The test was watched to fail before it was watched to pass**, and the failure is the real-tree
symptom rather than a proxy:

```
 × a build is published whole, or not at all > replaces the write-ahead log a previous writer left, rather than replaying it
   → IndexStaleError: the index at …/index.db is not current for this tree (the tree has changed
     since it was built) … Run `asc index build` to rebuild it from the JSONL tree.
   Tests  1 failed | 29 passed (30)
```

The new test builds into a root that **already holds a `-wal`** — the state the existing *"leaves no
write-ahead log beside the index"* test cannot reach, because it builds where no prior `-wal` exists.
It commits through `node:sqlite`, saves the `-wal` and `-shm` out from under the closing handle, puts
them back, moves the tree, and rebuilds; the test then asserts on the **read** (`openIndex`) rather
than on the build's own report, which is the same read-back that located the defect.

**End to end, on the scratch store where it was first measured** (`/tmp/asc-wal4`), after the fix:

```
$ node .../bin.js index build
/private/tmp/asc-wal4/.ascend/index.db  6  7f65a4b8f6003674f89c1a86dbe22b…f5435fc82f32d32c0ec03feb72eba
build exit=0
  stored           : 7f65a4b8f6003674
  tree             : 7f65a4b8f6003674
  abandoned_writer : undefined
$ node .../bin.js types brief     # the read that refused 5 of 5 times before
read exit=0
```

Compare step 4–6 above: same command, same store, `stored: deadbeefdeadbeef` against `tree:
7f65a4b8f6003674`, three runs in a row. The marker row (`abandoned_writer`) is asserted absent, not
merely outvoted — a fingerprint that happened to agree would not show that the old pages were gone.

The gate after the change: **124 files / 2827 passed | 2 skipped**, `align` green, `verdict: green`.

## Links

- Bead: `asc-pwv7` (`discovered-from:asc-i5tj.6`)
- Related: `dogfood/0039` — a build that reports success from half a store
- The module doc whose claim stops one file short:
  `packages/store/src/jsonl-index.ts`, section *"Publication is atomic"*
