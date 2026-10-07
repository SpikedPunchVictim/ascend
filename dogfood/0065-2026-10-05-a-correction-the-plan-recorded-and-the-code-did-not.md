# 0065 — a correction the plan recorded never reached the code that cited the number

| | |
|---|---|
| **Bead** | `asc-1sgz` |
| **Surfaced** | 2026-10-05 |
| **Surfaced by** | reading `blockPermutationNull`'s doc comment to cite it in `docs/evidence/EV-patterns.md`'s live re-run Amendment, then running `node spike/spike-controls.mjs` to check the citation |
| **Entry type(s)** | none — the finding is about a doc comment and a test comment, not about stored entries |
| **Severity** | P3 |
| **Status** | fixed in the working tree (`asc-h7nq`, uncommitted at the time of writing) |

## What was found

`packages/analysis/src/association.ts`'s `blockPermutationNull` doc comment — the module's own
documented evidence for why the control exists — published twelve numbers that the repository's own
regenerable measurement does not produce. So did two comments in
`packages/analysis/test/controls.test.ts`.

The discrepancy was **already known and already recorded**: `IMPLEMENTATION_PLAN.md:4377` says of
exactly this table, in bold, *"WRONG"* — *"none of those four observed statistics could be
reproduced from `spike/corpus.db` by any `weekday` derivation or column choice tried"* — and names
the checked-in `spike/spike-controls.mjs` and the published `docs/evidence/EV-patterns.md` table as
the anchor. **What did not happen is the correction reaching the two sites that cite the numbers.**
The plan was corrected; the code and its test were not, so the module went on telling every reader
four χ² values, four null medians and four p-values that its own script has never printed.

## How it surfaced

Writing the live re-run Amendment to `EV-patterns.md`, I opened `association.ts` to quote the frozen
corpus's block-control table and compare it against the live one. The doc comment's `tool_name ×
weekday` sat at **85.34** with a null median of **75.19** — observed *above* the median, "p 0.2685".
The Amendment directly above where I was writing carries the same pair at **95.88** with a median of
**85.68** and "p 0.2667", and its prose says *three of four* observed values sit below the median.

Rather than pick a side by eye, I ran the checked-in script:

```
  --- TABLE 2: block permutation of the weekday label among days ---
  pair                            observed  null med       p95       p  verdict
  denial_kind x weekday             185.50    195.39    234.68  0.6225  BLOCK CONFOUND
  project x weekday                 327.60    398.41    489.61  0.9432  BLOCK CONFOUND
  weekday x repo                    348.07    439.89    543.14  0.9594  BLOCK CONFOUND
  tool_name x weekday                95.88     85.68    114.37  0.2667  BLOCK CONFOUND
  5000 iterations, seed 20261005, +1 corrected.
```

That reproduces `EV-patterns.md` exactly and the doc comment not at all. Grepping the tree for the
four unreproducible values then found the *second* copy in `controls.test.ts`, and the third
occurrence — the plan's own supersession note — which is what turned a stale number into a finding
about where corrections go.

**Nobody was looking for it.** The plan had already found the wrong numbers and written them down as
wrong; the question "did the correction land anywhere the numbers are actually stated?" was not asked
by anyone, and the work item that found the error closed believing it had been fixed.

## The metric

**1. The two tables, and which one is regenerable.** `node spike/spike-controls.mjs` over the frozen
`spike/corpus.db`, exact output quoted above. Side by side:

| pair | published in `association.ts` | `spike/spike-controls.mjs` |
|---|---|---|
| `project × weekday` | 310.58 / 355.55 / 0.8594 | **327.60 / 398.41 / 0.9432** |
| `repo × weekday` | 329.28 / 399.01 / 0.9078 | **348.07 / 439.89 / 0.9594** |
| `denial_kind × weekday` | 181.71 / 190.86 / 0.6053 | **185.50 / 195.39 / 0.6225** |
| `tool_name × weekday` | 85.34 / 75.19 / 0.2685 | **95.88 / 85.68 / 0.2667** |

Twelve of twelve values disagree. The script's four observed statistics are character-for-character
the ones `EV-patterns.md` published from the same snapshot (185.50, 327.60, 348.07, 95.88), which is
what settles which side is wrong — the published record and the script agree, and the code is the
outlier.

**2. How many sites carried the unreproducible numbers.** `grep -rn` over the tree for
`310.58|181.71|329.28|85.34|0.8594|0.9078|0.6053|0.2685`, excluding `node_modules`, `.ascend/` and
`dist/`:

