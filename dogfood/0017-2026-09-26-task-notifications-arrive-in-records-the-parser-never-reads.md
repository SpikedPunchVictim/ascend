# 0017 — a task notification arrives as a record shape the parser never reads, and nothing counts the ones it drops

| | |
|---|---|
| **Bead** | `asc-ggd4` (P1, fixed) |
| **Surfaced** | 2026-09-26 |
| **Surfaced by** | replaying `handlers/subagent-outcome.yaml` over this project's log under `asc-6ola.9`, then asking why the handler's count was 44 when the spawn count was 85 |
| **Entry type(s)** | none — the finding is in the adapter's normalizer (`packages/adapter-claude-code/src/normalize.ts`); the affected event kind is `agent.return` (normalized) |
| **Severity** | P1 — the project's severity-zero class ("silently drops a fact and reports nothing wrong") |
| **Status** | fixed in the commit that adds **Resolution** (`EVENT_DERIVE_VERSION` 6) |

## What was found

`agent.return` is emitted for **44 of the 80** spawns in this project that carry a
`child_agent_id` — 55%. The other 36 are not lost, missing, or unreturned: their notifications
are **in the transcripts**, and all 36 sit in the **same file** as their spawn. The normalizer
never reads the records they arrive in.

`taskNotification` (`normalize.ts:145`) returns `undefined` unless `record['type'] === 'user'`
**and** `record['message']['content']` is a string that `startsWith('<task-notification>')`. In
this project the notifications for all 36 arrive as `queue-operation` records — the tag in a
**top-level** `content`, with no `message` field at all — and as `attachment` records, a type the
adapter never reads.

The absence that matters is the counter. `unmatchedNotifications` counts only notifications that
**parsed** and failed to join, so these 108 records contribute **no counter of any kind**. A
reader of the `asc handlers check` header sees `unmatchedNotifications 55` and concludes the
rest was attributed. The drop is not merely unhandled; it is unreportable in the current shape.

## How it surfaced

The prediction was made first, which is what made the miss legible. `asc-6ola.9`'s PREREG
registered **rows = 85, unclosed = 0** — and, in the same note, the evidence against it: *only
694 of 1,244 notifications join a spawn corpus-wide, so rows may be materially below 85.*

The replay returned **rows 44, triggers 85, unclosed 41**. `triggers` matching exactly was the
tell: the handler had seen every spawn, so the shortfall had to be downstream of the trigger.
44 + 41 = 85 partitions the triggers, which ruled out a handler bug and pointed at the source.

Three probes followed, each narrowing the cause rather than confirming a guess:

1. **The join shapes.** 85 spawns, 80 with `child_agent_id`, 5 without; 59 returns; 44 distinct
   child ids on each side; **36 spawn ids with no return**. This was the first honest statement
   of the size — but it still could not say whether the 36 were unreturned or unread.
2. **The decisive question.** For each of the 36: does a `<task-id>` exist anywhere in the
   transcripts? **36 of 36 did; 0 had none.** So no delegation failed to report — the adapter
   failed to read.
3. **The record shape.** All 36 have the notification in the *same file* as the spawn, which
   cleared `spawned`'s per-file gate (`:425`) — the obvious suspect, and the wrong one. The
   shapes carrying them were `queue-operation` ×72, `attachment` ×35, `user+isMeta` ×1.

**Nobody was looking for this.** The question being asked was whether delegated tasks return
usable results. The finding is about whether the adapter can see the answer. It became visible
only because a *count* was predicted before it was taken: without "rows = 85" written down, 44
would have read as "44 delegated tasks came back", which is a different and false claim, and the
41 unclosed spawns would have read as delegation outcomes rather than as parser losses.

## The metric

The handler's own output, exact, `asc handlers check handlers/subagent-outcome.yaml --samples 0`:

```
(log)             normalizer.records                 86556
(log)             normalizer.events                  111730
(log)             normalizer.unpairedResults         0
(log)             normalizer.unfinishedCalls         1
(log)             normalizer.unmatchedNotifications  55
subagent-outcome  rows                               44
subagent-outcome  triggers                           85
subagent-outcome  unclosed                           41
```

The two probe blocks below are the output of scratch scripts in the gitignored `spike/tmp/`
(`spawn-join.mjs`, `notif-join.mjs`, `notif-files.mjs`, `notif-shape.mjs`), each streaming the
same corpus through `createNormalizer`/`streamCorpus` from
`packages/adapter-claude-code/dist/index.js` — the production normalizer, the same one the
handler above ran under. Named so the numbers can be re-checked; `spike/tmp/` is gitignored by
directory, so the scripts are not committed.

The join shapes on the normalized log:

```
spawns                      85
  with child_agent_id       80
  WITHOUT child_agent_id    5
returns                     59
  with child_agent_id       59
  with id                   55
distinct spawn child ids    80
distinct return child ids   44
intersection                44
spawn ids with no return    36
```

The question that separates "unreturned" from "unread" — every one of the 36 has a notification:

```
spawn ids with NO return                             36
  ...of those, task-id exists somewhere in the transcripts: 36
  ...of those, NO task-id anywhere                        :  0
```

And the record shapes carrying a missing id — the root cause:

```
record shapes carrying a MISSING id: {
 "queue-operation": 72,
 "attachment": 35,
 "user+isMeta": 1
}
```

`unmatchedNotifications 55` is the counter that made this hard to see. It measures a population
that is disjoint from the 108 dropped records: parsed-but-unjoined, not unparsed.

