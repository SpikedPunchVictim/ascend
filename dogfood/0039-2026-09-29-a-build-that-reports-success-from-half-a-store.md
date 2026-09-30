# 0039 — a build that reports success from half a store

| | |
|---|---|
| **Bead** | `asc-i5tj.15` — "a legacy store beside the tree must be refused, not built over" |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | sizing the local cutover: counting what the tree held and what the store held, then asking what `asc index build` would have said about the difference |
| **Entry type(s)** | none — the finding is in the build path, not in a recorded entry |
| **Severity** | P1 — the project's severity-zero class: the operation whose whole job is "produce the store from the lines" produced a store from *some* of them, and reported success |
| **Status** | fixed in-flight, uncommitted as of 2026-09-29 |

## What was found

`asc index build` reads the **tree** and only the tree. During a migration there is a window — the
whole of E12.4's cutover, which this repository is currently inside — where a legacy `ascend.db` and a
record tree sit in the same `.ascend/`, and the tree holds **part** of the corpus. In that window a
build publishes an index of the part, prints `records <n>`, and exits 0.

Nothing downstream can notice. The fingerprint is taken over the tree, so the index IS current for
what it was built from, and a read has no reason to look for a file the layout says is retired. There
is no second line of defence, because there is no longer anything suspicious to see: `asc types list`
prints six rows with counts that look like a corpus, not like an error.

That is the whole danger, and it is why the answer had to be a refusal rather than a warning: the
output that would have warned someone is **indistinguishable from a healthy one**.

## How it surfaced

Nobody was looking for it. The plan's exploration had already recorded that this repository is
unmigrated (E12.4b3, finding 8: `.ascend/` holds `ascend.db` and nothing else, and the SessionStart
hook runs `asc ingest claude-code` at every session start). The step that produced the defect as a
*finding* was mechanical: counting lines in the tree and rows in the store, to know what the cutover
would have to carry. The two numbers were thousands apart, and the obvious next question — *what does
a build say about that?* — had an answer nobody wanted.

It was then reproduced deliberately, twice, by removing the one guard call and driving the real
binary. Both transcripts are below, verbatim.

## The metric

**No tree at all, guard removed.** A directory holding only a copy of this project's real store —
`/tmp/f2legacy/.ascend/ascend.db`, 23,273,472 bytes, `select count(*) from entries` = `6473`:

```
$ node packages/cli/dist/bin.js index build          # run in /tmp/f2legacy
index                                   records  fingerprint
--------------------------------------  -------  ------------------------------------------------------------
/private/tmp/f2legacy/.ascend/index.db  0        e3b0c44298fc1c149afbf4c8996fb9…e41e4649b934ca495991b7852b855

exit 0
```

`e3b0c442…` is the SHA-256 of the empty string — the fingerprint of an empty tree, published as a
successful build. The reads that follow are empty and also exit 0, measured with the exit status
taken from the command itself rather than from a pipeline:

```
$ node packages/cli/dist/bin.js types brief      # brief exit=0  stdout bytes=0
$ node packages/cli/dist/bin.js types list       # list exit=0   stdout bytes=114, header only
```

`asc types brief` is the SessionStart hook's own command, and it exits **0 having printed nothing** —
the hook loop reports success on a project whose entire corpus is absent.

**Half a store, guard removed.** A copy of this project's own `.ascend/` — a 2,917-line tree beside
the same 6,473-entry store:

```
$ node packages/cli/dist/bin.js index build          # run in a copy of this repo's .ascend/
index                                 records  fingerprint
------------------------------------  -------  ------------------------------------------------------------
/private/tmp/f2half/.ascend/index.db  2917     df4a310c117e44a6e24e6c5856b118…5dff0848410d795594f2060f55000

exit 0
```

```
$ node packages/cli/dist/bin.js types list
name                version  properties  entries  review_after  status
------------------  -------  ----------  -------  ------------  ------
context_compaction  1        9           740                    active
review_finding      1        13          83                     active
skill_activation    1        5           120                    active
tool_denial         1        6           617                    active
user_correction     1        4           19                     active
verification_run    1        7           1332                   active
```

**3,562 entries in the store are absent from that index, and the output reads as a healthy corpus.**
The arithmetic, since the two counts are taken differently: the tree's 2,917 lines are 2,911 entry
lines plus the 6 starter type lines, against `select count(*) from entries` = `6473` in the store.
That is the measurement this record exists for. Here the read side is not empty either — the same
command that prints nothing over an empty tree prints a plausible brief of 558 bytes and exits 0
(`types brief exit=0`) — so the half-flipped state is the *quieter* of the two: a project mid-migration
briefs its sessions from 2,911 of its 6,473 entries with no signal at all. The first sighting, before
these fixtures existed, was the same shape on a different store: a directory holding a 3,585-entry
`ascend.db` and no tree at all built to `0 records`, exit 0 (recorded at the time in `buildIndex`'s
doc).

