# 0102 — a request body replayed as its own event

| | |
|---|---|
| **Bead** | `asc-j6pj` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | the pre-push gate blocking, on a push of two branches that changed nothing the deriver reads |
| **Entry type(s)** | `skill_activation` (derived); the same walk reaches `verification_run` |
| **Severity** | P2 |
| **Status** | fixed in the working tree |

## What was found

The harness began writing a record type this adapter had never seen — `api-request-blob`, a stored
**request body**, which re-carries the `message.content` of the request it stored, `tool_use` blocks
included, and carries no `uuid`, `timestamp`, `cwd` or `gitBranch`. `accept()` had no record-type gate
and no notion of a record that is not an event, so it walked the body exactly as it walks the event,
and `acceptToolUseBlocks` wrote a **second** `skill_activation` for an invocation that already had
one — same key, and none of the three provenance values the entry's own definition leans on.

The duplicate was the visible half. The other half is that the replayed call also registered a
**claim**, and a claim is consumed by the next run of the same skill — so a request body could not only
add a bogus activation, it could **silence a real one**. That is a lost event, and it is the worse
direction: a duplicate is visible in a count, a dropped activation is not visible anywhere.

## How it surfaced

**Nobody was looking for it.** The gate was green on this tree at `2026-10-14T22:59:09.108Z`
(`297370` ms) and blocked at `2026-10-15T00:04:40.969Z` (`298551` ms, `blocked test`). Between those
two rows the *corpus* moved and the *tree* did not: the offending file was last written at `17:08`
local (`00:08Z` the next day, which is the UTC date the gate row carries), and only 3 files in the
whole corpus contain the type at all. A push was blocked by a third party's transcript growing.

The mechanism that made it legible was reading the failure as a question about the corpus rather than
about the commits — the change under test touched only markdown, and the one diff in the failing test
file since the last green run was a **comment**.

## The metric

The failing entry, identical across all three assertions:

```
skill_activation|2996be0b-5228-4285-8f61-e81dbbf3e10b:toolu_013aP9HmETNeEUsy5xNUBHvL
```

Two records carried that `tool_use` block — an `assistant` record with `cwd` and `gitBranch` set and
`timestamp 2026-10-14T23:18:03.808Z`, and an `api-request-blob` record with all four fields null. The
deriver emitted two entries; the blob's is the bad one.

The record-type sweep, one pass over the live corpus, `node` over the built package's own
`streamCorpus` and `createDeriver`:

```
records 1118625
--- records WITHOUT a uuid that carry an accept() trigger field:
  api-request-blob	n=375 uuid=0	tool_use=71 tool_result=8
```

That is the whole list. Twelve other record types carry no `uuid` either — `mode`,
`permission-mode`, `last-prompt`, `ai-title`, `agent-name`, `bridge-session`, and the harness's
newer `api-request`, `api-request-shape`, `cost-state`, `artifact-comment-monitor`,
`artifact-autoreact-ledger`, `fork-context-ref` — and not one of them carries a field any branch of
`accept` reads. The complete trigger set was taken from the source, not from a list:
`attributionAgent`, `attributionSkill`, `compactMetadata`, `message`, `toolDenialKind`,
`userFeedback`.

The same pass gives the discriminator the fix is built on: `assistant` **358,875**, `attachment`
**333,884**, `user` **200,924** and `system` **8,910** records carry a `uuid` on every record, and the
other twenty types carry one on **none** — `216,032` records (`1118625 - 902593`).

The fix's delta, from two sweeps of the same corpus keyed on
`type|key|cwd|branch`, `diff`ed line by line:

```
1224d1223
< skill_activation|2996be0b-5228-4285-8f61-e81dbbf3e10b:toolu_013aP9HmETNeEUsy5xNUBHvL|<none>|<none>
2895a2895
> verification_run|b5d54754-fe9e-4c00-9f7b-d25b5f14a75d:call_hdezm3h0|.|gitbutler/workspace
```

