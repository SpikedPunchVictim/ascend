# Spike asc-6ola.5 — handler format: findings

Throwaway. Predictions were sealed in `PREREG.md` (sha256 `a620d660…75f5929d`, in the bead notes)
before any handler was ported. Input: the frozen corpus of `spike/replay`, scoped to this project.

Reproduce:

```bash
node spike/handler-format/run.mjs <frozen> -Users-<user>-projects-ascend            # a/ and b/
node spike/handler-format/run.mjs <frozen> -Users-<user>-projects-ascend <a> <b>    # other handler dirs
node spike/handler-format/hazards.mjs
```

## Result, exact

```
normalize: 77 files, 96650 events, 4274 ms
reference (JS, spike/replay window): 236 ms
A: load+compile 18 ms, evaluate 251 ms
B: table load 437 ms, queries 101 ms

bead-close: reference 249 (spike window) / 249 (call rule); window-rule gap -0 +0; literal-vs-call rule -0 +0
  A: 249 rows, PARITY [c1b6bf9c53d9]
  B: 249 rows, PARITY
bead-claim: reference 52 (spike window) / 52 (call rule); window-rule gap -0 +0; literal-vs-call rule -0 +0
  A: 52 rows, PARITY [f416a5c65a3e]
  B: 52 rows, PARITY
plan-status-edit: reference 5 (spike window) / 5 (call rule); window-rule gap -0 +0; literal-vs-call rule -0 +0
  A: 5 rows, PARITY [29033f031e1d]
  B: 5 rows, PARITY
search-miss: reference 18 (spike window) / 18 (call rule); window-rule gap -0 +0; literal-vs-call rule -0 +0
  A: 18 rows, PARITY [c67c29a1896d]
  B: 18 rows, PARITY
repeat-failure: reference 508 (spike window) / 519 (call rule); window-rule gap -56 +67; literal-vs-call rule -0 +0
  A: 519 rows, PARITY [e9ab068e875b]
  B: 519 rows, PARITY
```

A second run gave A 145 ms and B 331 + 79 ms. Treat the timings as order-of-magnitude figures.

## Predictions, settled

| # | prediction | result |
|---|---|---|
| P1 | A reaches parity on 4 of 4 | **confirmed: 4 of 4** (and 5 of 5 with the fifth handler) |
| P2 | B reaches parity on 4 of 4 | **confirmed: 4 of 4** (5 of 5) |
| P3 | A needs exactly 1 bespoke primitive; B needs ≥ 3 functions | **A: FAILED. B: confirmed.** A needed 4 constructs added for these handlers: `shares_token`, `followed_by`, and the filters `basename` and `snake`. B needed 6 functions: `regexp`, `regexp_i`, `regex_capture`, `shares_token`, `basename`, `snake` |
| P4 | Both express the fifth handler with no new primitive | **confirmed, weakly.** The fifth handler was written before SPEC-A, so the spec's `count` and `$call` could have been shaped by it. That makes this a test of design intent, not of generality |
| P5 | A < 1 s; B < 5 s and slower than A | **confirmed:** A 251 ms, B 538 ms (437 ms table load + 101 ms queries) |
| P6 | sonnet writes ≥ 3 of 5 with parity in each, and B ≥ A | **confirmed: 5 of 5 in both** (so B = A). n = 5 per candidate is an anecdote |
| P7 | the loader refuses 4 of 4 hazards; the hash ignores formatting | **confirmed: 8 of 8 refused** (the four named, plus `ok: yes`, a duplicate key, an unknown key, and an unknown field). Reformatting gave the same hash; changing one value changed it |

## What it means

**Expressiveness does not separate the candidates. How they fail does.** Both reproduced all
five handlers exactly, from my hand and from sonnet's. Haiku was run as an extra probe, not
pre-registered, n = 5 each, so it is an anecdote:

```
A: bead-close PARITY, bead-claim PARITY, plan-status-edit "refused: unknown field old_status",
   search-miss PARITY, repeat-failure PARITY
B: bead-close PARITY, bead-claim PARITY, plan-status-edit PARITY,
   search-miss "17 rows, missing 1, extra 0", repeat-failure "HAVING clause on a non-aggregate query"
```

