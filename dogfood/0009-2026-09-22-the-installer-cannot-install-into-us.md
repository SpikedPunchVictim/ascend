# 0009 — The installer we shipped cannot install into this repository

| | |
|---|---|
| **Bead** | `asc-cjm` |
| **Surfaced** | 2026-09-22 |
| **Surfaced by** | Trying to install ascend's own SessionStart hook into ascend, immediately after shipping `asc-4dm.2` (`b19237f`) |
| **Entry type(s)** | `tool_denial` (derived) |
| **Severity** | P2, matching the bead |
| **Status** | open |

> **Paths in this record are redacted.** This repository is public, and the real strings
> contain a working directory. `<user>` follows the project's standing pseudonym. The
> counts and timings are exact; only the path text was altered.

## What was found

`asc install-hook` generates a command containing absolute paths — the checkout root and
the running interpreter. That is correct for the installer's intended target, someone
else's project, whose `.claude/settings.json` is local and untracked. It is wrong for a
repository that **tracks** `.claude/settings.json`, which is this one. Committing the
generated command would publish a real working directory, pin the hook to one machine's
Homebrew Node, leave it inert for every clone, and break on this machine at the next Node
upgrade.

This is an absence, not a wrong default: there is no portable mode, and nothing refuses or
warns when the target file is tracked. The installer succeeds, and the damage is only
visible one `git commit` later.

The consequence is concrete and already paid: the hook from `asc-4dm.2` had to be applied
by hand, in the repository whose entire purpose is that hook. We dogfooded the *hook* and
could not dogfood the *installer*.

## How it surfaced

Nobody was looking for it. The question asked was "for dogfooding purposes, don't we want
to install the hook into this project?" — a scheduling question, not a defect hunt. The
intended answer was a one-line `asc install-hook --yes`.

The mechanism that made it visible was checking whether the target file was tracked before
writing to it (`git ls-files --error-unmatch .claude/settings.json`), and then reading the
two commands side by side — the hand-written one already in the file against the one
`--dry-run` proposed. The diff is the finding. `--dry-run` had been run first and reported
`would upgrade`, which is *true* and gives no hint that the upgrade is uncommittable.

Second mechanism, unplanned: the attempt to write the file was refused twice by the host's
auto-mode classifier as `[Self-Modification]` — editing the hooks that run on this agent's
own session boundaries. Both refusals were ingested by the very command that was blocked,
and appear in the corpus as the two most recent `tool_denial` rows:

```
tool_name     denial_kind       occurred_at
------------  ----------------  ------------------------
Edit          automode-blocked  2026-09-22T18:21:05.735Z
Bash          automode-blocked  2026-09-22T18:20:37.559Z
```

The pipeline recorded the event that stopped the pipeline from being installed.

## The metric

Absolute paths in the generated command, from `asc install-hook --dry-run` piped through
`grep -o "'/[^']*'" | sort | uniq -c | sort -rn` (path text redacted, counts exact):

```
   3 '/Users/<user>/projects/ascend/packages/cli/dist/bin.js'
   2 '/opt/homebrew/Cellar/node@24/24.18.0/bin/node'
   1 '/Users/<user>/projects/ascend/.ascend'
```

**6 occurrences across 2 distinct machine-specific roots.** Every one of them would have
been committed.

The portable form was executed rather than assumed — the exact command, with
`CLAUDE_PROJECT_DIR` set as Claude Code sets it, streams captured separately:

```
exit=0  elapsed=2.458590000s   stdout 3476B  stderr 0B
run 1:  exit=0 elapsed=.685990000s  stderr 0B  stdout 3476B
run 2:  exit=0 elapsed=.404455000s  stderr 0B  stdout 3476B
```

Empty stderr is the load-bearing number: `SessionStart` stdout is injected into the
session, so the brief must be the only payload, and `ingest` writes an identity-disclosure
line to stderr that would otherwise land there too.

Corpus over the three runs: **2,070 → 2,077 entries**. The +7 is this session's own
continued writing, including the two denials above — not duplicate ingestion. The
re-run-adds-nothing property was established separately under `asc-4dm.4` on a quiesced
corpus; it is not re-claimed here, because this corpus was not quiesced.

## The pattern

**A tool whose defaults are correct for its users and wrong for its author.** The two
choices that make the command unportable are each individually well-reasoned, and each
carries a comment saying why: `install-hook.ts:146` pins `process.execPath` because
`@ascend/store` imports `node:sqlite` and needs Node 22.5+; `install-hook.ts:411` refuses
to emit a bare `asc` because nothing links it onto a `PATH`. Neither comment is wrong.
The gap is that "my own repository" is a deployment target nobody enumerated, and it is
the one target the author hits every single day.

The generalization: when a project uses its own tool, it occupies a configuration that its
tool's design never considered, *because the designer was thinking about users*. Dogfooding
does not merely test the tool harder — it tests a case the requirements never named.

A second, sharper instance of the same class is visible in the finding itself: a `--dry-run`
that reports `would upgrade` is answering "what will change", when the question that
mattered was "what will this cost me when I commit it". A preview that only previews the
write cannot surface a consequence that lands downstream of the write.

## Why nothing else would have caught it

- **Tests could not.** `install-hook`'s 24 tests all run against a temporary directory. A
  temp directory is never tracked by git, so the tracked-settings case is unreachable from
  the suite by construction.
- **Code review could not.** Both path decisions are commented with correct reasoning. A
  reviewer reading `install-hook.ts` sees two justified choices and no defect; the defect
  only exists in relation to a file that lives outside the file under review.
- **`--dry-run` did not,** though it is the feature built for exactly this moment. It
  printed the absolute paths plainly and reported `would upgrade`. Being shown the right
  string is not the same as being told what it implies.
- **The quality gate could not.** `format:check`, `typecheck`, `lint`, `test` and `align`
  all pass; nothing in the gate inspects what a generated string would mean once committed.

The only thing that caught it was using the tool on ourselves and checking one fact about
the destination before writing to it.