Exactly one entry removed, and it is the offending one. The one addition is this session's own
transcript — `b5d54754` is the session the probe was run from — recorded live while the probes ran,
which is also why the two sweeps both total `3315`. Entries with no `cwd`: **1 before, 0 after**.

After the fix: `derive.test.ts` **148 passed (148)** in 456 ms, and
`derive-real-corpus.test.ts` **8 passed | 1 skipped (9)** in 39.51 s.

`n = 1` corpus, `n = 1` machine, and the duplicate itself is one entry — an anecdote, well under
`MIN_N`. What is not an anecdote is the shape: 71 replayed `tool_use` blocks and 8 replayed
`tool_result` blocks corpus-wide, a count over the whole corpus rather than a sample.

## The pattern

A claim written about a **third party's live data**, which the data outgrew. Nothing in this
repository controls the transcript format, so every rule read off it is a reading of a corpus at a
moment — and this one was read as a property. `localityOf`'s own docblock had already written the
prediction down: records carrying neither `cwd` nor `gitBranch` are control records, *"None of them
triggers a derived event today, so the omission below is not a gap in practice. It would become one
the day a derived type keys off a control record."* That day arrived, and the docblock is the only
place in the repository that had said which day it would be.

The class is `dogfood/0098` one layer down. There, two branch-line ingests derived the same events and
a rebase combined their appends; here, one transcript file derived the same event twice, because one
record was a copy of another. Both are *one event read as two*, and in both the second reading arrived
with a null where the first had a value.

## Why nothing else would have caught it

**A test did catch it** — `derive-real-corpus.test.ts`, and that is worth stating rather than claiming
otherwise. It is the file that blocked the push, and it caught the finding because it asserts what the
defect violated: every derived entry carries its locality. Its own docblock calls it *"a local honesty
check, not a portable CI gate"*, and it skips wherever `~/.claude/projects` does not exist, so on
every machine but this one nothing runs the assertion at all.

What no test would have caught is the **silencing**. The claim registry is interior state; a fixture
that exercises it is a fixture someone has to write, and the reason to write it is the finding. The
three corpus assertions failed on the duplicate — the second-order effect was found by reading
`acceptToolUseBlocks` after the first-order one had already been explained, and it is now pinned by a
fixture rather than by the corpus.

A review would not have caught it either, and this is the part that generalizes: the code was correct
for every record type that existed when it was written, and the defect needed a record type from the
future.

## Consequences and constraints

- **Entries are immutable** (`entries_are_immutable`, `entries_cannot_be_deleted` are enforced by
  trigger), so the 71 replayed calls are not a cleanup task. The two options this leaves are the two
  the convention names: prevention at write time, which is what this fix is, or an invalidation
  annotation.
- **The store never wrote the bad copy.** `asc ingest claude-code` refuses an id already held with
  different content, reports the collision, and leaves the stored row — so the defect's cost until now
  was a false collision on every ingest and a permanently red local test, not corrupted data. That
  refusal path was read from source, not measured by running the ingest.
- **The gate is a drop, and drops are the thing this repository counts.** The fix refuses any record
  with no `uuid`, and nothing counts what it refuses: the alternative is a counter over the 216,032
  records a sweep does not read, which is a number nobody can act on. What would show a genuine event
  type arriving without a `uuid` is the corpus test's own per-type floors, which are the reason a type
  that stopped deriving fails a gate instead of disappearing quietly.
- **Two claims about the same corpus are now stale and are NOT corrected here**: the count table and
  the test docblock both still say `review_finding` derives zero. Measured on this sweep it derives
  **36**. That is a separate finding about a separate type, and it is named in `asc-j6pj` rather than
  folded into this fix.

## Links

- Bead: `asc-j6pj`
- `dogfood/0098` — one event read as two, by two branch-line ingests rather than by one replay
- `docs/evidence/EV-45.md` — the corpus re-derivation that measured `repeatedKeys`
- `derive-real-corpus.test.ts` — the local honesty check that produced the three failures
- The docblock in `localityOf` that predicted this day, and now records it
