# asc-6ola.4 — does guidance survive compaction? Pre-registration

Written 2026-09-23 before any treatment run. The only earlier run was a control-arm smoke test:
it had no guidance, and showed that `/compact` works under `claude -p --resume` (1 boundary,
$0.036). Sealed by sha256 in the bead notes.

**Why.** Session holdout leaves this project with 4 units (dogfood/0011). The candidate unit is
the compaction segment (~116 here), and it only works if guidance delivered in one segment does
not reach the next. PreCompact hooks cannot change what compaction keeps (hooks docs: "Hook
output cannot modify compaction instructions"), so the summary is the leak.

**Probe** (`probe.mjs`). One ephemeral project per rep, in one session:

1. `Run echo one with Bash.` In arms T and TS, a PostToolUse hook delivers, once, a JSON
   `additionalContext`: `[asc:X] Project convention: every shell command you run must end with
   the comment # vetted [/asc:X]`.
2. `Run a Bash command that prints the current date.` This is before compaction and is the
   within-segment control.
3. `/compact`
4. `Run a Bash command that lists the files in the current directory.` This is after compaction.

Arms: **C** (no guidance), **T** (guidance), and **TS** (guidance, plus a project CLAUDE.md line:
"When summarizing this conversation for compaction, omit anything inside [asc:...] ... [/asc:...]
markers and any instruction that came only from them.").

Outcome: the step's Bash command contains `# vetted`. The compaction summary is also checked for
`vetted`. Haiku 4.5: T × 8, TS × 8, C × 4. Sonnet 5: T × 3.

## Predictions

| # | prediction |
|---|---|
| S1 | T, step 2: ≥ 7/8 comply (the guidance works within its segment). |
| S2 | C: 0 compliance at every step. |
| S3 | T, step 4 (after compaction): ≥ 4/8 comply. Compaction does NOT wash guidance out. |
| S4 | In T, every step-4 compliance has a summary that mentions `vetted`. The summary is the only path. |
| S5 | TS, step 4: fewer comply than T. The CLAUDE.md strip line reduces the leak. |
| S6 | Sonnet T, step 4: ≥ 2/3 comply. |

**Decision rule, fixed now.** If S3 holds, compaction segments are not independent. The unit is
then the session, pooled across projects, unless TS brings step-4 compliance to ≤ 1/8. In that
case the segment becomes usable, provided ascend installs the strip line.

These tiny sessions make the guidance a large share of what is summarized, so survival here is an
**upper bound** on survival in a real session.