A's only failure was refused **at load**, with a message that names the mistake: a capture used
as a `where` key without its `$`. One of B's failures was **silent**. `ROW_NUMBER() OVER (PARTITION
BY z.seq)` without `file` let triggers from different transcripts compete, and one real row
disappeared with no error. A wrong handler that runs green is the severity-zero class. The strict
loader turns most of those mistakes into load errors. SQL, being general, accepts them.

**SQL does not remove the vocabulary problem.** P3's intuition was that SQL is "general" and
YAML needs bespoke primitives. In practice B needed a registered function for every non-relational
operation the handlers use (regex test, regex capture, token overlap, path and case transforms). The
bespoke vocabulary is the same in both. SQL only moves it from the evaluator into functions.

**Growth cost is real in A.** Four constructs were added to A because these handlers needed
them. Each new handler shape may add another, and each addition is an evaluator change with
tests. In B a new shape is usually a new query. This is A's main cost, and the spike cannot size it
beyond "4 constructs for 5 handlers".

**The window has to be defined by tool call, and it matters.** spike/replay's window ("stop at the
Nth following `tool.use.end`") and the call rule agree on `search-miss` and disagree on
`repeat-failure` by 123 rows (−56 +67). With parallel tool calls, "the next N calls" is ambiguous
until it is defined by call index. The call rule `[trigger.call, trigger.call + N]` and PREREG's
literal rule ("call ≤ trigger.call + N") differed on 0 rows here.

**Parity underdetermines two parameters.** Negative controls: B `bead-close` with a changed
literal → 249 missing and 249 extra, and B `repeat-failure` with 9 calls → 67 missing and 56 extra.
Both were caught. Two mutations **survived**: A `search-miss` with 4 calls instead of 5, and A
`plan-status-edit` without the case-insensitive flag, both still at parity. No search-miss row in
this corpus depends on the 5th call, and all 5 plan edits are exact-case. The runner is sound; the
corpus does not discriminate those settings.

**Hazards, measured rather than assumed.** Under YAML 1.2 (`yaml@2.9.0`, `version: '1.2'`),
`on:`, `no:` and `yes:` stay strings: `{"on":"x","no":1.1,"yes":"on"}`. The bead's `on:`→`true`
hazard is YAML 1.1 behaviour and does not arise. `1.10`→`1.1` does arise, and the type check
catches it. But its message quotes the parsed `1.1`, not the source text the author wrote.
Unknown tags (`!custom 6`) are accepted silently by the parser, so the explicit-tag refusal is
load-bearing.

**Cost.** Normalizing is the expensive step (4.3 s for 96,650 events). The evaluators are an order
of magnitude cheaper. Only A evaluates one event at a time, which is what live dispatch needs.
B needs the table built first. Live use of B would mean incremental inserts and re-querying per
event, and that was not measured.

## Recommendation (the owner decides; the format is costly to reverse)

**A, strict YAML 1.2, for dispatch. SQL stays for analysis.** Reasons:
- both are equally expressive on n = 5 handlers;
- A's mistakes fail at load, while B produced a silent wrong answer;
- A evaluates per event, which live dispatch needs;
- A has a canonical hash;
- SQL needed the same bespoke vocabulary anyway.

Accepted cost: the construct set grows with handler shapes, so a proposal for a new construct
needs a real handler that requires it (promotion on evidence).

## Limitations

- **Home field.** I wrote SPEC-A, SPEC-B, the reference and the handlers, knowing the handlers.
  SPEC-A's examples resemble `bead-close`, and TASKS.md gives every regex verbatim. So Q5 measured
  translation from English to a format, not handler design. Four of sonnet's five YAML handlers
  hash **identical** to mine.
- n = 5 handlers from one project, one corpus. A second project's handlers (n ≥ 2) are untested.
- The events are 96,650 here against 96,631 in spike/replay. All 19 extra are `command.run`, which
  fits the `execSteps` change in `f25c6d6`. That is not verified.
- Live dispatch was not run for either candidate.
