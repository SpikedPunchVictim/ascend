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

### Q4 — the store guard: does it run in the gate, what does it cost, and what does `dist` guarantee? (`asc-9flv`)

`asc-98e1` built `asc store verify` and nothing called it. Wiring it into the gate raised the two
questions the bead named before any edit, and one it did not.

**Q4a — the cost.** Measured against this store:

```
$ time node packages/cli/dist/bin.js store verify --staged
Note: 22 record file(s), 10810 record id(s), 1 baseline(s) — no conflict markers, no unreadable
lines, no lost record ids.
node packages/cli/dist/bin.js store verify --staged   0.59s user 0.33s system   1.008 total
$ echo $?
0
```

**~1.0s**, and it reads git objects only, so that is node's startup rather than the store's size.

**Q4b — "the command needs `dist/` built, which the gate's own typecheck step does not guarantee."**
That is *half* right, and the half it gets wrong is load-bearing.

`pnpm typecheck` is `tsc -b && tsc -p tsconfig.eslint.json`, and `tsc -b` **is** this repo's build —
`pnpm build` is the same command. So in the ordinary case the step directly above the guard has just
rebuilt `dist/` from this working tree, which is why the guard is placed after it rather than first.

But "rebuilt what changed" is not "the tree is complete," and the difference is measurable:

```
$ rm packages/cli/dist/budget.js
$ pnpm typecheck >/dev/null 2>&1; echo "typecheck exit=$?"; ls packages/cli/dist/budget.js
typecheck exit=0
ls: packages/cli/dist/budget.js: No such file or directory

$ pnpm build >/dev/null 2>&1; echo "build exit=$?"; ls packages/cli/dist/budget.js
build exit=0
ls: packages/cli/dist/budget.js: No such file or directory

$ ./node_modules/.bin/tsc -b --force >/dev/null 2>&1; echo "force exit=$?"; ls -l packages/cli/dist/budget.js
force exit=0
-rw-r--r--@ 1 spikedpunchvictim  staff  21656 ... packages/cli/dist/budget.js
```

**Both exit 0 with an output file missing.** The mechanism is in the artifact rather than the
behaviour: `packages/cli/dist/.tsbuildinfo` carries `fileNames` and `fileInfos` — an **input** list —
and no output list at all (`mentions budget.ts: true`, `mentions budget.js: false`), so build mode has
nothing to compare an output against and reports "up to date." `--force` (2.0s) is what restores it.

**Decision: the gate does not build defensively; it fails loudly, and the choice is stated in the
hook.** A guard that cannot find its own binary exits **2** — measured by deleting
`dist/commands/store/verify.js`:

```
$ node packages/cli/dist/bin.js store verify --staged
 ›   Error: command store:verify not found
$ echo $?
2
```

Non-zero, so the commit is blocked. That is the direction this has to fail in: *a guard that cannot
find its own binary must not read like a guard that looked and found nothing.* The alternative —
skip the check when `dist` looks stale — manufactures exactly the silent absence the guard exists to
catch, and `tsc -b --force` on every commit spends 2.0s to buy a guarantee that the loud failure
already provides in the one state where it is needed.

**Q4c — and the arm the bead did not name: is the guard wired in at all?** A step added to a gate is
believed, so it is tested in both directions. `dev-hooks.test.ts` now stubs `node` the way it already
stubbed `pnpm` — delegating everything except the guard's invocation to the real node — and asserts
that the guard runs **and** that a refusing guard blocks the commit. **Shown red first**: against the
pre-`asc-9flv` gate file the new test fails with

```
AssertionError: expected '[pre-commit] format:check\n[pre-commi…' to contain
'[pre-commit] store verify --staged'
     Tests  1 failed | 5 passed (6)
```

`node` is stubbed for the same reason `pnpm` is. Left real, the guard would run against *this*
checkout's index, and the gate's control-flow test would quietly become a test of whatever happened
to be staged — passing or failing for reasons that are not the gate.

### Q5 — the test count: can the gate see a deleted test, and does the check it gained redden for the wrong reason? (`asc-049w`)

`dogfood/0061` is a green gate over a file whose 55 tests had become 5. The gate ran the whole suite
and printed a pass count; nothing compared that count to anything, so a deleted test and a passing
test were the same word in its output. `asc-049w` gives it something to compare against. Two questions
were named before any edit: **does the count come from the runner**, and **can the check be driven
red**?

