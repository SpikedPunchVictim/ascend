# 0067 — a p that travelled without its row order

| | |
|---|---|
| **Bead** | `asc-t0x8` |
| **Surfaced** | 2026-10-06 |
| **Surfaced by** | verifying `asc-jpka`'s own plan against the live store — the plan's checkable claim did not reproduce |
| **Entry type(s)** | `tool_denial` (project-defined) |
| **Severity** | P2 |
| **Status** | fixed in this pass — the contract states it, the code documents it, and two tests pin it |

## What was found

`permutationNull` is **order-sensitive**, and nothing said so. Its doc comment made the opposite
claim in as many words — *"The RNG is seeded from `random.ts`, so a control is reproducible from its
parameters"* — which is true only of the half it names. Fisher-Yates walks the array it is **given**,
in the order it is given, so the same multiset in a different order draws a different set of
permutations and reports a different p. The parameter that was missing is not the seed and not the
iteration count; it is the **row order**, and unlike those two it was written down nowhere at all.

An absence, stated plainly: no function in this package takes its rows in a stated order, and no
comment, no flag description and no test named the order as an input. The published p-values in
`docs/evidence/EV-patterns.md` are reproducible from `spike/spike-patterns.mjs` and from nothing else,
because that file's file-scan order is the only place the order exists.

## How it surfaced

Nobody was looking for it either. It surfaced because `asc-jpka`'s approved plan contained one claim
a reader could check by hand:

> The reproducibility claim to check by hand: `--permutations 400` on `tool_denial` must return
> `project × tool_name` ≈ **0.2095** and `denial_kind × tool_name` ≈ **0.0299**, matching
> `spike/jpka-permutation-cost.mjs` — which imports the same function with the same default seed.

The command returned **0.184539** and **0.017456**. Same columns, same function, same seed, same
iteration count, different answers — and the chi-square values agreed to the last digit, so the
tables were demonstrably the same tables.

The mechanism, and it is worth stating as a procedure: **the discrepancy was resolved by finding the
one input that differed, not by re-running.** Three candidates were live — the entry order, which
column of each pair is shuffled, and whether the row set differed. The row set was eliminated first
(`776` both ways). The shuffle direction was eliminated by calling `rankAssociations` directly from
the spike's own process and getting the spike's number back, which meant my script and the command
agreed about which column moves and disagreed only about the rows. That left the order, and one
`grep` found it:

```
packages/store/src/pages.ts:117:const ORDER = 'ORDER BY recorded_at, id';
```

`recorded_at` is the ingest clock, not the entry's own timestamp, so this is not the JSONL tree's
append order and cannot be derived from the files. Rebuilding the columns in that order reproduced
the command **digit for digit**.

## The metric

**One pair, one seed, one iteration count, two row orders.** `spike/jpka-permutation-cost.mjs`, live
store, `tool_denial`, N=776, 400 iterations:

```
denial_kind x tool_name
  store observed 209.83   400it p=0.017456 (floor 0.002494,    67 ms)
  tree  observed 209.83   400it p=0.029925 (floor 0.002494,    69 ms)
project x tool_name
  store observed 343.81   400it p=0.184539 (floor 0.002494,   104 ms)
  tree  observed 343.81   400it p=0.209476 (floor 0.002494,   103 ms)
```

`store` is `openIndex` — the command's own read path, `ORDER BY recorded_at, id`. `tree` is the entry
files in append order. The observed χ² is identical in both, which is what makes the difference
attributable to the order and to nothing else: a χ² is a function of the crosstab, and reordering
rows leaves the crosstab alone.

**The command, same run, quoted from its own output** — `asc stats tool_denial --assoc --permutations 400`:

```
denial_kind  tool_name  776  0  0.22603165958183663  209.83292278616975  52  ...  0.017456359102244388
project      tool_name  776  0  0.08428369030649693  343.81271053102046  273 ...  0.18453865336658354
```

`0.017456359102244388` and `0.18453865336658354` — the store arm of the spike, character for
character.

**The asymmetry is in which column is shuffled, not only in the rows.** `--correlate` shuffles the
second column *named*, so the same pair the other way round is a different null. Live, 400
iterations, `tool_name × project`:

```
$ asc stats tool_denial --correlate project --correlate tool_name --permutations 400
... determinism 0.235, shuffled p 0.184539 over 400 iterations (floor 0.002494).
$ asc stats tool_denial --correlate tool_name --correlate project --permutations 400
... determinism 0.235, shuffled p 0.189526 over 400 iterations (floor 0.002494).
```

