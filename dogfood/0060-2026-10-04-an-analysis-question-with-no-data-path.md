# 0060 — an analysis question the store cannot answer

| | |
|---|---|
| **Bead** | `asc-xqf1` |
| **Surfaced** | 2026-10-04 |
| **Surfaced by** | `asc types show evidence_record --json`, read while writing `docs/evidence/EV-43.md` to check a claim about how often this series' predictions are refuted |
| **Entry type(s)** | `evidence_record` (starter) |
| **Severity** | P3 |
| **Status** | open |

## What was found

`evidence_record` declares the question it exists to answer — `analysis_questions[0]` reads *"How often
did a result contradict its pre-registered prediction?"* — and **no property on the type carries a
prediction or its outcome**. The eight properties are `arms`, `bead`, `confidence`, `decision`,
`measured_on`, `measurement`, `method`, `question`. This is an **absence**, not a wrong value: the
question is declared, the type's purpose line is *"Keep measured answers to questions named before
measuring"*, and nothing in the store can answer it.

## How it surfaced

While writing `EV-43` I wanted to test a claim I had just put to the user — that reasoning from
documented behaviour keeps betraying this series, on the strength of `asc-3ow4`'s P2 and P3, both
refuted. The only instrument available was grepping the **prose** of `docs/evidence/*.md`, because no
field holds a prediction. The grep came back the other way (below), so the claim was dropped.

**Nobody was looking for this.** The gap surfaced because a number was wanted and the store's own
declared question turned out to have no field behind it — not because anyone audited the schema.

## The metric

**Required.** Verbatim, as printed, 2026-10-04.

The type's own declaration (`asc types show evidence_record --json`):

```
analysis_questions[0]  How often did a result contradict its pre-registered prediction?
property_count         8
properties             arms, bead, confidence, decision, measured_on, measurement, method, question
```

`verdict` exists as a field name, but it is a **review's** verdict, not a prediction's:
`review_completed` carries `name: 'verdict'` with `enum_values: ['approved', 'changes_requested',
'rejected']` (`packages/cli/src/starters.ts:85`), and `review_finding` carries `verdict` and
`verdict_source` (`packages/adapter-claude-code/src/derived-types.ts:436,448`). Neither is the outcome
of a pre-registered prediction.

`analysis_questions` is **guidance only**: read to render a row at
`packages/cli/src/commands/types/show.ts:54-55` and validated as non-empty text at
`packages/core/src/guidance.ts:55-64`. No non-test source consumes it analytically — 17 non-test hits
across `packages/*/src`, every one either rendering or validation.

The only available probe for the question, and what it returned over `docs/evidence/EV-*.md`
(43 records scanned):

```
lines containing REFUTED:      17
lines containing HOLDS:        84
lines containing NOT REACHED:   2
```

**Those counts are not a rate and are not reported as one.** They count the *word*, which cannot
separate a prediction's verdict from a sentence mentioning one, and a record that tabulates its
predictions contributes to neither side. What they establish is that the probe is prose-shaped; the
finding itself is the absent field, which is an absence to verify rather than a proportion to sample —
so `MIN_N` does not apply to it, and it is not offered as an estimate.

What the missing field cost, measured: the claim *"documented behaviour keeps betraying us"* could not
be checked against anything but that word count, and the word count came back **84 HOLDS against 17
REFUTED** — not the failure the claim asserted. The claim was withdrawn. A gap that stops a claim from
being checked is doing damage before anyone files it.

## The pattern

**A declared analysis question with no data path.** This codebase already recognises the class, and
says so in the `arms` property's own description: its point is to make a losing arm *"a queryable field
rather than a sentence buried in `measurement`'s prose"*. The identical reasoning applies to a
prediction and its verdict, and was not applied to them — so the type names the question and gives it
nowhere to live, while the field built to stop exactly this kind of prose-burial sits beside it.

## Why nothing else would have caught it

No existing check can catch an absent field on a guidance-only type. `analysis_questions` is validated
as **text** and rendered by `asc types show`; every element is a non-empty string, so every assertion
passes (`guidance.ts:55-64`). `align` reads imports, not schema completeness. A test would have to ask
the question *of the store* to notice there is nothing to ask it of — which is what happened here, and
it happened by accident.

## Consequences and constraints

There is no bad data to repair, so immutability is not the constraint. The remedy is prevention at the
schema: either the type gains a queryable place for a prediction and its outcome — a `property_count`
change, with the version bump that implies, since `derived-types.test.ts` and the schema tests pin
these — or the question is declared decorative and removed. Leaving it declared and unanswerable is the
one option this record argues against, because it reads as coverage.

## Links

- Bead: `asc-xqf1`
- Evidence record the finding came out of: `docs/evidence/EV-43.md`
- Entries recorded at the time: `evidence_record` `552733b2-0eae-44f3-8d1e-a9e807353903`
