# 0036 — `asc types show` elides a cell mid-word, including a closed vocabulary

| | |
|---|---|
| **Bead** | `asc-1gnl` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | `asc types show stage_transition`, read to fill in an `asc record stage_transition` call |
| **Entry type(s)** | `stage_transition` (derived) |
| **Severity** | P3, matching the bead |
| **Status** | open |

## What was found

The default (table) view of `asc types show` elides every long cell to a fixed width with a U+2026
marker, and it does that to cells whose content is a **closed enum list**. For `stage_transition`,
both `enum required` cells render as `enum required [complete, in_pr…`, so the reader is told the
vocabulary is closed and not what it is. The same elision cuts the field guidance a reader consults
*before* filling the field: the `from_status` cell keeps `One of the three the plan format allows.`
and drops the list, and the `to_status` cell drops `Equal to from_status is legal and usually a
mistake -- record the transition, not the state.` — the exact sentence that warns against the mistake
[0037](0037-2026-09-29-a-no-op-transition-is-a-real-entry.md) records.

This is an *absence* in the sense the template means: nothing is wrong with the values, and the
information exists — `--json` carries the full `value` **and** an `enum_values` array — so what is
missing is that the reading surface elides it.

## How it surfaced

I needed to record a `stage_transition` and had to know whether `in_progress` was a legal value.
`asc types show stage_transition` is the command whose whole purpose is to answer that, and it
rendered:

```
property.from_status    enum required [complete, in_pr…three the plan format allows.
property.to_status      enum required [complete, in_pr…he transition, not the state.
```

The truncation is not marked as "there is more", it is the standard table affordance, so the honest
reading of that line was "the vocabulary starts `complete`, `in_pr…`" — which is not enough to know
whether `in_progress` is in it. The next thing I did was record the entry, because recording is the
only other way to find out, and that mistake is 0037.

The failure path does print the full list (`'to_status' expects one of: complete, in_progress,
not_started.`), so the vocabulary is obtainable by being wrong. **Nobody was looking for it** — I was
looking for a legal enum value and the tool showed me a truncated one.

## The metric

Obtained with `node packages/cli/dist/bin.js types show stage_transition` and
`grep -c '…'`, against `--json` for the full values:

```
table rows containing a truncation marker: 7
total table rows: 18
```

and the cells, verbatim:

```
15:property.from_status    enum required [complete, in_pr…three the plan format allows.
18:property.to_status      enum required [complete, in_pr…he transition, not the state.
```

From `--json`, the value the table elided:

```
.rows[12].value = 'enum required [complete, in_progress, not_started] -- The status it had. One of the three the plan format allows.'
.rows[12].enum_values[0] = 'complete'
.rows[12].enum_values[1] = 'in_progress'
.rows[12].enum_values[2] = 'not_started'
```

`7 of 18` is a single type and a single reading, so this is a **measurement of the rendering, not an
estimate of how often it misleads**; the rate at which a truncated cell costs someone a wrong guess
is not measured here and is not claimed.

## The pattern

**A display surface that elides content is safe for prose and unsafe for a closed vocabulary or a
rule.** `enum required [complete, in_pr…` is not a shorter version of the field's description — it is
a different claim, one that is silent about having a boundary. Prose that is cut reads as prose that
is short; a list that is cut reads as a list that is short, and the reader has no way to tell.

The class is "the surface that exists to answer the question elides the answer", and it is worth
distinguishing from ordinary truncation because the fix is not "widen the column" but "know which
cells are not prose".

## Why nothing else would have caught it

A test **would** have caught it, and cheaply: `asc types show` has snapshot-shaped output, so
asserting that no `enum required` cell carries the marker would pin it. That is an argument for the
test, and it is why the bead asks for one alongside the fix rather than only for a wider column.

What no test would have caught is *which* cells matter, because that is a judgement about the meaning
of a cell and not about its length. The 7 markers are indistinguishable from each other in the
output; only one of them cost anything.

## Consequences and constraints

The fix is a rendering change, so it is reversible and cheap — but the bead's real content is the
rule it should leave behind: a cell whose value is a closed vocabulary, a default, or a refusal
message is rendered in full or rendered with the elision made explicit ("and 1 more"). A reader who
cannot tell a truncated list from a short one has been misled by a command that was trying to help.

`asc types show` is not a derived artifact of the store — the type definitions are — so nothing here
is a data problem and no invalidation applies.

## Links

- Bead: `asc-1gnl`
- The finding this one caused: [0037](0037-2026-09-29-a-no-op-transition-is-a-real-entry.md) (`asc-xvz5`)
- Entries recorded at the time: `df58e059-79f0-40fa-b034-5f80e0b5f140` (the false transition, struck),
  `f3f7fcba-a748-4b60-b876-108a77a3f225` (the real one)
