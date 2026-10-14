# 0101 — a check for the absolute hook path exists, and nothing runs it

| | |
|---|---|
| **Bead** | `asc-1h3u` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | the gate's own suite, on a run made only to demonstrate `dogfood/0099`'s fix |
| **Entry type(s)** | none — this is about the hooks' configuration, not the store |
| **Severity** | P1 |
| **Status** | fixed in the working tree (the config value); the gap is open |

## What was found

`core.hooksPath` in this checkout's `.git/config` was the **absolute** path
`/Users/spikedpunchvictim/projects/ascend/.beads/hooks`, where the repository's own installer writes
the **relative** `.beads/hooks` — deliberately, and it says so:

```
const HOOKS_PATH = '.beads/hooks'; // RELATIVE, deliberately: see EV-hooks Q2.
```

Two separate places in this repository already know that the absolute-inside-the-repo form is wrong.
`scripts/install-hooks.mjs` writes the relative value, and the same file's verification refuses the
absolute one:

```
  if (isAbsolute(configured) && !relative(repoRoot, configured).startsWith('..')) {
    problems.push(`${SOURCE} is absolute and inside the repo; a rename will orphan every hook`);
  }
```

Neither of those runs at gate time. The only thing that caught the wrong value was
`packages/cli/test/dev-hooks.test.ts > git hook wiring > does not use an absolute path inside the
repo, which a rename would silently break` — a test, which turns **the whole suite red**, at push
time, under whoever last edited anything.

That last part is the finding rather than the config value: a red suite at push time is
indistinguishable from "the code you just wrote is broken", and this one had nothing to do with the
code under it.

## How it surfaced

**Nobody was looking for it.** It was the second attempt at an unrelated demonstration. The first
pair of pre-push gate runs had been made to show `dogfood/0099`'s fix — a stack push paying the gate
once per branch rather than once per push — and both runs blocked at `test` instead. The failure was
read out of the run's own log because the gate quotes the failing file, and the assertion message
names the config value directly. Nothing in the change under test touches `.git/config`.

The value's age is checkable and it matters: `.git/config` was last written at `11:39:13` local time
on 2026-10-14 (`18:39:13Z`), and the push gate rows from `08:43:02.559Z` and `08:47:23.830Z` the same
day carry `outcome: ok` with `test=0/273069` — the suite was green then. So the breakage arrived
between those two moments, in a workspace where other agents are committing, and neither the installer
nor the gate noticed it arriving.

## The metric

Both blocked runs, verbatim from `.ascend/gate-runs.jsonl`, with the fields that carry the claim:

```
{"v":1,"at":"2026-10-14T20:09:52.190Z","head":"9779aea588825c4d49b33efc71adb3d8b0bc4143","steps":[{"label":"format:check","ms":7133,"status":0},{"label":"typecheck","ms":5436,"status":0},{"label":"store verify --staged","ms":1511,"status":0},{"label":"duplicate entry ids","ms":587,"status":0},{"label":"lint","ms":16051,"status":0},{"label":"test","ms":335803,"status":1}],"total_ms":366521,"wall_ms":366528,"scope":"full","skipped":[],"outcome":"blocked","blocked_at":"test","loadavg":[20.80126953125,18.03564453125,16.51171875]}
{"v":1,"at":"2026-10-14T20:16:29.679Z","head":"9779aea588825c4d49b33efc71adb3d8b0bc4143","steps":[{"label":"format:check","ms":6845,"status":0},{"label":"typecheck","ms":4837,"status":0},{"label":"store verify --staged","ms":1629,"status":0},{"label":"duplicate entry ids","ms":617,"status":0},{"label":"lint","ms":16041,"status":0},{"label":"test","ms":367286,"status":1}],"total_ms":397255,"wall_ms":397272,"scope":"full","skipped":[],"outcome":"blocked","blocked_at":"test","loadavg":[27.357421875,24.64404296875,20.0888671875]}
```

The suite's own line, from the run log:

