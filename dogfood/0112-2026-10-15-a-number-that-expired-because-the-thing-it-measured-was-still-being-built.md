# 0112 — a hash cited as evidence expired because the shape it measured was still being built

| | |
|---|---|
| **Bead** | `asc-09wx.8.8` (whose description carries the number that expired) |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | re-measuring the bead's own claim before closing it, after the first measurement script was found to be returning a constant |
| **Entry type(s)** | none — the finding is about a number written into a bead, not about the record tree |
| **Severity** | P3 — the conclusion the number supported is true; the number supporting it is stale |
| **Status** | open — the bead's figure is corrected alongside this record |

## What was found

**`asc-09wx.8.8` records the intervention starter's `specHash` as
`ab4cad18af3b4b01470527ed629f1ef2da94c083da68f915a2498f150f4348b6` before and after rewording
`metric.sha256`'s description, and that number does not reproduce: the same spec hashes to
`acf4d7a44c1e2f3f6c460fd500697f44140b015cac177e9495b4cb6c8ffd50e6` now.**

The number is not wrong *about the prose*. Prose is free, and that is independently measured below:
changing the `metric` description to an unrelated sentence leaves the hash byte-identical. What the
number is stale about is the thing it was taken over — the **shape**. `ab4cad18…` is exactly what the
same starter hashes to with the `disposition` property removed, so it was measured before `disposition`
joined the type. A hash over a definition shape is a function of the whole shape, so a shape that is
still being built gives a number with a shelf life of one edit, and the intervention type was edited
repeatedly across `asc-09wx.8.1`–`.8.7` on the same day the measurement was taken.

## How it surfaced

**Nobody was looking for it.** The claim was already accepted and the bead was about to be closed on
it. It was re-measured only because the *first* script written to measure it turned out to be a
constant: its helper took a spec argument and hashed a different object, so "before" and "after" were
the same value by construction and its `moves? false` proved nothing. That is the severity-zero class
this project rates worst — a check that cannot fail reporting a pass — and the response was to rewrite
the measurement so that it could fail, with two controls that must move the hash.

The rewrite produced a different base hash from the one in the bead. That difference is what forced the
question, and a one-line sweep answered it: hashing the starter with each property dropped in turn, one
drop — `disposition` — reproduces the recorded number exactly.

So the sequence is: a script that could not fail, replaced by one that could; the replacement disagreeing
with a number nobody had asked about again; and the disagreement turning out to be a second, unrelated
finding about how long a measured number stays true.

## The metric

The intervention starter as `asc types init` writes it, hashed through the store's identity path
(`specHash`, `packages/store/src/registry.ts`), driven from the built tree:

```
metric.description carries the new wording: true
registered spec keys: name, properties

base                           acf4d7a44c1e2f3f6c460fd500697f44140b015cac177e9495b4cb6c8ffd50e6
same prose re-set              acf4d7a44c1e2f3f6c460fd500697f44140b015cac177e9495b4cb6c8ffd50e6 | moves vs base? false
different prose                acf4d7a44c1e2f3f6c460fd500697f44140b015cac177e9495b4cb6c8ffd50e6 | moves vs base? false

CONTROL enum_values narrowed (status) 88dab7395d9d0e71bf31a8a2814a31a491d6ebdc84a2f752c7ae266d4828d015 | moves? true
CONTROL property renamed (metric->ruler)      fe476ee8efa6dcdc4263633a8e2052344486b65b3107afa53b4c311be04ed2ce | moves? true

definitionShape keeps metric.description? false
definitionShape keeps metric.type?        true
```

And the sweep that places the stale number on a shape:

```
properties: 15
MATCH: shape without disposition
single-property drops matching the bead number: 1
```

Three spec shapes were hashed to make sure the discrepancy was not a shape artefact of the harness —
`specHash` of the starter as a `TypeSpec`, of `{name, properties}`, and of the full type document — and
all three return `acf4d7a4…`, the same value. `typeHash` on the same spec returns something else
entirely (`28107d348498…` canonicalized, `d87cb5a7c91b…` raw), which is the trap `dogfood/0105` recorded
this same bead falling into once already.

**Two claims, two outcomes: the measured claim (`prose is free`) holds and is re-measured; the cited
number (`ab4cad18…`) had expired.** `n = 1` bead in `n = 1` checkout, an anecdote under `MIN_N`.

## The pattern

**A measured number is a function of its input, so evidence is only as durable as that input's
stability** — and a hash over a definition shape is the least durable kind there is, because it moves on
any structural edit, including ones made for a different reason in the same session.

The failure is invisible in a particular way: the number was *correct*, the claim it supported is
*still true*, and nothing about the sentence containing it looks stale. The only tell is re-running it,
which nothing does — a bead is not executed. This is `dogfood/0110`'s class one level up: there, a fact
was restated where no tool could read it; here, a fact was *measured* correctly and then left where no
tool could re-measure it, in a document that describes an artifact still under construction.

The usable form of the rule is not "do not cite hashes". It is: **state what the number is a function
of, next to the number**, so a later reader can tell an expired value from a wrong one — and, where the
input is a shape still being built, say which parts of it are settled, so the number has a stated
horizon rather than an implied one.

## Why nothing else would have caught it

Nothing asserts the contents of a bead. The whole suite was green, `format:check`, `typecheck`, `lint`,
`align check` and the mutation specs were all green, and every one of them was right to be: no
behaviour depended on either number. The bead's claim was verified when it was written by a script that
could not fail, and the second measurement — the one that could — was run for a reason that had nothing
to do with the number that went stale.

A review would plausibly have caught the *first* defect (a helper that ignores its argument is visible
in four lines) and it would not have caught this one, because reading the number and its neighbours
gives no way to know the type gained a property after it was taken.

## Consequences and constraints

The bead's figure is corrected where it stands, with the reason, rather than quietly replaced: an
expired number and a wrong number need different responses, and the record of which one it was is the
point. The measurement script that produced the stale value was itself defective and is not kept.

## Links

- Bead: `asc-09wx.8.8` (the change), `asc-09wx.8.5` (the work that added `disposition` to the type)
- Related: `dogfood/0105` (the same bead's first correction — `typeHash` is a trap for this question),
  `dogfood/0110` (a fact restated where no tool can read it)
