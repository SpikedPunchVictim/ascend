# 0082 — `install-hook` reported success and installed a hook that never reached its binary

| | |
|---|---|
| **Bead** | `asc-hllr` (found during); filed separately — see *Links* |
| **Surfaced** | 2026-10-12 |
| **Surfaced by** | `asc install-hook --holdout 0.3 --yes` in a foreign repository, then a Claude Code session in it that edited a file and decided nothing |
| **Entry type(s)** | none recorded — the store the entries would have gone into is the thing that stayed empty |
| **Severity** | P1 — the settings file says an experiment is installed while no unit is ever decided, and nothing reports it |
| **Status** | open |

## What was found

`asc install-hook` wrote a PostToolUse entry into
`/Users/spikedpunchvictim/temp/ascend-backtest/n8n/.claude/settings.json`, reported

```
hook         /Users/…est/n8n/.claude/settings.json  installed
PostToolUse  /Users/…est/n8n/.claude/settings.json  installed
```

and wrote both `.claude/ascend-hook.sh` and the shim `.ascend/bin/asc`. The store existed
(`asc init` had run). A Claude Code session then started in that project, edited
`packages/workflow/src/common/find-ai-root-node-names.ts` — `git status` shows the modification, and
`asc handlers check` over the session's own transcript reports the `file.changed` that edit produced —
and **`.ascend/exposure/` did not exist when the session ended.** No decision, no delivery, and
nothing on stdout to say so. The SessionStart hook was missing in the same way: two checks of
`find .ascend/entries -name '*.jsonl' | wc -l` right after that session returned **0**, so
`asc ingest claude-code` had not run either.

**The mechanism is a resolution that prefers `PATH` over a shim it already knows the path of, plus a
swallowed exit code.** The generated hook script resolves its binary in three steps:

```sh
if [ -n "$ASCEND_BIN" ] && [ -f "$ASCEND_BIN" ]; then      bin="$ASCEND_BIN"
elif [ -f "$root/node_modules/.bin/asc" ]; then            bin="$root/node_modules/.bin/asc"
elif command -v asc >/dev/null 2>&1; then                  bin="$(command -v asc)"
else                                                       exit 0
fi
```

This project has no `node_modules`, so step 2 misses; step 3 is whatever `asc` the **user's shell**
has on `PATH`. Measured, that is

```
$ command -v asc
/Users/spikedpunchvictim/projects/ascend/.ascend/bin/asc
```

— **another project's shim.** The shim resolves its binary against the project it is being run *for*
(`root=${CLAUDE_PROJECT_DIR:-…}`), which here is n8n, then looks for `$root/packages/cli/dist/bin.js`.
n8n has a `packages/cli` and no `dist/bin.js` in it, so it refuses:

```
$ sh ./.claude/ascend-hook.sh post-tool-use --holdout 0.3 < hook-input.json
asc: no ascend binary for /Users/spikedpunchvictim/temp/ascend-backtest/n8n -- re-run 'asc install-hook' from the checkout that should run it
$ echo $?
0
```

**`install-hook` had written the right shim, and the script did not try it.** It is at
`$root/.ascend/bin/asc`, and the script computes exactly that directory two lines earlier, to append
it to `PATH`:

```sh
ascend_bin_dir="$root/.ascend/bin"
if [ -n "$CLAUDE_ENV_FILE" ] && [ -x "$ascend_bin_dir/asc" ]; then … fi
```

Invoked by that path instead of through `PATH`, the same project's shim works on the first try:

```
$ ./.ascend/bin/asc hook post-tool-use --holdout 0.3 < hook-input.json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"This repository is a pnpm + turbo monorepo. …"}}
```

So the two generated files are halves of one mechanism that each assume the other went first. The
shim carries the absolute path to the installing checkout precisely so a foreign project can find it;
the script's resolution is the only way a hook reaches the shim; and the one branch that would reach
*this project's* shim is missing, so a shim belonging to a different checkout shadows it.

**The second half is that the failure is discarded.** The shim exits 127; the script runs it through
`run hook "$@"` and then `exit 0` unconditionally, so 127 becomes 0. Every path in the script ends in
success, including the one where nothing ran — which is the contract the module doc asks for
("a missing binary is inert") and is also why the install's own report cannot be contradicted after
the fact.

## How it surfaced

By running the thing, in the two-answer pilot `asc-hllr` was filed for. The hook firing is one of the
two questions, and the first session answered it "no" — which looked like a defect in the ask, the
handler, or the store, and was none of them. Nobody was looking for a binary-resolution defect: the
pilot went looking for a unit count.

