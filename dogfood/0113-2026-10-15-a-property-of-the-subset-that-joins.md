# 0113 — a property of the subset that joins, written as a property of the population

| | |
|---|---|
| **Bead** | `asc-09wx.8.4` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | an ad-hoc read-only sweep of `~/.claude/projects`, run to justify one sentence of a docblock that had already been written |
| **Entry type(s)** | `hook.context` (`core`, new kind), `hook.delivery` (`core`) |
| **Severity** | P3 |
| **Status** | docblock corrected in the working tree before the kind shipped; the class is open |

## What was found

`hook.context` was added to `EVENT_KINDS` (`packages/core/src/event.ts`) because one hook run writes
several attachment records and the one that says what the model was handed is not the one
`hook.delivery` reads. The kind is right. Its docblock, as first written, said this:

> On ALL 669 the sibling `hook_success` record's `content` is EMPTY, so `hook.delivery.bytes` is 0
> for every delivery that injected anything -- the largest injected source in `EV-54`, a 46.3 KB
> `bd prime`, reads as zero.

**Both halves are false, and the corpus refuted them in four numbers.**

Three consecutive records of one real run in this checkout's own transcript — a `hook_success` with
empty `content`, a *second* `hook_success` carrying the **same** `toolUseID` and 3,567 bytes of the
hook's own output, and the `hook_additional_context` whose `toolUseID` is the hook **event name**
and whose content is 1,538 bytes. The model was handed those 1,538 and neither of the other two. So
`hook.delivery.bytes` is not 0 for the delivery that injected the most — it is emitted twice for that
one run, once as 0 and once as 3,567 — and neither number is what reached the model.

And "ALL 669 … EMPTY" cannot be produced by the measurement that would support it: the id-join reaches
**58** of 672, of which **18 carry text**. A property measured over the joined pairs is a property of
at most 58 records, stated there of all 672.

## How it surfaced

**Someone was looking — at the field, not at the prose.** The sweep was run to answer *"is `hook.context`
the right shape?"*, and it answered yes. What it also did, unasked, was print the population the
docblock had already generalised from, and the two disagreed. That is 0079's mechanism arriving a
second time, three days later, in a docblock about the *same field pair* — and 0079's own rule is
written into the header of the file the new docblock lives in, in bold, citing 0079 by number.

