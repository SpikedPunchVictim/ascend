# 0033 — a tripwire test fired because the work it guarded finally got done

| | |
|---|---|
| **Bead** | `asc-2uov` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | the quality gate, run after fixing the findings of an adversarial review |
| **Entry type(s)** | `review_finding` (derived — the first ones from real work) |
| **Severity** | P2 |
| **Status** | open |

## What was found

`normalize-real-corpus.test.ts` asserted `byKind['review.finding'] === 0` over the real corpus, from a
measurement of 2026-09-26: `ReportFindings` had been called **0** times across 1,236 transcript files
and 637,258 records, so the `review.finding` branch's only evidence was fixtures. The test was written
as a **tripwire** — its own comment says "the day either is non-zero this goes red and names which".

It went red. `ReportFindings` had been called 33 times by 2026-09-28, but **every one of those calls
was in an ephemeral probe project, which ingest skips by design**, so the reported route had still
never reached real work — the exact gap `handlers/review-finding-nudge.yaml` exists to close. This
session closed it: an adversarial review of E12.1 reported its findings through `ReportFindings`
rather than writing prose, in this project, which is not ephemeral.

Two things came out of the red, and only one of them was a test to fix.

**The sub-finding: a REFUSED `ReportFindings` call still contributes its findings.** The corpus went
to 18, not 9. The arithmetic is exact — 2 calls × 9 findings — and the first of those two calls was
refused by the harness for a schema error (`short_summary` over the 60-character cap). The deriver
reads the tool_use **input**, not the result, so a call the harness rejected still lands. That is
arguably right: the findings were real and only the wrapper's schema was wrong, so dropping them would
lose real review findings. But it is undocumented, and it means any count of `review.finding` counts
**attempted** findings.

## How it surfaced

By running the gate over work already done, which is the only way it could have surfaced: nothing was
wrong with the code, and the red was the tripwire doing its job. The useful part is that the tripwire's
firing condition was *"a real project finally reports findings"* — so the red is not a defect report,
it is the notification that a gap this project had been measuring for days had closed.

**Nobody was looking for it, and that is the point of the mechanism.** The author's attention was on
the nine review findings; the gate was the instrument that noticed something else had changed. This is
the dogfood series' own thesis in miniature — a test written to say "I have nothing to say" became the
thing that announced it now does.

## The metric

The red, verbatim:

```
 × the normalizer against the real corpus > has NEVER seen a review finding, which is the only
   thing it can say 4ms
     → expected 18 to be +0 // Object.is equality

 AssertionError: expected 18 to be +0 // Object.is equality
 ❯ packages/adapter-claude-code/test/normalize-real-corpus.test.ts:180:50
```

The corpus census behind that 18 — every `ReportFindings` call in every transcript, with the findings
count per call:

```
transcript files scanned: 228
ReportFindings calls:     35
findings across calls:    376
findings per call:        [9,9,2,19,22,2,10,12,14,2,2,10,14,22,19,9,15,8,2,6,2,9,2,10,18,15,...]
```

376 findings exist in 228 files while the normalizer reports 18, and the difference is the ephemeral
probe projects ingest skips — which is the same 33-vs-real split `derived-types.ts:525-528` already
recorded. The two leading `9`s are this session's two calls, the first of them refused. That the
refused call is among them is the sub-finding above; it is an arithmetic identification (18 = 9 + 9,
two calls made, one refused), not a re-run of the deriver with the call removed.

The rewritten test, which now asserts the positive claim the old wording explicitly could not make:

```
 ✓ the normalizer against the real corpus > reads review findings from real work, which this
   corpus could not previously say
 Test Files  1 passed (1)   Tests  5 passed (5)
```

## The pattern

**A dated measurement used as a test premise.** The zero was true on 2026-09-26 and was never going to
stay true, and the test was written knowing that — which is what made it a tripwire rather than a
false green. The class is worth naming because the alternative is the worse one: asserting `> 0` where
the honest value is `0` produces a green that means nothing, and asserting `=== 0` without a comment
produces a red that looks like a regression. This one asserted the true value *and* said what the
red would mean.

The sub-finding's class is separate and less happy: **a count whose unit is not the unit its name
implies.** `review.finding` reads as "findings a review produced"; it counts "findings a reviewer
attempted to report, including the ones the harness refused". Nothing enforces the difference, and the
only reason it was noticed is that 18 could not be explained by 9.

## Why nothing else would have caught it

Nothing was broken, so no review, no `align check`, and no type could have caught it — there was
nothing to catch. The tripwire caught it, which is the argument for the mechanism.

The sub-finding, though, is the kind a review *could* have caught by reading the deriver and asking
what it reads: `derive.ts` reads `call.input.findings`, and `input` is present whether or not the call
succeeded. That is a readable fact about one line, and it went unread because nothing depended on it
until a count was off by exactly its own size.

## Consequences and constraints

The test is rewritten, not deleted: it now asserts that every `review.finding` event carries a
`category` from the nine `FINDING_LENSES` slugs, and that the normalizer's own `offVocabularyFindings`
counter is 0. Asserting the events *and* the counter is deliberate — they are two routes to one claim,
and a disagreement between them is the class of silence this file exists to break.

It is now coupled to the live corpus containing at least one real reported finding. Every other test in
that file is already coupled to the corpus's magnitude (`derived.length > 50`, `streams > 100`), so
this is the file's existing posture rather than a new dependency — but a pruned `~/.claude/projects`
would redden it, and the failure would look like a normalizer regression rather than an empty corpus.

## Links

- Bead: `asc-2uov`
- Related: `dogfood/0026` (no stored `review_finding` carries `failure_scenario` — the same
  reported-vs-parsed split, measured from the store side), `dogfood/0019` (the reviewer route that
  never named the tool)
- Type description recording the split: `packages/adapter-claude-code/src/derived-types.ts:519-542`
- Test rewritten: `packages/adapter-claude-code/test/normalize-real-corpus.test.ts`
