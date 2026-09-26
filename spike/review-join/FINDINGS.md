# Spike asc-gtnu.1 — how far does the finding→implementer join have to reach?

Throwaway reconnaissance, not a pre-registered experiment. `asc-gtnu` need (2) is "a join from each
review finding to the implementer's events for the same files (did it run a `catchable_by` check?)",
and `packages/core/src/handler.ts` cannot express it: a window accepts an event only when
`event.seq > trigger.seq` (`:930`) and every partition is `(session_id, agent_id)` (`:903`). Stage 3
of the plan was going to add a bounded **backward** reference and possibly cross-stream scope. This
spike exists to let the data choose between those, before the invariant every existing handler rests
on is touched.

Reproduce:

```bash
node spike/review-join/measure.mjs > spike/review-join/measure.out
```

Raw output is `spike/review-join/measure.out`, pasted unedited below. Counts only: no path string is
printed and no transcript prose is read — this repository is public.

## What is being measured, and what stands in for a finding

There is no finding data. `ReportFindings` has been called **0 times** across 1,236 transcript files
and 637,258 records (`asc-gtnu.1`, re-measured 2026-09-26), so the stand-in is the finding's subject:
**a subagent stream, and the paths it read.** A reviewer that read a file is a reviewer that can
report on it, and that proxy exists in the corpus today.

For every (stream, distinct path read) pair, where does a `file.changed` for that path land?

| bucket | meaning | what it implies for the DSL |
|---|---|---|
| **a** | the same stream | expressible today, but only in the direction the edit falls |
| **b** | the session's `main` stream | needs SESSION scope |
| **c** | another agent's stream | needs SESSION scope |
| **d** | nowhere in the session | unsatisfiable; reported, never zero-filled |

`a` is not sufficient to justify a *backward* reference. `before:` needs an edit strictly EARLIER in
the stream than the trigger, so `a` is split into `a<--` (some edit's `seq` is below the earliest
read of that path) and `a-->`. The same split is given for `b` and `c`.

## The measurement

```
project -Users-spikedpunchvictim-projects-ascend
files 90 events 114268 streams 90 (83 subagent, 7 main) sessions 7
sessions holding more than one stream 4 of 7 
read paths: absolute 2142 relative 0

pair = one (stream, distinct path read). aBackward = an edit exists in the same stream
strictly before the earliest read of that path; bBackward is the same for the main stream.
scope                      pairs      a   a<--   a-->      b   b<--      c   c<--      d shares
subagent / exact path        831    154     16    138    353      1    130     17    194 a  18.5%  bc  58.1%  d  23.3% 
subagent / basename          831    154     16    138    356      1    141     17    180 a  18.5%  bc  59.8%  d  21.7% 
main (control) / exact       257    158    132     26      0      0      1      1     98 a  61.5%  bc   0.4%  d  38.1% 
main (control) / basename    257    159    132     27      0      0      1      1     97 a  61.9%  bc   0.4%  d  37.7% 

--- concentration: is one stream producing all the pairs? ---
subagent streams that read anything 69 of 83
pairs 831 largest single stream 44 (5.3%) top 5 44,33,30,28,26 streams with 1 pair 3

--- field sets, read off the events, not quoted from source ---
   2150 file.read      agent_id batch call derive_version id path seq session_id tool ts
   3259 file.changed   after agent_id batch call derive_version id path seq session_id tool ts
   1495 check.run      agent_id batch call derive_version id runner seq session_id ts verdict verdict_source verdict_state
     88 agent.spawn     agent_id agent_type async batch call child_agent_id derive_version description id model seq session_id ts
     59 agent.return    agent_id call child_agent_id derive_version duration_ms id seq session_id status tokens tool_uses ts

normalizer counters {"records":88407,"events":114268,"unpairedResults":0,"unfinishedCalls":1,"unmatchedNotifications":55,"syntheticModelRecords":12}
kinds {"command.run":68939,"tool.use.start":18172,"tool.use.end":18171,"file.changed":3259,"file.read":2150,"check.run":1495,"search.run":1346,"prompt.submit":409,"model.context":90,"session.end":90,"agent.spawn":88,"agent.return":59}
```

## Three answers

**1. Cross-stream scope IS required. 58.1% (483 of 831) of subagent read pairs have their only
`file.changed` outside the reading stream** — 353 in the session's `main` stream, 130 in another
agent's. A within-stream-only extension covers 154 of 831, 18.5%. This is not one stream's
peculiarity: 69 of the 83 subagent streams read at least one file, and the largest single stream
contributes 44 pairs (5.3%). The partition has to become `session_id` alone, and the replay has to
hold per-session state across files — the largest piece of Stage 3, now known to be necessary rather
than speculative.