The mechanism is narrower than 0079's and worth naming on its own. 0079 was *three records
generalised into three sentences*. This one was **a number measured on a subset, restated as a
number about the population** — and it is far harder to see, because a subset count and a population
count are the same kind of thing. The draft carried both in adjacent sentences: the join count (*"finds
40 of the 669"*) and the emptiness claim (*"ALL 669 … EMPTY"*). Whatever produced the second, the first
is what a reader can check, and it is what should have stopped it: a join that reaches 6% of a set
cannot make a claim about the set.

Three further facts came out of the same sweep, and two of them were also absent from the draft:

- **The corpus is live.** The first count taken this session read **669** records and **356** inlined;
  the re-measurement, minutes later, on the same 2,496 files, read **672** and **359**. The corpus holds
  the *running session's own transcript*, so a total taken over it is a reading with a time, not a
  constant — the rule `dogfood/0112` states, applied to the instrument rather than to the record.
- **`toolUseID` here is the hook event name on 632 of 672** (`SessionStart` 632, `PostToolUse` 37,
  `PreToolUse` 3), which the draft had as "629 of them".
- **Every one of the 672 contexts has at least one `hook_success` in the contiguous attachment cluster
  before it** — 1,260 records, 743 with no content and 517 carrying text. That is a stronger argument
  for the kind than the false one was: a reader summing `hook.delivery.bytes` near a delivery gets a
  number that has nothing to do with what the model read, whatever the records happen to say.

## The metric

Read-only over `~/.claude/projects`, 2026-10-15, throwaway `node -e` scripts, no file written. The
whole-corpus sweep, verbatim:

```
files 2496 records 672
shapes [ [ 'array(string)', 672 ] ]
persisted 313 inlined 359
wrapper bytes: min 1538 median 1789 max 2410
```

The attachment-cluster sweep, verbatim:

```
attached contexts: 672 | toolUseID === hookEvent: 632
by hookEvent: [ [ 'SessionStart', 632 ], [ 'PostToolUse', 37 ], [ 'PreToolUse', 3 ] ]
hook_success in the CONTIGUOUS cluster before a context: 1260 | empty: 743 | non-empty: 517
contexts with no hook_success in their preceding cluster: 0
top context byte-lengths: [ [ 1538, 126 ], [ 1789, 79 ], [ 1290, 60 ], [ 1922, 53 ], [ 1289, 51 ], [ 1430, 35 ] ]
```

The two readings of "the sibling", verbatim — the pair that shows the sentence was unproducible:

```
SessionStart hook_success in the files that hold an attached context: 1379 | empty: 702 | non-empty: 677
hook_success whose toolUseID MATCHES an attached toolUseID: 58 | empty: 40 | non-empty: 18
```

The one run the corrected docblock now cites, verbatim (records 4, 5 and 6 of
`183d8b3f-2d40-4290-970a-eaec80ab26a7.jsonl`, which is this session's own transcript):

```
4 attachment hook_success hookEvent=SessionStart hookName=SessionStart:startup toolUseID=d18d2d1a-3ac4-41d7-a939-c26f8a717a0a contentBytes=0 head=""
5 attachment hook_success hookEvent=SessionStart hookName=SessionStart:startup toolUseID=d18d2d1a-3ac4-41d7-a939-c26f8a717a0a contentBytes=3567 head="context_compaction -- Never by hand -- asc ingest claude-cod"
6 attachment hook_additional_context hookEvent=SessionStart hookName=SessionStart toolUseID=SessionStart contentBytes=1538 head="<persisted-output>\nOutput too large (46.3KB). Full output saved to"
```

Every group above is over `MIN_N` (20, `packages/analysis/src/proportion.ts`), so none of these is an
anecdote at the population level. **The 58 joined pairs and the 18 non-empty among them are the
exception**: 18 is *under* `MIN_N`, so "18 of 58 carry text" is reported here as an anecdote — the
direction it establishes (the claim is false on the joined subset too) is what it is cited for, and
the proportion is not.

The three records of the single run are a transcription of three lines, not a sample of anything, and
are labelled as one run.

## The pattern

**A property of a subset, restated as a property of the population, where the subset boundary is a
join that mostly fails.** 0079's class is "three records became three sentences"; this is its sharper
sibling — the base was not tiny, it was *filtered*, and a filter that silently keeps 6% of a set looks
exactly like a set.

It is recognisable by a number in a docblock that a reader cannot reproduce without knowing which
subset it was taken over. `hook.delivery`'s docblock already carries one safe sentence of this shape —
*"MEASURED 2026-10-12 … 86,877 `hook_success` attachments"* — and it is safe because it names both the
sweep and the date. The draft's sentence named neither, and the omission is what let a count of 40
stand in for a count of 669.

There is a second, smaller lesson about measuring a corpus that contains the running session: **take
the measurement and write the sentence in the same breath**, or the sentence will describe a corpus
that no longer exists. Between the two sweeps above the record count moved 669 → 672 with the file
count unchanged, because the live transcript is appended to an existing file.

## Why nothing else would have caught it

- **The type system cannot** — every clause was about values.
- **`normalize.test.ts` cannot**, and it is worth being exact about why: the block written for this
  kind drives synthetic `hook_additional_context` records, so it confirms exactly what the author
  already believed. It passed, and would have passed with the false docblock intact.
- **`normalize-real-corpus.test.ts` is the closest thing and it cannot see this either.** It asserts
  that every event's kind and field names are *declared* — a structural property — and it never
  reports a count or a distribution.
- **The bug-hunt lens that should own it does not fire.** This is an `assumption_audit` finding in
  shape: the assumption "these two records are the same delivery" is implicit in the prose with no
  guard. But the lenses read **code**, and the assumption was never in code — the code correctly
  treats them as two independent records with two independent kinds. The wrong belief lived only in
  the paragraph describing the code.
- **0079 did not prevent it, and that is the part worth having written down.** The rule it produced is
  in the header of the very file this docblock was added to, in bold, naming 0079. A rule about *how
  small a sample may be* did not cover a sample of 58 taken through a filter.

## Consequences and constraints

Nothing was persisted wrong. `hook.context` had not been emitted into any store, and
`EVENT_DERIVE_VERSION` moved 12 → 13 in the same change, so the first derivation under the new version
is the first one that exists — **no backfill, no invalidated data.** The false sentence never reached a
reader outside the working tree.

Two constraints on the fix, both stated because they are not free:

- **The correction is unkillable by test, and the mutation spec says so rather than pretending
  otherwise.** `scripts/mutations/hook-context-and-sizes.json` carries the paragraph as an intended
  survivor with the test it must *hold* through. Prose cannot carry an invariant here; the numbers a
  reader can check are the fields, and the ten killed mutants beside it are what hold those.
- **The claim is now dated and scoped, which means it will go stale rather than wrong.** The docblock
  names 2,496 files and 2026-10-15. That is the intended failure mode: a dated measurement that reads
  as old is recoverable, and an undated one that reads as current is not.

## Links

- Bead: `asc-09wx.8.4`
- The same class, three days earlier, in a docblock about the same field pair: `dogfood/0079`
- The rule this one shows the limit of: `dogfood/0112` — a measured number in prose is a function of
  what was measured and when it was taken
- Evidence the injected context is large enough to matter: `docs/evidence/EV-54.md`
- The corrected docblocks: `hook.context` and `hook.delivery` in `packages/core/src/event.ts`
