# 0055 — An epic closed with no reason, three requirements named in its own criteria and its child's close reason that were never built, and a plan line asserting the opposite of the tracker

| | |
|---|---|
| **Bead** | `asc-fwpe`, `asc-0hys`, `asc-jpka` (filed from this); epic `asc-xgo` re-close |
| **Surfaced** | 2026-10-02 |
| **Surfaced by** | adversarial verification of `asc-xgo`'s criteria against the tree, on being asked to close it |
| **Entry type(s)** | none — this is about the tracker and the plan document, not about entries |
| **Severity** | P0 epic, closed unfounded |
| **Status** | open |

## What was found

`asc-xgo` (E7, the analysis layer) was closed on 2026-09-18 with the close reason
`Closed` — the default, carrying no information at all. Its nine children are genuinely done,
test-pinned and CLI-reachable, which is why it read as *eligible for close*. But the epic's own
stage criteria carry three requirements that **do not exist in any form**:

1. the **tautology check** EV-patterns names as a required addition to E7,
2. the **temporal-block control** the same document names alongside it, and
3. the **effective-sample-size / pseudoreplication check** `asc-xgo.1`'s close reason asserts as a
   "NEW REQUIREMENT FOR E7".

This is an *absence* — the thing the template warns a code review will not catch, because there is no
line of code to look at. Worse, one criterion was satisfied in the library and unmet on the surface it
is stated about: the shuffled-label control exists and is test-pinned, but `asc stats` cannot reach it.

## How it surfaced

The mechanism is the one worth recording: **verify an epic's criteria against the current tree rather
than trusting its children's close reasons.** A closed child is a claim, not evidence, and an epic's
progress bar (`9/9 complete`) counts *children closed*, never *criteria met*. Every one of the nine
children here was accurate about itself; the epic was still unfounded, because the requirements that
were never built were never given a child. An epic accumulates requirements from three places — its
plan stage, its children's close reasons, and the evidence documents it cites — and a close checks
none of them.

**Somebody was looking.** I ran this audit deliberately, and it is the fourth epic verified this way;
three of four had a criterion their code did not back. So this is not a case of the tool handing me
something unasked — it is the *discipline* paying for itself, and it should be read that way.

What the tool DID hand me unasked was the second finding, which I was not looking for: a line I
committed to `IMPLEMENTATION_PLAN.md` **earlier the same day** reads "E7 (`asc-xgo`) is 9/9 complete
and eligible for close; left open because it was not in scope for this pass." `bd show asc-xgo`
returns `status: closed`, `closed_at: 2026-09-18T10:00:52Z`. The plan asserted a status four days
stale, in the same sentence that declared the epic sound. Nothing checks a claim about a bead's status
against the bead.

## The metric

- The three requirements, absent from source:
  ```
  $ grep -rniE "tautolog|temporal.block|pseudoreplic|effective.sample|within.day" packages/*/src
  (no output — 0 matches)
  ```
- And absent from the tracker, so not merely unimplemented but untracked:
  ```
  $ bd search tautolog
  No issues found matching 'tautolog'
  $ bd search pseudoreplic
  No issues found matching 'pseudoreplic'
  ```
- The shuffled-label control, unreachable from its surface:
  ```
  $ grep -rn "permutations" packages/cli/src/commands/stats.ts
  (no output — exit 1)
  ```
  `rankAssociations` is called with one argument at `stats.ts:387`, so `permutations` defaults to 0
  and `pPermuted` is omitted. The only callers passing it are tests.
- The status contradiction, exactly as the tracker printed it:
  ```
  $ bd show asc-xgo --json | ... 
  status         'closed'
  closed_at      '2026-09-18T10:00:52Z'
  close_reason   'Closed'
  ```
- Requirement counts are all well under `MIN_N` (20) as *instances* — three unbuilt requirements, one
  stale plan line, in one epic. These are anecdotes. The *class* has the larger N: this is the fourth
  epic audited and the third whose criteria its code did not back (4/4 audited, 3/4 unfounded).

## The pattern

**A criterion is satisfied by default when the operation it describes does not exist.** The repo named
this shape once already — E8's "dropping a scheme loses no entry data" is technically true because no
drop operation exists (`asc-4uex`). Here it recurs at the epic level: a required control that was never
built cannot fail, so nothing flags it. The general form is that *absences pass every check written
against presence* — a grep for what is there cannot see what is missing, and a progress bar counts the
children you made, not the requirements you inherited.

The second pattern is narrower and staler: **a document's claim about a tracker's state is unchecked
prose.** The plan line was true when plausible and false when committed; nothing reconciles the two.

## Why nothing else would have caught it

`asc doctor` reads the store, not the plan or the bead graph. The full gate (`format:check`, `typecheck`,
`lint`, `test`, `align`) is all green with these three requirements missing — it checks code against
tests, and there is no test for a requirement that was never written. The nine children's own tests are
green and honest. Even a careful reading of `asc-xgo` would not have caught it, because the requirements
live in the *plan stage* and in a *child's close reason*, not in the epic's description. Only reading
the epic's criteria and then grepping for the code that would satisfy them finds it.

## Consequences and constraints

The three gaps are filed (`asc-fwpe`, `asc-0hys`, `asc-jpka`) and the Stage 4 criteria amended to name
them as unbuilt rather than carried-in-done. Reopening the epic is not the remedy — the nine children
are done and reopening says otherwise; the remedy is that the *close reason* names the gap, which this
record and the re-close supply. EV-patterns is already honest about its own status (`:151-153`, "the
two controls proposed above are untested designs, not measured remedies"), so no evidence document
needs correcting — only the plan and the close reason, which claimed more than the evidence did.

## Links

- Beads: `asc-fwpe`, `asc-0hys`, `asc-jpka`; epic `asc-xgo`
- Evidence record: `docs/evidence/EV-patterns.md` (the controls, `:126-138`; the ESS gap, `:225-230`;
  its own limitation, `:151-153`)
- Related: `asc-4uex` (the same vacuous-satisfaction shape at E8), `dogfood/0045`
- Plan text amended: `IMPLEMENTATION_PLAN.md`, Stage 4, the EV-constraints paragraph and the status line
