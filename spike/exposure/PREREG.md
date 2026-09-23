# asc-6ola.2 probe — can guidance delivery be verified from the transcript?

Written 2026-09-23 before the probe ran. Sealed by sha256 in the bead notes.

**Why.** An exposure log that only records "the handler emitted guidance" repeats the failure
EV-16 found: `hook_response` held the full brief while the model got a 2 KB preview (`asc-3q7`).
The frozen corpus shows the transcript writes an `attachment` record with a `rendered` field for
SessionStart hooks (183 `hook_success` + 131 `hook_additional_context`). No other hook event
appears in the corpus, because none was ever configured. Exposure needs PreToolUse,
PostToolUse and Stop.

**Probe.** One `claude -p` session (haiku) in an ephemeral scratch project with five hooks. Each
hook emits a unique random nonce through one output channel. Task: run `echo hi`, then list every
`NONCE-` string seen, verbatim. Two reps.

| id | event | channel |
|---|---|---|
| SS | SessionStart | plain stdout (control: known delivered) |
| UPS | UserPromptSubmit | plain stdout |
| PRE | PreToolUse (Bash) | JSON `hookSpecificOutput.additionalContext` |
| POSTJ | PostToolUse (Bash) | JSON `hookSpecificOutput.additionalContext` |
| POSTP | PostToolUse (Bash) | plain stdout |
| STOP | Stop | JSON `{"decision":"block","reason":…}`, first stop only |

## Predictions

| # | prediction |
|---|---|
| E1 | SS and UPS nonces are recorded as attachments AND reported by the model. |
| E2 | POSTJ is recorded and delivered. |
| E3 | PRE is recorded and delivered (low confidence: not known whether PreToolUse accepts additionalContext). |
| E4 | POSTP is **not** delivered to the model (plain stdout on PostToolUse is not model context). |
| E5 | STOP's reason is delivered: the session continues and reports it. |
| E6 | **The key one:** for every nonce the model reports, the transcript holds a record containing it. So delivery is verifiable by replay, and the exposure log can record `delivered` from the transcript rather than trusting the handler. |
