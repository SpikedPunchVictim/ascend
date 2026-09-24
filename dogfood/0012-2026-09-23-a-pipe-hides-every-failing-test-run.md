# 0012 — the event model's success flag reports every failing test run as a success

| | |
|---|---|
| **Bead** | `asc-6ola.6` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | a read-only review agent (fable) reading the asc-6ola design against the frozen transcripts; re-verified by hand |
| **Entry type(s)** | none yet; it concerns the normalized `command.run` event (`spike/replay/replay.mjs`) and the planned check "catch" (asc-6ola.1) |
| **Severity** | P0, matching the bead |
| **Status** | fixed in `f25c6d6`; store re-derived and v1 invalidated 2026-09-23 (see **Resolution**) |

## What was found

The normalized event gives a command one success flag, `ok`. It is taken from the harness's
`is_error` on the tool result, which reflects the shell's exit status. Tests here are almost always
piped (`… | tail -20`), so the exit status belongs to `tail`. Every failing test run in this project's
history is recorded as a success. A handler written as "on `command.run` where `ok` is false" is
green on the exact runs it exists to catch, and so is any check "catch" or `verification_run`
outcome built on it.

## How it surfaced

A review agent was asked for gaps in the event design and ranked this first. I re-ran it with a
stricter definition before relaying it. The honest version of "was anyone looking": **partly.** The
power check's pre-registration (`spike/power/PREREG.md`, M2) already said "Read from transcript text,
not the Bash exit status, because a test command piped to `tail` exits with `tail`'s status". I knew
the mechanism well enough to route one metric around it. Nobody saw that the event model itself, which
every handler would read, carries the same false green. Working around a defect in one analysis
without filing it is how it survived.

## The metric

The re-verification, over this project's frozen transcripts (77 files, frozen
2026-09-23T06:46:47Z). A Bash `tool_use` whose command matches `/vitest|npm (run )?test|pnpm (run )?test/`
is joined to its `tool_result`. A run has failed if its ANSI-stripped output matches
`/Test Files\s+[^\n]*failed/`:

```
{ runs: 1046, piped: 982, failOut: 171, failOutErrFalse: 171 }
```

171 of 171 failing runs have `is_error: false`. The review agent's broader regex (vitest, jest,
pytest, npm/pnpm test, mocha) reported:

```
testCalls 1046, testCallsErr 7, testCallsPiped 958, testCallsPipedErr 5,
testCallsOutFail 282, testCallsOutFailButOk 282
```

The two failure counts use different definitions and are not comparable. Both say every one.

## The pattern

A proxy signal that is correct for the case it was designed around (a command's own exit status)
and silently inverted by composition (a pipe). It's the same shape as dogfood/0010, where the
segmenter was correct for one-line commands and wrong for program text. The normalizer inherits the
harness's notion of success and never states what that notion measures.

## Why nothing else would have caught it

No test exercises the normalizer against piped commands. The replay spike scored `bead-close` and
`search_miss`, neither of which reads `ok`. A test would have caught it once someone wrote one. The
point is that nobody knew one was needed.

## Consequences and constraints

**It is not only a design risk. It is in shipped data.** The `verification_run` type derived by
`asc ingest claude-code` takes `verdict` from `is_error`, by design ("from the tool result's own
`is_error` field rather than from anything in the output text",
`packages/adapter-claude-code/src/derived-types.ts:326`). Each entry id ends in its `tool_use_id`,
so every stored verdict joins to the output it was derived from. Over this store's 649 entries, 577
of which join to the frozen corpus, with strict per-runner failure patterns (vitest `Test Files …
[1-9] failed`, cargo `test result: FAILED`, tsc `error TS\d+:`, `Tests … [1-9] failed`):

```
stored passed (joined): 510 strict failure in output: 60 | stored failed (joined): 67 strict failure in output: 7
npx vitest | stored passed         {"n":40,"strictFailure":16}
cargo test | stored passed         {"n":123,"strictFailure":14}
npx tsc | stored passed            {"n":74,"strictFailure":11}
tsc | stored passed                {"n":13,"strictFailure":7}
```

That is 60 of 510 stored `passed` verdicts (11.8%) whose own output shows a failure. The 60 have
not been checked one by one; the samples are genuine vitest summaries (`Test Files  1 failed`). A
first count of 160 overmatched on cargo's passing line (`0 failed`) and was discarded (a search_miss
entry records it). That 60 of 67 stored `failed` verdicts do NOT match the strict patterns is
expected, since a build or lint failure has no test summary. It also means the patterns are
incomplete, so 60 is a floor.

Entries are immutable, so this is never a cleanup. The options are an invalidation annotation on
the affected `verification_run` entries, and a new version of the derived type whose verdict states
its source (`exit_status` / parsed outcome, each with a `_state`). Prevention for the event model
is the same: `exit_status` from the live `tool_response`, plus an outcome parsed from the output.

## Resolution

`f25c6d6` reads `is_error` only when that exit status belongs to the check: nothing after the
check but `&&`. Otherwise it reads the check's own output summary, and when that doesn't settle
a verdict, it writes nothing. `verification_run` is v2, with a required `verdict_source`. Its
ids carry the derivation version (`verification_run@2:`), so v2 entries sit beside v1 instead of
colliding with them.

The re-ingest (`asc ingest claude-code --full`, 2026-09-23), exact:

```
entry   verification_run    1181 new
5637 check run(s) had their exit status masked by a later command and printed no summary line that settles a verdict, so none was recorded.
```

Each of the 652 v1 entries was classified against its v2 sibling (the same key), or, where there
is no sibling, against its own transcript:

```
superseded (v2 sibling exists) 88 | orphans 564 {"transcript_missing":67,"masked_no_output":434,"owned_chain_changed":3,"masked_output_disagrees":56,"masked_output_agrees":3}
```

The 564 orphans include one entry whose `tool_use_id` recurs under a second session, a copied
transcript. The classifier's map was keyed by `tool_use_id` and dropped it. It was classified by
hand from its own transcript (masked, no output), so the classes sum to 563 and the row count
is 564.

The invalidations follow those classes: `superseded` for the 88, and `wrong_value` for the 497
where either v1's `is_error` belonged to a later command or its recorded transition no longer
reproduces. The 67 whose transcript is gone are **not** invalidated: nothing can re-derive
them, so there's no evidence either way. The v1 view, afterwards, exact:

```
$ sqlite3 .ascend/ascend.db "select invalidated, verdict, count(*) from v_verification_run_v1 group by 1,2"
|failed|27
|passed|40
superseded|failed|22
superseded|passed|66
wrong_value|failed|46
wrong_value|passed|451
```

Of the 88 superseded pairs, 4 changed verdict from passed to failed, all read from output. And
the v2 view, exact:

```
$ sqlite3 .ascend/ascend.db "select verdict, verdict_source, count(*) from v_verification_run_v2 group by 1,2"
failed|exit_status|17
failed|output|504
passed|exit_status|51
passed|output|609
```

Failures were 95 of 652 v1 entries (14.6%) and are 521 of 1,181 v2 entries (44.1%). The two
sets are not the same events: v2 covers a corpus that grew, and a different set of transitions.
So this is the size of what v1 could not see, not a before/after rate. 1,113 of the 1,181 v2
verdicts come from output. `is_error` alone would have settled 68.

## Links

- Bead: `asc-6ola.6` (parent `asc-6ola`; blocks `asc-6ola.7` edit.unverified)
- Related: `dogfood/0010` (segmenter), `spike/power/PREREG.md` (M2's workaround)