**Q5a — the count comes from the runner, and this is the reconciliation that says so.** The reporter
is `vitest.test-count.ts`, registered in `vitest.config.ts`'s `reporters`; it writes
`.testcount/scan.json` on `onFinished`. A reporter's output cannot be asserted into existence from a
unit test, so it was reconciled against a real run:

```
$ pnpm test 2>&1 | grep -E "Test Files|^ *Tests "
 Test Files  131 passed (131)
      Tests  3037 passed | 2 skipped (3039)

$ node -e "const s=require('./.testcount/scan.json'); console.log(s.files, s.tests, s.passed, Object.keys(s.byFile).length, Object.values(s.byFile).reduce((a,b)=>a+b,0))"
131 3039 3037 131 3039
```

The suite printed `3037 passed | 2 skipped (3039)`; the scan reads `3039` collected, `3037` passed,
and **131 `byFile` keys summing to 3039** — the per-file floors account for every collected test and
none twice. The count is the runner's, not a `grep -c "it("`, which `dogfood/0061` measured wrong
twice (it misses `it.each` expansion and a double-quoted name) and wrong in the direction the check
exists to detect.

**Q5b — a removal the file count cannot see, driven end to end.** `packages/cli/test/output.test.ts`
was backed up and truncated from 729 to 668 lines, removing its final `describe` block (2 `it.each` ×
8 shapes + 3 `it` = 19 tests). The full gate was then run with `sh .githooks/pre-commit`:

```
 Test Files  132 passed (132)
      Tests  3028 passed | 2 skipped (3030)

[pre-commit] test count
test count: 3030 collected / 3028 passed in 132 files -- baseline 3049 / 3047, 19 BELOW baseline
  SHRANK  packages/cli/test/output.test.ts  58 -> 39 (-19)
  BELOW   collected tests  3049 -> 3030 (-19)
  BELOW   passed tests  3047 -> 3028 (-19) -- a test skipped or gone, not necessarily deleted
[pre-commit] ascend gate FAILED (exit 1) -- commit blocked
```

**`Test Files 132 passed (132)` — the file count is identical to the run before it**, which is exactly
the defect `dogfood/0061` recorded, and the check now names the file that was hollowed out.

**Q5c — the removal becomes legible rather than silent.** Against that run's scan:

```
$ node scripts/test-baseline.mjs update
test baseline: 132 files / 3049 collected / 3047 passed -> 132 files / 3030 collected / 3028 passed
  LOWERED  packages/cli/test/output.test.ts  58 -> 39

$ node scripts/test-baseline.mjs
test count: 3030 collected / 3028 passed in 132 files -- baseline 3030 / 3028, 0 above baseline
$ echo $?
0
```

The move is a diff of a tracked file — `3049 -> 3030` collected, `3047 -> 3028` passed,
`LOWERED packages/cli/test/output.test.ts 58 -> 39` — so an intentional removal is now something a
reviewer reads in the commit instead of something that never appears.

**Q5d — and it goes back up, so this is a floor that tracks rather than a ratchet that only falls.**
The file was restored byte-identical to `HEAD` (`git diff --stat` empty) and the gate re-run:

```
 Test Files  132 passed (132)
      Tests  3047 passed | 2 skipped (3049)

[pre-commit] test count
test count: 3049 collected / 3047 passed in 132 files -- baseline 3030 / 3028, 19 above baseline
[pre-commit] ascend gate ok
```

Green **against the lowered baseline** — `19 above baseline` — which is the property that matters:
failures are drops, so growth never nags. `update` then raised it back
(`RAISED packages/cli/test/output.test.ts 39 -> 58`, `132 / 3049 / 3047`). Both directions measured,
because a baseline that can only fall is not tracking anything.

**Q5e — the arm a collected-count baseline alone would bless.** One `it(` in the same file was flipped
to `it.skip(` — one line, `git diff --stat` reading `1 insertion(+), 1 deletion(-)` — and the full gate
run:

