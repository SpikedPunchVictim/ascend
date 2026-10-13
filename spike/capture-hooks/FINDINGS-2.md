# asc-s05g — the hook-input key inventory, measured with an instrument that can show it

Descriptive, not pre-registered. This is a **new run**, not a revision of `FINDINGS.md`, which is the
record of an earlier one and stays as it is. It exists because that record's displayed line was

```
keys+=[$(Object.keys(e).filter((k) => !BASE.includes(k)).join(','))]
```

against a literal `BASE` that contains `transcript_path`. A key listed in its own exclude list can never
appear in the output, so the line could not distinguish *the harness sent transcript_path* from *nobody
looked* — while reading as an enumeration of what arrives. It is an enumeration of what arrives minus
eight keys that were assumed present.

## The instrument

`spike/capture-hooks/probe.mjs` now prints, per event, the whole sorted key list and each assumed key
with a present/absent marker, and then — because a per-event line cannot show a key that is absent on
*every* event, which is the single reading the old line made impossible — a count of how many captured
events carried each assumed key. `spike/exposure/capture-probe.mjs` carried the same filter and takes
the same correction. `BASE` no longer exists in either file; there is nothing left to filter a key out
of an enumeration with.

## The run

`node spike/capture-hooks/probe.mjs <scratch-dir> haiku` — one run, exit 0, cost **$0.236439**, 10
captured events. Throwaway project under the OS temp root, one skill (`probe-skill`), async capture
hooks on six events, and one synchronous PostToolUse hook with matcher `Skill` that returns JSON
`additionalContext` carrying a nonce.

The model was passed as the alias `haiku`, because the pinned id the earlier record used is refused by
this account now: that run exited 1 with `costUsd 0`, one captured event and no tool stage, and printed
*"There's an issue with the selected model (claude-haiku-4-5-20251001). It may not exist or you may not
have access to it."* The harness then logged `[claude-code:unrecognized_model]` naming
`deepseek-v4.1-flash:cloud` as what the alias resolved to, so **the model that answered is not
necessarily haiku** and this record does not claim it is.

Exact output, with the temp path shown as `<tmp>`:

```
{"model":"haiku","exit":0,"costUsd":0.23643899999999998,"captured":10,"dir":"<tmp>/capture-hooks-1791855411845"}
skill tool calls in stream: [{"id":"call_ulktn1ip","inSubagent":false,"input":{"skill":"probe-skill"}},{"id":"call_yxh3m5td","inSubagent":true,"input":{"skill":"probe-skill"}}]
UserPromptSubmit         keys(7)=[cwd,hook_event_name,permission_mode,prompt,prompt_id,session_id,transcript_path] assumed-absent=[scratchpad_dir,effort]
PreToolUse        Skill  keys(10)=[cwd,effort,hook_event_name,permission_mode,prompt_id,session_id,tool_input,tool_name,tool_use_id,transcript_path] assumed-absent=[scratchpad_dir] tool_input={"skill":"probe-skill"}
PostToolUse       Skill  keys(12)=[cwd,duration_ms,effort,hook_event_name,permission_mode,prompt_id,session_id,tool_input,tool_name,tool_response,tool_use_id,transcript_path] assumed-absent=[scratchpad_dir] tool_input={"skill":"probe-skill"}
PreToolUse        Agent  keys(10)=[cwd,effort,hook_event_name,permission_mode,prompt_id,session_id,tool_input,tool_name,tool_use_id,transcript_path] assumed-absent=[scratchpad_dir]
SubagentStart            keys(7)=[agent_id,agent_type,cwd,hook_event_name,prompt_id,session_id,transcript_path] assumed-absent=[scratchpad_dir,permission_mode,effort] agent_id=a01d1318 agent_type=general-purpose
PreToolUse        Skill  keys(12)=[agent_id,agent_type,cwd,effort,hook_event_name,permission_mode,prompt_id,session_id,tool_input,tool_name,tool_use_id,transcript_path] assumed-absent=[scratchpad_dir] agent_id=a01d1318 agent_type=general-purpose tool_input={"skill":"probe-skill"}
PostToolUse       Skill  keys(14)=[agent_id,agent_type,cwd,duration_ms,effort,hook_event_name,permission_mode,prompt_id,session_id,tool_input,tool_name,tool_response,tool_use_id,transcript_path] assumed-absent=[scratchpad_dir] agent_id=a01d1318 agent_type=general-purpose tool_input={"skill":"probe-skill"}
SubagentStop             keys(14)=[agent_id,agent_transcript_path,agent_type,background_tasks,cwd,effort,hook_event_name,last_assistant_message,permission_mode,prompt_id,session_crons,session_id,stop_hook_active,transcript_path] assumed-absent=[scratchpad_dir] agent_id=a01d1318 agent_type=general-purpose
PostToolUse       Agent  keys(12)=[cwd,duration_ms,effort,hook_event_name,permission_mode,prompt_id,session_id,tool_input,tool_name,tool_response,tool_use_id,transcript_path] assumed-absent=[scratchpad_dir]
Stop                     keys(11)=[background_tasks,cwd,effort,hook_event_name,last_assistant_message,permission_mode,prompt_id,session_crons,session_id,stop_hook_active,transcript_path] assumed-absent=[scratchpad_dir]
assumed session_id       present on 10 of 10 captured events
assumed prompt_id        present on 10 of 10 captured events
assumed transcript_path  present on 10 of 10 captured events
assumed cwd              present on 10 of 10 captured events
assumed scratchpad_dir   present on 0 of 10 captured events
assumed permission_mode  present on 9 of 10 captured events
assumed effort           present on 8 of 10 captured events
assumed hook_event_name  present on 10 of 10 captured events
Q4 nonce reported by model: true
```

