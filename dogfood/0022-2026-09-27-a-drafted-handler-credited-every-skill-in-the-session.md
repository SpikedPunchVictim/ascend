# 0022 — a drafted capture handler credited a table to every skill loaded before it, and counted one refusal twice

| | |
|---|---|
| **Bead** | `asc-tuur.5` (both defects fixed before commit, in `9792efb`); the remaining gap is `asc-tuur.8` |
| **Surfaced** | 2026-09-27 |
| **Surfaced by** | `asc types capture review_finding --json` on this repository's own transcripts, run to check Stage 4's success criterion |
| **Entry type(s)** | `review_finding` (derived) |
| **Severity** | P2 |
| **Status** | fixed in `9792efb`; the lens-number gap is open as `asc-tuur.8` |

## What was found

Two defects in the first real run of `asc types capture`, the command that drafts a handler for a
newly defined type out of what sessions already write.

1. **Every skill loaded earlier in a session was credited with the table.** The drafted `say:`
   handler would have spoken whenever any of four skills loaded, including `find-skills` and
   `cli-best-practices`. Only one of them, bug-hunt, writes the table. Installed, that draft puts
   a review sentence into sessions that are not reviews.
2. **A refusal was counted once per validation issue, not once per row.** The report said 34
   refusals on `class` for a draft that produced 17 rows.

## How it surfaced

The run was checking one thing: whether the draft is equivalent to the hand-written
`handlers/review-finding-table.yaml`. **Nobody was looking for either defect.** Both were visible
only because the report prints each skill it credits and each refusal count beside the row count.
The unit fixtures had one skill per session, and each refused row had only one issue per field, so
they could not show either.

## The metric

Exact output, first run (before the fix). 98 files, one project directory:

```
table[0] rows 17
table[0] skill[0] bug-hunt (1 session(s) -- under 20, an anecdote)
table[0] skill[1] cli-best-practices (1 session(s) -- under 20, an anecdote)
table[0] skill[2] empirical-planning (1 session(s) -- under 20, an anecdote)
table[0] skill[3] find-skills (1 session(s) -- under 20, an anecdote)
draft rows 17
draft would_write 0
draft refused 17
draft refused.class 34
draft refused.file 17
    in: [bug-hunt, cli-best-practices, empirical-planning, find-skills]
```

After the fix (credit the skill loaded last before the Write; count rows per field):

```
table[0] skill[0] bug-hunt (1 session(s) -- under 20, an anecdote)
draft rows 17
draft would_write 0
draft refused 17
draft refused.class 17
draft refused.file 17
    in: [bug-hunt]
```

One session holds the table, so this is an **anecdote**. The same 17 rows run through the
hand-written handler, ingested into a scratch store from a copy of that one transcript, printed
`17 rejected`, all for `file`. So on the same scope, the draft and the hand-written handler both
write 0. The draft's extra failure is `class`: this report's Lens cells are numbers ("6", "1, 8"),
and the draft cannot map them yet (`asc-tuur.8`).

## The pattern

**Attributing by co-occurrence where the data has an order.** "Loaded in this session" is a set;
"loaded just before this Write" is the claim the draft actually needs. Counting issues where the
claim is about rows is the same mistake: a denominator that is not the thing being reported.

## Why nothing else would have caught it

A fixture with two skills before the table, or with two issues on one field, would have caught
either one. Neither existed. A test for the first now does
(`credits a table to the skill loaded last before it`).

## Links

- Bead: `asc-tuur.5`, `asc-tuur.8`
- Evidence: `spike/capture-hooks/NUDGE-FINDINGS.md` (the nudge the say draft imitates)
