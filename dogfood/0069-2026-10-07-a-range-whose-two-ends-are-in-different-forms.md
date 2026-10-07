# 0069 — a range whose two ends are printed in different forms

| | |
|---|---|
| **Bead** | `asc-6eln` |
| **Surfaced** | 2026-10-07 |
| **Surfaced by** | `asc explore evidence_record`, run against this project's own store as an existing-data check while fixing `asc-6eln` |
| **Entry type(s)** | `evidence_record` (project-defined) |
| **Severity** | P1 |
| **Status** | fixed in this pass — `recorded_at` and the annotation `createdAt` now require one fixed form, the `timestamp` property validator refuses offsets, and the rule lives in one place (`store/utc-timestamp.ts`) instead of three |

## What was found

`asc explore` printed a range whose ends are not in the same form:

```
property.measured_on  timestamp  measured 24 (49.0%) …  18  2026-09-18T00:00:00.000Z … 2026-10-06T00:00:00Z
```

One end carries milliseconds and the other does not. The defect behind it is that this store orders
timestamp columns **as text**, and text order is chronological order only when every value is in one
fixed form. `recorder.ts` refused offsets for exactly that reason and said so in writing; nothing
refused a variable-width fraction, so a bare `Z` and a `.500Z` in the same second compare backwards
(`Z` is 0x5A, `.` is 0x2E). The range above is the visible symptom: the two ends cannot be compared
as strings, and the ordering those strings are sorted by is not a time ordering.

## How it surfaced

The mechanism is a **range printed as a pair of strings**, where a reader can see at a glance that
the pair is not uniform. The tool volunteered this in the ordinary course of `asc explore` — it was
not asked whether `measured_on` mixes precision, and it could not have said so if it were, because
nothing in the profile records the form of a value.

**Nobody was looking for it.** The command was run to answer a different question entirely: whether
the boundary fix about to be written would make rows that are already stored unreadable. The
mixed-form range was the answer to *that*, and the defect it points at arrived unasked.

The honest qualification: the *existence* of the ordering defect had been identified earlier the
same day by reading `recorder.ts` against `profile.ts` — a code review, not dogfooding. What
dogfooding supplied is the half a review cannot: **whether it is live**. See the metric, where the
answer turned out to be no, and saying so is the point.

## The metric

The live store, `.ascend/index.db`, read-only. `evidence_record.measured_on` is the only
hand-written timestamp property in the corpus — 18 distinct values, of which **16 are bare `Z`** —
against `occurred_at`, the adapter-written one on the derived types, which is **4166 distinct and
conforming in every one**:

```
distinct measured_on values : 18
reported (TEXT) min / max   : 2026-09-18T00:00:00.000Z  /  2026-10-06T00:00:00Z
chronological  min / max    : 2026-09-18T00:00:00.000Z  /  2026-10-06T00:00:00Z
INVERTED?                   : False
same-second, differing form : 0 group(s)
```

**The reported range is correct.** Text order and chronological order agree on all 18 values,
because no two of them land in the same second in different forms. So the defect is **reachable and
not manifested**: the mixed forms are really there — that is what the profile printed — and the
condition that would make them sort wrong has not occurred.

**18 distinct values is under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`), so this is an
anecdote, not an estimate.** It is reported as an anecdote deliberately: the claim "this store has
no live inversion" rests on a population smaller than the threshold this project uses for
proportions, which means it is one value away from being wrong in the other direction.

A zero here is a **measured** zero, not a missing one: the collision count was computed by grouping
every distinct value on its second and asking whether any group holds two forms.

## The pattern

**A rule enforced on one side of a comparison and not the other.** `recorder.ts:200` named the
text-ordering hazard and applied it to offsets; the fractional-seconds half of the same hazard went
unmentioned, so the guard that was written to prevent this class prevented one instance of it. The
same regex was then copied into `annotations.ts` with a comment saying the rule came from
`recorder.ts` — which is exactly how a half-guard propagates: the *code* travels and the *argument*
is left behind.

The recognition rule: **when a guard states its reason, check that the reason does not also cover a
case the guard misses.** A comment explaining why is the most valuable artefact in the file, and the
most common way it goes stale is that it is more general than the check beneath it.

## Why nothing else would have caught it

A test would not, and largely still cannot. There is no assertion anywhere that a `timestamp`
property's values are mutually comparable as strings, and writing one would require the fixture to
hold two values in one second that differ in precision — a shape a test author would have to
invent from the bug.

`align check` sees nothing: no dependency direction changes.

A code review is what found the *rule* gap, and it found it only because `profile.ts:21-24` states
the assumption in prose and `schema.ts:58` contradicts it in prose. Where the contradiction is not
written down in two places, this class is invisible to review.

What caught the **liveness question** was running the command and reading its own output for
uniformity. That is the part worth repeating.

## Consequences and constraints

- Entries are immutable, so the 18 existing `measured_on` values are not a cleanup task. Two options
  were available and the measured one was taken: prevention at write time — chosen for `recorded_at`
  and `createdAt`, where **every stored value already conforms** (7248 of 7248 and 3905 of 3905, so
  the tightened rule refuses nothing that exists) — or invalidation, which was not needed because
  nothing is wrong.
- **The residual is deliberately left, and is stated rather than hidden.** A hand-written property
  is not required to carry milliseconds, because requiring it would have made live rows unreadable —
  **21 of the 24 stored `measured_on` rows are bare `Z`** (16 of 18 distinct), and `findEntry`
  re-validates every row against its spec on read. The residue is documented in `profile.ts`'s note
  on its range summary and in `store/utc-timestamp.ts`.
- The measurement above **closes the question for this corpus and only this corpus.** A different
  store with two mixed-precision values in one second would invert, and nothing here would notice.

## Links

- Bead: `asc-6eln` (Phase 2 of the bug hunt; ships with `#4`, the offset half)
- Bug-hunt report: `.agents/research/2026-10-07-bug-hunt-full-codebase.md`, findings 4 and 7
- Rule in one place: `packages/store/src/utc-timestamp.ts`