The 5 spawns with no `child_agent_id` are a separate, honest population — no tool result at all —
and an anecdote under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`) if read as a rate.

## The pattern

**A parser whose input gate is narrower than the format it parses loses facts silently, and
loses them where no counter is looking.** Two failures stack here, and they are separable:

- **The gate.** `type === 'user'` and `message.content` are assumptions about one producer's
  shape, held as preconditions rather than checked. When the same notification started arriving
  in a second shape, nothing failed — it simply stopped being seen.
- **The counter's blind spot.** `unmatchedNotifications` names a population that *excludes* the
  lost records. A counter is only as good as its population, and one defined as "parsed but
  didn't join" can never report a parse failure. **The records that should have been counted are
  the ones that mention `<task-notification>` and yield nothing** — that counter does not exist,
  and its absence is why this took a pre-registered count to find.

The class generalizes: this project's `scrub` work (`dogfood/0013`, `0014`) hit the same shape
from the other side — a transform that silently changed what it was given, with no counter for
what it changed. The rule that keeps emerging is that a filter needs a counter for what it
removes, not only for what it lets through.

## Why nothing else would have caught it

Every instrument that could have was green or silent:

- **Typecheck** is green — the parser's signature is unchanged and the missing shapes are
  `unknown` at the boundary either way.
- **The unit suite** is green: no fixture contains a `queue-operation` or `attachment` record
  carrying a notification, so no test discriminates the shape. Both live corpora do.
- **Ingest** reports `unpairedResults 0` and `unfinishedCalls 1` — both correct, and neither
  about notifications. The one counter that is about notifications measures a disjoint set.
- **Code review** would not flag it: the gate reads as a deliberate narrowing ("this hook writes
  user records"), which it was — and it stopped being true without anything changing in this
  repo.
- **The handler** was correct throughout. It reported 41 unclosed because 41 returns were never
  emitted, which is exactly what it was asked to report.

The only instrument that caught it was a prediction taken before the count, and a follow-up
question asked of the *data* rather than of the handler.

## Consequences and constraints

- **No store entries are affected and no `derive_version` bump applies.** The defect is in an
  adapter's read path, not in derivation rules; no `agent.return` event reaches the store today
  except through replay, so nothing needs invalidating.
- **`asc-6ola.9`'s question is blocked, not answered.** "Do delegated tasks return usable
  results" cannot be answered from a log where returns fire for 55% of spawns. The bead's
  mechanism (`judged`, the candidate declaration) is delivered and green; its *question* closes
  when this is fixed and the same replay is re-run unmodified.
- **Any downstream rate over `agent.return` is currently a rate about the parser.** That
  includes the cost fields: they were predicted to be on a minority of rows and are on all 44,
  because the 36 rows that would have been missing them were never emitted at all.
- **Re-measuring is cheap and must not be done with a changed handler.** The fix lands in the
  adapter; the replay command and the handler file stay byte-identical, so the before/after is
  one variable.

## Resolution

The normalizer now reads a notification from all three record shapes that carry one:

- `user`, the delivered message;
- `queue-operation`, the tag in a top-level `content`;
- `attachment`, in `attachment.prompt`.

It emits one `agent.return` per task id and fields, at the first sighting. Records whose strings
lead with the tag somewhere it does not read are counted as `unreadNotifications`. That is the
counter whose absence made this finding invisible.

**Why a dedupe was needed.** A measurement before the change showed that one notification is
written up to three times. This project's transcripts, read-only, 2026-09-28, gave these counts
for strings that lead with the tag:

```
354 queue-operation:enqueue @ .content
235 queue-operation:remove @ .content
223 attachment:queued_command @ .attachment.prompt
117 user @ .message.content
1 user @ .message.content[].content,.toolUseResult.stdout
```

A notification is identified by its task id and parsed fields. For 309 of the 310 task ids that
have an enqueue, that key yields exactly one notification per enqueue. The one exception carries
no fields at all, so it is an anecdote.

**The metric.** `asc handlers check handlers/subagent-outcome.yaml --samples 0` was run before and
after on the same 98 files:

```
                          before (v5)   after (v6)
rows                      45            89
triggers                  95            95
unclosed                  50            6
unmatchedNotifications    57            273
unreadNotifications       --            1
```

- **unclosed.** Five of the 6 remaining are spawns with no `child_agent_id`, the same 5 EV-25
  found. They have no tool result to join. The sixth is an async `fork` with a child id and no
  return, and it is not characterised.
- **unmatchedNotifications** rises because it now sees every notification. 269 of the 273 come
  from the 220 task ids that were never agents, and all 220 have the background-shell id form
  (`b` plus 8 characters). A background shell's completion notification is not an agent's return,
  so these are correctly unmatched, and counted once each rather than once per record.
- **unreadNotifications = 1** is the single tool result above whose output leads with the tag.
  It is a tool that printed a notification, not a shape the harness writes.

## Links

- Bead: `asc-ggd4`
- Evidence record: `docs/evidence/EV-25.md` (both predictions missed; the miss is what surfaced
  this)
- Code: `packages/adapter-claude-code/src/normalize.ts` — `taskNotification` `:145-149`, the
  `spawned` gate `:425`, the `unmatchedNotifications` counter `:187`
- Precedent: `dogfood/0013`, `dogfood/0014` (a transform that silently changed its input, with
  no counter for what it changed)
