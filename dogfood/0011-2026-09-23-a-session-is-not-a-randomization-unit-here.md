# 0011 — a per-session holdout has about two units per arm in this project

| | |
|---|---|
| **Bead** | `asc-6ola.4` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | `node spike/power/power.mjs` (asc-6ola.3), replaying this project's transcripts to size a holdout comparison |
| **Entry type(s)** | none yet; it concerns the planned `guidance.decided` holdout arm (asc-6ola.2) |
| **Severity** | P1, matching the bead |
| **Status** | open |

## What was found

asc-6ola.2 settled that the holdout is assigned per session × intervention, because a model that
has seen guidance carries it for the rest of the session. In this project a session is not a
unit there are many of. Sessions run for days and are compacted dozens of times, so a
comparison between sessions has about four units in total. However many events those sessions
hold, the comparison is bounded by the sessions. The design was settled one bead earlier and
nothing in it checked the count.

## How it surfaced

The power check was pre-registered (`spike/power/PREREG.md`, sealed `bc800c7b…5c40`) to measure
event rates, within-session clustering and days to power. Nobody was looking for how many
sessions there were. It showed up as a line nobody asked about — `sessions 4` beside
`units 1236` — and as an ICC that clamped to exactly 0. An ICC of 0 from 4 clusters is not
"no clustering"; it is an estimator with nothing to estimate from. Reading the zero as a zero
would have been the search-miss mistake in statistical form: an empty result read as an answer.

## The metric

From `node spike/power/power.mjs <scratchpad>`, on the frozen corpus (1,007 transcripts, frozen
2026-09-23T06:46:47Z):

```
M1 search miss / this project: sessions 4 (active days per session: median 6, max 6); P(no session held out at 20%) 41.0%
M2 failing test run / this project: sessions 3 (active days per session: median 6, max 7); P(no session held out at 20%) 51.2%
M1 search miss / pooled: sessions 46 (active days per session: median 1, max 17); P(no session held out at 20%) 0.0%
```

Compactions, by `grep -c '"subtype":"compact_boundary"'` per top-level transcript in this
project's directory: `94` in `96a5a5d3…`, `18` in `f5717795…`, and none in the other two.

All session counts here (4, 3) are under MIN_N (20). That is the finding itself, not a caveat on
it: the unit count is an anecdote-sized group by construction.

## The pattern

A unit of analysis chosen by argument ("a model carries guidance for the rest of the session")
without counting how many of that unit exist. The argument is right about contamination and says
nothing about supply. It belongs to the same family as `MIN_N` readiness. The power check found
that clearing MIN_N per arm arrives 57–204× before the comparison is powered. Both are a count
that looks sufficient because it counts the wrong thing.

## Why nothing else would have caught it

The exposure probe (asc-6ola.2) ran ephemeral one-prompt sessions, where session and prompt are
the same thing. A design review would have accepted the contamination argument, because it is
correct. Only replaying the real project's history shows that sessions here last a week.

## Consequences and constraints

Nothing has been recorded under the session design yet, so no entries need an invalidation
annotation. The fix is in the design: choose the unit (the compaction segment is the candidate),
and make the power check refuse a unit with fewer than MIN_N expected per arm.

## Links

- Bead: `asc-6ola.4` (parent `asc-6ola`; found by `asc-6ola.3`)
- Pre-registration and findings: `spike/power/PREREG.md`, `spike/power/FINDINGS.md`
- The design it revises: `spike/exposure/FINDINGS.md` ("Holdout")
