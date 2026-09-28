# 0025 — a subagent receives its notifications behind a preamble the parser never reads

| | |
|---|---|
| **Bead** | `asc-wkmq` |
| **Surfaced** | 2026-09-28 |
| **Surfaced by** | characterising the one unclosed async fork `asc-ggd4` left (`dogfood/0017` Resolution) |
| **Entry type(s)** | none written; the `agent.return` and `prompt.submit` events handlers read |
| **Severity** | P3 |
| **Status** | fixed in the commit that adds this record (`EVENT_DERIVE_VERSION` 8) |

## What was found

A subagent stream receives a task notification as a `user` record whose text starts with the
harness's `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble, and only then gives the
`<task-notification>` tag. The normalizer read a notification only when the tag leads the text.
So it missed every notification delivered to a subagent. That had two effects:

- A subagent's own async child never returned.
- The delivery fell through to `promptText` and became a `prompt.submit`, a prompt nobody typed.

The counter `asc-ggd4` added for unread notifications also tested for a leading tag, so it
counted none of them. `asc-ggd4` fixed the same class of gap in the main stream, one record shape
over, and did not reach this one.

## How it surfaced

`asc-wkmq` asked why one async fork had a child id and no return. The first reading pointed at the
wrong cause. The child id appears in two `queue-operation` records in the **main** session file,
not in the stream of the subagent that spawned the fork, so this looked like the cross-stream
ordering problem `asc-gtnu.7` owns. Checking the timestamps undid that. The spawning subagent was
still running when its child finished, and its own stream holds a `user` record naming the child
4 seconds later. That record starts with the preamble. The bead asked for the characterisation.
Nobody was looking for the fake prompts.

## The metric

Records that carry the tag anywhere, over the 98 files of this project's transcripts, read-only,
2026-09-28. `lead` means the tag leads the text:

```
226 attachment lead=true preamble=false contains=true
357 queue-operation:enqueue lead=true preamble=false contains=true
238 queue-operation:remove lead=true preamble=false contains=true
68 user lead=false preamble=false contains=true
12 user lead=false preamble=true contains=true
117 user lead=true preamble=false contains=true
```

For the 12 preamble records: where each sits, whether the same task id is read in another shape in
that stream, and the id's first character and length:

```
   1 subagent alsoReadInStream=false idShape=a17 tagAt=494
  11 subagent alsoReadInStream=false idShape=b9 tagAt=494
```

All 12 are in subagent streams, and none has another readable copy in its stream. 11 are
background-shell ids, which are correctly unmatched. 1 is the fork.

`asc handlers check handlers/subagent-outcome.yaml --samples 0`, on the same files before and
after:

```
                                     before (v7)   after (v8)
subagent-outcome  rows                89            90
subagent-outcome  unclosed            6             5
normalizer.unmatchedNotifications     276           287
normalizer.unreadNotifications        1             1
```

`unmatchedNotifications` rises by 11, the 11 background shells. The 5 still unclosed are the 5
spawns with no `child_agent_id` that EV-25 found. The same before/after on `edit-verified`,
`edit-unverified` and `read-unused` moved no count: rows, triggers, unclosed and noMatch are all
identical. So on this corpus the 12 fake prompts cut no window short. That is 12 records, an
anecdote.

## The pattern

**A reader keyed to where a marker usually sits, rather than to the marker.** The same as
`dogfood/0017`, one shape over. That fix enumerated the record shapes that carry the tag. This
one is about where the tag starts inside a shape already read. Enumerating shapes fixes the cases
someone measured, and the preamble had never been measured.

## Why nothing else would have caught it

The counter meant to catch unread notifications used the same leading-tag test as the reader, so
it was blind in exactly the same place. A counter that shares its predicate with the reader it
audits can only confirm that reader. The fixtures were written from main-stream records.

## Links

- Bead: `asc-wkmq`
- Precedent: [0017](0017-2026-09-26-task-notifications-arrive-in-records-the-parser-never-reads.md)
- Code: `packages/adapter-claude-code/src/normalize.ts`, `NOTIFICATION`
