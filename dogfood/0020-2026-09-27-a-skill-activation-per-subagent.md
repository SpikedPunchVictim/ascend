# 0020 — `skill_activation` counts one skill run as one activation per subagent, and misses a skill a subagent calls itself

| | |
|---|---|
| **Bead** | `asc-gtnu.17` |
| **Surfaced** | 2026-09-27 |
| **Surfaced by** | the user rejecting "15 of 19 bug-hunt sessions produced no report" as impossible |
| **Entry type(s)** | `skill_activation` (derived) |
| **Severity** | P2 |
| **Status** | fixed in the `asc-gtnu.17` commit (`skill_activation` rule 2); live store not yet re-derived |

## What was found

`skill_activation` does not count what a user means by "I ran bug-hunt". The deriver makes one
activation per run of records that carry `attributionSkill`, and it does this separately in each
stream (`packages/adapter-claude-code/src/derive.ts:955`). Every subagent spawned while a skill is
active inherits that attribution. So one bug-hunt request counts as 1 + N activations, one for the
main stream and one for each subagent. The reverse also happens: when a subagent calls
`Skill(bug-hunt)` itself and its records carry no `attributionSkill`, it produces **no**
activation. The type over-counts in the common case and under-counts in the other, and neither
error shows up in the total.

## How it surfaced

While designing how ascend could capture review findings without changing the user's workflow, I
counted bug-hunt runs by scanning raw transcripts for `Skill(bug-hunt)` tool calls. That scan
found 19 calls, which I reported as if they were sessions: "15 of 19 produced no templated report".
The user said there had not been that many. Breaking the count down by session and stream showed
three things:

- my raw count mixed tool calls with sessions, and included two of our own experiment sessions;
- the store's figure (24, which EV-27 carried as "bug-hunt skill runs") has a subagent problem of
  its own;
- the two instruments disagree about which sessions exist.

Nobody was looking for it. The user knew their own usage and saw that the number was too high.

## The metric

The store, measured 2026-09-27 through `asc query` on the live store (read-only):

```
activations  sessions  main_stream  temp_dir_projects
-----------  --------  -----------  -----------------
24           6         7            0
```

```
s         agent            n
--------  ---------------  -
09054587  (null)           1
2563912b  (null)           2
96a5a5d3  (null)           1
96a5a5d3  Explore          4
b286a945  (null)           1
b286a945  general-purpose  3
df503f84  (null)           1
df503f84  general-purpose  5
f5717795  (null)           1
f5717795  general-purpose  5
```

17 of the 24 are subagent streams.

The raw scan, over `~/.claude/projects` (read-only, Python). It counted `Skill` tool_use blocks
whose `skill` contains `bug-hunt`, plus `<command-name>` slash invocations, deduplicated by
tool_use id or record uuid:

- 21 distinct activations in 8 sessions. 2 of those sessions are our own experiments, with cwd
  under the OS temp root (EV-16's arm and the `asc-gtnu.14` probe).
- Session `08e77eaa` (in a project whose name is redacted here) has 5 `Skill(bug-hunt)` calls, all in subagent
  streams. `grep -l '"attributionSkill":"bug-hunt"'` finds 0 of its files, and the store has no
  activation for it.
- Session `09054587` is in the store, but its transcript is no longer on disk. The store is the
  only surviving record of that run.

Counting one review per top-level request gives about **8 reviews across 7 sessions**. That uses
these rules: exclude synthetic sessions, fold subagent streams into their parent, take the union of
the signals, and count from the store. All of these are small numbers, well under `MIN_N` = 20.
That is fine for a census, which is what this is.

## The pattern

A derived type's unit is whatever the signal it keys on happens to delimit (here, a run of
attributed records in one stream), and that is not the unit a person means ("I ran it once").
Subagents make the gap wide, because they multiply streams without multiplying intent.
`dogfood/0006` (`recorded_at` is the ingest clock) is the same shape on a different axis: a field
that measures the instrument rather than the event.

## Why nothing else would have caught it

