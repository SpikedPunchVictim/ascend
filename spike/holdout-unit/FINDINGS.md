# asc-6ola.4 — does guidance survive compaction? Findings, and the holdout unit they settle

Predictions sealed in `PREREG.md` (sha256 `fc89d74c…3237`, in the bead notes) before any treatment
run. Raw rows are in `*.out` (`T-first.out` is haiku T rep 0, run alone to check the mechanics
under the sealed protocol). 23 sessions, $5.40 total. Claude Code 2.1.280.

**Every group here is under MIN_N (20). These are anecdotes with intervals, not rates.**

## Result

| arm (model) | step 2: follows it, same segment | step 4: follows it, after compaction | summary mentions `vetted` |
|---|---|---|---|
| T (haiku) | 5/8 [30.6, 86.3]% | 3/8 [13.7, 69.4]% | 4/8 |
| TS (haiku, CLAUDE.md strip line) | 3/8 [13.7, 69.4]% | 1/8 [2.2, 47.1]% | 3/8 |
| C (haiku, no guidance) | 0/4 | 0/4 | 0/4 |
| T (sonnet 5) | 1/3 [6.1, 79.2]% | 0/3 [0.0, 56.1]% | 3/3, and `[asc:` markers in 3/3 |

| # | prediction | result |
|---|---|---|
| S1 | T step 2 ≥ 7/8 | **refuted**: 5/8 |
| S2 | C: 0 compliance | confirmed: 0/4 at both steps |
| S3 | T step 4 ≥ 4/8 (compaction does not wash out) | **refuted by one**: 3/8. Of the 5 that followed it before compaction, 3 still followed it after. |
| S4 | every step-4 compliance has a summary mentioning `vetted` | confirmed: 4/4 across T and TS |
| S5 | TS step 4 < T step 4 | held, 1/8 vs 3/8, but **confounded**: TS also lowered step 2 (3/8 vs 5/8), so the strip line weakened the guidance itself, not only its carryover |
| S6 | sonnet step 4 ≥ 2/3 | **refuted**: 0/3, although its summaries kept the guidance, markers included, 3/3 |

The sealed decision rule was conditioned on S3 holding, and S3 missed by one. I'm not reading
that as "compaction washes guidance out". 3 of 5 carried over, and the interval is
[23.1, 88.2]%. The rule's escape was "TS ≤ 1/8". TS landed on exactly 1/8, but for a confounded
reason, so it does not settle the question either.

## What it says

1. **Compaction is not a washout.** Guidance that took hold in a segment survived into the next
   one in 3 of 5 cases (haiku). The summary is the only path. Every carryover had a summary
   mentioning the guidance, and with guidance delivered but no mention, carryover was 0/9
   [0.0, 29.9]%. That makes a compaction segment an **unclean** unit. Its control arm inherits
   treatment through the summary.
2. **The leak can be detected per segment.** A summary mention is a sensitive flag: it was
   present in every carryover, 0 false negatives in 9. It is not specific: 4 of 10 mentions
   carried over. Replay already reads the summary (it is an `isCompactSummary` record), so each
   segment can carry a *contamination flag* for each intervention. That is the same pattern as
   `guidance.delivery`: derived by replay, never trusted from the live side.
3. **You can't prevent the leak.** PreCompact cannot change the instructions, and the CLAUDE.md
   strip line lowered compliance in the segment where the guidance was delivered. Removing guidance
   from the summary costs the guidance its effect.
4. **Unasked, and it matters for asc-6ola.3.** Guidance delivered through PostToolUse
   `additionalContext` was followed at the very next opportunity in only **5/8 (haiku)** and
   **1/3 (sonnet)**. The power check assumed a 50% reduction for M1 and 30% for M2. If only
   about half of deliveries are followed at all, a lesson that fixes every instance it reaches
   yields about half its effect. Effect sizes should be planned from measured compliance, not
   assumed.

## Settled design for the holdout unit

- **Randomize per segment × intervention**, where a segment runs from session start or a
  compaction boundary to the next one. That gives about 116 units here instead of 4.
- **Derive a contamination flag by replay** for each segment: the segment's inherited summary
  mentions the intervention (its marker or the payload's distinctive terms). A flagged
  held-out segment is **exposed**, not control.
- **The analysis compares clean controls with treated segments.** Reporting also includes the
  diluted comparison, where flagged controls stay in the control arm, as a lower bound, plus the
  count of excluded controls. The power check (asc-6ola.3) counts only clean controls toward
  MIN_N and power.
- **Session × intervention stays available** for projects with short sessions, pooled across
  projects at user level (46 sessions pooled). The power check picks whichever unit gives more
  clean units over the horizon.
- **Consequence for asc-6ola.2's `guidance.decided`**: the assignment key is
  `(session_id, segment_index, intervention)`, and `segment_index` is known live, because
  SessionStart fires with source `compact`.

## Limitations

- Every group is under MIN_N. One harness version, and two models with 3 sonnet reps.
- These are tiny sessions, where the guidance is a large share of what gets summarized. Summary
  mention and carryover are both likely **upper bounds** for real sessions. Nobody measured how
  a mention's rate falls with the amount of other context.
- One guidance item, a formatting convention. Guidance with a stronger reason to follow it may
  behave differently.
- The flag's specificity (4 of 10 mentions carried over) means excluding flagged controls also
  drops some clean ones. With so few units, the cost can't be quantified.
