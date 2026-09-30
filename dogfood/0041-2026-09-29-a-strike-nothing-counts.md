# 0041 — a strike nothing counts

| | |
|---|---|
| **Bead** | `asc-9xi0` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | recording two `decision` entries from a plan's to-do list, then reading back what the store held |
| **Entry type(s)** | `decision` (starter); the finding is in the read path, not in the entries |
| **Severity** | P2 — no data is lost and no wrong answer is returned; the mechanism's stated effect is simply absent |
| **Status** | open |

## What was found

An invalidation is recorded, and **nothing on the read path consults it**. `listInvalidations`
exists in the store and is called by exactly one module in `packages/*/src` — `commands/invalidate.ts`,
its own command. So a struck entry keeps its place in every count, every listing and every
search diagnostic, and the only surface that reports the strike is `asc invalidate --list`.

The absence is the finding, and it is worth stating in the form the template asks for: a strike is
supposed to change what a later reader sees, and there is no code in the repository that reads one.

## How it surfaced

The plan for this epic ends with a *"Records to update"* list, and one item is: *"`asc record --type
decision` for the staging change and the cursor home, once `asc` works again (stage G)."* Stage G is
the cutover that makes `asc` work again, so this was the first thing done with a working store.

Two decisions were recorded. The second — the ingest cursor's home, a gitignored sidecar — **already
existed**: entry `61a1e2e9`, recorded at 2026-09-30T00:19:59, when the owner settled that choice
earlier in the same work. The plan's to-do list names a *topic* to record, not an entry, and nothing
between reading that list and calling `asc record` asked whether the store already held one.

What caught it was one query, run for an unrelated reason — I was verifying that a recorded entry
reads back through the tree and the rebuilt index, and asked how many decisions mention the sidecar:

```
$ asc query "select count(*) as n from v_decision_v1 where chosen like '%sidecar%'"
n
-
2
```

Two. There was one choice.

**Nobody was looking for this.** The duplication was my own mistake and the tool did not cause it;
what the tool failed to do is the finding, and it failed in the one place built to prevent exactly
this. `asc search` reports where a query's terms occur outside the indexed evidence text, and the
surface it names — *"the query terms do occur as property values"* — is a prior-art check by
construction. It listed the duplicate and the entry it duplicated as two:

```
$ asc search decision "gitignored sidecar"
no matches.
This type has 92 entries, of which the index holds 60 --
only entries with evidence text are searchable, so a term absent from those cannot match
however it is spelled.

The query terms do occur as property values, which a search does not cover:
  chosen = "A gitignored JSON sidecar at .ascend/ingest-cursor.json, holding both the per-file rows and the applied-handler ledger, written by the ingest command and read by nobody else."  (1 entry)
  chosen = "a gitignored sidecar at .ascend/ingest-cursor.json, owned by the ingest command"  (1 entry)
```

One of those two had been struck eleven seconds earlier, and the output is identical to what it would
print for two independent decisions.

## The metric

- **The strike was recorded, verbatim:** `96c9e2cb-3b4f-4fab-ab5c-7e8de821544f  superseded  wrote  …
  superseded_by 61a1e2e9-d66e-4e25-88d4-3dcbcdd527b0  created_at 2026-09-30T02:30:01.138Z`.
- **The count it was counted in did not change.** Recorded at 02:30:01; measured after it, in this
  order:

  ```
  asc query "select count(*) as n from entries where type_name='decision'"                       -> 92
  asc query "select label, count(*) as n from annotations where scheme='invalidation'
             and entry_id in (select id from entries where type_name='decision') group by label"  -> superseded | 1
  asc types list | grep decision                                                                 -> decision  1  4  92  100  active
  ```

  92 entries, 1 of them struck, and the type's reported count is 92. The same query run before the
  strike returned 92 as well — the strike moved no number anywhere.
- **The callers, verbatim:** `grep -rln "listInvalidations\|invalidated_ids\|isInvalidated"
  packages/*/src` returns three files — `commands/invalidate.ts`, `store/src/annotations.ts`,
  `store/src/index.ts`. Two are the definition and its export; the third is the command that writes
  strikes. There is no fourth.
- **Prevalence, and its limit.** This is **1** strike against **1** read surface, and n = 1 is an
  anecdote: it says the mechanism is absent, which the grep establishes, not how often it misleads.
  Any claim about frequency would need a corpus of strikes made by someone not looking for this. The
  92 decisions in this store are the population the anecdote is drawn from, and the one duplicate is
  the only entry I can attest was re-recorded from prior art that already existed.

## The pattern

**A strike is a promise about a future read, and a promise is only kept where it is read.** The
invalidation mechanism was designed from the write side — the scheme exists, the vocabulary is
closed, the trigger keeps entries immutable, `--list` proves the strike landed — and every test of it
stops at the store boundary. That is the same shape as the false-green class this repository already
has a rule about: a signal is emitted, and the thing the signal is supposed to change does not
change. The generalization worth keeping: **for any mechanism whose value is "a later reader is not
misled," ask which reader, and point at the line of code.** Where the answer is "none yet," the
mechanism is a record rather than a control, and its help text should not describe an effect.

The narrower pattern is about the search diagnostic, and it is the sharper half: a surface that lists
matching entries for prior-art purposes **must** carry the same annotations the entries carry, because
it is precisely the surface a person consults *before* creating a new entry.

## Why nothing else would have caught it

- **A test could have, and cheaply** — the missing one is a strike followed by an assertion that a
  count changed. The suite is green because every invalidation test asserts on the strike's own
  written row (`invalidate.test.ts`), never on a count after it.
- **A review plausibly could have.** "Who calls `listInvalidations`?" is a one-line grep. The honest
  answer is that reading the mechanism from the write side makes it look complete, and a reviewer
  following the same direction as the author tends to stop in the same place.
- **The type's own design questions did not.** `decision`'s `analysis_questions` are *"Which decisions
  were later reversed?"* and *"Was reversibility marked correctly on the ones that were?"* — both
  answerable only by a read path that applies strikes. The vocabulary asked the question the read
  path cannot currently answer.

## Consequences and constraints

The duplicate is not deleted: entries are immutable, and `asc invalidate`'s own help says a strike
recorded in error cannot be withdrawn either (retraction is deliberately unbuilt, `asc-k6p.2`). It is
struck as `superseded`, naming `61a1e2e9` as the entry to rely on, and it stays in the count at 92.

Two things are **not** claimed. The generated `v_<type>_v<version>` views returning struck rows is not
a defect on its own — they are documented as views over the entries, and a raw view returning raw rows
is defensible. And no consumer outside `packages/*/src` was checked: the grep covers the repository's
source, so an adapter, handler or hook that reads strikes would falsify the "no fourth caller" claim
without contradicting anything measured here.

## Links

- Bead: `asc-9xi0`
- Related: `dogfood/0039` (a build that reports success from half a store) — the same class, a signal
  that changes nothing; `asc-4wx6` (a reasonless invalidation reaches the store) and `asc-y7p`
  (invalidation is entry-granular) — the write side of this mechanism, both open
- Source: `packages/store/src/index.ts` (`listInvalidations`, exported and unused),
  `packages/cli/src/commands/invalidate.ts`, `packages/cli/src/commands/search.ts` (the property-value
  diagnostic)
- Entries recorded at the time: `55b31f62` (the staging decision, which stands — the one entry of the
  two that the store did not already hold), `96c9e2cb` (the duplicate, struck),
  `61a1e2e9` (the entry it was superseded by)