## What the corrected table says

| assumed key | present on | which events omit it |
|---|---|---|
| `session_id` | 10 of 10 | — |
| `prompt_id` | 10 of 10 | — |
| `transcript_path` | 10 of 10 | — |
| `cwd` | 10 of 10 | — |
| `scratchpad_dir` | **0 of 10** | every event |
| `permission_mode` | 9 of 10 | SubagentStart |
| `effort` | 8 of 10 | UserPromptSubmit, SubagentStart |
| `hook_event_name` | 10 of 10 | — |

**Three of the eight keys the old probe subtracted are not on every event, and one of them is on no
event at all.** `scratchpad_dir` was never sent by this harness in this run; `effort` is missing from
UserPromptSubmit and SubagentStart; `permission_mode` is missing from SubagentStart. Under the old
line every one of those three absences was printed as silence, indistinguishable from presence —
which is exactly the failure the bead describes, now shown as a measurement rather than argued.

`transcript_path` — the key whose invisibility is the reason this bead exists — is present on **10 of
10** events, which is what `spike/hook-input-keys/FINDINGS.md` established from the other direction.

The original questions, re-answered by this run:

| Question | This run |
|---|---|
| Q1: PostToolUse with matcher `Skill` fires, and `tool_input.skill` names the skill | yes — `tool_input={"skill":"probe-skill"}` |
| Q2: it fires for a Skill call inside a subagent, carrying `agent_id` + `agent_type` | yes — `agent_id=a01d1318 agent_type=general-purpose` |
| Q3: SubagentStop fires, and with which keys | yes — 14 keys, including `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons`, `stop_hook_active` |
| Q4: the Skill PostToolUse hook's JSON `additionalContext` reaches the model | yes — the model repeated `NONCE-SKILL-fff37fc2` |

These agree with `FINDINGS.md`'s four answers, on a later harness version. What is new is not the
answers but that an instrument now exists which could have disagreed.

## Limitations

n=1. One harness version. The model is whatever the `haiku` alias resolved to on this account, not a
pinned id, and the pinned id the earlier record used is no longer served — so this run is not a
drop-in replacement for that one's model claim. Q4 was checked on the main-stream call only. The
per-event `keys(n)` counts are of this run's ten events; they are not a claim about every session.
