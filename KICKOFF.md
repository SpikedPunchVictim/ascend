# Kickoff prompt — ascend

Copy everything below the line into a fresh agent session started in this repo.

---

You are building **ascend**, a greenfield TypeScript project. This repo currently contains only
planning documents — no source code yet.

## What ascend is

LLM workflows don't record what they do in a form that supports later analysis, so patterns never
surface and process changes can't be evaluated. ascend is a local, per-project store that workflows
write structured **entries** into as they work. Entry *types* are defined at runtime — an LLM can
register a new type and start recording against it. After hundreds of entries accumulate, a human
queries the corpus, finds patterns no single entry revealed, and acts on them.

The defining property: **analysis is deferred.** Entries are recorded without interpretation.
Classification happens retrospectively, once a pattern becomes visible. This is deliberately *not* a
metrics or time-series system, and there is no baseline-comparison requirement.

## Read these first, in this order

1. **`ARCHITECTURE.md`** — the source of truth for every design decision, and *why* each was made.
   Do not re-litigate settled decisions; several were chosen against the obvious option for reasons
   recorded there.
2. **`TASKS.md`** — the work breakdown, the empirical protocol, and the rules of engagement.
3. **`bd ready`** — the actionable task queue (beads is already initialised, prefix `asc`).

## How to work

Tasks live in beads. `bd ready` shows what's unblocked; `bd show <id>` gives the full description,
acceptance criteria, and empirical requirements. Use `bd update <id> status=in_progress` when you
start and `bd close <id>` when done. Dependencies are already wired — respect them.

**Start with `asc-5f6` (spike harness) and `asc-l4q` (the rename).** They are the only two
unblocked tasks; everything else is gated.

## Non-negotiables

1. **Empirical before assertive.** Any decision that can be settled by running something MUST be
   settled by running it. Twelve tasks are tagged `[EMPIRICAL]` — each produces a committed
   `EV-<n>` record (Question / Method / Measurement / Decision / Confidence). Name the question
   *before* running. Use real data: the ~829 real transcripts in `~/.claude/projects/` (read-only,
   never write there), a real model, the real CLI. **Report the losing arm's numbers too.**
2. **A negative result is a successful task.** If a measurement kills part of the design, say so
   plainly and stop. `asc-spike-patterns` is an explicit GO/NO-GO on the project's central premise:
   whether patterns actually emerge at single-user volume. It uses a shuffled-label control. If the
   answer is no, raise it — do not proceed quietly.
3. **Never invent a number.** "Faster" is not a finding. "180ms → 24ms, n=50" is.
4. **The spike gates everything.** No task in E2 or later starts until `spike-findings` closes with
   a recorded verdict.
5. **Omitted, never fabricated.** When a value doesn't exist, omit it — never write `0` for unknown.
   `measured-as-zero`, `not-applicable`, and `not-measured` are three distinct states and the
   distinction cannot be retrofitted.
6. **Core stays pure.** `packages/core` and `packages/analysis` have zero `fs`, zero `Date.now()`,
   zero network. Time and IDs are injected. A test enforces this.
7. **Three attempts, then stop.** Document what was tried, the exact error text, and why it failed;
   reassess rather than attempting a fourth time.
8. **Every commit compiles and passes tests.** No `--no-verify`, no disabled tests.
9. **Dogfood from the moment it runs.** As soon as `asc record` works, ascend records its own
   construction — a `stage-transition` per task closed, a `stuck-event` per 3-strike event, a
   `decision` per non-obvious choice. ascend's own build becomes its first corpus, and analysing it
   is the project's own acceptance test.

## Tooling already installed here

`pnpm install` is done; `node_modules/` exists. Two of the prior-art projects below are installed as
devDependencies of this repo, so they are usable tools and not only reading material. Neither is on
`PATH` — invoke them as `./node_modules/.bin/<name>`.

- **`align` (`@spikedpunch/align-cli` 0.2.1)** — architecture-conformance oracle. The purity rules in
  non-negotiable #6 should become machine-checked align rules rather than prose. Run `align init`
  once `packages/` exists, commit `align.config.ts`, and wire `align check` into the pre-commit gate
  (`asc-quality-gates`). `align check` exiting 0 is part of the definition of done.
- **`mast` (`@spikedpunch/mast` 0.3.0)** — lexical + declaration-exact code search. Run `mast init .`
  after the workspace lands and re-index as the tree grows; it beats fanning out `grep` across five
  packages. Verified working here.

Caveat worth knowing before you lose an hour to it: mast needs a compiled `better-sqlite3` binding,
and `pnpm rebuild better-sqlite3` is a silent no-op on this setup. If any `mast` command other than
`--help` throws a `MODULE_NOT_FOUND` listing `better_sqlite3.node` paths, run
`node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/node_modules/.bin/prebuild-install`
from inside that package directory. Native-build allowances live in `pnpm-workspace.yaml` —
pnpm 11 ignores the `pnpm` field in `package.json`.

**Do not inherit mast's FTS5 tokenizer by assumption.** mast chose trigram for *code identifiers*;
ascend indexes *prose*. `asc-spike-fts` measures that choice against real data.

## Prior art worth reading (all local, all on this machine)

- **`~/projects/align`** — `packages/core/src/telemetry/*`, `docs/adr/015-2026-07-13-telemetry.md`.
  The closest precedent for the recording half: envelope design, pure-core/imperative-shell split,
  one-recorder discipline, and the omission doctrine.
- **`~/projects/mast`** — `src/search/{fused,fts}.ts`. FTS5 + BM25 + RRF, the query sanitizer you
  must port (`toFtsMatch`), and zero-result assist. Note mast *deleted* its vector store; ascend
  uses no embeddings.
- **`~/projects/<project-F>-workbench/apps/COLLECTIVE_BUILD_REPORT.md`** — read the confounds section.
  It is a real corpus that lost the absent-vs-zero distinction permanently. Do not repeat it.
- **`~/projects/<project-E>/.todos/issues.db`** — session/work-unit modelling in SQLite. Note the
  `issues.parent_id` trap: never use empty-string sentinels.

## Reporting

State limitations plainly. Report failures verbatim. If the design and the evidence disagree, the
evidence wins — record what it overturned in `spike/FINDINGS.md` and flag it.
