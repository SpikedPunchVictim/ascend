# asc-tuur.4 — does the review-finding nudge make a bug-hunt reviewer call ReportFindings?

**Pre-registered** on bead asc-tuur.4 before the first run:

- before: 0 of 2 sessions call ReportFindings;
- after: at least 1 of 2 call it.

This is n=2 per arm, under `MIN_N` (20), so it is an **anecdote**.

`node spike/capture-hooks/nudge-probe.mjs --max-usd 6`: sonnet-5, `-p`, prompt "Hunt for bugs in
packages/core/src/handler.ts. Do not change any source files." Both arms had:

- the spike/recall allowlist tree;
- CLAUDE.md as of e7cc416;
- `asc init`, then `asc install-hook --yes` with the SessionStart entry stripped afterwards.

The only difference between the arms: the after arm has `handlers/review-finding-nudge.yaml`, so
install-hook also wrote its PostToolUse hook (matcher `Skill`).

Exact output:

```
run       hooks                 skills          nudge  RF calls  findings  writes  reported  parsed  $
before-1  []                    ["bug-hunt"]    false         1         2       0         2       0  0.7921
after-1   ["PostToolUse"]       ["bug-hunt"]    false         1         2       6         2       0  1.3082
before-2  []                    ["bug-hunt"]    false         0         0       1         0       0  0.8149
after-2   ["PostToolUse"]       ["bug-hunt"]    false         1         2       2         2       0  0.9331
total spent $3.8483
```

**The `nudge` column is wrong, and it is corrected here rather than rerun.**
- The column was read from the stream-json output, and stream-json does not echo hook context.
- Read from each session's transcript instead (`grep -c 'ascend records review findings'`), the
  nudge is in both after sessions and in neither before session:
  - after-1: 2 matches, 1 `hook_additional_context` attachment;
  - after-2: 2 matches;
  - before-1 and before-2: 0 matches.
- The probe now reads delivery from the transcript (`nudgeDelivered`).

| | before | after |
|---|---|---|
| nudge delivered (transcript) | 0/2 | 2/2 |
| sessions calling ReportFindings | 1/2 | 2/2 |
| review_finding entries stored (all `reported`) | 2 | 4 |

**Against the predictions.** The before prediction is **refuted**: before-1 called ReportFindings
with no nudge. The after prediction held, at 2/2. With 1/2 already reached without the nudge,
n=2 cannot separate the nudge's effect from the baseline. What this does show:
- the hook fires end to end in a real headless session, from an install done by `install-hook`;
- the sentence reaches the model;
- no after session failed to report.

**Unasked, and worth more than the headline.**
- **before-2 wrote its bug-hunt report with no markdown table in it** (0 lines starting with `|`,
  10,160 characters). So route A, the table handler, has nothing to read in that session. This is
  exactly the session the nudge exists for. It is one report, and it is a second format drift
  beside the per-finding sections asc-tuur.7 records.
- **`parsed` is 0 in both after sessions, although they wrote reports (6 and 2 Writes).** This is
  by design, not a miss: the session reported, so the table rows are left to the reported route
  (the dedupe in `typed-handlers.ts`).

**Limitations.**
- n=2 per arm, one model, one prompt.
- The spike/lens-review baseline for the same cell was 0/1, with Write denied. Here Write was
  allowed, which is a difference between the two probes, not between these arms.
- **The after arm's tree also holds a `handlers/` directory, and after-1 read it.** Its tool
  calls include `Glob {"pattern": "handlers/*"}` and a Grep with that directory as its path.
  after-2's tool calls do not touch it. So after-1 may have seen the nudge's text as a file as
  well as through the hook, and that is a confound on 1 of the 2 after sessions. The dispatcher reads `handlers/` from the project root, so the directory
  cannot simply be left out. A rerun needs a deny rule on Read/Glob/Grep for it.