**With the guard in place**, the same directory:

```
$ node packages/cli/dist/bin.js index build
Error: there is a store at /private/tmp/f2half/.ascend/ascend.db beside the
record tree at /private/tmp/f2half/.ascend, and ascend will not build an index
from one of them while the other is there: a build reads the tree, so it would
index what the tree holds and leave every record in ascend.db out of it,
reporting success throughout. Run `asc init` to migrate the store into the tree
-- it moves the file to .ascend-archived/, it never deletes it -- or move
ascend.db aside yourself, if it holds nothing you need. If the tree there
already holds lines, `asc init` refuses and names the next step: move the tree
aside, then run it again.

exit 1
```

and in the fresh `f2legacy` fixture, `ls .ascend/` afterwards listed `ascend.db` **alone** — no
`index.db`, no staging file — because the refusal runs before the `.tmp` removal and the
`renameSync`. The last sentence of the
message was added *after* driving the remedy it names, in the half-flipped copy:

```
$ node packages/cli/dist/bin.js init
Error: /private/tmp/f2half/.ascend already holds a record tree (2917 line(s)).
This migration writes a tree and never appends to one, because a writer that
appended would interleave two corpora into a single tree with nothing reporting
the join. Move the tree aside and run this again, or leave the store as it is.

exit 1
```

Two correct refusals in a row, no data lost — the remedy is sound and takes two hops, which is not
something a person should have to learn from an error message when a sentence can say it.

**Load-bearing, checked by mutation.** Deleting the one `assertNoLegacyStore(root);` call makes 4
tests fail — 3 in `packages/store/test/jsonl-index.test.ts`, 1 in `packages/cli/test/store-flip-cli.test.ts`
— and the suite is green with the call in place.

## The pattern

**A derived artifact built from part of its source reports success.** A build's contract is "produce
the store from the lines", and it cannot tell a complete tree from a partial one, so the only place
the difference can be caught is *before* the read, by asking whether anything else in the directory
also claims to be the store.

The generalizable instrument: when a migration moves a source of truth, the new reader does not
degrade — it **answers confidently about whatever it can see**. Anything that reports a count derived
from the new source will report a smaller one and look fine, which is why this class is severity-zero
rather than merely serious: the false signal is not louder or quieter than the true one, it is the
same signal.

Its companion, from the owner's ruling for this epic — *either/or, never both; JSONL is the store;
SQLite does not coexist as a second source of truth*: **the refusal declines to answer a question it
cannot answer.** A build that finds both could rank them (the tree is newer, the store is bigger,
the store has the entries) and every ranking would be a decision made silently on someone's behalf
about where 3,556 records live. Refusing is the only answer that cannot lose them.

## Why nothing else would have caught it

A review plausibly could have, by asking "what does a build do if the tree is partial?" — and that is
the honest answer. The suite could not: every flip test builds from a complete tree, and
`store-flip-cli.test.ts`'s fresh-clone case asserts the *opposite* behaviour deliberately (an empty
tree builds, exit 0 — which is correct, and is what made the partial case look identical). The
absence of the guard was not visible in any test, because no fixture ever put a store and a tree in
the same directory.

What made it findable was arithmetic, not analysis: two counts that should have been equal, taken
before anything was changed. Nobody was looking for a build defect; they were looking for the size of
a migration.

## Consequences and constraints

The guard is a **path check**, not a store check: any file named `ascend.db` in `.ascend/` is refused,
including one that is not a store, because opening it would cost every build in a migrated project a
database open to re-establish a fact its absence already carries. The message's second half covers
that case ("move it aside yourself, if it holds nothing you need").

The guard fires on the **build** path. It does not fire on a read, because a read has no reason to
open the legacy file — and that is a limitation worth stating plainly: a project already holding a
falsely-built index, with a store beside it, will keep being read from the index until someone runs
`asc index build` and gets the refusal. The index is derived and deletable, so the state is
recoverable, and the cutover is where it is meant to be met.

The remedy is a refusal, so it cannot repair anything on its own. `asc-i5tj.4.4` carries the actual
cutover of this repository: archive the partial tree, then `asc init`, so all 6,473 entries migrate
with their legacy ids.

## Links

- Bead: `asc-i5tj.15`; parent epic `asc-i5tj` (E12.4); the cutover is `asc-i5tj.4.4`
- Plan: `IMPLEMENTATION_PLAN.md` E12.4b3 (finding 8) and the Stage F/G staging
- Related: `dogfood/0038` (a retirement the rebuild erased) — found in the same session, from the
  other side of the same seam: there the rebuild *lost* a fact, here it *omits* a corpus
- Source: `packages/store/src/jsonl-index.ts` (`assertNoLegacyStore`, `buildIndex`),
  `packages/cli/src/commands/index/build.ts`
- Entries recorded at the time: none — surfaced from counting, not from stored entries
