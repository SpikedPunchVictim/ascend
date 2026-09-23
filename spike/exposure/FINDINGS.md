# asc-6ola.2 probe — findings, and the exposure format they settle

Predictions sealed in `PREREG.md` (sha256 `442ac5bb…68f3`, in the bead notes). Two reps,
`claude-haiku-4-5-20251001`, Claude Code 2.1.280, ephemeral scratch projects. Cost $0.0336 and $0.0354.

## Result, rep 1 and rep 2 identical for the pre-registered channels

| id | channel | model reported it | transcript record with `rendered` containing it |
|---|---|---|---|
| SS | SessionStart plain stdout | 2/2 | 2/2 `hook_success:SessionStart` |
| UPS | UserPromptSubmit plain stdout | 2/2 | 2/2 `hook_success:UserPromptSubmit` |
| PRE | PreToolUse JSON `additionalContext` | 2/2 | 2/2 `hook_additional_context:PreToolUse` |
| POSTJ | PostToolUse JSON `additionalContext` | 2/2 | 2/2 `hook_additional_context:PostToolUse` |
| POSTP | PostToolUse plain stdout | **0/2** | **0/2**, yet a `hook_success:PostToolUse` record holds the text in `content` and `stdout` |
| STOP | Stop `decision: block` reason | 2/2 | 2/2 `hook_blocking_error:Stop` |
| BIG *(extension, rep 2 only)* | PostToolUse JSON `additionalContext`, 20,405 bytes, nonce at the end | **0/1** | `rendered` holds a preview: `<persisted-output>\nOutput too large (19.9KB). Full output saved to: …` |

| # | prediction | result |
|---|---|---|
| E1 | SS and UPS recorded and delivered | confirmed 2/2 |
| E2 | POSTJ recorded and delivered | confirmed 2/2 |
| E3 | PRE recorded and delivered (low confidence) | confirmed 2/2 |
| E4 | POSTP not delivered | confirmed 2/2 |
| E5 | STOP reason delivered | confirmed 2/2 |
| E6 | every reported nonce has a transcript record containing it | confirmed, and sharper than predicted: **a record with `rendered` exists if and only if the model received the text.** Delivered 10/10 had one; not delivered 3/3 had none. |

n = 2 reps with one model and one harness version. The mechanism behaved deterministically, but
this is not a rate.

## What it means

1. **"The hook ran" is not exposure.** POSTP wrote a `hook_success` record whose `content` holds
   the full guidance, and the model never saw it. An exposure log that trusts the handler, or
   trusts `hook_success`, reports false exposures. This is a false green in the
   `mutation-harness-must-distinguish` class.
2. **Delivery is verifiable by replay.** The `rendered` field is the harness's own record of what
   entered the model's context. Tool-level records carry `toolUseID`, which equals the hook input's
   `tool_use_id`, so the join is exact.
3. **Delivery has three outcomes, not two.** BIG was *partly* delivered: a preview replaced it and
   whatever sat past about 2 KB was lost. The `asc-3q7` ceiling therefore applies to tool-level
   guidance too, not only SessionStart.
