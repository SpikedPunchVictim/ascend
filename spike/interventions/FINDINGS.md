# asc-6ola.1 — real lessons against the intervention shape: findings and design

Predictions sealed in `PREREG.md` (sha256 `54b203aa…fad22`, in the bead notes) before classifying.
Data: the 33 `bd remember` memories. Labels live in `classify.mjs`. The tallies are computed from
them.

## Result

```
memories 33 kinds [["lesson",20],["fact",9],["record",4]]
I1 not lessons            13/33 = 39% (pred >= 25%)
I2 trigger = event        10/20 = 50% (pred >= 50%)
I3 check exists           11/20 = 55% (pred >= 30%)
I4 classes                [["false-green",9],["measurement-validity",3],["concurrency",2],["encoding-terminator",2],...] (pred: one class >= 5)
I5 needs > 1 intervention 10/20 = 50% (pred >= 20%)
I6 trigger = none         7/20 = 35% (pred >= 25%)
false-green: triggers [["event",4],["none",3],["window",2]] checks [["exists",6],["possible",2],["no",1]]
```

All six held. I2 held exactly at its boundary. **One rater**, and that rater also wrote the
predictions, so a second rater should re-label `classify.mjs` before these proportions are
quoted as estimates. n = 20 lessons is exactly MIN_N; the per-class counts under it are anecdotes.

Can a check's catch be seen? The test files named by the 11 `exists` checks appear in this
project's tool output 22–92 times each, with 2–15 failing runs each (file-level match on vitest
output). Catches are observable. Two conditions apply: a locator must name the *test*, not the
file, and mutation-harness runs must be separated out, because a check failing under a planted
mutation is validation, not a catch.

## What the result says

1. **Most "lessons" are not interventions.** 13 of 33 are facts or records: driver behaviour,
   decisions such as `kysely-rejected`, progress notes. They stay where they are. Interventions are
   the actionable subset, not a new home for all knowledge.
2. **More than half the lessons were already mechanized, and nothing knew it.** 11 of 20 have an
   enforcing test on disk. None is linked to its lesson, so nobody can ask "which lessons have a
   check, and did the check ever catch anything?". Registering these 11 is the first cheap win.
3. **Checks guard instances. The class kept recurring.** False green holds 9 of the 20 lessons, and
   6 of those 9 have a check. Those checks pin the *specific* mechanism (`set -e` in an if, stdin
   through `spawnSync`, …), while the class recurred through a new mechanism each day from 09-11 to
   09-15. A class needs its own intervention, above the instance checks.
4. **"No detectable trigger" does not mean "no moment".** The 7 `none` lessons (35%) apply to
   reasoning: "is this guard proven to fail?", "is this count a rule or a reading?". Nothing in a
   file edit gives them away, but they all bite at the moment of a **claim**: "tests pass",
   "fixed", "N = …", handing work to review. That moment *is* an event: `Stop`, a `bd close`, a
   review agent's start. Class-level interventions attach to lifecycle events, not content events.
5. **Lesson to intervention is one-to-many** (I5: 10 of 20). `stdin-pipe-eagain` wants a check (it
   has one) *and* guidance when `readFileSync(0)` is written.

## Design

**Three kinds**, all versioned the same way:

| kind | fires on | exposure is | a "catch" is |
|---|---|---|---|
| `guidance` | a content event (`file.changed`, `command.run`, tool input) matched by a handler | `guidance.decided` + `guidance.delivery` (asc-6ola.2) | derived by analysis: the behaviour moved against the holdout |
| `check` | whenever it runs (a test, lint rule, align rule) | a `verification_run` whose output names the locator | the locator **failed and then passed** within a non-mutation session |
| `checklist` | a lifecycle event (`Stop`, `bd close`, review start) | as guidance | as guidance; plus reviewer findings of the target class falling (asc-gtnu) |

**Storage mirrors `entry_types`.** Definitions are immutable, and a new shape is a new row:

```
interventions(name, version, kind, spec_json, intervention_hash, created_at)
intervention_targets(name, version, scheme, label)      -- the class(es) it addresses; many-to-many
intervention_evidence(name, version, ref_kind, ref)     -- entry id, bead, EV doc, dogfood record, memory key
intervention_status(name, version, status, reason, evidence_ref, at)  -- append-only
```

- **Every change is a new version**, not a minor/major split. Guidance wording is the treatment,
  so any edit changes what is being measured. The exposure record already carries
  `intervention_version` and `payload_sha256`.
- **Status is a log, not a column**, because definitions are immutable: `unproven → active →
  retired | superseded`. Promotion to `active` needs an evaluation reference (a holdout comparison
  or, for a check, at least one observed catch). This is the Design Reserve's
  promotion-on-evidence, applied to lessons. A new guidance item may be delivered while `unproven`,
  since that is how evidence gets collected, but only with a holdout.
- **The class vocabulary reuses annotation schemes.** A `failure_class` scheme's labels
  (`false-green`, `measurement-validity`, …) are what interventions target *and* what reviewer
  findings (asc-gtnu) are annotated with. One vocabulary on both sides is what makes the join, and
  the escape rate, computable.

**Spec shape per kind** (spec_json):
- `guidance`: `trigger` (a handler: `on`, `where`, optional `window`), `channel`, `payload`
  (≤ a byte budget well under the measured ceiling), `budget` (per session), `cooldown`,
  `holdout_rate`.
- `check`: `locator` (`{runner: 'vitest', file, test}` · `{runner: 'align', rule}` · …),
  `mutation_marker` (how to recognise a validation run, which is excluded from catches).
- `checklist`: `trigger` (a lifecycle event), `items`, `holdout_rate`.

## First use, when implementation lands

1. Register the 11 existing checks as `check` interventions, targeting their class, with the
   memory key as evidence. Their catches become countable immediately from the replayed history.
2. Register one `checklist` for `false-green` on the "claim" lifecycle events, with a holdout.
   It's the one class with enough lessons (9) and a demonstrated recurrence.

## Limitations

- One rater, one project, one hand-written lesson store.
- File-level catch detection only; test-level locators are untested.
- The lifecycle events for "a claim is being made" (`Stop`, `bd close`, review start) are
  asserted from the lesson texts, not measured.
