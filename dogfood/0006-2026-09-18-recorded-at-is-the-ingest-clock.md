# 0006 — `recorded_at` is the ingest clock, not the event clock

| | |
|---|---|
| **Bead** | `asc-bn0` |
| **Surfaced** | 2026-09-18 |
| **Surfaced by** | `asc stats tool_denial --changepoints`, the first time the new command was run against the real store |
| **Entry type(s)** | `context_compaction`, `skill_activation`, `tool_denial`, `user_correction`, `verification_run` (all derived) |
| **Severity** | P2 |
| **Status** | open — `asc stats` now takes `--at`; every other surface that buckets by `recorded_at` is unexamined |

## What was found

`recorded_at` is when `asc` wrote the row. For a type derived by `asc ingest claude-code`, every
entry produced by one ingest run shares a single `recorded_at` instant — so any analysis that treats
`recorded_at` as time is measuring when the ingest ran, not when anything happened. On this project's
own store that is 94.7% of the corpus collapsed onto one point.

This is an *absence* finding as much as a defect: nothing anywhere says which clock a surface is
reading, so a time series built on the wrong one looks exactly like a time series built on the right
one. The entries are not wrong. `recorded_at` is accurate about what it claims. What is missing is
anything that distinguishes it from the clock a reader assumes they are looking at.

## How it surfaced

**Nobody was looking for it.** `asc-5k0` is a plumbing task — seven analysis primitives had shipped
with no way to run them, and the bead is about the command surface, not about the data. The first
end-to-end run of the finished `--changepoints` mode against the real store was a smoke test:

```
$ node packages/cli/dist/bin.js stats tool_denial --changepoints
Error: every series spans fewer than 3 days, and a break needs a before and an
after. Record more entries over more days.
```

That refusal was written for a young corpus. It fired on 564 entries spanning five weeks. The
refusal was correct and its advice was wrong, and the only reason the discrepancy was legible is
that the message said *how many days*, not just *not enough data* — a message that had read
"insufficient data for a changepoint scan" would have been accepted and the mode would have shipped
scanning the wrong clock.

The mechanism is worth naming because it is new to this series: **a refusal whose stated reason
could be checked against the data, and did not survive the check.** The three previous mechanisms
recorded here were a pre-registered prediction tested against real output (0001), the unclassified
remainder of a rule (0004), and a discipline task auditing itself (0003). This one is a guard rail
that fired correctly and whose explanation was falsifiable.

## The metric

Every type in the store, with its entry count and the range of its `recorded_at` — exact output of
`asc explore <type>`, one line per type, taken 2026-09-18:

```
context_compaction  527   2026-09-17T22:37:40.736Z  2026-09-17T22:37:40.736Z
decision            43    2026-09-12T18:30:05.783Z  2026-09-18T08:49:14.060Z
evidence_record     8     2026-09-17T18:38:35.880Z  2026-09-18T09:25:57.427Z
note                16    2026-09-16T03:39:50.180Z  2026-09-18T00:24:42.295Z
skill_activation    90    2026-09-17T22:37:40.736Z  2026-09-17T22:37:40.736Z
stage_transition    24    2026-09-16T03:37:03.826Z  2026-09-18T00:25:58.655Z
stuck_event         4     2026-09-16T03:37:04.023Z  2026-09-16T17:27:17.719Z
tool_denial         564   2026-09-17T22:37:40.736Z  2026-09-17T22:37:40.736Z
user_correction     19    2026-09-17T22:37:40.736Z  2026-09-17T22:37:40.736Z
verification_run    502   2026-09-17T22:37:40.736Z  2026-09-17T22:37:40.736Z
```

Five types have a `recorded_at` range of zero — min equals max — and all five are the derived ones.
527 + 90 + 564 + 19 + 502 = **1,702 entries on the single instant `2026-09-17T22:37:40.736Z`**, of
1,797 in the store: **94.7%**. The five hand-recorded types (95 entries) span real days, which is
what makes the contrast a fact about ingest rather than about the store.

All five collapsed types declare the right clock as a property. `tool_denial`'s, exact output of
`asc explore tool_denial`:

