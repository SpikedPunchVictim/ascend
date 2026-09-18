# NNNN — <short title: the defect, not the fix>

<!--
  Copy this file to `dogfood/NNNN-YYYY-MM-DD-short-name.md` and fill it in.
  NNNN is the next free sequence number; the date is the date the finding SURFACED,
  not the date the bead was filed or fixed.

  This series is for findings that arrived by USING ascend, where nobody had asked the
  question. That is what separates it from `docs/evidence/EV-N.md`: an EV record answers a
  question named in advance and carries pre-registered predictions. A dogfood record
  documents something that surfaced on its own. If you wrote the question down first, it
  belongs in docs/evidence/. If the tool handed it to you, it belongs here.

  Delete any section that genuinely does not apply, but do NOT delete "The metric" -- a
  finding without a measurement is an impression, and impressions belong in a bead comment
  rather than in this series.
-->

| | |
|---|---|
| **Bead** | `asc-xxx` |
| **Surfaced** | YYYY-MM-DD |
| **Surfaced by** | <the command, query, or activity that produced it> |
| **Entry type(s)** | <type> (<starter \| derived \| project-defined>) |
| **Severity** | <P0..P3, matching the bead> |
| **Status** | open / fixed in `<sha>` |

## What was found

One paragraph. State the defect, not the remedy. If the finding is an *absence* — something
that should happen and does not — say so explicitly, because absences are the ones a code
review will not catch.

## How it surfaced

The mechanism, in enough detail that someone could hit it again. The useful question is not
"what is wrong" but "what made it visible", because the mechanisms repeat even when the
findings do not. Recorded examples so far: a pre-registered prediction tested against real
output; the unclassified remainder of a rule; a discipline task auditing itself.

Say plainly whether anyone was looking for this. "Nobody was looking for it" is the single
most valuable sentence in this series — it is the evidence that dogfooding pays for itself.

## The metric

**Required.** Every measurable claim carries the measured value AND how it was obtained.
Paste exact tool output rather than paraphrasing it: a paraphrase of a number is a new
number, and only exact text can be matched by a later search or re-check.

Where a value does not exist, OMIT it. Never write `0` for unknown.

If a group is under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`), say so — an
anecdote reported as an estimate is the failure this project exists to prevent.

## The pattern

What class of problem is this an instance of? A finding that generalizes is worth more than
a finding that does not, and naming the class is how the next one gets recognized faster.

## Why nothing else would have caught it

Be specific and be honest. If a test or a review *would* plausibly have caught it, say so —
that is an argument for a test, and it makes the rest of this series more credible, not less.

## Consequences and constraints

Anything that limits the response. The common one: **entries are immutable**
(`entries_are_immutable`, `entries_cannot_be_deleted` are enforced by trigger), so a finding
about bad data is never a cleanup task — the options are prevention at write time, or an
invalidation annotation.

## Links

- Bead: `asc-xxx`
- Evidence record, if the finding came out of one: `docs/evidence/EV-N.md`
- Entries recorded at the time: `<entry ids>`
