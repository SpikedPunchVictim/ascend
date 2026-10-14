# 0094 — a mutant that could not load read as a survivor

| | |
|---|---|
| **Bead** | `asc-funq` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | writing `scripts/mutations/gate-memo.json` — planting a mutant by hand and reading the failing test names off vitest's JSON reporter, which is the method this project's own conventions name |
| **Entry type(s)** | none — this is about the mutation harness's authoring method, not the store |
| **Severity** | P3 |
| **Status** | open |

## What was found

The documented way to find a mutant's killers is: apply the mutant, run the owning test file with
`--reporter=json`, and read the failing names off `assertionResults`. **When the mutation leaves the
module unparseable, vitest fails the file at collection and there is no assertion result to read.**
`assertionResults` comes back `[]`, `numFailedTests` is `0`, and the entire failure lives in two
fields the method does not name: the file's `status` (`"failed"`) and its `message` (the parse
error). A reader following the method sees zero failing tests, and zero failing tests in a mutation
run means *nothing catches this* — a survivor.

So **a mutant that cannot load is indistinguishable from a mutant nothing catches, under the
instrument the instructions tell an author to use.** The runner is not that instrument, and this
record says so with its own measurement below; the gap is in the *method*, and the method is how
every mutation spec in this repo gets written.

## How it surfaced

**Nobody was looking for it.** It arrived from the ordinary act of writing a spec: one of the two
environment-guard mutants had a first spelling that deleted its guarded line outright, and the
project's method was followed to find its killer. The near-miss was caught before it reached the
spec — the mutant was respelled to keep the module valid rather than dropped, and the spec was then
run through the runner, which is where the two instruments disagree visibly. What made it legible
was checking whether the mutant *parsed* instead of accepting the empty result as an answer.

The reason it is worth a record rather than a shrug is the shape of the failure: the wrong answer is
the answer that makes an author **delete** a good mutant. A survivor is a finding here
(`mutation-survivors-point-at-the-fixture`), so a false survivor costs coverage silently, and the
spec that results looks complete from every direction a reviewer can see.

## The metric

The unloadable spelling was re-planted on 2026-10-13 so that both instruments could be recorded
rather than remembered. The module is genuinely unparseable — `node --check scripts/gate.mjs` exits
**1** with `SyntaxError: Unexpected token ')'` — and it was restored from a byte copy afterwards,
verified by sha256 (`74a56c5bdab0f88920b9901afcb95b2ff8efdef5895c552cf33833e5552c4b29` identical
before the plant and after the restore).

**What the documented method sees**, from
`./node_modules/.bin/vitest run scripts/gate-memo.test.ts --reporter=json --outputFile=…`,
read back out of the JSON, verbatim:

```
success: false  numTotalTests: 0  numFailedTests: 0
file: gate-memo.test.ts  status: failed
assertionResults: []
message: "Expression expected"
```

Zero failing tests. The only signal is `status` and `message`, which the method does not read.

**What the runner sees for the same spelling**, from
`node scripts/mutate.mjs /tmp/asc-0094-bad-m7.json --allow-dirty`, verbatim, exit **1**:

```
| id | verdict | killers that died | survivors |
|---|---|---|---|
| BAD-M7 | DEAD KILLER -- the file ran no test | - | pays for everything when the environment asks for the whole thing |

why a killer never ran:
  BAD-M7  "pays for everything when the environment asks for the whole thing" -- scripts/gate-memo.test.ts ran no test: Error: Expression expected

rebuild: node_modules/typescript/bin/tsc -b ok -- no build output is left holding a mutant

1 mutant(s), 1 problem(s). FAILS.
```

The runner reads vitest's summary line through `executed()`, and its docblock says why: *"a file that
will not compile executes no test either, and is named rather than scored."* That is the same
reasoning this record is about, applied in the tool and not in the prose.

**The bound, stated plainly.** This is **one** mutant spelling, measured twice on one machine under
one vitest version in one repository. That is an anecdote and not an estimate — well under `MIN_N` —
and it says nothing about how often the method misleads in general. What the two readings above do
establish is that it misleads *here*, deterministically, with no reliance on timing or load.

## The pattern

**A verdict-reading procedure documented in prose drifts from the tool that implements the same
idea, and the prose keeps the narrower reading.** The runner closed this blind spot deliberately and
said so in its own docblock; the authoring method — the step that produces the input the runner
checks — did not inherit the closure. The class is worth naming because the two halves live in
different files and neither is wrong on its own: one is a function that reads a summary line, the
other is a sentence in a conventions document.

It is the same family as `dogfood/0089` one instrument over — a verdict that cannot state the
conditions it was reached under — and the inverse of `dogfood/0061`, where a check existed and was
never wired up. Here the check exists, is wired up, and the *method* is the un-updated copy.

## Why nothing else would have caught it

Not a test. Nothing in the repo executes the authoring method; it is a thing a person or an agent
does at the terminal between two tool calls, and its output is a JSON file that is not kept.

The runner **would** catch it, and in this case did — but the runner is what an author reaches for
*after* the killers are chosen, so the method decides which mutants are still on the table by the
time it runs. A mutant dropped at the hand-run stage never reaches the runner to be refused.

A review would not have caught it either, and that is the honest and uncomfortable part: a spec
written under the false reading is smaller and internally consistent, and nothing in the resulting
file records that a mutant was ever deleted.

## Consequences and constraints

- **The fix is prose, and it is already applied.** `scripts/mutations/gate-memo.json`'s header now
  carries the measured pair and tells the next author to `node --check` the mutant before believing
  a survivor.
- **The header's first version of that note was itself wrong, and the correction is part of the
  finding.** It attributed the mis-read to the runner. The measurement above refutes that: the
  runner names the problem. A note about a misleading instrument that mis-states which instrument is
  misleading is the same defect one level up, which is why the note now quotes both readings.
- **No entry or data consequence.** Nothing was written to the store under the false reading, and
  entries are immutable in any case — the options here were always prevention at write time.
- **The direction this fails in is the expensive one.** A false survivor costs coverage quietly,
  while a false kill is loud. The runner's own rule that every named killer must pass unmutated
  first exists for the loud direction; there is nothing for this one.

## Links

- Bead: `asc-funq`
- Evidence record, if the finding came out of one: `docs/evidence/EV-70.md`
- Spec whose header now carries the correction: `scripts/mutations/gate-memo.json`