4. **Channels are not interchangeable.** Plain stdout reaches the model only on SessionStart and
   UserPromptSubmit (confirmed against https://code.claude.com/docs/en/hooks: "The exceptions are
   `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`"). Tool-level
   guidance must use JSON `additionalContext`.

## The exposure format this settles

Exposure is two records joined by an `exposure_id`. The part only the live dispatcher knows is
written live. The part only the transcript can prove is derived by replay.

**`guidance.decided`**, written live by the dispatcher for every eligible match, including the
ones it withholds:

| field | why |
|---|---|
| `exposure_id` | join key; also embedded in the payload (below) |
| `intervention_id`, `intervention_version` | which lesson (`asc-6ola.1`) |
| `harness`, `session_id`, `prompt_id`, `tool_use_id`, `hook_event`, `agent_id?` | the trigger; all present in hook input per the docs |
| `arm` | `delivered` · `held_out` · `suppressed` |
| `suppress_reason` | `budget` · `dedupe` · `cooldown` · `channel_invalid` · `oversize`, when `arm = suppressed` |
| `channel` | `additional_context` · `stop_block` · `session_stdout` · … (harness-neutral name) |
| `payload_sha256`, `payload_bytes` | what was sent, without storing it twice |

**`guidance.delivery`**, derived by replay for `arm = delivered`:

| `delivery` | evidence |
|---|---|
| `delivered` | a record with `rendered` whose content holds BOTH markers |
| `truncated` | start marker present, end marker absent, or a persisted-output preview |
| `not_delivered` | no record with `rendered` for this trigger |
| `unverifiable` | the harness keeps no rendered record. Never written as `delivered`. |

**Markers.** The dispatcher wraps every payload as `[asc:<exposure_id>] … [/asc:<exposure_id>]`.
The start marker survives truncation and the end marker does not, so one replay check tells all
three outcomes apart. The model can also cite the id, which later links an acknowledgement to the
exposure.

**Holdout.** `held_out` is the control arm: the lesson matched and was deliberately not shown. It
is assigned per *session* × intervention (a hash of `session_id` and `intervention_id` against the
holdout rate), not per event, because a model that saw the guidance once carries it for the rest
of the session. Without a concurrent holdout, every evaluation is before/after with nothing held
constant.

**Dispatcher rules the probe forces:**
- Refuse channels that don't deliver (plain stdout on tool events), and log them as `suppressed:
  channel_invalid` rather than silently doing nothing.
- Cap payloads well under the ceiling, and let replay catch any violation as `truncated`.

## Limitations

- Subagent hooks (`agent_id`) and `SubagentStop` were not probed. Neither were other harnesses.
- The size ceiling for tool-level context is bracketed only from above (< 20,405 bytes delivered as
  a preview). `asc-3q7` brackets SessionStart at 8,990–10,495.
- "Reported by the model" shows the text reached context. It does not show the text changed
  behaviour. That is what the holdout arm exists to measure.

## Addendum: capturing events ourselves (survey, not pre-registered)

`capture-probe.mjs`: an async `cat >> events.jsonl` hook on 8 events, one haiku session ($0.0318),
two Bash calls. Exact output:

```
SessionStart        keys+=[source]
UserPromptSubmit    keys+=[prompt]
PreToolUse         toolu_01SrjhgJ8xvCjq3gf7DZKqVe keys+=[tool_name,tool_input,tool_use_id]
PostToolUse        toolu_01SrjhgJ8xvCjq3gf7DZKqVe keys+=[tool_name,tool_input,tool_response,tool_use_id,duration_ms] tool_response={"stdout":"hi",...}
PreToolUse         toolu_013GJ5GEDKZyuAw5VmtKwMSy keys+=[tool_name,tool_input,tool_use_id]
Stop                keys+=[stop_hook_active,last_assistant_message,background_tasks,session_crons]
SessionEnd          keys+=[reason]
tool_use ids: transcript 2 captured 2 missing from capture 0
```

- Hook payloads carry the tool output and `duration_ms` (the transcript has no duration).
- The second call was blocked and produced **only** `PreToolUse`: no `PostToolUse` and no
  `PostToolUseFailure`. A capture that doesn't also subscribe to `PermissionDenied` leaves
  denied calls with no outcome.
- The assistant's text reaches hooks only as `last_assistant_message` at `Stop`. Text between tool
  calls is transcript-only.

Per-event cost, 200 runs each: shell append 5.65 ms, minimal node appender 71.8 ms, `asc` CLI
184 ms. With `async: true` (documented as "runs in the background without blocking"), capture
leaves the model's path.

Unmeasured: whether concurrent async appends (parallel tool calls) interleave inside one file when
a payload exceeds the atomic write size, and the byte cost of keeping `tool_response` bodies.
