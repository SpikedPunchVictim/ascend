# 0115 — A sizing instrument that refuses every nudge

| | |
|---|---|
| **Bead** | `asc-xg62` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | `asc handlers power`, run because `asc-09wx.12` names it as the way to size the commit-risk nudge before spending anything |
| **Entry type(s)** | none — no entry is written; the finding is about the planning arithmetic |
| **Severity** | P2 |
| **Status** | open |

## What was found

**`asc handlers power` cannot plan a nudge, and a nudge is the only thing the epic it was written
for produces.** The command's outcome is `a trigger in the segment produced a row`; a `say:`
handler compiles to *"an emit of one field, `say`"*, so every trigger emits exactly one row and
`successes == units`. `whyNot` refuses on that identity before any arithmetic runs, so the command
returns `nothing to plan` for **every** `say:` handler that exists or could exist. It plans a
*capture* handler (`handlers/edit-unverified.yaml` plans fine) and cannot plan the *nudge* that
capture exists to size.

There is a second, deeper instance of the same mismatch underneath the first. Even given an
outcome with variance, the outcome a nudge exists to move is not in the event stream: `EV-63`'s
outcome — *a later commit rewrites one of the commit's source lines inside the window* — is a git
fact, and `packages/cli/src/handler-replay.ts` replays transcripts. So the base rate the plan is
built on cannot be supplied by this instrument for this class of intervention at all.

## How it surfaced

**Nobody was looking for it, and the near-miss is the interesting part.** The step was a handoff
instruction: *"use the existing holdout arm (asc-xn4g) and `asc handlers power` to size it first."*
That reads as a mechanical step — write the handler, pass the file, read the number — and it is the
step a session would take without a second thought. Two things had to be true for the refusal to be
visible rather than misread:

1. **The `say:` handler had to be written before the command was run**, because there is no nudge
   handler in the repo to pass. The predicate used is the one `handlers/session-commit.yaml` records
   as the closest thing that exists, and `asc-hvnx`'s close (new `head`/`argv` on `tool.use.start`)
   made a second, pre-commit form expressible for the first time.
2. **The refusal had to be read as a refusal.** `units 851 / successes 851 / verdict "nothing to
   plan"` is the shape of *"there is nothing here"*, and the honest reading is the opposite: there is
   a great deal here — 851 units — and the instrument's outcome definition cannot see it. A session
   skimming for a number would have found `units_per_day`, `days_to_power` and `proportion` absent
   and reported "the tool says it cannot be sized", which is true and useless.

The `rows 4579 / triggers 4579` pair from `asc handlers check` is the same identity stated by a
different command, which is what turned the first read from a guess into a mechanism.

## The metric

Command, exact:

```
node packages/cli/dist/bin.js handlers power <probe>.yaml --effect 0.5 --all-projects --json
```

Corpus, from the `(log)` rows of that run:

```
(log).files = 2316
(log).events = 1412273
(log).first_ts = "2026-08-25T23:40:29.804Z"
(log).last_ts = "2026-10-15T19:16:21.910Z"
(log).ephemeral_skipped = 187
(log).unreadable = 0
```

Two probes, the only commit-moment predicates the repo has:

```
nudge-say-post  on: command.run,  where head eq git + argv contains commit
  units = 851   successes = 851   active_days = 48
  undated = 0   proportion = "no estimate"
  verdict = "nothing to plan -- the outcome was the same in all 851 units, so there is no
             variance for any effect size to move"

nudge-say-pre   on: tool.use.start, stage: pre, where tool eq Bash + head eq git + argv contains commit
  units = 736   successes = 736   active_days = 48
  undated = 0   proportion = "no estimate"
  verdict = "nothing to plan -- the outcome was the same in all 736 units, so there is no
             variance for any effect size to move"
```

The identity, stated by `asc handlers check` over the same corpus:

```
nudge-say-post  rows = 4579   triggers = 4579
```

**What the instrument does still yield, and it is the useful half**: 851 / 48 = **17.7 units per
active day** (post-commit) and 736 / 48 = **15.3** (pre-commit), where a unit is one compaction
segment containing a commit.

**The design effect is the number that decides the experiment, and it is not measured here.** The
closest measured analogue is the sibling handler over the same corpus and the same unit:

```
edit-unverified   units = 398   successes = 216   active_days = 34
                  clusters = 10   rho = 0.129   rho_source = "estimated"   design_effect = 18.614
```

At 17.7 units/day, baseline 0.540 (`EV-63` pooled `reworked_7` over 1,062 eligible commits) and a
50/50 holdout, the repo's own `powerPlan` gives, per design effect:

| design effect | 30% reduction | 50% reduction | smallest detectable in 90 active days |
| ------------- | ------------- | ------------- | ------------------------------------- |
| 1             | 17 days       | 6 days        | 13.0%                                 |
| 10            | 166 days      | 57 days       | 40.4%                                 |
| 20            | 332 days      | 114 days      | 55.8%                                 |
| 30            | 499 days      | 172 days      | 66.8%                                 |

