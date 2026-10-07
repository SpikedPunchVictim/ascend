# 0066 — a p floor whose iteration count came from the other control

| | |
|---|---|
| **Bead** | `asc-h3sv` |
| **Surfaced** | 2026-10-06 |
| **Surfaced by** | writing the `--help` text for `--permutations`, and having to decide whether the floor was a constant or arithmetic |
| **Entry type(s)** | `evidence_record` (project-defined); the corpus is `tool_denial` (project-defined) |
| **Severity** | P3 |
| **Status** | fixed in this pass — the command states the floor as arithmetic, and the record carries a dated Amendment |

## What was found

`docs/evidence/EV-patterns.md` states that the shuffled-label control, the one every verdict in its
tables was gated on, floors at **p = 0.0025 = 1/5001** because it ran **5,000 iterations**. It ran
**400**. The number and the parameter are both real, and they belong to two different controls: 400
is the shuffled control in `spike/spike-patterns.mjs:86`, the file the record names as its own method;
5,000 is `spike/spike-controls.mjs:27`'s **block** control, which is a different null over a
different column and which, at `:256`, uses 400 itself for its own shuffled re-check. The record
lifted the count from one instrument and stated it as the other's, and the two agree to four decimal
places — `1/401 = 0.0024937655860349127`, which prints as `0.0025` — so nothing looked inconsistent.

## How it surfaced

Nobody was looking for it. It arrived from a piece of work that had to *state* the floor rather than
use it: `asc-jpka` puts the shuffled control on the command surface, and the acceptance asks the
report to print "the achievable p floor". Printing a constant would have been one line. Deciding
whether it *was* a constant meant opening the file that produced the published numbers, and the file
says 400.