```
 Test Files  132 passed (132)
      Tests  3046 passed | 3 skipped (3049)

[pre-commit] test count
test count: 3049 collected / 3046 passed in 132 files -- baseline 3049 / 3047, 0 BELOW baseline
  BELOW   passed tests  3047 -> 3046 (-1) -- a test skipped or gone, not necessarily deleted
[pre-commit] ascend gate FAILED (exit 1) -- commit blocked
```

The file count is flat, **the collected count is flat at 3049**, and every per-file floor is met. Only
the `passed` floor catches it. Its limitation is stated in the message itself and is real: it names the
count, not the file, because per-file `passed` is not carried in the baseline — the per-file floors are
collected counts.

**Q5f — the check was shown to bind to its implementation.** The script was written before its tests,
not red-first, so four mutations were run, each against the test written for it: an equal count made to
fire failed the two green arms; removing the collected-total check failed exactly the total arm;
removing the `passed` check failed exactly the `.skip` arm; a missing input exiting `0` instead of `2`
failed all three `CANNOT CHECK` arms. Removing the step from `.githooks/pre-commit` failed exactly the
new `dev-hooks.test.ts` test (1 failed / 6 passed). The script was restored byte-identical
(`diff -q`). This is a weaker check than a real red would be: it proves the tests bind to this
implementation, not that they were derived from a failure.

**Q5g — two exit codes, and the arm that reads like a pass is the one that is a refusal.** A guard that
cannot find its own input must not read like a guard that looked and found nothing, which is the same
reason `asc store verify` exits 2 when its binary is missing (Q4). `check` exits **1** for a breached
floor and **2** for a missing or unreadable input, and a missing scan is a **hard failure rather than a
skip** — the run above it was supposed to write it.

**Q5h — the limitation this drive actually met, which is not a property of the check.** One arm took
three attempts, and the two failures were not the check's. A pre-existing test over the *live*
transcript corpus carries its own `180_000` ms bound; under machine load it exceeded it, `pnpm test`
exited 1, and the gate blocked before the count step was reached. Two runs of the same gate over an
unchanged tree: red with the failing test at `duration_ms 180086` and `loadavg: 95.34 63.96 40.16` on
12 cores, green with the same test at `29489 ms`. The gate's own fast path measured **229 s** on the
quiet run and **672 s** on the loaded one. That is `dogfood/0063`, a recurrence of `dogfood/0007`'s
class; it is recorded there, and it is named here because the gate's cost and its verdicts both move
with the machine, which is the thing a reader of this file most needs to know.

**Q5i — the hook's header said the fast path cost `~10s`.** Measured: 229–672 s, dominated by
`pnpm test`. The header was corrected with the measured range rather than a rounded number, since the
cost is a function of the machine rather than of the diff.

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

**Q4: the store guard is wired into the gate, after `typecheck`, and the gate fails loudly rather
than skipping when it cannot find its own binary.** `asc-9flv`. Cost measured at ~1.0s; the `dist`
stale case measured as exit 2, which blocks. The claim the bead inherited — that `typecheck` does not
guarantee `dist` — is true in a narrower way than stated, and Q4b above records exactly how: `tsc -b`
tracks inputs and no outputs, so it never notices a deleted one, while in the ordinary case it has
just rebuilt everything that changed. The guard sits below it to use that rebuild, and the loud
failure covers what the rebuild cannot.

**Q5: the gate compares the suite's collected count — per file and in total — against a baseline the
repo carries, and it separates "a floor was breached" (exit 1) from "an input was missing" (exit 2).**
`asc-049w`, closing `dogfood/0061`. The count comes from the runner through `vitest.test-count.ts`,
reconciled against a real run in Q5a because a reporter's output cannot be asserted into existence; the
check is driven red on a deleted file and on a skipped test (Q5b, Q5e); and the movement is shown as a
diff in both directions (Q5c, Q5d), because a baseline that can only fall is not tracking anything.
`passed` is floored beside `collected` because `it.skip` leaves the collected count flat while losing
the coverage, and per-file floors are what let the message name the file. The costs are stated rather
than discovered later: a floor drifts, so the headroom is printed on every green run; per-file `passed`
is not carried, so a `.skip` is named by count and not by file; and a baseline written on one platform
does not carry to another where `it.runIf` collects differently. Two facts about this drive are not
about the check and are recorded as such — the fast path costs minutes and moves with machine load, and
`dogfood/0063` is the class of unrelated red that cost one arm three attempts.

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
