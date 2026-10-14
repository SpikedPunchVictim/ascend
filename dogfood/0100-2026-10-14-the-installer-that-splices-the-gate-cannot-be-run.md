# 0100 — the installer that splices the gate cannot be run any more

| | |
|---|---|
| **Bead** | `asc-g0rl` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | `pnpm hook:install`, run to publish the corrected cost note in `.githooks/pre-push` |
| **Entry type(s)** | none — this is about the hooks' own installation, not the store |
| **Severity** | P1 |
| **Status** | open |

## What was found

`pnpm hook:install` exits non-zero and writes nothing:

```
  FAILED: .beads/hooks/pre-commit has no beads block (looked for '# --- BEGIN BEADS INTEGRATION'),
  so this script cannot tell which part is safe to replace. Refusing to overwrite.
```

The refusal is correct — the file is not the file the script wrote — but the reason is that the file it
wrote is no longer there. GitButler has claimed `.beads/hooks/pre-commit` for itself: it carries a
`GITBUTLER_MANAGED_HOOK_V1` marker, it is a dispatcher that runs `$HOOKS_DIR/pre-commit-user` first and
exits on its failure, and beads' block plus ascend's gate have been **displaced** to
`.beads/hooks/pre-commit-user`. `.beads/hooks/post-checkout` is in the same state.

`core.hooksPath` is still `.beads/hooks`, so the gate still runs — through the displaced file — and
nothing is broken today. What is gone is the ability to change it. The installer is the only supported
way to move a hook edit from `.githooks/<hook>` (the source) into `.beads/hooks/<hook>` (what git runs),
the repository's instructions say to re-run it after every hook edit, and it now fails on its first
hook, so `.beads/hooks/pre-push` cannot be re-spliced either even though GitButler never claimed that
one.

## How it surfaced

**Nobody was looking for it.** It was the second step of an unrelated task: `dogfood/0099`'s prose
correction had been written into `.githooks/pre-push`, and the next move was the routine one the
repository prescribes — `pnpm hook:install` — to make it take effect. The command failed instead.

The displacement itself is not new. It arrived in `89c4577`, the commit that carries the gate-cost
work: that commit's stat shows `.beads/hooks/pre-commit` shrinking by 170 lines and
`.beads/hooks/pre-commit-user` being created beside it, and the same pair appearing for `post-checkout`.
Nobody noticed, because a displaced hook that still runs is invisible — the gate kept blocking, the
rows kept being written, and the installer was not run again until today.

## The metric

The refusal, verbatim, and the evidence for where the gate actually is — four reads of the working
tree, all on 2026-10-14:

```
$ git config core.hooksPath
/Users/spikedpunchvictim/projects/ascend/.beads/hooks

$ head -3 .beads/hooks/pre-commit
#!/bin/sh
# GITBUTLER_MANAGED_HOOK_V1
# This hook is managed by GitButler to prevent accidental commits on the workspace branch.

$ grep -l 'GITBUTLER_MANAGED_HOOK_V1' .beads/hooks/*
.beads/hooks/post-checkout
.beads/hooks/pre-commit

$ grep -n 'BEGIN BEADS INTEGRATION' .beads/hooks/pre-commit .beads/hooks/pre-commit-user .beads/hooks/pre-push
.beads/hooks/pre-commit-user:71:# --- BEGIN BEADS INTEGRATION v1.2.2 ---
.beads/hooks/pre-push:53:# --- BEGIN BEADS INTEGRATION v1.2.2 ---
```

So `pre-commit` holds no beads block and `pre-commit-user` does; `pre-push` was never claimed and still
does. The two artifacts were then checked for staleness against their sources — the gate part of each
spliced file against `.githooks/<hook>` — and both were **in sync** (`.beads/hooks/pre-commit-user`
against `.githooks/pre-commit`; `.beads/hooks/pre-push` against `.githooks/pre-push` before the
correction, differing only by the paragraph being corrected).

`n = 1` occurrence of the displacement, in `n = 1` checkout: an anecdote, well under `MIN_N`. The
countable that is not an anecdote is zero: **no commit since `89c4577` has re-spliced either hook**, and
none could have.

## The pattern

An installer that verifies its artifact thoroughly — this one re-reads what it wrote and asserts the
markers, the reachability of beads' block and the resolved `core.hooksPath` — and does not verify its
*assumption about who owns the file*. It refuses to clobber, which is the right instinct and is why
this is a loud failure rather than a silent one; but refusing is not the same as working, and the
failure it produces is a workflow that has quietly stopped existing. The class is the same as
`dogfood/0095` and `0099`: a mechanism whose assumptions are about a **second program** (there a
client's choice of git command, here another tool's claim on the hook directory) and which no test in
this repository exercises.

Two consequences worth separating. First, the trap the plan warns about — edit the hook, nothing
happens, because the source is inert until spliced — now has no remedy in this workspace, so a future
hook edit ships as a comment and blocks nothing. Second, the artifact verification the installer
performs was reproduced by hand today, which means it was performed by the same agent that made the
edit: exactly the arrangement EV-hooks Q1 exists to argue against ("an installer's success message is
not evidence" — the stronger form is that a person's re-run of the checks is not evidence either).

## Why nothing else would have caught it

No test calls the installer. `grep -rln 'install-hooks\|hooksInstall'` across `packages` and `scripts`
finds no test file — its only hits are `package.json`'s `hook:install` script and a docblock in
`packages/cli/src/commands/store/verify.ts` that names the arrangement in passing. So the displacement
could sit there for as long as nobody re-installed, and the signal that would have surfaced it — a
non-zero exit from `pnpm hook:install` — only fires for someone who runs it, which is exactly the
person who has just made a hook edit and will now be tempted to hand-edit the spliced file instead.

A test would catch it, cheaply and hermetically: a fixture directory laid out like `.beads/hooks` with a
managed dispatcher in `<hook>` and beads' block in `<hook>-user`, asserting which file the installer
writes and that every verification still passes. That is an argument for the test rather than against
this record.

## Consequences and constraints

- **The correction in `dogfood/0099` was applied by hand.** `.beads/hooks/pre-push` was rewritten with
  the installer's own algorithm (shebang, gate source minus its shebang, then beads' block verbatim),
  and then the installer's verification was reproduced by hand: markers present, gate part byte-equal
  to the source, no bare `exit` above beads' block, file executable. That is a divergence from the
  documented path, not a workaround for a rule — nothing here bypasses a check, and the checks were
  run — but it is the kind of divergence that should be one-off, which is why the bead exists.
- **The fix is not obvious enough to apply unasked.** Splice into the file git actually runs, which
  means choosing `<hook>-user` when the target carries the GitButler marker; but the bootstrap path
  (`bd hooks install --beads` when the target is absent) and the verification both have to follow the
  same choice, and choosing wrong installs a gate nobody runs. Recorded in the bead rather than
  guessed at here.
- **GitButler's management of the directory is not stable state to build on.** This is a second tool's
  layout decision inside a directory beads owns, and the installer already documents that it takes
  this mechanism rather than `core.hooksPath` because that single value is beads'. A fix should ask
  the marker, not assume the suffix.

## Links

- Bead: `asc-g0rl`
- `.githooks/pre-push`, `dogfood/0099` — the correction that needed the splice
- `docs/evidence/EV-hooks.md` — the installer's own four measured questions, Q1 and Q2b most of all
- Entries recorded at the time: `tool_denial-e3f683d51501`, `verification_run-2718f4117ffe`
