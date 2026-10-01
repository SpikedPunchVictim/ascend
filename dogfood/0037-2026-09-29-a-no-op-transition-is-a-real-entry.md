# 0037 — a stage with no transition is recorded as a transition

| | |
|---|---|
| **Bead** | `asc-xvz5` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | `asc record stage_transition`, in the act of finding out whether `in_progress` was a legal `to_status` |
| **Entry type(s)** | `stage_transition` (derived) |
| **Severity** | P2, matching the bead |
| **Status** | fixed in the working tree — `asc record` refuses a no-op `stage_transition` unless the entry gives a reason, and the door is `evidence_text`, the field the two *deliberate* no-ops in this project's tree already carried. The guard sits on the write command rather than in `recordEntry`/`validateEntry`, because that funnel is shared with `asc import`, `asc ingest` and `asc index build`'s replay — measured, this tree holds **4** no-op lines and a refusal there would make `asc index build` throw on all four; a corpus holding a reasonless no-op still imports and indexes. **Two sentences in the body above are now stale and are corrected here rather than edited there, because the body is immutable** (`asc-4wx6`'s precedent): the dry-run probe at "How it surfaced" printed *the id it would mint* only until `asc-mw1u`, and it now **refuses the no-op outright** instead of recording it — so the probe would have stopped this entry rather than merely avoiding it. |

## What was found

`asc record stage_transition` accepts and stores an entry whose `to_status` equals its
`from_status`. The field's own description says what that is — *"Equal to `from_status` is legal and
usually a mistake -- record the transition, not the state."* — and nothing refuses it, so the mistake
becomes a durable entry. It cannot be withdrawn: entries are immutable and cannot be deleted, and
retraction is deliberately unbuilt (`asc-k6p.2`), so the only remedy is a strike, which leaves the
entry present and annotated rather than absent.

The entry is not merely noise. `stage_transition` exists to answer *"How often does a stage go
complete without its tests passing?"*, and a no-op transition enters the same count as a real one
while describing no change at all.

This is an absence: the guard that the field's own description implies does not exist.

## How it surfaced

I needed to know whether `in_progress` was a legal value. `asc types show` had rendered the
vocabulary truncated ([0036](0036-2026-09-29-a-closed-vocabulary-is-elided.md)), and **the only other
way to ask the tool whether a value is legal was to write it**. So I wrote the entry I was least
sure about — `from_status=in_progress, to_status=in_progress`, picked because it was safe to be wrong
about — and the tool answered by accepting it.

The answer was *yes*, `in_progress` is legal, so there was no validation failure and nothing was
rolled back. The probe became a record:

```
df58e059-79f0-40fa-b034-5f80e0b5f140  stage_transition  1
```

**The safe probe existed and I did not reach for it.** Measured, after the fact: `asc record ...
--dry-run` validates the whole call, prints the row it would write including the id it would mint,
and writes nothing — `stage_transition entries: 45` before and `45` after, with a
`Warning: dry run: nothing was written.` on stderr. That is a gap in *reach* rather than in
capability, and it is the same shape EV-16 measured from the other end: `asc` invoked in some form
in **0 of 15** sessions, where the mechanism existed the whole time and nothing reached for it
(`docs/evidence/EV-16.md`, and EV-30's *"the ask is the trigger, not the brief"*).

**Nobody was looking for this.** I was looking for a legal enum value; the tool answered a different
question, by writing.

## The metric

Measured with `node /tmp/count-st.mjs`, a read-only `node:sqlite` handle on `.ascend/ascend.db`:

```
=== before the dry run ===
stage_transition entries: 45
annotations: 0
=== dry run with from_status == to_status (the shape I recorded by mistake) ===
Warning: dry run: nothing was written.
index  id                                    type              version
-----  ------------------------------------  ----------------  -------
0      bf578e65-f9c3-4a30-b6f2-8de7dc5cb0ba  stage_transition  1
=== after the dry run ===
stage_transition entries: 45
annotations: 0
```

The cost, as recorded: **1** entry struck, and the strike is itself 1 more entry
(`df58e059-...` struck under `wrong_value`). `1` is an anecdote by this repo's own rule — `MIN_N` is
20 (`packages/analysis/src/proportion.ts:50`) — so what is established here is that the path exists
and is reachable, not how often it is taken.

## The pattern

**A validation error is a query.** When a closed vocabulary is not readable from the surface that
documents it, the next available way to ask is to attempt a write — and for a tool whose writes are
immutable, the cheap probe is the expensive one. The general form: *an error path that is the
cheapest way to get an answer will be used as one*, so it had better not have a side effect. Here
there is no error path at all, because the value was legal, which is what makes the answer land as
data.

The second pattern is smaller and more portable: **the description is not the guard.** The field says
equal is "usually a mistake" and the store accepts it anyway — so the sentence is documentation, and
documentation that a reader must find *before* the mistake is documentation that will be found after
it. `asc-1gnl` is the evidence that it was not even findable before it.

## Why nothing else would have caught it

A test would catch it once someone decided it was a defect, and the decision is the whole content
here: the field's description calls the value *legal*, so a test asserting refusal contradicts a
written contract and would have been rejected as wrong. Nothing in the suite, and no review of the
schema, was going to reclassify "legal but usually a mistake" into "refused" — that is a judgement
about a count's meaning, and it took a real mistake to force it.

A review of the *command* would plausibly have caught the reach gap: `--dry-run` exists, the docs
explain it, and it is still not where a hand goes when the question is "is this value legal". That is
a design signal rather than a bug, and it needs the same treatment the recall hook needed — assume
the mechanism will not be reached for, and put the answer where the question is asked.

## Consequences and constraints

**The entry stays.** It is immutable, and the strike already recorded against it (`wrong_value`,
with the reason) is the only available response. That is the designed behaviour and not a problem to
fix; the thing worth noting is that the strike is *more* entries than the mistake, so the cost of a
false entry is 2 rather than 1 — invisible while the counts are small, and the reason prevention at
write time is worth more than cleanup.

The option the convention leaves is prevention at write time. Two shapes, and they are not
equivalent: refuse `from_status === to_status` outright, or accept it behind an explicit
acknowledgement. Refusal is the honest default for a type whose purpose is measuring movement, and
it has a cost — a legitimate no-op transition would become unrecordable, which is a claim about the
world and not about the schema. `asc-xvz5` carries the choice rather than deciding it here.

## Links

- Bead: `asc-xvz5`
- The finding that caused this one: [0036](0036-2026-09-29-a-closed-vocabulary-is-elided.md) (`asc-1gnl`)
- Entries recorded at the time: `df58e059-79f0-40fa-b034-5f80e0b5f140` (struck, `wrong_value`),
  `f3f7fcba-a748-4b60-b876-108a77a3f225` (the transition that did occur)
- Related: `asc-k6p.2` (retraction is deliberately unbuilt), `asc-4wx6` / dogfood/0034
