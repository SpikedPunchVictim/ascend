# asc-zser — can `install-hook` put `asc` on a session's PATH? Pre-registration

Written 2026-10-09 before any treatment run. The predictions below were made independently of the
Claude Code documentation (the doc question was asked in parallel), so a doc claim that contradicts
one of them is a finding rather than a reason to adjust it.

**Why.** Nothing links an `asc` binary onto `PATH` — README §Install says so in as many words — so
every artifact that shows a bare `asc` command depends on a shell alias the reader must define.
`dogfood/0050` is that cost made concrete, and `dogfood/0028` is why the recording route is shaped
as it is: *the hook script cannot spell the bare form either*. The bead names one candidate
mechanism: `CLAUDE_ENV_FILE`, a file Claude Code sources as a shell script at session start, so
`export PATH="/x:$PATH"` really expands — unlike `settings.json`'s `env` block, whose values are
literal and where a `PATH` value *replaces* the inherited one.

Three questions decide whether the mechanism is real, and none of them is answerable by reading
`install-hook.ts`:

1. **Does `CLAUDE_ENV_FILE` exist on a stock install** — is it a variable Claude Code sets, or one
   the user must configure first?
2. **Is a write to it honoured in the SAME session that writes it?** A `SessionStart` hook runs at
   the boundary; if the file is read *before* hooks run, a hook's write only lands on the NEXT
   session, and the feature is worth much less.
3. **What happens when it is absent?** A hook that writes to an unset path unguarded must not turn
   every session start into an error.

**Probe** (`probe.mjs`). One ephemeral project per rep, two sessions each. The project holds a
`bin/asc` that prints `MARKER-OK` — a command named `asc` that exists *only* on the project's own
`bin/`. A `SessionStart` hook consumes its JSON stdin, logs whether `$CLAUDE_ENV_FILE` is set and
whether it lives inside or outside the project (never the value itself), and in the `write` arm
appends `export PATH="<project>/bin:$PATH"` to it.

Then two sessions — a fresh `--session-id` each — run one Bash command:

```
echo "FOUND=$(command -v asc || echo NONE)"
```

`Bash(echo:*)` is the only allowed tool, so a negative cannot be a permission denial misread as
"not found". The verdict is read off the shell's RESULT text, never off the command text (which
contains the literal `FOUND=NONE` it would print). Arms: **write** (hook writes the export) and
**control** (hook logs but writes nothing). Haiku 4.5, 4 reps per arm.

Question 3 is not a live arm: whether an unguarded write to an unset path errors is a fact about
`sh`, tested directly and cheaply rather than inferred from a session.

## Predictions

| # | prediction |
|---|---|
| P1 | `CLAUDE_ENV_FILE` is **set** for a `SessionStart` hook on a stock install — Claude Code provides the variable, the user does not configure it. If it is unset, the bead has no mechanism and is refuted at its premise. |
| P2 | The path it names is **outside the project** (under `~/.claude` or a temp directory), which is what makes this the bead's *"touches a file outside the project"*. |
| P3 | A `PATH` export written into it by a `SessionStart` hook **is honoured in the SAME session** — session 1 resolves `asc`. This is the load-bearing prediction; the whole design rests on it. |
| P4 | The **control** arm never resolves `asc` in either session: the marker is not already on `PATH`, so a positive in the `write` arm is attributable to the write. |
| P5 | Session 2 resolves `asc` too, whether because the export persists in the file or because the hook re-writes it at each session start. |

**Decision rule, fixed now.**

- **P3 holds** → the mechanism is real and `asc-zser` is buildable as designed: `install-hook`
  writes a `PATH` export into `CLAUDE_ENV_FILE` at `SessionStart`, and the session that starts sees
  a bare `asc`. Then the open question is only *what to install* — the checkout's own `dist/bin.js`,
  or a shim — and it becomes an implementation bead, not a measurement one.
- **P3 fails, P5 holds** → the mechanism is **next-session-only**. `install-hook`'s message must say
  so, the alias in README §Install is still needed for the session that installs it, and the bead's
  value is much reduced. Recorded, not built as hoped.
- **P1 fails** → premise refuted; close the bead with the refutation and no code.

## Outcome (added 2026-10-09, after the runs — the section above is unchanged)

**All five predictions held. `P3 holds` → the mechanism is real and `asc-zser` is buildable as
designed.** 4 reps per arm, two sessions each: the write arm resolved `asc` in the same session
**4/4**, the control arm **0/4**; `CLAUDE_ENV_FILE` was set and outside the project **8/8**. The
unguarded-append test exited 1 with `sh: : No such file or directory`; the guarded one exited 0.
Record, decision and the harness deviation (the registered probe command was denied by the
allowlist and had to be replaced): **`docs/evidence/EV-47.md`**.
