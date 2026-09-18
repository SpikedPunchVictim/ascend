# 0003 — Recording an entry is never one step

| | |
|---|---|
| **Bead** | `asc-ttg` |
| **Surfaced** | 2026-09-17 |
| **Surfaced by** | `asc-0fp`, the recording-discipline task, auditing itself |
| **Entry type(s)** | `evidence_record`, `note` (project-defined); `stage_transition`, `decision` (starter) |
| **Severity** | P2 |
| **Status** | open |

## What was found

Every entry recorded during a full day of real use required a scratch JSON envelope file to be
written first. The prose properties — `measurement`, `rationale`, `confidence`, `question`,
`method` — are paragraphs, and paragraphs do not go on a command line. So recording is always two
actions, never one.

The friction is not that any single record is slow. It is that **no record is a single action**.
That is the shape ARCHITECTURE.md's "recording friction is a first-class risk" actually takes in
practice, and it was not obvious from the code.

## How it surfaced

`asc-0fp` ("Record every task close from here on") carries an instruction that makes the tool's own
friction a deliverable:

> If recording feels expensive, THAT IS A FINDING - record it as a stuck-event and raise it.
> Recording friction is a first-class risk in ARCHITECTURE.md.

So the finding was *commissioned* rather than stumbled upon. What could not be commissioned was the
answer: whether it would feel expensive, and where the cost would actually sit. The prediction
implicit in the bead was that recording might be slow. The measured answer is that it is not slow —
it is **two-step**, which is a different problem with a different fix.

## The metric

**9 entries recorded across one working day**, every one from real work, none retrofitted:

| type | n | origin |
|---|---|---|
| `stage_transition` | 4 | starter |
| `evidence_record` | 3 | project-defined |
| `decision` | 1 | starter |
| `note` | 1 | project-defined |

Measured costs:

- **9 of 9 entries required a scratch envelope file first.** Not a sample — every entry recorded
  that day.
- **1 refusal** on a `json` property given a JSON-*encoded string* instead of a real array. Caller
  error, and the refusal named the exact fix; but the envelope/flag duality is where it came from.
- **3 refusals before the first successful record**, earlier the same day: `--file` is not a flag
  (the document is a positional), then document and entry flags cannot be combined, then a wrong
  field name. Each message was clear and correct. None was guessable from `--help` alone.
- **`stage_transition` required an `asc types show` first** to learn its property shape.

`n=9` is **below `MIN_N` (20)**. This is an anecdote from one agent on one day, not an estimate, and
it is reported as one. What makes it worth filing anyway is that the central observation is 9 of 9
with no counterexample, and its cause is structural rather than statistical: the prose properties
exist, and they cannot be typed inline.

## The pattern

**A cost that only appears under repetition.** Any one of these steps is trivial. Reading the code
tells you nothing, because the code is fine — `asc record` does exactly what it should. The cost is
a property of doing it nine times in a day, which is precisely the thing a design review cannot
simulate and a test will never measure.

## Why nothing else would have caught it

- **Not a bug.** Every command behaved correctly. All four refusals were accurate and well-worded.
- **Not visible in review.** There is no bad line to point at.
- **Not measurable by a test.** A test records one entry, programmatically, from a fixture. The
  friction lives in composing prose, which tests never do.

It required an agent recording real entries about real work, repeatedly, and being asked to report
honestly on how that felt.

## Consequences and constraints

**No fix is proposed here, deliberately.** The useful question is which cost is the real one, and
the candidates are not the same bet: an `--editor` flag, a stdin envelope, a per-type scaffold
(`asc record <type> --scaffold` emitting a skeleton), or simply better `--help` examples. Picking
one before knowing which cost dominates would be guessing.

### A separate finding: an instruction that contradicts a type's contract

`asc-0fp` says to record this **as a `stuck_event`**. It was not, and the reason is itself the
finding. `stuck_event`'s own `record_when` binds it to the three-strike rule firing — and three
strikes never fired. Recording one would have **falsified a type's contract in order to make an
instruction come out true**.

That is the same trade an implementing agent refused earlier in the same week, when it declined to
reuse a counter named `unverdictable` for a meaning that counter's doc comment did not carry. The
instruction and the type disagree, and one of them should change. The friction itself was recorded
as a `note` — the type of last resort — because no better-fitting type exists, which is arguably a
third small finding.

## Links

- Bead: `asc-ttg`
- Origin: `asc-0fp` (recording discipline; closed as a ticket, the rule continues)
- Entry recorded at the time: `note` `ec927772`