```
IMPLEMENTATION_PLAN.md:4377   (the supersession note -- the values quoted AS wrong)
packages/analysis/src/association.ts:733-736
packages/analysis/test/controls.test.ts:208
packages/analysis/test/controls.test.ts:263
```

**Two sites stated them as measured fact** and one stated them as superseded. The corrected tree now
returns four lines as well, but all four are the *correction* quoting the stale set rather than
publishing it.

**3. The one claim in the comment that no correction would have fixed.** The doc comment also read
*"collapses EVERY weekday pair, and the observed statistic sits BELOW the null median in each case"*.
Both halves are wrong for `tool_name × weekday`: **p 0.2667** is above any conventional level, and
**85.34 > 75.19** (as printed then) — indeed **95.88 > 85.68** in the regenerable table — puts the
observed value *above* the null median. `EV-patterns.md`'s own prose gets this right (*"three of the
four cases"*) while its table caption says *"**All four** weekday pairings collapse"*; the same
overstatement is in `IMPLEMENTATION_PLAN.md`. So the record was corrected on the numbers and left
standing on the words.

## The pattern

**A correction is only applied where someone remembers to apply it, and a superseded number has no
mechanism that finds its other copies.** The plan did the hard part — it caught the error, stated it
plainly, and named the anchor that settles it — and then closed, because a plan is a document about
work rather than a work item over artifacts. Nothing in the gate can see it: the numbers live in
comments, so `tsc`, `eslint`, `vitest` and `align check` all pass over a module whose documented
evidence contradicts its own script.

The sharp edge is **where the correction was stored.** `IMPLEMENTATION_PLAN.md` carries the only
record that these numbers were ever wrong, and this project's convention is to delete a plan once its
stages are done. Finishing the plan therefore *erases the evidence*, leaving corrected code with no
marker that anything was ever incorrect — the same shape as a record corrected in place without a
`**corrected**` cell. The fix here is deliberately the opposite: the stale values are quoted *as
stale* in `association.ts` and `controls.test.ts` rather than deleted, so a reader who finds an old
copy of the number in a transcript or a commit message can see what happened to it.

## Why nothing else would have caught it

- **The test suite could not, and this is the honest part.** `controls.test.ts`'s comments sit beside
  assertions that use a *hand-built synthetic fixture* (`CONFOUND`, four days) whose arithmetic is
  pinned and correct. The corpus numbers in the comments are decoration on a passing test; a test
  cannot fail because its comment is wrong, and the comment was the only place the wrong number
  mattered.
- **`align check` could not** — it reads imports, not comments.
- **`typecheck` and `lint` could not** — a number in a comment has no type.
- **A code review plausibly would have, if the reviewer ran the script.** That is the cheap question
  this record argues for: a doc comment that says "MEASURED" and names a script should be checked
  against that script at least once after the script is finalized. Here the comment was written
  *before* the script's final column definitions and never revisited.
- **The plan's own review did catch the error.** The failure was not detection; it was that detection
  in a plan does not propagate. That is the part worth generalizing.

## Consequences and constraints

- **The numbers are corrected in place, with the correction marked**, matching the house precedent
  (`dogfood/0013`): a record is immutable in its findings and corrected in its facts. The stale set is
  quoted as stale so the correction is visible to someone who only ever saw the old value.
- **No stored entry is involved**, so `entries_are_immutable` does not constrain anything here — this
  is a documentation defect, and prevention at write time means checking a published number against
  its named script once, late.
- **`IMPLEMENTATION_PLAN.md` still holds the only prose record** and is due for deletion under the
  project convention. `asc-1sgz` carries the options; none is chosen, and the corrected comments now
  cite `dogfood/0065` directly, which is what keeps the finding alive past the plan.
- **The overstatement is the part most likely to recur.** Correcting a number is mechanical; reading
  the sentence around it, which said *each case* where the table said *three of four*, is not.

## Links

- Bead: `asc-1sgz`
- Related beads: `asc-h7nq` (the bead whose evidence-writing surfaced this), `asc-fwpe` (which wrote
  the doc comment's table before the spike's columns were final)
- Evidence record: `docs/evidence/EV-patterns.md`, Amendments 2026-10-05 (`asc-fwpe`) and 2026-10-05
  (`asc-h7nq`)
- Regenerable measurement: `node spike/spike-controls.mjs` (frozen `spike/corpus.db`, 2026-09-11)
