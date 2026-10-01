# 0049 — a call the harness REFUSED still counted, and its corrected retry counted the same findings again

| | |
|---|---|
| **Bead** | `asc-2uov` |
| **Surfaced** | 2026-09-30 |
| **Surfaced by** | asking what a refused `ReportFindings` call's *retry* did, while working out whether the bead wanted documentation or a fix |
| **Entry type(s)** | `review_finding` (derived) |
| **Severity** | P2 |
| **Status** | fixed in the working tree |

## What was found

The deriver reads a `ReportFindings` call's **input**, so a call the harness refused still wrote one
`review_finding` entry per finding. The bead recorded that and called it *"arguably correct — the
findings were real and only the wrapper's schema was wrong — but undocumented"*.

That framing is what the measurement overturned. A refusal is not the end of the story: the reviewer
corrects the call and **resubmits the same findings**, and the deriver wrote *those* too. So the
defect does not add a stray row, it **doubles the count**, and the number it doubles is the per-lens
count this whole type exists to produce. The absence underneath is that nothing in the deriver ever
read a `ReportFindings` call's **result** — the only place its acceptance is recorded.

## How it surfaced

By measuring the trigger rather than the claim. The bead's own sub-finding was about *documentation*,
and the question that made it visible was a different one: not "should refused calls count?" but
"what did the retry do?". Pairing each `tool_use` with its `tool_result` in the session transcript
answered it in one pass.

**Nobody was looking for the doubling.** The bead's author had already written the refusal down and
drawn the opposite conclusion from it — that the entries were right and only the prose was missing.
What nobody had asked was whether the *same findings* arrive a second time. The one thing that made
this findable at all is that the two calls are **byte-identical in content**, so a set comparison is
decisive rather than a judgement call about what "the same finding" means.

A second thing nobody was looking for: the refusal rate is **8.6% corpus-wide but 50% in the only
transcripts ingest actually reads**. Both of this machine's two ingested `ReportFindings` calls are in
this project, and one was refused.

## The metric

Every number below is the exact output of the tool named beside it, run 2026-09-30 and 2026-10-01.

**The store held 18 entries for 9 distinct findings.** `grep -o '"tool_use_id":"[^"]*"'` over
`.ascend/entries/review_finding-e8e7b5e21361/0001.jsonl`, grouped by call id:

```
  58 "tool_use_id":"toolu_013SMqqQVfuuVaE8oFzZvHCN"
  24 "tool_use_id":"call_g2giq5ii"
  12 "tool_use_id":"call_dgxcwtds"
  10 "tool_use_id":"call_kdgpoxk8"
   9 "tool_use_id":"call_p374n0av"
   9 "tool_use_id":"call_0o92cyc2"
   8 "tool_use_id":"toolu_01FTEWrvwhmZ68syixGDzXzT"
```

`call_0o92cyc2` is the refused call and `call_p374n0av` the accepted retry, both in
`b5d54754-fe9e-4c00-9f7b-d25b5f14a75d.jsonl`. Comparing the two calls' `(file, line, summary)`
triples:

```
  identical (file,line,summary) in both: 9
  only in the refused call: 0
  only in the accepted call: 0

  same key, different category: 0
```

**Nine of nine, zero differences.** Every per-lens count for that session read exactly doubled.

**Why the harness refused it** — 6 of the 9 `short_summary` values overran the tool's own
60-character maximum, `longest short_summary: 79`; the accepted retry carried `0` over, `longest
short_summary: 57`. The refusal itself is fully observable — the `tool_result` carries
`is_error: true` and the message names the field: `"maximum": 60 ... path: ["findings", 0,
"short_summary"]`.

**How often this happens.** Across every transcript on this machine (35 `ReportFindings` calls):

```
ReportFindings calls across every transcript: 35
  accepted: 32   REFUSED: 3   with no result block seen: 0
  refusal rate: 8.6%

findings: 376 total
  from accepted calls: 350
  from REFUSED calls:  26

=== by whether ingest would read it ===
  real project: 2 calls, 1 refused (50.0%), findings 9 accepted / 9 refused
  EPHEMERAL (ingest skips): 33 calls, 2 refused (6.1%), findings 341 accepted / 17 refused
```

