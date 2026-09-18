# EV-7: does the git-hook integration actually run?

> **Project identifiers were redacted after publication.** This repository is public. Private
> project, user and MCP-server names in this record were replaced with the stable pseudonyms used
> throughout `docs/evidence/` (`<user>`, `<org-B>`, `<project-A>` ..). The same pseudonym always
> means the same thing in every record, so every count and comparison below stays checkable. Only
> identifiers changed; no measured value was altered. The store behind these numbers was scrubbed
> to match — see `dogfood/0004-2026-09-18-the-corpus-records-identity.md`.


**Question**    Two questions, named before running:

                **Q1.** `asc-rename`'s acceptance criterion was *"config was checked to contain no
                absolute paths, but CONFIRM rather than assume."* The close reason recorded for
                `asc-l4q` asserted the confirmation was made. **Was that assertion true?**

                **Q2.** ascend needs a pre-commit quality gate (`TASKS.md` non-negotiable #5).
                beads also installs git hooks, and `core.hooksPath` is a **single value** — one
                mechanism, two claimants. Which component should own it, and can they coexist?

**Method**      Read-only inspection of this repo (`.git/config`, `.beads/hooks/`, `bd hooks list`),
                plus a **throwaway probe repo** in `/tmp` to answer Q2 without touching ascend's
                config. The probe asked what `bd hooks install` actually persists and what
                `--chain` actually produces. Both probe directories were removed after measurement.

                No transcript, database, or tracked file was modified by the measurement itself.

## Measurement

### Q1 — the assertion was false

```
$ git config --local --list | grep '^core\.'
core.hooksPath=/Users/<user>/projects/<project-G>/.beads/hooks

$ test -d "$(git config core.hooksPath)" && echo EXISTS || echo DEAD
DEAD
```

`.git/config` **does** contain an absolute path, and it points at `projects/<project-G>` — the directory's
name *before* the rename. It does not exist.

Independent corroboration, from bd itself rather than from my reading:

```
$ bd hooks list
  ✗ pre-commit: not installed
  ✗ post-merge: not installed
  ✗ pre-push: not installed
  ✗ post-checkout: not installed
  ✗ prepare-commit-msg: not installed
```

All five shims **do** exist on disk at `.beads/hooks/` and **are git-tracked**
(`git ls-files .beads` lists all five; `.beads/hooks/` is not in `.beads/.gitignore`). They are
inert because git resolves hooks through `core.hooksPath`, which points elsewhere.

**Consequence: this repo has had zero functioning git hooks since the rename.** Five beads hooks —
including a `pre-commit` chain and a `prepare-commit-msg` that writes agent-identity trailers — have
been silently dead. Nothing reported it. Git emits no warning when `hooksPath` names a directory
that does not exist; the hooks simply do not run.

### Q2 — bd's installer contradicts itself

Probe: `git init` in a fresh `/tmp` directory, then `bd hooks install --beads`.

```
✓ Git hooks installed successfully
Hooks installed to: .beads/hooks/
Git config set: core.hooksPath=.beads/hooks      <-- what it PRINTS

$ git config --local core.hooksPath
/private/tmp/asc-hookprobe.heOUFw/.beads/hooks   <-- what it WRITES
```

**The printer and the writer disagree.** bd announces a relative path and persists an absolute one.
That mismatch is the entire root cause of Q1: a rename cannot break a relative path, and silently
breaks an absolute one.

### Q2b — `--chain` can produce an unreachable block, and still reports success

Probe: a pre-existing `.beads/hooks/pre-commit` containing a user gate ending in `exit 0`, then
`bd hooks install --beads --chain`.

```
$ sh .beads/hooks/pre-commit
PRE-EXISTING USER GATE
exit=0

$ awk '...' .beads/hooks/pre-commit
3: exit 0 found HERE
5: beads block starts HERE
=> CONFIRMED: beads block (line 5) is unreachable, exit 0 at line 3 short-circuits it
```

The installer help says `--chain` will *"Chain with existing hooks (run them before bd hooks)."*
It does preserve user content — but it **appends** bd's block *after* it, so a user hook that
terminates normally leaves bd's block permanently unreachable, while the installer prints
`✓ Git hooks installed successfully`.

### Q2c — the replacement arrangement, verified by controlled comparison

The decision above fixes the *shape* (ascend's gate above beads' markers, beads owning
`core.hooksPath`). `scripts/install-hooks.mjs` implements it. It was verified end-to-end in a
throwaway repo, with `bd hooks install --beads --chain` run alongside as the **control**:

| arrangement | `core.hooksPath` written | beads' block executes? |
|---|---|---|
| `bd hooks install --beads --chain`, gate ending `exit 0` | *absolute* | **NO** |
| `scripts/install-hooks.mjs` | `.beads/hooks` (*relative*) | **YES** |

Execution was proven by shell trace (`sh -x`), not by output — the first attempt at this
measurement reported "NOT PROVEN" and was **wrong**: it grepped for `+ bd hooks run pre-commit`,
but beads wraps that call in a perl timeout, so the traced line is
`+ perl -e 'alarm shift; exec @ARGV' 300 bd hooks run pre-commit`. Absence of beads' *output* was
also not evidence — the block is silent when there is no database and no chained hooks. The
re-run under the corrected pattern shows the block executing. This is the third time in this
record that checking the artifact rather than a proxy for it changed the answer.

The same script also verified, on the artifact it had just written:

- the gate is present **above** the beads marker, and the beads block is intact and terminal;
- no bare `exit`/`exit 0` sits above the marker (enforced as a **precondition on the gate
  source**, so a poisoned gate is refused *before* anything is written — verified by feeding it a
  gate ending `exit 0`: exit 1, no write);
- re-running is idempotent (one gate, one beads block);
- `bd hooks list` reports **5 installed**, where ascend's real repo currently reports 5 *not*
  installed.

One bug was caught by the script's own post-condition check on its first run: it asserted the file
`endsWith('# --- END BEADS INTEGRATION')`, but beads stamps a version into the marker
(`# --- END BEADS INTEGRATION v1.2.2 ---`), so a **correct** artifact was rejected. The check now
matches the marker text and ignores the version stamp. The install succeeded; only the assertion
was wrong. Note the direction of that failure — it was loud, and it stopped the run. A verifier
that cannot produce a false *pass* is doing its job even when it false-fails.

### Q3 — and then the new gate reported a false green of its own

While verifying the gate, it printed `[pre-commit] ascend gate ok` while the test suite was
**failing**. Measured directly:

```
$ pnpm test  >/dev/null 2>&1; echo "pnpm test exit = $?"
pnpm test exit = 1

$ sh .githooks/pre-commit >/dev/null 2>&1; echo "GATE EXIT CODE = $?"
GATE EXIT CODE = 0           <-- and it printed "ascend gate ok"
```

**Cause:** the checks ran in a subshell used as an `if` condition:

```sh
if ! ( set -eu; ...; pnpm test ); then ...fail...; fi
```

POSIX **suppresses `set -e` inside any command forming an `if` condition.** So `set -eu` never took
effect, the subshell ran past the failing `pnpm test`, exited 0, and the gate announced success over
a red suite. The gate was written this way precisely to isolate shell state (invariant 2 above) — the
isolation was right, the failure propagation was silently absent.

**Fix:** the subshell is now a *standalone* command whose status is captured, so `set -e` applies:

```sh
( set -eu; ...; pnpm test )
status=$?
if [ "$status" -ne 0 ]; then echo "... FAILED (exit $status)"; exit 1; fi
```

Verified both directions: with a failing `pnpm`, exit 1 and no `ok`; with a passing `pnpm`, exit 0
and `ok`. Both are pinned by tests in `packages/cli/test/dev-hooks.test.ts`, which drive the real
gate file with a stubbed `pnpm` so neither arm depends on the suite's own state.

**This is the third false-green in this record and the second one that is mine.** `EV-storage.md`
had a harness measuring an empty table; bd's installer prints one path and writes another; and now
the gate that exists to catch exactly this class could not itself fail. All three share one shape:
**a success message produced by code that never verified the thing it claimed.** The gate is the
worst of the three, because a gate is believed — its whole purpose is to be the signal you trust
when you stop looking.

The class invariant adopted in `EV-storage.md` ("assert the store is populated before measuring")
and generalized in Q2 ("an installer's success message is not evidence") therefore extends one step
further, to the gate itself:

> **A check must be shown to fail before it is trusted to pass.** A green result from a check that
> has never been observed going red is not evidence of anything.

That is now enforced twice over: the gate's own two-arm test above, and the existing
`purity-enforcement.test.ts`, which drives the linter against a deliberate violation *and* a clean
control for the same reason.

## Decision

**Q1: the `asc-l4q` close reason was wrong and has been corrected.** It claimed config contained no
absolute paths. It contained one, dead. `asc-l4q` is **reopened** — the rename verification failed
on its own stated acceptance criterion, and the failure was in *how I checked*, not in what I found:
`bd where` reports the database path and says nothing about `.git/config`, and I treated it as if it
covered config. Repair is tracked as `asc-joa.3`.

**Q2: bd should own `core.hooksPath`, and ascend should chain into bd — not the reverse.**

The evidence decides this, and it overturns the design I had already implemented:

- My `hook:install` script set `core.hooksPath .githooks`. That value is **relative**, which is the
  property Q2 proves is load-bearing — but it would take git hooks away from bd entirely, disabling
  five beads hooks to install one ascend gate. Stealing the mechanism to use it is not a fix.
- bd's shims are already **git-tracked**, and bd's own health check (`bd hooks list`) works only when
  bd's markers are where it expects them. Owning the path keeps that signal honest.
- bd's shims are **portable** — `grep -rn 'projects/' .beads/hooks/` finds no absolute path inside
  any hook body. The only non-portable artifact bd creates is the `core.hooksPath` value itself.

**Therefore: `.githooks/pre-commit` is not the hook git will run, and must not pretend to be.** It
is the *source* of the gate; `scripts/install-hooks.mjs` splices it into the file git actually
resolves. The ordering constraint is fixed by measurement (Q2b, Q2c): the gate must sit *above*
bd's managed block and must **never** terminate the shell there, or it reproduces exactly the
defect it was written to avoid — a gate that disables the hooks it chained to, while reporting
success. It also runs its work in a **subshell**, because splicing shares one shell and a bare
`set -eu` or `cd` in the gate would silently change beads' block behaviour.

**Not done here:** the `core.hooksPath` write is a repo-local git-config change. That is the user's
decision, and a session-level permission denial already declined an equivalent write. The installer
is written, verified, and **left unarmed**. Opting in is one command:

```sh
pnpm hook:install      # -> node scripts/install-hooks.mjs
```

It sets the path **relative** (`core.hooksPath=.beads/hooks`), so a future rename cannot repeat
this. `pnpm hook:uninstall` removes the gate and leaves beads' hooks as they were.

## Confidence

**High** on every measurement above — each is a command whose output is quoted verbatim, and Q2's
findings were reproduced from scratch in a throwaway repo rather than inferred from ascend's state.

**High** that the hooks are dead, because two independent methods agree: git's resolution of
`core.hooksPath`, and bd's own `bd hooks list`.

**Medium** on the chosen ownership arrangement. The ordering constraint (gate above bd's markers, no
early `exit 0`) is measured. What is *not* yet measured is how a bd upgrade treats user content above
its markers — bd documents that content outside the markers "is preserved across installs and
upgrades," but I have not run an upgrade to confirm it. Treat the gate's survival across a bd upgrade
as **unproven**.

## What this changes beyond the hook

Three false-greens appear in this record, and they share one shape: **a mechanism reported success
while doing nothing**, and the report was believed because nothing contradicted it. Two of the three
are mine.

| # | defect | whose | how it was caught |
|---|---|---|---|
| 1 | harness measured a runtime path on a just-recreated, empty table (`EV-storage.md`) | mine | re-ran the ALTER against a *populated* table |
| 2 | `bd hooks install` prints a relative path, writes an absolute one (Q2) | bd's | read `.git/config` instead of the success message |
| 3 | the gate printed `gate ok` over a failing suite (Q3) | mine | compared `pnpm test`'s exit code to the gate's |

Every one was caught by *checking the artifact rather than the report*: re-running the ALTER against
populated data; reading `.git/config` instead of trusting `bd where`; capturing the gate's exit code
instead of reading its summary line.

The class invariant this project adopted from `EV-storage.md` — *any measurement of a runtime
registration path must assert the store is populated before measuring* — takes two further forms
here, one per direction the reporting can fail:

> **An installer's success message is not evidence. Verify the artifact it claims to have written.**

> **A check must be shown to fail before it is trusted to pass.** A green result from a check never
> observed going red is not evidence of anything.

Applied to this finding: `bd hooks install` printing `✓ Git hooks installed successfully` while
producing either a dead path (Q2) or an unreachable block (Q2b) is the same defect as my harness's
`ACCEPTED, 0.26 ms`. The remedy is also the same — assert the post-condition on the artifact, not the
return code. `asc-joa.3`'s fourth acceptance criterion (a non-existent `hooksPath` must fail loudly)
is the first invariant written as a requirement; the gate's two-arm test in
`packages/cli/test/dev-hooks.test.ts` is the second.
