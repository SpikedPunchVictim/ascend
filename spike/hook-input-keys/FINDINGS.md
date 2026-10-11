# asc-xn4g (Stage 0) — what a hook input actually carries, key by key

Descriptive, not pre-registered. The questions were fixed in `probe.mjs`'s header before the first
run. `node spike/hook-input-keys/probe.mjs <scratch> [model]` was run twice, `claude-haiku-4-5`,
`-p`, throwaway projects under the OS temp root.

**This spike exists because an earlier one could not answer the question while appearing to.**
`spike/capture-hooks/FINDINGS.md` prints `keys+=[…]` computed as
`Object.keys(e).filter((k) => !BASE.includes(k))` for a literal
`BASE = ['session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'permission_mode',
'effort', 'hook_event_name']`. A key listing `transcript_path` in its own exclude list can never
print it, so that run cannot distinguish *the harness sent `transcript_path`* from *nobody looked*.
The output reads as an enumeration of what arrives. It is an enumeration of what arrives **minus
eight keys that were assumed**.

## Result

Exact output of run 1, temp path as `<tmp>`; run 2 was identical apart from session ids:

```
SessionStart
  KEYS (5): cwd, hook_event_name, session_id, source, transcript_path
  transcript_path: /Users/…/.claude/projects/-private-tmp-…/<uuid>.jsonl
  transcript exists at hook time: true
  source: "startup"

UserPromptSubmit
  KEYS (7): cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path
  transcript exists at hook time: true
```

| Question | Result |
|---|---|
| Q1 `transcript_path` present, and on which events? | present at SessionStart and UserPromptSubmit; **the tool stages were not reached** (below) |
| Q2 an absolute path that exists at hook time? | yes, on both events measured |
| Q3 does a real transcript hold countable `isCompactSummary` records? | yes — see the corpus scan |
| Q4 does SessionStart carry `source`, and what is it? | yes; `"startup"` on a normal start |

Q3, against the live corpus rather than the throwaway session (read-only; nothing was copied out of
it): **files = 2260, files containing a compaction = 232, most compactions in one file = 120.**

## What was NOT reached, and why

**Both runs exited 1 at `init`, before the model took a turn.** Only SessionStart and
UserPromptSubmit fire before a model call, so the two tool stages — the only ones `asc hook` would
actually decide a holdout arm at — never fired in either run. Run 2 added `--strict-mcp-config`
because run 1's `init` record showed a user MCP server stuck at `status: pending`; that did not
change the outcome. The cause is not identified. It is **not** the throwaway project: the same
harness produced tool stages under `spike/capture-hooks` and `spike/exposure`.

So the tool-stage key set is **documented below, not measured here**. That is the honest status,
and it is weaker than the two rows above.

## The documented answer, for the part the spike could not reach

Per the hooks reference (https://code.claude.com/docs/en/hooks), `transcript_path` is a **common
input field**, present on every event; PreToolUse's documented example input carries it alongside
`session_id`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_use_id`. SessionStart's `source` takes `startup` · `resume` · `clear` · **`compact`** ·
`fork`, where `compact` is auto or manual compaction.

The reference also carries a caveat this design must inherit, because it is exactly the seam
`asc-xn4g` reads across:

> the transcript file is "written asynchronously and may lag the in-memory conversation, so it may
> not yet include the current turn's most recent messages when a hook fires"

## What it means for asc-xn4g

1. **The route is open.** A live `asc hook` can reach the session transcript by `transcript_path`,
   which is measured present where the hook runs and documented present everywhere else. The
   segment index is therefore derivable live by counting compaction boundaries in that file — the
   same count replay derives from the same file. Live and replay agree **by construction**, which
   is what `spike/holdout-unit/FINDINGS.md` needs of the assignment key.
2. **No second SessionStart hook, and no new state file.** This matters because
   `install-hook.ts` insists there remain exactly one SessionStart entry and that
   `asc types brief` be its only payload. A counter written by SessionStart would have had to
   either share that channel or add a second one; reading `transcript_path` adds neither.
3. **The lag is the risk, and it is specific.** Counting boundaries from a lagging file can
   under-count by one immediately after a compaction — the wrong segment, silently. A compaction
   is heavy and the summary record is written as the session continues, so the window is probably
   short, but **nobody has measured it**. It is the thing to measure before trusting the arm, and
   it is a measurement, not a design question.

## Limitations

- n = 2, one model, one harness version, and the tool stages were reached in neither run.
- The two reached stages cost $0.0000 in model tokens as far as this spike can tell: the session
  died at `init`. No cost figure is claimed.
- Q3 counts a *record type*, not a segment boundary; a file's boundary count is what replay would
  derive from the same lines, which is why the two agree — but the derivation itself was not
  re-implemented here.
- The corpus scan reads `~/.claude/projects` read-only, the same way the adapter does. Nothing was
  copied out of it.
