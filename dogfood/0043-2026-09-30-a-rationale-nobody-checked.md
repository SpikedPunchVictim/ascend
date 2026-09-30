# 0043 — a rationale nobody checked

| | |
|---|---|
| **Bead** | `asc-sh2q` |
| **Surfaced** | 2026-09-30 |
| **Surfaced by** | reading `schema.ts` while scoping `asc-i5tj.4.3`, and then testing the comment's own claim instead of trusting it |
| **Entry type(s)** | none — the finding is in a source doc comment, not in a recorded entry |
| **Severity** | P2 — no wrong answer was ever produced; the cost was a dead table kept for a year-shaped reason, and a rationale that would have survived any amount of review |
| **Status** | fixed in the working tree, uncommitted as of 2026-09-30 |

## What was found

`schema.ts` carried a doc comment above the `ingest_cursor` DDL explaining why the table was **kept**
rather than removed with the cursor's move to a JSON sidecar. Its stated reason was that
`migrateStoreToTree`'s report "has to name" the table — the corpus format cannot carry the cursor, so
the table appears in the report's `dropped` list with its row count, and *"dropping the table would
silence exactly the gap the operator needs to be told about."*

**That is false, and it is false about a module the comment names.** `droppedTables`
(`migrate.ts:266-297`) derives the report's list from `sqlite_master` — the tables that are *present
in the database being migrated* — not from `MIGRATIONS`. Removing migration 4 stops new indexes from
being born with the table; it cannot make an existing legacy store's rows invisible to a report that
enumerates that store's own tables.

So a live, never-read table sat in every derived index, licensed by a sentence that a one-line read
of `migrate.ts` would have refuted.

## How it surfaced

`asc-i5tj.4.3` was scoped from prose: the bead and `IMPLEMENTATION_PLAN.md` both described the
remaining work, and one of the bead's loose ends was this table — `dogfood/0042` had already called
it *"cosmetic."* The next question was whether it could simply be deleted, and the comment above the
DDL answered "no, and here is why," in the same confident register as the surrounding text.

The thing that turned it into a finding was **not** believing it. `grep` for `droppedTables` and one
read of the function was enough to see that the reason given belongs to a different mechanism than
the one it describes, and driving the real binary settled it: a legacy store built with 1,070
`ingest_cursor` rows, `asc init`, and the report still says

```
Warning: the migration could not carry the ingest_cursor table: 1070 row(s).
```

**Nobody was looking for this.** The task was to delete a table, and the finding is that the reason
the table could not be deleted — the reason that had kept it there — was never true.

## The metric

One claim, named in advance as the thing to falsify, measured on the real binary. From the run above,
verbatim:

```
Warning: the migration could not carry the ingest_cursor table: 1070 row(s). A
record tree holds types, entries, schemes and annotations, and this table is
none of them. The archived store at .../.ascend-archived/2026-09-30T05-47-06-960Z
still has them.
```

The table was built for the fixture with 1,070 rows, written by a loop (not hand-counted), so the
report's number matching it is the check that the report is reading the archived database rather than
a constant.

**This is an anecdote, and it is under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`): one
comment, checked once, false once.** It is not an estimate of how often ascend's comments are wrong.
It is the reason to go and find out.

## The pattern

**A record that describes code is not checked against the code, and each hop through which it travels
adds confidence without adding evidence.** The false sentence began as a comment, was copied into a
`decision` entry's reasoning, into `IMPLEMENTATION_PLAN.md`, and into the bead — where it became, not
a claim about a comment, but *scope*: "the table is kept, and it goes with the rest of the SQLite
store in E12.4d." By the time it reached the plan it read as a settled fact about a planned future,
and the register it was written in is what made it survive three readings.

This is the class `dogfood/0038` and `dogfood/0039` sit in from the other side: 0038 is a retirement
the rebuild erased, 0039 a build that reported success from half a store. Both are the system
reporting a state it was not in. This one is the quieter member — no instrument reported anything
wrong, because **no instrument reads comments**, and the cost was only paid in a table that could
never hold a row.

The specific failure of reasoning is worth naming separately, because it is mechanical: **the comment
attributed a property to `migrateStoreToTree` that belongs to `sqlite_master`.** Ascend has an
`align` rule set for dependency direction and import cycles, and this was neither — it was a
directional claim *between two modules* with nothing to check it.

## Why nothing else would have caught it

**The behavior was already tested, and the test passed the whole time.** `migrate.test.ts`'s
*"reports the tables no corpus line can carry, and not the derived ones"* asserts the exact report
line — `{ table: 'ingest_cursor', rows: 1, keys: [] }` — and it was green. So the code was right and
only the sentence *about* the code was wrong, which is precisely the shape a test suite cannot
catch: a test constrains behavior, and a comment is not behavior.

A review would plausibly have caught it — this is a one-function read — which is an argument for
reading a rationale before acting on it rather than an argument for a new test. It is also why the
finding is worth recording at the P2 it is rather than higher: the class is real, and this instance
cost a table, not an answer.

What *would* have caught it, and did: **treating the comment as a hypothesis with a run attached.**
The falsification is three commands — build a legacy store, `asc init`, read the warning — and it is
now what `asc-i5tj.4.3`'s verification records, so the mechanism that found it is written down rather
than left in a session.

## Consequences and constraints

- **No cleanup, because there is nothing to clean.** The report was never wrong, and the archived
  stores hold the rows either way. The only artifact of the false claim was the table, which is now
  gone (`asc-i5tj.4.3`: migration 4 deleted, no version number moved).
- **The comment is replaced, not merely deleted.** `schema.ts` now says what the deletion costs and
  what it does *not* silence, with the mechanism named, so the next reader has something checkable
  rather than something confident.
- **The generalizable constraint, and the reason this is not a one-off:** ascend cannot apply
  `entries_are_immutable`'s discipline to its own prose. A `decision` entry is immutable and dated,
  which means a wrong rationale in one stays wrong and stays citable — the plan cited entry
  `61a1e2e9` for the reasoning this record refutes. **A correction has to be a new record that names
  the old one**, which is what this file does and what the `IMPLEMENTATION_PLAN.md` edit now does
  inline.

## Links

- Bead: `asc-sh2q`
- The work that surfaced it: `asc-i5tj.4.3` (delete migration 4), `asc-i5tj.14` (the cursor's home)
- Prior records in this class: `dogfood/0038`, `dogfood/0039`
- The record that called the table cosmetic: `dogfood/0042`
- The `decision` entry whose reasoning carried the claim: `61a1e2e9`