```
property.occurred_at   timestamp  measured 564 (100.0%), not_app…(0.0%), not_declared 0 (0.0%)  451  2026-08-13T17:01:28.248Z … 2026-09-17T20:30:58.884Z
```

451 distinct values across 36 days. Scanned on that axis instead, exact output of
`asc stats tool_denial --changepoints --at occurred_at --json`:

```json
{
  "series": "entry rate by occurred_at",
  "axis": "occurred_at",
  "method": "pettitt",
  "periods": 36,
  "break_after": "2026-08-22",
  "first_after": "2026-08-23",
  "before_mean": 3.4,
  "before_median": 3,
  "after_mean": 20.384615384615383,
  "after_median": 10.5,
  "statistic": 182,
  "p": 0.03169813400317263,
  "p_adjusted": 0.03169813400317263,
  "small_group": false
}
```

So the corpus does contain a break — denials rise from a mean of 3.4 a day to 20.4 a day after
2026-08-22, p = 0.0317 — and on `recorded_at` it is not merely weak or wrongly placed. It does not
exist, because there is no timeline for it to sit on. **The cost of the wrong axis here is not a
distorted answer but a refusal, which is the lucky case; a corpus ingested in three runs rather than
one would have produced three periods, a scan, and a changepoint at an ingest boundary.**

## The pattern

**A field that is accurate about its own meaning and wrong for the use it invites.** `recorded_at`
does not lie: the row was written at that instant. The defect is that the name reads like the time
of the thing, the column sits where a reader expects a timestamp, and nothing at the point of use
says which of the two clocks is being read.

This is the same class as `dogfood/0004`, where `evidence_text` accurately recorded what was said
and the problem was what a downstream reader would take it to mean. The generalization: *a derived
corpus has at least two clocks, and any surface that buckets, orders or ranges over time has to say
which one it used.* The remedy that survived here is the cheapest one available — the axis is a
required parameter of the answer, named in the output on every row, defaulting to `recorded_at`
rather than guessing. An automatic switch to the type's lone `timestamp` property was rejected
deliberately: it would make the axis a function of the schema, so two types scanned from one command
line would sit on two different clocks with nothing saying which.

## Why nothing else would have caught it

A test would not have. `asc stats`'s own suite builds its fixtures with `asc record`, and a test
fixture recorded in one batch has exactly the property this finding is about — the tests pass
identically whichever clock they read, because in a fixture the two clocks agree or the fixture
supplies only one. The suite now has a test that records a batch and asserts the refusal names
`--at at`, but that test was written *after* the finding and encodes it; it could not have produced
it.

A code review would not have, either. The line `entries.map((entry) => bucket(entry.recordedAt))`
is correct on its face — `recorded_at` is the entry's timestamp, and the reviewer would have to
already know that the ingest writes 564 of them at once to see the problem. This is the honest
answer: the only thing that surfaced it was running the command against a real corpus and reading a
refusal that did not match what was known about the data.

## Consequences and constraints

**Entries are immutable** (`entries_are_immutable`, `entries_cannot_be_deleted`, enforced by
trigger), so the 1,702 rows already on one instant cannot be rewritten to their `occurred_at`. That
is not a loss: `occurred_at` is on every one of them, so the information is present and only the
default reading is wrong. The options are at the read surfaces (`--at`, done for `--changepoints`)
and at write time for future ingests (should a derived entry's `recorded_at` be its `occurred_at`?
— open, and not obviously yes: `recorded_at` is also the audit trail of when ascend wrote the row,
and overloading it would destroy that).

What is explicitly **not** covered by the `--at` fix: `asc explore`'s `recorded_at_min`/`_max` range,
`asc query`'s ordering, and the generated views all still read `recorded_at` with nothing saying so.
That is the open part of `asc-bn0`.

## Links

- Bead: `asc-bn0`
- Surfaced while implementing: `asc-5k0` (`asc stats` command surface), epic `asc-xgo`
- Related mechanism: `dogfood/0004` — a field accurate about itself and wrong for its use