**2. The direction is overwhelmingly FORWARD, and the corpus could not have said otherwise.** Only 34
of 831 pairs (4.1%) admit an edit strictly earlier than the read (`a<--` 16, `b<--` 1, `c<--` 17);
603 (72.6%) have their editor only after it. So on this corpus a backward-only design covers 4.1%
and a forward one covers 72.6% — but see the limit below: **this corpus contains no reviewers**, so
what is measured is the *explorer*→implementer shape (read first, report, then main edits), and a
reviewer's shape is the mirror image (implement, then review the code already written). The plan
assumed backward; the data says **neither direction may be assumed from this corpus**, and both
constructs are plausibly needed for different roles. What the data does establish is that the
*scope* question and the *direction* question are independent, and only the first is settled here.

**3. (d) is 23.3% and it is not an instrument failure.** 194 subagent pairs and 98 main pairs have no
`file.changed` for that path anywhere in the session: read-only subjects — docs, config, other
repositories, files under review. A handler asking this question must report these as unsatisfiable
rather than emit a zero-valued row, exactly as the plan's silent-zero guard requires. The main-stream
control has *more* of them (38.1%) than the subagent streams, which is consistent with main reading
widely and editing narrowly.

## The control says the shape is a property of subagents, not of the corpus

Main-stream reads are mostly joinable within their own stream — 61.5% (158 of 257), and 132 of those
have the edit strictly *before* the read. The gap between that and 18.5% for subagents is the whole
finding: **a subagent reads what another stream writes.** It is the reviewer/implementer asymmetry
appearing in the data, measured on 831 pairs, before any reviewer has reported a finding.

## `check.run` cannot be joined to a file, at any scope

The field set above is read off the 1,495 `check.run` events, not quoted from `EVENT_KINDS`:
`runner seq session_id ts verdict verdict_source verdict_state` and the envelope. **There is no
`path`.** So "did it run a `catchable_by` check on THIS file" is not derivable, in-stream or
cross-stream, and the 1,495 events are the size of the population that cannot answer the question.
`handlers/edit-unverified.yaml` already asks only "did ANY check run after this edit", which is a
different question. This is unchanged by Stage 3 and is filed separately in Stage 4.

## Two spelling checks, because an exact match alone is not evidence

- **All 2,142 read paths are absolute; zero are relative.** So the exact-path column is well-defined
  for the read side.
- Matching on basename recovers 14 subagent pairs and 1 main pair (d: 194 → 180, 98 → 97). It also
  cannot distinguish a genuine spelling difference from two same-named files in different
  directories, so 14 is an **upper bound** on what an exact match loses, not a measurement of it. The
  exact-path column is the honest one; ~1.7% is the largest error it could be making here.

## Limits

- **The proxy is a read, not a finding, and this corpus has no reviewers.** Measured corpus-wide:
  1,063 `Agent`/`Task` spawns, of which **0** carry a `review` subagent_type (674 `general-purpose`,
  307 unspecified, 61 `Explore`), and 0 `ReportFindings` calls. So no reviewer→implementer pair
  exists anywhere in this data, and the direction conclusion above is the one thing here that does
  not transfer. Scope does: streams partition identically whatever the subagent's role.
- **One project.** 7 sessions, 4 of them holding more than one stream, 90 files, 114,268 events. This
  is a **census of one project's 831 pairs, not a sample estimate**, so no interval is computed and
  no `wilson` is quoted — `MIN_N` governs a grouped proportion, and this is a count over a whole
  population. It says nothing about any other project.
- **The corpus is live.** Three consecutive runs read 114,227 / 114,250 / 114,268 events; `main`
  pairs moved 256 → 257 between runs while the subagent pairs and the four buckets were stable at
  831 / 154 / 353 / 130 / 194. The numbers above are one run at 2026-09-26T23:23Z, saved in
  `measure.out`.
- **NOT pre-registered numerically.** The question and the four buckets were fixed in the plan file
  before this ran, but no magnitude was predicted, so this is descriptive reconnaissance and not a
  test of a prediction. `EV-27.md` must say so rather than present these as a settled prereg.
- `unmatchedNotifications: 55` and `unfinishedCalls: 1` are the normalizer's own counters, reported
  because they are nonzero and might otherwise be read as a clean sweep.

## Decision this forces on Stage 3

Written down before Stage 3 starts, which is what Stage 0 owed:

1. **Ship cross-stream scope.** Partition by `session_id` for handlers that ask for it, with the
   default left at `stream` so every existing `handlers/*.yaml` replays byte-identically. 58.1% of
   the join lives there; a within-stream-only Stage 3 would cover 18.5% of it.
2. **Do not pick `before:` over a forward construct on this evidence.** 72.6% of the measured joins
   are forward, but they are the explorer's shape. `catchable_by` is a reviewer's question about
   code already written and already checked, which is backward — and there is no reviewer in the
   corpus to measure it with. Both directions stay in scope, and the direction test belongs to the
   seeded-defect reviewer experiment filed in Stage 4, not to this corpus.
3. **`d` gets a reported verdict, not a row.** 23.3% of pairs are unsatisfiable within the session;
   the handler must say so.
4. **`check.run`'s missing path is out of Stage 3's reach** and is filed as its own bead in Stage 4.