**What dropping them would cost** — and this is the number the decision turned on:

```
REFUSED ReportFindings calls: 3
  findings in them: 26
  with an identical finding in a later ACCEPTED call (phantom if dropped): 25
  with NO accepted twin (would be LOST if dropped): 1
  -> 96.2% of refused-call findings are duplicates of an accepted one
```

The single finding with no twin is in an **ephemeral** transcript, which ingest skips by design
(`asc-80m`). So in every transcript the store actually reads, suppressing a refused call loses
**nothing**.

The group of 3 refused calls is under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`), so
`8.6%` and `96.2%` are **anecdotes from 3 refusals, not rates** — stated here so they are not read as
estimates. The `18 for 9` figure is not: it is an exhaustive count of one store's rows.

**After the fix, driven end to end** — the real binary over the real 77 MB transcript, into a fresh
scratch store:

```
entry   review_finding      9 new
Warning: 9 reported finding(s) came from a ReportFindings call the harness
REFUSED, so no entry was written for them from that call.
```

Nine, not eighteen. And this store, after the 9 phantoms were struck: `asc types list` reads
`review_finding  2  13  74  56` — 74 entries standing, 56 struck, from 83 and 47 before.

## The pattern

**A count that is right about what it read and wrong about what it says** — the class `dogfood/0039`
named and `dogfood/0047` was the third instance of. Here the deriver read the call's input correctly
and reported the result as *"a review found these nine things"*, when the instrument had answered
*"no"*.

It is also a **false-green**, and worth naming as one: `review_finding` is the type whose entire
purpose is per-lens counts, and a doubled count is a wrong answer from the one number the type
exists to produce. The project's own doctrine calls this severity-zero — *"a false positive, anything
that claims done or passing when it isn't, is the worst class of defect"* — and the counter was
absent, so nothing contradicted it.

## Why nothing else would have caught it

The suite could not. `derive-real-corpus.test.ts` **deliberately asserts nothing about
`review_finding`**, with a recorded reason: the corpus it walks held zero `ReportFindings` calls. The
unit tests all constructed a `tool_use` block and never a `tool_result` for it, so the result was
never in the fixture — an entire half of the input was absent from every test and nobody had
noticed, because the rule's own comment said a result was not needed.

A review would not have. The code was explicit and reasoned: *"No join is needed, which is why this
rule sits here rather than in the pending-result machinery: the findings are an ARGUMENT to the
call, not a result of it."* Every clause of that is true. It is true and it is the bug, which is
exactly the shape a review reads past — the comment explains the design, and the design is what is
wrong.

## Consequences and constraints

**Entries are immutable**, so this was never a cleanup. The fix is prevention at write time; the 9
rows already written needed an invalidation annotation, struck `superseded` with each phantom's
`--superseded-by` naming its index-matched survivor — the same remedy and the same label this store
already used for a duplicate on 2026-09-30 (*"Nothing about the measurement is wrong, only its
count."*).

**The fix is prospective.** `openRecordWriter` appends (`jsonl-files.ts:659`) and never rewrites, so
re-ingesting removes nothing already on disk. That is why the strike was required in addition to the
code change, and it is worth knowing before the next deriver fix is assumed to be self-cleaning.

**A refusal that is never retried is still lost.** The fix trades a doubled count for, in the
measured case, nothing — but the general guarantee is only that the store no longer counts what the
instrument refused. The counter `refusedFindings` is the only place the trade is visible.

**One question is left NOT measured**, recorded here rather than filed: whether
`asc ingest claude-code --dry-run` could report which existing rows a fresh derive would no longer
produce. `dogfood/0048` records the same gap for a different fix; it is now the second fix to want
it, which is an argument for building it rather than two arguments for asking.

## Links

- Bead: `asc-2uov`
- Related: `dogfood/0039` (the class), `dogfood/0047` (its third instance), `dogfood/0048` (the same
  unmeasured question), `dogfood/0024` (a `review_finding` version bump that left the old rows
  counted — the reason this fix deliberately does **not** bump `derivationVersion`)