The mechanism is the one this series has already named twice (`0065`, and `0064`'s correction): **a
number travels between instruments without its parameter.** What is new here is the direction it
travelled. `0065` was a correction that reached a document instead of the code. This is a number that
reached a *document from the wrong code*, and then was quoted onward as fact — it is reproduced in
the confidence section, in the method section, and in the `asc-h7nq` Amendment, and it is the
parenthetical of `asc-jpka`'s own acceptance:

> …and the achievable p floor (EV-patterns measured a 5,000-iteration floor of p=0.0025)

A work item's definition of done inherited a wrong number from the record it was citing. That is the
part worth keeping: the error did not stay in the evidence file, it became a requirement.

## The metric

**The instrument the record names as its method runs 400 iterations.** `spike/spike-patterns.mjs:86`:

```
      const nul = permutationNull(a, b, { iterations: 400, seed: 12345 });
```

That is the only `iterations:` literal in the file:

```
$ git log -p --follow -- spike/spike-patterns.mjs | grep -n "iterations: [0-9]*"
145:+      const nul = permutationNull(a, b, { iterations: 400, seed: 12345 });
```

**One line, added in `2904153` ("E1 + E2: repo foundation and pure core"), never revised.** The file
has said 400 since it existed, so this is not a spike that drifted away from a record that was once
right — the record was wrong when it was written.

**The 5,000 belongs to the block control.** `spike/spike-controls.mjs:27`:

```
const ITERATIONS = 5000;
```

and the same file re-uses 400 for its own shuffled re-check at `:256`:

```
    const nul = permutationNull(p.aValues, p.bValues, { iterations: 400, seed: 12345 });
```

**The two floors are not distinguishable at the precision the record quotes.**
`1/401 = 0.0024937655860349127`, `toFixed(4)` → `0.0025`. The record's `1/5001` is
`0.0001999600079984003` → `0.0002`. The record quotes `0.0025` **and** `1/5001` in one sentence, and
the two contradict each other; that contradiction was in the file and was read past.

**Every occurrence, and which ones are wrong** — `grep -n "5,000\|5000\|1/5001\|1/401"
docs/evidence/EV-patterns.md`:

| line | claim | verdict |
|---|---|---|
| 22 | method: the shuffled control ran "(5,000 iterations, seeded)" | **wrong** — it is 400 |
| 156–157 | "The 5,000-iteration control floors at p=0.0025 … at 5,000 iterations the smallest achievable p is 1/5001" | **wrong**, and self-contradictory |
| 293 | Correction 2: "Permuting whole **days' weekday labels** among days … 5,000 iterations, seeded" | **correct** — that is the block control, and it does run 5,000 |
| 539, 541 | the `asc-h7nq` Amendment: "The snapshot's table used **5,000** iterations; the shipped command hard-codes **500**" | **wrong** on both sides — the snapshot's *shuffled* table used 400, and the 500 the command hard-codes is `BLOCK_ITERATIONS`, a third control again |

Five occurrences, four wrong, and only one of the five is the thing it says it is. The finding is
scoped to the shuffled control's floor; the block control's 5,000 is real and is not in question.

**Measured live, after the fix** — `asc stats tool_denial --assoc --permutations 400`:

```
Warning: the shuffled-label control ran on every pair at 400 iterations, so the
smallest empirical p it can report is 0.002494 = 1/(400+1).
```

`0.002494`, from the count actually used, and it moves with it: at 5,000 the same line reads
`0.000200`. That is the remedy — the floor is arithmetic from `N`, never a constant, which is also
the only spelling that stays true for a caller who picks a different `N`, which is the whole point of
the flag.

**Cost, for the record of why 400 is even in play.** `spike/jpka-permutation-cost.mjs`, live store,
776 entries: `project x tool_name`, `400it p=0.184539 (floor 0.002494, 104 ms)` and
`5000it p=0.215957 (floor 0.000200, 1294 ms)`.

## The pattern

**A measurement's parameter is part of the measurement, and it is the part that gets dropped.** The
dollar value survives transcription; the conditions under which it was taken do not. This is the
third instance in this series and the first where the dropped parameter then propagated into a
*requirement* rather than staying in prose: `asc-jpka`'s acceptance repeats it, so a future reader
checking that acceptance against reality would find the command reporting `0.002494` and have no way
to tell whether the command or the acceptance was wrong.

The narrower, more actionable form: **two controls that both floor near 0.0025 are not
interchangeable, and a document that runs three controls must keep three counts.** `EV-patterns` ran
a shuffled control at 400 and a block control at 5,000, and the 5,000 migrated to the wrong one. The
fix that generalizes is not "be careful" — it is that a floor is *derived* and printed, so it cannot
be restated wrongly by whoever writes it down next.

## Why nothing else would have caught it

Nothing in the repo reads prose, so this is not a near-miss. But two things that *look* like they
should have caught it, and did not, are worth naming.

- **The records are cross-referenced and the cross-reference was followed.** `asc-jpka` cites
  `EV-patterns` by name; the number was copied, not checked. A citation to a document is not a
  citation to a measurement.
- **The evidence file's own internal contradiction was readable.** `0.0025` and `1/5001` sit in
  adjacent clauses of one sentence. A reader checking either one against the other would have found
  it; reading for meaning, neither is alarming, because `0.0025` looks like a rounded `1/401` and
  `1/5001` looks like a small floor, and both are the sort of number that is right in most files.

What would have caught it is what did: opening the script that produced the numbers. That is
`empirical-planning` practice 3 — *cite the number, and if you don't have it, go measure* — applied to
a number that was already written down and looked cited.

## Consequences and constraints

**The record is corrected in its facts and not in its finding, and the correction strengthens the
finding.** `EV-patterns`' Confidence bullet says that 14 "survivors" are not 14 independent
discoveries. That claim is about multiple comparisons, it stands, and at 400 iterations the floor is
**twelve times higher** than at 5,000 — so there is even less room above it and the warning the bullet
gives is stronger, not weaker. Entries are immutable; the Amendment is dated and additive.

**The wrong number is now in a closed work item's acceptance.** `asc-jpka`'s acceptance cannot be
edited retroactively into truth without rewriting what was asked for. The command reports the right
number; the acceptance's parenthetical is left standing and the Amendment is what a reader can reach.

**One of the five occurrences is correct and must not be swept.** The block control really does run
5,000 (`spike/spike-controls.mjs:27`), and it is the control the record's temporal Correction 2 is
about. A correction applied by find-and-replace across "5,000" in that file would break a true
sentence to fix four false ones.

## Links

- Bead: `asc-h3sv` (P3), filed this pass
- Evidence record this corrects: `docs/evidence/EV-patterns.md` — see the
  **Amendment — 2026-10-06** at the end of that file
- Sibling findings: `dogfood/0065` (a correction that reached the plan and not the code),
  `dogfood/0067` (a number that travelled without its row order — the same class, found the same day,
  in the same flag)
- The regenerable measurement: `spike/jpka-permutation-cost.mjs`