The fixtures have no subagents that inherit an attribution, so every test sees one stream and one
activation. The only thing that could see the gap was a count checked against someone's memory of
their own usage.

## Consequences and constraints

- EV-27's carried figure, "bug-hunt skill runs: 24 (`v_skill_activation_v1`)", counts
  activations, not runs. EV-27 is not edited. This record is the correction.
- Any design that detects "a review happened" from `skill_activation` inherits this error. That
  includes the capture work filed with this record.
- Existing entries are immutable. The fix goes where they are written (derive a parent/child
  relation, or a separate per-request type), or it is an invalidation annotation. It is never a
  cleanup of the store.

## Resolution

`skill_activation` is at derivation 2 (`derivationVersion`). The type's properties are unchanged,
and `EVENT_DERIVE_VERSION` is unchanged because no event reads `attributionSkill`. The new rule:

- **A `Skill` tool call is an activation** in any stream, keyed on its tool_use id.
- **The attributed run a call starts is the same activation.** The call claims it, and one call
  claims one run.
- **A subagent run with no call of its own is inherited.** It is counted as `inheritedSkillRuns`
  and not written.
- **A main-stream run with no call is still an activation.** That is how a slash-invoked skill
  arrives.

Before the change, the signals were cross-tabulated per (stream, skill) over the live corpus,
excluding OS-temp projects:

```
31 main invoked attributed-after
37 main invoked never-attributed
2 sub attributed no-invocation-in-stream from-first-record
50 sub attributed no-invocation-in-stream later
7 sub invoked attributed-after
77 sub invoked never-attributed
```

34 of the 37 untagged main-stream "invocations" are built-in commands (`/exit` 23, `/compact` 10,
`/config` 1, `/login` 1), not skills. The only main-stream skill calls that went untagged are
`empirical-planning` ×2. A `Skill` result was an error 0 of 105 times, so the rule writes at the
call, not at the result.

The whole corpus was re-derived into a scratch store under rule 2 (`asc ingest claude-code`, fresh
`asc init` under the OS temp root) and compared with the live store, which is still on rule 1.

For bug-hunt:

```
s         agent            n
--------  ---------------  -
08e77eaa  general-purpose  5
2563912b  (main)           2
96a5a5d3  (main)           1
96a5a5d3  general-purpose  1
b286a945  (main)           1
b286a945  general-purpose  3
df503f84  (main)           1
f5717795  (main)           1
f5717795  general-purpose  4
```

- `df503f84`'s 5 inherited streams are gone.
- `08e77eaa`'s 5 subagent calls, which were invisible, are present.
- The remaining subagent rows are subagents that called `Skill(bug-hunt)` themselves. Each one
  is a real load of the skill, and none is a separate request.

A request is a main-stream activation, or a session whose only activations are in subagents:

```
requests  sessions
--------  --------
7         6
```

The two stores reach 7 requests from different rows. The live store has `09054587`, whose
transcript is gone. The scratch store has `08e77eaa`, which rule 1 never saw. **Their union is 8
requests across 7 sessions**, the figure this record estimated by hand.

Across all skills, main-stream activations went from 43 (rule 1, live) to 35 (rule 2, scratch):

- 11 rule-1 main rows belong to sessions whose transcript is gone, so a scratch store cannot
  re-derive them;
- 3 rows are main-stream `Skill` calls that were never tagged, which rule 2 now writes;
- 43 − 11 + 3 = 35.

Every other per-session difference is one skill whose name the live store holds redacted and the
scratch store does not. That is the same activation, not a rule difference.

**The live store is not yet migrated.** Rule-2 entries get new ids (`skill_activation@2:...`), so
the next `asc ingest claude-code` writes them beside the rule-1 rows. As in `dogfood/0015`, the
rule-1 rows are then retired by invalidation annotation, never deleted. The ones whose transcript
is gone are not invalidated, because they are the only record of those activations.

## Links

- Bead: `asc-gtnu.17`
- Correction to: `docs/evidence/EV-27.md` (carried figure, "bug-hunt skill runs")
- Related: `dogfood/0019`, `asc-gtnu.14`
