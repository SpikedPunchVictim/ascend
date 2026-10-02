# 0054 — a file with a size cap, and a record inside it with none

| | |
|---|---|
| **Bead** | `asc-8uzh` |
| **Surfaced** | 2026-10-02 |
| **Surfaced by** | building `asc-8uzh`: reading what `RecordWriter.append` actually caps, after the bead's own note said half of it had shipped under a different bead |
| **Entry type(s)** | `entry` — every type carrying free text (`evidence_record`, `review_finding`, `note`, …) |
| **Severity** | P2, matching the bead |
| **Status** | fixed in this branch (`e12-13-recording-command`) |

## What was found

The store bounded a **file** and never bounded a **record**. `MAX_BYTES_PER_FILE = 20 MiB` reads like
a guarantee about how large anything on disk can get, and it is not one: the roll condition is
`head.records > 0 && head.bytes + bytes > maxBytes`, so a file already holding one record rolls
*before* the oversized record rather than refusing it, and a single record larger than the cap is
written as a file exactly that large. The code says so on purpose, and a test pins it.

So the property the store actually enforced was **"a file is at most 20 MiB, unless a record is
larger than that"**, and the fields that could be larger are the unbounded free-text ones —
`evidence_text`, a `measurement`, a `note`. Nothing anywhere refused, warned, or even reported one.

## How it surfaced

By reading the append path for what it *does* rather than for what the bead said it did. The bead
(`asc-8uzh`) asks for two thresholds and its own note records that the byte-bounded rollover half had
already shipped under `asc-i5tj.1` — so the remaining work looked like "add the missing half". What
the reading turned up is that the *shipped* half had been generalised in the doc: `MAX_BYTES_PER_FILE`'s
comment describes the threshold and not its precondition, and the precondition ("while records stay
small") is exactly the thing that was missing.

**Somebody was looking — for a per-record limit.** The owner chose 1 MiB and chose *refuse* over
*warn* (2026-10-02). What nobody was looking for is the part that makes this a finding rather than a
feature request: **the suite asserted the gap as intended behaviour.** The test
*"writes a record larger than the cap instead of rolling forever"* exists to pin the rollover
arithmetic, and its comment reads *"the cap bounds how many records share a file, it never refuses a
record"*. True, and load-bearing for the rollover rule — but it is also a green test standing over the
absence, in a file where every other threshold has a matching test. A reviewer checking "is the writer
bounded?" would find `MAX_BYTES_PER_FILE`, a passing test with "cap" in the name, and an answer.

## The metric

The bead's own measurement (`spike/git-layout/linesize.mjs`), taken 2026-09-24 and quoted verbatim
from `bd show asc-8uzh`:

```
largest line 7,858 B, 0 lines over 10,000 B, heaviest type 39.3 MB at 5,000
all-max (spike/git-layout/linesize.mjs, n=24 for evidence_record: an
anecdote).
```

**n = 24, so the per-type figure is an anecdote** under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`)
— it is the shape of the estimate, not an estimate.

Re-measured on this repo's own tree, 2026-10-02 11:52, over `.ascend/entries/*/*.jsonl` and
`.ascend/annotations/*/*.jsonl` (`node /tmp/e125-measure.mjs`, exact output):

```
entries: 6827 lines, 6827 distinct ids, 0 ids appearing more than once
records: 10732 lines
bytes: min 254, mean 768, p50 736, p99 2421, p99.9 6633, max 9047
over 10,000 B: 0
over 1 MiB:    0
```

**n = 10,732 record lines, 0 over 1 MiB**, and the largest is 1/116th of the cap
(1,048,576 / 9,047 = 115.9). So the boundary is far outside anything this store produces, and the
refusal cannot fire on ordinary use — which is the point: it exists for a runaway field, not a large
one, and a cap that fired near the measured maximum would be a cap that breaks recording.

The number that motivated the finding is not the maximum but the **absence of one**: with no per-record
bound and a 20 MiB file cap, the worst case a type can reach is `MAX_BYTES_PER_FILE` per file with
nothing stopping the single line, and the rollover rule makes that a *guaranteed* outcome rather than
a prevented one.

## The pattern

**A bound stated without its precondition reads as a stronger guarantee than it is.** Three shapes in
one place:

1. **Two thresholds, one of which is not a bound on the thing the name suggests.** `MAX_BYTES_PER_FILE`
   bounds a file. Nothing bounded the unit a file is made of.
2. **The gap is pinned by a green test.** *"writes a record larger than the cap instead of rolling
   forever"* — the test is correct and necessary, and its existence is why the absence read as covered.
   This is the same class as `dogfood/0053`'s *"orders two records that share an id by their text"*:
   the suite is where a defect goes to look intended.
3. **The comment generalises.** The doc on `MAX_BYTES_PER_FILE` describes a 4,194 B mean and when the
   cap binds; it never says what happens when one record is 30 MiB, because nothing did.

## Why nothing else would have caught it

- **Not a test**: the behaviour was already specified by one, in the direction of *not* refusing. A
  test suite cannot find a missing rule by agreeing with the code.
- **Not the bead**: it asked for a limit and had a proposal (1 MB) — it did not know one half had
  shipped, nor that shipping it had left a doc that overclaimed.
- **Not a review of `append`**: the function is six lines and each is right. The claim that was wrong
  was in the *comment above the constant*, and comments are read for intent, not audited as
  invariants. `dogfood/0043` is this project's earlier record of the same shape.

What did catch it: reading the append path against the bead's own note, i.e. checking a shipped claim
rather than the code under the claim.

## Consequences and constraints

- **Refused, not rolled**, because rolling cannot make a record smaller: the choice is to write a
  30 MiB record as a 30 MiB file or not at all.
- **The two caps stay different rules and the tests now say so.** A file cap still never refuses a
  record (the rollover test stays green); a record cap does. One asserts the rollover arithmetic, the
  other the write refusal, and collapsing them would have broken the first.
- **The refusal names the largest field**, because the byte count alone is not actionable and the line
  is the only place that knows which field it was. This is `dogfood/0053`'s lesson applied in the
  other direction before it could be relearned: the message carries the coordinate.
- **The refusal happens before any directory is created**, so a refused write leaves the tree exactly
  as it was rather than a directory holding nothing.
- **The pre-existing rollover test's comment had to change meaning without changing behaviour.** It
  said *"the cap never refuses a record"*; it now has to say *"the FILE cap never refuses a record"*,
  because the sentence is false in general and true of one of two caps.

## Links

- Bead: `asc-8uzh`
- Spike: `spike/git-layout/linesize.mjs`
- Related: `dogfood/0053` (the sibling finding from the same bead pair — a wrong answer pinned by a
  test), `dogfood/0043` (a rationale nobody checked), `asc-i5tj.1` (which shipped the file cap)
- Entries recorded at the time: none — the measurement above is the record
