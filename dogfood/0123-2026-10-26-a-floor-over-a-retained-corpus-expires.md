# 0123 — A per-type floor over a retained corpus expires

| | |
|---|---|
| **Bead** | `asc-kmb6` |
| **Surfaced** | 2026-10-26 |
| **Surfaced by** | `git commit` → the pre-commit gate's `test` step |
| **Entry type(s)** | `user_correction` (derived) |
| **Severity** | P2 |
| **Status** | fixed in this commit |

## What was found

`derive-real-corpus.test.ts` asserts a per-type floor against the LIVE `~/.claude/projects`
corpus. `user_correction` was floored at 5 against a measurement of 8 on 2026-10-14. On
2026-10-26 the same sweep derives **3**, and the gate goes red on a tree whose only source
change is a YAML handler and a hook script.

The defect is not the count. It is that Claude Code reaps transcripts older than about thirty
days, so the population this floor is a claim about is a **sliding window**, and a floor set
near the top of a rare type's window is a floor that expires by calendar rather than by any
defect in the deriver.

## How it surfaced

Nobody was looking for it. A commit of unrelated work — three evidence records and the
commit-risk nudge handler — was blocked at the `test` step.

The mechanism is the one this series keeps finding: a number was written down as a durable
fact about a population, and the population turned out to be a window that the harness
shortens behind us. The floor had **headroom 3** on the day it was written, and the comment
above it already said the rationale for 5 could not be pointed to anywhere in the source. It
now reads as a prediction that the corpus would not lose three corrections in twelve days.

## The metric

The gate, verbatim:

```
[pre-commit] test
$ ASCEND_TEST_SCOPE=full vitest run

 × the deriver against the real corpus > derives entries that all satisfy their own definitions 4ms
AssertionError: user_correction fell below its floor: expected 3 to be greater than or equal to 5
 ❯ packages/adapter-claude-code/test/derive-real-corpus.test.ts:293:72
```

The attribution, from one instrumented pass over the corpus — `streamCorpus` + `createDeriver`,
printing every `user_correction`'s source file and `occurred_at` — which reports the same 3:

```
count 3
2026-09-27T20:08:53.595Z 183d8b3f-2d40-4290-970a-eaec80ab26a7 .../-Users-spikedpunchvictim-projects-ascend/183d8b3f-2d40-4290-970a-eaec80ab26a7.jsonl
2026-10-09T07:51:19.405Z b5d54754-fe9e-4c00-9f7b-d25b5f14a75d .../-Users-spikedpunchvictim-projects-ascend/b5d54754-fe9e-4c00-9f7b-d25b5f14a75d.jsonl
2026-10-22T23:03:49.727Z 0282db07-0e76-46cd-aced-7229f45fdd00 .../-Users-spikedpunchvictim-projects-grizzly-grizzly-sv/0282db07-0e76-46cd-aced-7229f45fdd00.jsonl
```

The corpus's oldest surviving transcript:

```
$ find ~/.claude/projects -name '*.jsonl' -type f | wc -l
    2548
$ find ~/.claude/projects -name '*.jsonl' -type f -exec stat -f '%Sm %N' -t '%Y-%m-%d' {} + | sort | head -1
2026-09-23 .../20538359-cead-4808-9443-5d7c32dddf9b/subagents/agent-ab15892d424ef9add.jsonl
```

8 − 3 = 5, and the five are gone with no file left to read. **The reconciliation is exact,
which is the only reason the mechanism is stated as a fact rather than a hypothesis** — a
drop that did not add up would have been a deriver defect wearing the same message.

## The pattern

**A floor is a claim about a population, and a population can have a retention policy.** This
is the sibling of `dogfood/0048` (a premise that expired without saying so): both are a number
that was true when written, sitting in a place where a later reader reads it as still true. The
specific class here is narrower and worth naming separately: *a statistic over a live corpus
that the harness prunes from the old end*. Any threshold derived from such a corpus needs its
window stated beside it, or it is a threshold on a different population next month.

## Why nothing else would have caught it

Nothing was going to. The assertion is the check — it is the thing that catches a deriver that
stops deriving, and it worked exactly as designed: it caught a change. What it could not
distinguish is a change in the DERIVER from a change in the CORPUS, and it reported both in
the same sentence. A test that had printed the corpus's file count and oldest transcript
beside the per-type counts would have made this a thirty-second read instead of an
instrumented sweep.

The failure log did its part: `test-failures.log` recorded the red with its loadavg, which is
what ruled out the known corpus-timeout flake (`ascend-gate-cost-and-corpus-flake`) and sent
this to the derivation rather than the budget.

## Consequences and constraints

The floor moves to 1, not to a value a few below 3. For a type this rare the only claim the
population can support is *it still derives at all* — any absolute number here is a prediction
about the next thirty days of the owner's behaviour, and the corpus is not the place to record
one. The floor's other job, catching a deriver that emits nothing, is already carried by the
four types that derive in the hundreds (`verification_run`, `context_compaction`,
`tool_denial` at 50 each) and by `MIN_ENTRIES`.

Entries are immutable, so the store's 26 `user_correction` records are not a cleanup task and
not a contradiction of this reading: the store accumulates across ingests, and the corpus is a
window over what still exists. The two numbers answer different questions and neither is wrong.

## Links

- Bead: `asc-kmb6`
- Sibling: `dogfood/0048` — a premise that expired without saying so
- Instrument: `/tmp/uc-sweep.mjs` (throwaway, one `streamCorpus` pass)
- Evidence record for the reading it invalidated: none — this was not a named question
