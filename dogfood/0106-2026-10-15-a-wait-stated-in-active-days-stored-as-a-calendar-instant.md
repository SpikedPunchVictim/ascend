# 0106 — A wait stated in active days, stored as a calendar instant

| | |
|---|---|
| **Bead** | `asc-09wx.8.5` (this is a finding *inside* that bead's scope, not a separate one) |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | Writing `gradingPoint()`'s tests (`asc-09wx.8.3`) and pinning what its `dueAt` actually is |
| **Entry type(s)** | `intervention` (starter) — `grading_point`, read by the brief line and by `LedgerRow.premature` |
| **Severity** | P3 |
| **Status** | open |

## What was found

`intervention.grading_point` is stated in **active days** — the type says so, and says it is *"the
number `asc handlers power` reports"*, which is `days_to_power`, computed from active days. But
`gradingPoint()` in `packages/cli/src/intervention.ts` builds the row's `dueAt` as
`appliedAt + days × 86_400_000 ms`, which is **calendar** days. A chain is all the function is handed,
and which days were active is a fact about the log, so a canonical instant cannot be built in active
days at all. The two units agree only where a project's log is active nearly every day.

The consequence is the **false-negative** direction. `premature` flags a grade recorded *before*
`dueAt`; when `dueAt` arrives before the wait has actually elapsed, a grade taken at it — holding a
fraction of the active days the row asked for — is not flagged. So the check that exists to catch a
premature grade goes quiet exactly on the sparse logs, which are the ones where a 30-active-day wait
is a long calendar wait and the flag matters most.

## How it surfaced

`asc-09wx.8.3`'s grader compares a row's `grading_point` against the plan's `days_to_power`, and both
are in active days, so the comparison is sound. Writing the test that pins the *third* number in that
block — `due_at` — forced the question "and what unit is this one in?", and the answer is not the
unit of the two numbers printed above it. That is now a docblock in `packages/cli/src/intervention.ts`
and a deliberately-pinned assertion in `packages/cli/test/intervention.test.ts`, whose job is to be
the line `.8.5` has to come back and edit.

**Nobody was looking for it.** The task was a test for a function that already existed. The first
draft of that test's explanation was wrong in a way worth recording: it argued *"active days are never
more numerous than calendar days, so this instant falls at or before the wait the row means."* The
premise is false as stated — an interval of D elapsed days can touch D+1 distinct dates, and the
EV-55 replay touches 34 dates in 33.269 elapsed days — and the direction is not a bound at all but a
function of the log's density. Measuring, rather than reasoning from the subset relation, is what
corrected it.

## The metric

**How densely each real project's log is active**, read from this machine's read-only transcript
store: distinct UTC dates carrying an event, over the most dates the span could have touched
(`floor(span)+2` — a first event late in its day and a last event early in another).

```
sessions  active_dates  possible  calendar_days  coverage  project
      12            35        37           35.2     0.946  -Users-spikedpunchvictim-projects-grizzly-grizzly-exp
      15            34        35           33.3     0.971  -Users-spikedpunchvictim-projects-ascend
       6            14        21           19.3     0.667  -Users-spikedpunchvictim-projects-grizzly-grizzly-wip
       3            16        16           14.4     1.000  -Users-spikedpunchvictim-projects-grizzly-grizzly-pl
       7            12        12           10.4     1.000  -Users-spikedpunchvictim-projects-mast
```

**0.667 to 1.000.** Five projects, all real work; `ascend` — the log this repo dogfoods against — sits
at **0.971**, which is the reason the defect has been invisible here.

**What that costs a 30-active-day wait**, which is the EV-55 row's own `grading_point`:

| coverage | calendar days the wait needs | the stored instant arrives early by | active days actually held at it |
|---|---|---|---|
| 1.000 | 30.0 | 0.0 | 30.0 |
| 0.971 (`ascend`) | 30.90 | 0.90 | 29.1 |
| 0.946 (`grizzly-exp`) | 31.71 | 1.71 | 28.4 |
| 0.667 (`grizzly-wip`) | 44.98 | 14.98 | 20.0 |

On the sparsest real log, a grade taken at the row's own instant holds **20 of the 30 active days**
it asked for and `premature` does not flag it.

**The EV-55 row's own three numbers**, from `asc handlers grade eee14db2-45a5-4bf4-81a0-853f73674524
--effect 0.5`, and the same span replayed directly:

```
applied_at       2026-10-13T19:11:23.000Z
grading_point    30
due_at           2026-11-12T19:11:23.000Z

triggered 366  dated 366  active_days 34
first 2026-09-12T01:05:04.206Z  last 2026-10-15T07:32:27.403Z
calendar_days 33.269  active/calendar 1.0220
```

`due_at − applied_at` is exactly 30 × 86 400 000 ms. The last line is why the subset reasoning is not
available: 34 dates in 33.269 elapsed days is a ratio above 1, and a reader who took it as a density
would conclude the stored instant is *late*. The honest denominator is the 35 dates the span could
have touched, which is the 0.971 in the table above.

## The pattern

**A duration and an instant are different kinds, and a unit conversion between them needs the log.**
`grading_point` is a *count of days on which something happened*; `due_at` is a *point in time*.
Turning the first into the second requires predicting which future days will be active, which nothing
at write time can do. The field pair is therefore not a rounding error but a type error that the
schema cannot express — and the direction of the error is a property of the corpus, so it cannot be
argued about and has to be measured.

The class is worth naming because it will recur: every "wait N active days" and every "remind me when
there are N more units" wants an instant to hang a reminder on, and the instant is always a
different-unit approximation of the count.

## Why nothing else would have caught it

The unit mismatch is invisible to every test in the repo, by construction: a test builds the chain and
asserts on `dueAt`, so it asserts the calendar arithmetic and passes. There is no test that could know
the answer was supposed to be *30 active days in the future* without a log to measure active days
against, and the chain is deliberately log-free.

Review plausibly catches it — the two units are one line apart in the same docblock — which is what
happened here, in the same session, by being made to write the docblock.

## Consequences and constraints

- **The correction is a design choice, not a bug fix**, and it belongs to `asc-09wx.8.5` because that
  bead's brief line is the caller that needs the reading. Three shapes are open, and the third is the
  one this finding argues for:
  - Recompute `due_at` from the log at read time — the only accurate instant, and it needs the replay
    in the caller that prints the line.
  - Drop `due_at` and print the active-day count, which is honest and less directly useful.
  - Keep the calendar instant but label it an **earlier bound**, and have the brief line say the grade
    is *due to become readable* rather than *due*.
- **The `premature` direction must be stated, not derived.** The subset argument is wrong; the correct
  statement is "early where the log is sparse, about right where it is daily", and the numbers above
  are what a later reader should be able to match.
- **Entries are immutable**, and the EV-55 row's `grading_point` of 30 is unaffected — nothing about
  the row changes. Only the derived instant does, and it is derived on every read.

## Links

- Bead: `asc-09wx.8.5` (owner of the correction)
- Built by: `asc-09wx.8.3` (`asc handlers grade`, whose `reaches_grading_point` row compares the two
  active-day numbers and deliberately does not use `due_at`)
- Entries recorded at the time: the EV-55 intervention row `eee14db2-45a5-4bf4-81a0-853f73674524`
