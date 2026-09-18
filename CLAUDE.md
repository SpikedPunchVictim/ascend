# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

### Dogfooding findings get written to disk, under `dogfood/`

When using ascend on ascend surfaces a defect, a gap, or a friction — anything that becomes a
bead — write a record for it. **Filing the bead is not enough.** The bead says what to do; the
record says how we found out, and that is the part that teaches the next search. The mechanism
repeats even when the finding does not.

- **One record per finding**, at `dogfood/NNNN-YYYY-MM-DD-short-name.md`, copied from
  `dogfood/0000-template.md`. `NNNN` is the next free sequence number and gives beads a short
  stable citation (`dogfood/0002`); the date is when the finding **surfaced**, not when the bead
  was filed or fixed.
- **"The metric" is required.** A finding without a measurement is an impression, and impressions
  belong in a bead comment. Every measurable claim carries the measured value AND how it was
  obtained; paste exact tool output rather than paraphrasing a number. Where a value does not
  exist, omit it — never write `0` for unknown. A group under `MIN_N` (20,
  `packages/analysis/src/proportion.ts:50`) is named as an anecdote, including when the anecdote
  is about us.
- **Say whether anyone was looking.** "Nobody was looking for it" is the most valuable sentence in
  the series — it is the evidence that dogfooding pays for itself.
- **Remember entries are immutable.** A finding about bad data is never a cleanup task; the
  options are prevention at write time or an invalidation annotation.

**`dogfood/` or `docs/evidence/`?** The test is whether anyone asked the question first. A question
named in advance, with predictions pre-registered before measuring, is an `EV-N` record under
`docs/evidence/`. Something the tool handed you unasked is a dogfood record. A finding may cite
both.

Index and full convention: `dogfood/README.md`.

<!-- align:start -->
## align — architecture conformance

This repo is checked by [align](https://github.com/SpikedPunchVictim/align) for dependency-direction and import-cycle
conformance. Run `align check` (or the `align_check` MCP tool if the align MCP server is
connected) after any structural code change — new imports, moved files, restructured modules.

**A red `align check` is blocking.** Do not consider a structural change complete while
`align check` reports red. Run `align explain <ruleId>` (or the `align_explain_rule` MCP tool)
to understand why a rule fired before proposing a fix.

For full rule-authoring guidance run `align skill --topic authoring`.
<!-- align:end -->