`0.184539` matches the `--assoc` table for the same pair in the same order. `0.189526` is the same
data under a different control. Neither is wrong; a reader who ran one and then the other would have
had no way to tell that from a defect.

**The scale of it, before the fix.** `EV-patterns`' verdict table is reproducible from
`spike/spike-patterns.mjs` and from no other order — so *every* shuffled p in the published record
is tied to one script's `readdirSync().sort()` and its line order, and none of that is in the record.
The command's own numbers are tied to `recorded_at`.

## The pattern

**The dropped parameter does not have to be a number.** `0065` and `0066` are both a parameter that
did not travel with its measurement — a corrected value, an iteration count. Here the parameter was
never a value at all: it was an *implementation detail of the caller*, and the doc comment's own
claim of reproducibility is what kept anyone from looking for it. A false assurance that a number is
reproducible is worse than silence, because silence invites the check and the assurance answers it in
advance.

The generalizable statement: **a Monte Carlo estimate is a function of its draws, and its draws are a
function of every input, including the ones the function does not name.** Only `a`, `b`, `iterations`
and `seed` are in the signature; the order of `a` and `b` is not a parameter, so it is invisible — it
is a property of how the caller built the arrays, and the caller had no reason to think it mattered.

And the sharpest form, which is why this is P2 and not P3: **the wrong claim was in an approved plan's
verification section, and a plan is where a claim is least likely to be tested and most likely to be
believed.** It was caught only because the plan happened to state a checkable number and I ran the
check that the plan had written for itself.

## Why nothing else would have caught it

The unit suite is structurally unable to, and this is the interesting part rather than a complaint.
`association.test.ts`'s `permutationNull` block contains a test whose whole subject *is*
reproducibility — *"is reproducible from its seed, and varies with it"* — and it passes. It passes
because it calls the function twice **with the same array object**, which is the one input ordering a
reproducibility test naturally holds fixed. The test asked the right question about the seed and could
not ask the right question about the order, because the order is not a thing you vary by accident
inside a test: you have to decide to build a second array.

That is now a test of its own (`'is order-sensitive, so a published p is reproducible only with its
row order'`), and it took a skewed fixture to write. The first one I tried — the block's existing
balanced 3×3 fixture, reversed — moves the p95 by `5.55` → `5.550000000000001`, one ulp. An
order-sensitivity test on a symmetric multiset is a test that the effect is small enough to look like
floating-point noise, which is a good way to conclude there is no effect.

A code review plausibly would have caught it, and saying so is the honest part: the sentence *"so a
control is reproducible from its parameters"* is the kind of confident, slightly-overreaching claim a
reviewer notices. It sat in the module for months and no review did.

## Consequences and constraints

**Four surfaces now carry it, and the cheapest one is the one that matters.** The flag description
says it (*"THE SECOND COLUMN OF EACH PAIR IS THE ONE SHUFFLED — `b` in the table, and the second
`--correlate`"*), which is the version a user meets before they have a number to compare; the
`--correlate` warn line says it on every run; the `permutationNull` doc comment carries the
correction and the measured live pair; and the two tests pin the behaviour, not the prose.

**Nothing about the statistic changed, deliberately.** Averaging the two shuffle directions, or
canonicalising the row order inside the function, were both available and both rejected: the first
invents a statistic the published record does not use, and the second changes `--assoc`'s published
`p_permuted` values to numbers no existing script produces. The function's behaviour is correct; only
its advertisement was wrong.

**The published record's reproducibility is now conditional and this record is the only place that
says so.** `EV-patterns`' shuffled p-values are reproducible from `spike/spike-patterns.mjs` and are
not otherwise reproducible, because the order lives in that script. That is a real limit on the
record's evidence and it is not something the Amendment to `EV-patterns` fixes — it is stated here.

**A caller who builds their own columns gets their own p and cannot be told they are wrong.** That is
correct behaviour for a Monte Carlo estimate and it means a support request citing a p the command
does not produce has no automatic answer; the flag description is the whole remedy.

## Links

- Bead: `asc-t0x8` (P2), filed this pass
- Sibling findings: `dogfood/0066` (the same class — a parameter dropped in transcription — found the
  same day in the same flag), `dogfood/0065` (a correction that reached a document and not the code)
- The regenerable measurement: `spike/jpka-permutation-cost.mjs`, which now reads through `openIndex`
  and prints both orders side by side
- The order itself: `packages/store/src/pages.ts:117`, `ORDER = 'ORDER BY recorded_at, id'`