Two absences pointed at the resolver rather than at the handler, and both came from commands run for a
different reason:

- `.ascend/entries` → **0**. The SessionStart hook had not run either. **Two independent hooks missing
  is a fact about neither of them** — it is a fact about the one script they share.
- `hasTrustDialogAccepted` for that project → **`true`**. Workspace trust, the blocker recorded in
  `asc-hllr` a day earlier, was no longer the explanation.

That Claude Code was invoking hooks at all was then confirmed with a throwaway matcher-`*` hook that
appended to a log — `SESSIONSTART … CPD=/Users/…/n8n` and `POSTTOOL /Users/…/n8n` both appeared. The
invocation was never in doubt; what the invocation resolved to was.

## The metric

| | count | |
|---|---|---|
| sessions run with the hook installed and the store present | 3 | `asc init` + `install-hook --holdout 0.3` preceded all three |
| of those, sessions that decided a unit | **0** | `.ascend/exposure/` absent after each |
| `asc ingest` runs at session start | **0 of 1** | `.ascend/entries/*.jsonl` was 0 after the first session, and again after a second probe session |
| `file.changed` triggers in the first session's transcript | 1 | `asc handlers check`, and `git status` for the edit itself |
| — after `ASCEND_BIN` was set — | | |
| sessions that decided a unit | **3** | |
| `additionalContext` emissions | **5** | 5 sayings delivered |
| units decided | **4** | 3 `delivered`, 1 `held_out`, one line each |
| entries ingested | **6** | `.ascend/entries/*.jsonl`, and `.ascend/ingest-cursor.json` at 581.2 KB |

The group is 3 sessions, far under `MIN_N` (20, `packages/analysis/src/proportion.ts`), so **0 of 3 is
an anecdote and is named as one.** It is not offered as a rate. What it is not is a coincidence: the
same project went from 0 units to 4 on one environment variable, and both sides reproduce on demand
from the project root with one command each.

**This is the class `spike/exposure/FINDINGS.md` and `EV-16` were built around, arriving from the other
direction.** Those measured whether a delivered sentence reaches the model. This measures a sentence
that was never delivered, by a hook that reported itself installed — and to a reader of
`settings.json` the failure is indistinguishable from the experiment running and finding nothing.

## The pattern

**A resolution chain that ends in `command -v` is a resolution chain that ends in the user's `PATH`,
and the user's `PATH` is the one input the install does not control.** The script had a better answer
on disk — a shim written into this project, carrying this project's absolute path — and asked the
shell first. `$root/node_modules/.bin/asc` is the same mistake in a milder form: it asks the project
to have installed ascend, when `install-hook` already guarantees a shim that does not require it.

The narrower statement: **`install-hook` writes a mechanism whose first working branch is one it could
have verified at install time and did not.** It has the running binary in hand, it knows the project
root, and it writes two rows saying `installed`. One resolution attempt against `$root` before writing
those rows would have turned a silent first session into a sentence naming the missing step.

## Why nothing else would have caught it

The hook's own tests would not. `install-hook` is exercised, and correctly: the settings write, the
append-only merge, idempotency across three command generations and the script regeneration are all
pinned, and every one of them was satisfied — the file really was written and the script really was
current. What no test reaches without invoking Claude Code in a project that is not this checkout is
**whether the script, run in the project it was installed into, reaches a binary.**

`asc doctor` would not. It checks for *"a stale installed hook script"*; this script was current and
unrunnable.

`asc handlers check` would not, and it was the command I ran first, for a different reason. Over the
unfixed session's transcript it reports the `file.changed` trigger — the tool call — and says nothing
about a hook that was never invoked. The transcript is the model's record, not the hook's.

## Consequences and constraints

`asc-hllr`'s pilot was blocked for its first session by this. The path used past it was `ASCEND_BIN`,
the first branch of the same chain and a documented override — a workable path for a backtest, not a
fix for the defect.

Nothing here says the hook should stop being inert at run time. That contract is right. What is
missing is the install-time check, and the ordering fix is one branch.

## Links

- `docs/evidence/EV-49.md` — the pilot this surfaced during, and the numbers the fix produced
- `dogfood/0083` — the second defect the same pilot surfaced
- `packages/cli/src/commands/install-hook.ts` — `SETTINGS_COMMAND`, `hookScript`, `shimScript`
- `ARCHITECTURE.md` and the `[ ! -f … ] || …` inert-guard pattern
