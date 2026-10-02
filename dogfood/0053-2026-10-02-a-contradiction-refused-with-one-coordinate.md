# 0053 — a contradiction the file layer resolved, and the one refusal that named only half of it

| | |
|---|---|
| **Bead** | `asc-2ezs` |
| **Surfaced** | 2026-10-02 |
| **Surfaced by** | building `asc-2ezs`: running the spike's S3 fixture through `readRecordTree` and following the shape to whatever refused it |
| **Entry type(s)** | `entry` (derived and hand), `annotation` (project-defined) |
| **Severity** | P1, matching the bead |
| **Status** | fixed in this branch (`e12-13-recording-command`) |

## What was found

A tree holding **one id with two different contents** — the shape two branches produce when they each
write the same derived id from a different transcript, and `merge=union` keeps both lines — read
**successfully** through the file layer. `readRecordTree` returned both lines, ordered, as though they
were two records. The only refusal anywhere in the system sat one layer up, at index build, and it
named **the id and nothing else**: no file, no line. So the defect is not that the shape went
unrefused; it is that the layer that *had* the coordinates threw them away, and the layer that
refused could not produce them.

The refusal that did exist was also **content-blind**: it fired on any second row with the same id,
which means it could not distinguish "the same record written twice" from "two different records
claiming one identity". The CLI path had already drawn that distinction (`asc-90h`, comparing
fingerprints and reporting a *collision* with the differing fields named), so the store held two
answers to one question and the one a reader reached by `asc index build` was the less useful of the
two.

## How it surfaced

By following the fixture to its refusal rather than stopping at the first error. The spike
(`spike/git-layout/run.mjs`, S3) had already established that both lines survive a union merge — that
is *why* `asc-2ezs` exists. What nobody had checked is where the shape is refused, and the answer
turned out to be: not in the read layer, and not usefully anywhere.

**Nobody was looking for this half.** The bead asks for a read-time refusal and says the refusal must
name the id and both files/lines; it does not say, and nothing had measured, that a refusal already
existed at a different layer with a message that could not be acted on. A reviewer reading
`jsonl-files.ts` would have found the ordering rule *documented* as deliberate — the doc said one id
"legitimately carries TWO contents" and the third sort key was there to order them — so the wrong
answer was not merely present, it was defended in prose.

## The metric

Measured on this repo's own tree, 2026-10-02 11:52, with a throwaway script over
`.ascend/entries/*/*.jsonl` (`node /tmp/e125-measure.mjs`, exact output):

```
entries: 6827 lines, 6827 distinct ids, 0 ids appearing more than once
records: 10732 lines
bytes: min 254, mean 768, p50 736, p99 2421, p99.9 6633, max 9047
over 10,000 B: 0
over 1 MiB:    0
```

**0 ids appear more than once** — including 0 that appear twice with *identical* content, so the
dedupe half and the refusal half are both no-ops on this tree. That is the blast-radius number that
makes the change safe to ship here, and it is also the honest limit on it: **this tree cannot
exercise either rule**, so the rules are pinned by fixtures (S3 in one file, S3 across two files, S2
as the collapse control) rather than by anything this store holds. The tree is also growing while
this is written — the same measurement a few minutes earlier, before this session's own entries,
read 6,822 / 10,727.

The refusal's own effect on the tree that had the shape: it is a **hand-edit**, not a repair.
`asc store rewrite` exists to relax a rule it can satisfy by rewriting; a contradiction is not one of
them, because either choice discards a record.

## The pattern

**A wrong answer that reports success is worse than a missing one, and a documented wrong answer is
worse still.** The file layer did not fail to answer the question "what does this tree hold" — it
answered *two records*, confidently, and the answer was wrong. Three specific mechanisms made it
survive:

1. **The refusal was in the layer above the one holding the coordinates.** `readRecordTree` computed
   `parsed.where` (`entries/note-e8cd1a80204d/0001.jsonl line 2`) and used it for its own parse
   failures, then discarded it. `recordEntry` never had it.
2. **The message was content-blind**, so a re-ingest and a contradiction were one error.
3. **The doc defended the behaviour.** The ORDER rule's third sort key existed *for* the shape now
   refused, and its justification ("content-addressed", "legitimately carries TWO contents") was
   **wrong in both halves** — derived ids are `derived:claude-code:<type>:<session>:<key>`, addressed
   by session and key, not by content. So the branch was not just present, it was unreachable-looking
   code with a reason printed beside it.

A fourth instance of the project's own recurring class: the wrong behaviour was **pinned by a test**
(*"orders two records that share an id by their text"*) whose premise was that both lines survive. The
test is replaced by the refusal, because a test that asserts the defect is what makes the defect look
intended.

## Why nothing else would have caught it

A review **would** plausibly have caught the doc's false claim — that is exactly what reviews are for,
and this one had been read before and not caught it, in `asc-i5tj.5`'s own survey of the same file.
What a review would *not* have caught is the message quality: `DuplicateEntryError` naming only the id
looks correct in isolation, and the fact that it cannot be acted on is only visible next to the two
coordinates the caller needs and does not have. That took writing the fixture and reading the failure.

The suite could not have caught it either, by construction: the tree it runs against has **0 duplicate
ids**, so nothing in this repo's data reaches the rule.

## Consequences and constraints

- **Entries are immutable** (`entries_are_immutable`, `entries_cannot_be_deleted`). A tree that already
  holds the shape cannot be repaired by a command — the refusal names the hand-edit, and that is the
  only repair, which is why the message has to carry it rather than pointing at a tool.
- **The refusal is at read time, so it fires on every reader** — `readRecordTree`, and through it
  `buildIndex`, `asc import`, `asc store migrate` and `asc store rewrite`. That is intended (a tree
  nothing can read is a tree nothing should half-read) and it is also the risk: a store that already
  holds the shape stops building its index on upgrade. Measured: 0 here.
- **`rewrite.ts`'s doc had to say what it cannot repair**, because it is *"the only code that reads a
  tree `readRecordTree` would refuse"* and its exception is now one class, not the general power to
  repair anything.

## Links

- Bead: `asc-2ezs`
- Spike that established the shape: `spike/git-layout/run.mjs` (S3), `spike/git-layout/FINDINGS.md`
- Related: `asc-90h` (the ingest-side collision report, which already named the differing fields),
  `asc-i5tj.6` (the versionless-type rule and the rewrite exception)
- Entries recorded at the time: none — the measurement above is the record
