# asc-tuur.1 — which hook stages a handler's lifecycle hook can run at

Descriptive, not pre-registered. The questions were fixed in the asc-tuur plan before running.
`node spike/capture-hooks/probe.mjs <scratch-dir>` was run 2 times: haiku-4-5, `-p`, and a
throwaway project under the OS temp root. The project holds one skill (`probe-skill`), async
capture hooks on six events, and one synchronous PostToolUse hook with matcher `Skill` that
returns JSON `additionalContext` carrying a nonce. The cost was $0.0583 and $0.0438.

Exact output of run 1, with the temp path shown as `<tmp>`:

```
PreToolUse        Skill  keys+=[tool_name,tool_input,tool_use_id] tool_input={"skill":"probe-skill"}
PostToolUse       Skill  keys+=[tool_name,tool_input,tool_response,tool_use_id,duration_ms] tool_input={"skill":"probe-skill"}
SubagentStart            keys+=[agent_id,agent_type] agent_id=adb7ae18 agent_type=general-purpose
PreToolUse        Skill  keys+=[agent_id,agent_type,tool_name,tool_input,tool_use_id] agent_id=adb7ae18 agent_type=general-purpose tool_input={"skill":"probe-skill"}
PostToolUse       Skill  keys+=[agent_id,agent_type,tool_name,tool_input,tool_response,tool_use_id,duration_ms] agent_id=adb7ae18 agent_type=general-purpose tool_input={"skill":"probe-skill"}
SubagentStop             keys+=[agent_id,agent_type,stop_hook_active,agent_transcript_path,last_assistant_message,background_tasks,session_crons] agent_id=adb7ae18 agent_type=general-purpose
Stop                     keys+=[stop_hook_active,last_assistant_message,background_tasks,session_crons]
Q4 nonce reported by model: true
```

Run 2 printed the same lines, with a different `agent_id`. The only difference was the order of
SubagentStop relative to the main Stop.

| Question | Run 1 | Run 2 |
|---|---|---|
| Q1: PostToolUse `Skill` fires, and `tool_input.skill` names the skill | yes | yes |
| Q2: it fires for a Skill call inside a subagent, with `agent_id` + `agent_type` | yes | yes |
| Q3: SubagentStop fires, with `stop_hook_active`, `last_assistant_message`, `agent_transcript_path` | yes | yes |
| Q4: the Skill hook's JSON `additionalContext` reaches the model (nonce repeated) | yes | yes |

Together with `spike/exposure/FINDINGS.md`, this establishes that each of these fires under
`-p`, which answers the asc-5i6a question for these events:

- UserPromptSubmit, which carries `prompt`;
- Stop, which carries `stop_hook_active`;
- PreToolUse and PostToolUse, whose input carries the tool's input.

**What this means for the design.** Every lifecycle stage in the asc-tuur plan (`on_prompt`,
`on_skill`, `on_stop`, `on_subagent_stop`) has a hook that fires and carries what the stage needs.
SubagentStop's `last_assistant_message` is also a live route-A signal, because a subagent's
final report text arrives without reading the transcript.

**Limitations.** n=2, one model, one harness version. The runs show delivery, not that the model
acts on what it is given: `spike/holdout-unit` measured that at 5/8 (haiku) and 1/3 (sonnet).
Q4 was checked on the main-stream call only.