`de = 1` is not a candidate; the sibling handler measured 18.6 on the same units. The realistic
column is 300–500 active days, and it rests on a design effect that has not been measured for this
outcome — which is itself the thing to measure next, not to assume.

## The pattern

**An instrument whose coverage silently excludes the artifact it was prescribed for.** The command
runs, exits 0, and prints a well-formed refusal; nothing about that says *"my outcome definition
does not describe your intervention"* rather than *"your intervention has no signal"*. The class is
the same one `dogfood/0104` records from the other side: `command.run` could not carry a pre-command
handler, and the gap only became visible when something needed to fire before a command ran. Here
the gap became visible when something needed to be *sized* rather than *captured* — the same
vocabulary, one layer up.

The tell to recognize it faster: **a refusal that is structurally guaranteed for a whole class of
inputs rather than discovered in one.** `successes == units` is not a property of the nudge being
sized; it is a property of what `say:` compiles to. A refusal that would fire for every member of a
class is a statement about the instrument.

## Why nothing else would have caught it

Nothing in the test suite, and that is by construction rather than by omission. `handlers-power.test.ts`
drives the command over a fixture corpus whose handler uses `window:`/`absent:` and so has genuine
variance — 15 of 30 — which is what makes its expected sample size a number checkable by hand. Every
one of its twelve cases is green and correct. A `say:`-handler case is absent because before
`review-finding-nudge.yaml` the repo had no `say:` handler at all, and after it the two were never
put in the same sentence: the nudge is delivered by `asc hook` and the capture is read by
`asc handlers check`, and until `asc-09wx.12` asked for a *sized* nudge nothing needed both.

A reviewer would not have caught it either. The code is correct at every line: `say:` compiles to a
one-field emit because that is what a sentence is, and `plan()` takes `rows > 0` as its outcome
because that is what a replayed handler produces. The defect is in the *composition* of two correct
decisions, which is exactly the layer a per-file review does not reach.

## Consequences and constraints

- **This does not block `asc-09wx.12`; it re-specifies it.** The bead's own instruction — *"size it
  first with `asc handlers power`"* — cannot be carried out as written. The unit rate is available
  (17.7/active day); the base rate and the design effect are not, and both are needed.
- **Entries are immutable**, but no entry is involved: this finding is about a planning command that
  writes nothing.
- **No nudge handler exists to size**, and this record does not create one. The predicate used above
  is `asc-09wx.10`'s, which its own docblock states is not the nudge.
- **The decision is the owner's**: whether `asc handlers power` grows an outcome mode for
  interventions whose outcome lives outside the event stream, or whether sizing a nudge belongs to a
  git-side measurement beside `asc ingest git` — which already derives `size_top_decile` per commit,
  and so already holds the risk predicate the nudge would fire on.
- **The realistic answer is not a flag.** The design effect above 1 is the term that decides this,
  and it is driven by the unit being the compaction segment while the correlation lives in the
  session. Measuring that design effect for the rework outcome is the cheap next step.
- **Measured, 2026-10-15** — `docs/evidence/EV-71.md`. The design effect is **3.336** on the
  gradeable units (`rho` 0.1613, `rhoSource` estimated), 5.6x cheaper than the sibling below, so
  the clustering correction is *not* what constrains this experiment. Coverage is: only 104 of 852
  units carry a gradeable outcome, and widening the rework trace to every source-bearing commit in
  all eight repositories — about four minutes of wall clock — takes the arm from 472 active days to
  74. **The prediction table above is therefore wrong in both directions**: pessimistic about
  clustering, optimistic about accrual, and its `de = 1` row is not the relevant baseline. `EV-71`
  supersedes those day estimates; they are left as they were written.
- **Registered, 2026-10-15** — `docs/evidence/EV-72.md`. The arm's rule is `any` at the segment
  level: a unit counts as reworked if any of its source-bearing, window-closed commits was, which
  is the intent-to-treat outcome at the level the hook randomizes (`asc-6ola.4`). **70 active days**
  for a 30% reduction, on baseline 0.78173 and 8.2083 units per active day. The commit-level
  analysis the arm might have used instead was measured and closed: on the cluster key consistent
  with `EV-71` it costs 82 days, and the 15-day figure it can be made to show is the
  between-segment-within-session correlation assumed away, not information gained.

## Links

- Bead: `asc-xg62` (P2, open) — discovered from `asc-09wx.12`
- The bead this re-specifies: `asc-09wx.12` (P3, open)
- The refusal's sibling finding, from the other side: `dogfood/0104`
- The bead that closed the delivery half: `asc-hvnx` — `tool.use.start` now carries `head` and `argv`
- Evidence in play: `docs/evidence/EV-61.md` (fire rate and thresholds), `EV-63.md` (the rework
  outcome and its base rates), `EV-65.md` (why the size must come from the working tree)
- What measuring the design effect actually cost, once done: `docs/evidence/EV-71.md`
- The artifact that says it is not the nudge: `handlers/session-commit.yaml`
- The handler that plans, used above as the design-effect reference: `handlers/edit-unverified.yaml`