```
Tests  1 failed | 3595 passed | 2 skipped (3598)

FAIL  packages/cli/test/dev-hooks.test.ts > git hook wiring > does not use an absolute path inside the repo, which a rename would silently break
AssertionError: core.hooksPath is an absolute path inside this repo: '/Users/spikedpunchvictim/projects/ascend/.beads/hooks'.
A future rename of the checkout will break every hook with no warning.
Use a path relative to the repo root instead.
```

Where the wrong value came from, and that it was not this change:

```
$ git config --show-origin core.hooksPath
file:.git/config	/Users/spikedpunchvictim/projects/ascend/.beads/hooks

$ stat -f '%Sm  %N' -t '%Y-%m-%dT%H:%M:%S' .git/config
2026-10-14T11:39:13  .git/config

$ git diff --name-only | grep -c 'git/config'
0
```

And that the one command restores it — the value the installer already writes, resolving to the same
directory, so the hooks keep running identically:

```
$ git config core.hooksPath .beads/hooks && git config --get core.hooksPath
.beads/hooks

$ vitest run packages/cli/test/dev-hooks.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  12.32s
```

`n = 1` occurrence in `n = 1` checkout: an anecdote, well under `MIN_N`. What is not an anecdote is
the count of checks that would have run: **zero** — `scripts/install-hooks.mjs` carries the
verification quoted above and it runs only when someone invokes `pnpm hook:install`, which in this
workspace now refuses before reaching it (`dogfood/0100`).

## The pattern

A guard that is real, correct, and **unreachable** is not a guard. This repository has the check for
this exact failure written twice, and both copies live on paths a routine push never takes: the
installer, which is run by hand after a hook edit and nowhere else, and a test that reports the
problem as a suite-wide failure with no relation to the change being pushed.

It is the same shape as `dogfood/0100`: a mechanism whose validity is asserted at install time and
never afterwards. There, the installer's own artifact verification had stopped being runnable; here,
its configuration verification was never runnable on the push path to begin with. The class is *a
check whose only trigger is a human remembering to ask* — and the cost of that is paid by whoever
happens to be pushing when the state has drifted.

## Why nothing else would have caught it

A code review would not. Nothing changed in the tree; a value in `.git/config` drifted, and `.git/config`
is not in the repository, not reviewed, and not diffed. The gate's own steps do not include any
assertion about `core.hooksPath` — `format:check`, `typecheck`, `store verify --staged`,
`duplicate entry ids`, `lint`, `test`, `test count` and `align check` all read the tree.

The one thing that did catch it was the test, and catching it that way is expensive in a specific
currency: it produced two full six-minute runs that had to be read closely before the cause was
visible, and it was reported under a `head` whose author had changed neither the config nor the
hooks. A cheaper fix exists and is named in the bead rather than taken here — the installer's check
is about `core.hooksPath` and not about a hook, so it is a few lines to assert the same thing as a
gate step, where a drift would be named as drift instead of arriving as a failed suite.

## Consequences and constraints

- **The config value was fixed here, in one command, and that is a local edit.** `.git/config` is not
  tracked, so this fix does not travel with the commit and does not protect any other checkout. It is
  the state the installer writes, so it is a restoration rather than a decision — but a drift that
  took an hour to find will take one command to undo, and nothing in the repository prevents it from
  happening again.
- **The two runs that produced the metric are not evidence about `dogfood/0099`.** They are evidence
  about this. The demonstration for that fix had to be re-run after the config was restored, and the
  rows quoted in `dogfood/0099` are from the re-run.
- **A gate that blocks is doing its job here.** `outcome: blocked` is the correct verdict for a tree
  whose suite is red, and the fail-closed direction is the one that makes a green verdict worth
  anything. The finding is about how long it took to attribute, not about the block.

## Links

- Bead: `asc-1h3u`
- `dogfood/0100` — the installer that cannot be run, so its verification ran nowhere at all
- `docs/evidence/EV-hooks.md` — the four measured questions about this installer, including the
  relative-versus-absolute finding the check above came from
- `dogfood/0099` — the fix whose demonstration these two runs were made for
