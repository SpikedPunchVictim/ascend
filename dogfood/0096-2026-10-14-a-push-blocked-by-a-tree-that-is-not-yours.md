# 0096 — a push blocked by a tree that is not yours

| | |
|---|---|
| **Bead** | `asc-n0if` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | `but push` — the first attempt to publish the gate-cost branch |
| **Entry type(s)** | none — this is about the gate's own reach, not the store |
| **Severity** | P2 |
| **Status** | fixed 2026-10-19 — see Resolution |

## What was found

The pre-push gate checks the **working tree**, not the commits being pushed. It runs
`pnpm format:check`, `pnpm typecheck` and the full suite over whatever is checked out in the shared
checkout, so a push can be blocked by an edit that appears in no commit the push carries. Here it was
another session's half-finished work on a different bead: a type error in one of their files, made
about two hours earlier and never committed.

Two things follow, and the second is the worse one. The push cannot proceed until someone fixes a
file that is not theirs to fix — the gate thereby *forces* a cross-session write to release an
unrelated session's push. And the run's log row names a `head` that is a GitButler workspace commit,
not any commit on the branch being pushed, so the machine-local log is not on its own enough to say
whose work blocked what.

## How it surfaced

**Nobody was looking for it.** It arrived as the answer to a question `dogfood/0095` had left
explicitly open — whether GitButler fires the pre-push hook at all — and the answer contained a
second finding inside it. Recording that first answer is what put the machine in a position to be
blocked, and being blocked is what produced this.

The mechanism is worth stating because it repeats: the gate's own tests drive the runner
(`scripts/gate.test.ts`) with stubbed steps, and the hook's control-flow tests
(`packages/cli/test/dev-hooks.test.ts`) drive the real pre-commit source. Nothing drives the pre-push
hook against a real `but push` from a tree containing another session's work, which is the only
configuration in which the defect is visible.

The diagnosis took a wrong turn worth recording, because it is the same mistake the gate invites.
The failing assertion is in a file that *this* session had committed — so the first reading was "the
error is in my own commit." It is not: the committed form of that file carries neither the property
in the assertion nor the function that returns it. The working-tree form is longer and has both. The
file was committed here and then *continued* by the session that owns the bead, and only the running
tree can see the continuation.

## The metric

Two blocked pre-push rows, verbatim from `.ascend/gate-runs.jsonl` (machine-local, gitignored):

```
{"at":"2026-10-14T08:01:32.768Z","head":"62a85e6d076dbef5c810ea315996f0642f8af605","scope":"full","outcome":"blocked","total_ms":18290,"steps":"format:check=0/9656 typecheck=2/8634"}
{"at":"2026-10-14T08:05:12.190Z","head":"55aee3994e23b2c803edd298a14af852a2fee78b","scope":"full","outcome":"blocked","total_ms":15723,"steps":"format:check=0/8729 typecheck=2/6994"}
```

The failure that produced both, as the push printed it, with the error's position elided — this
series cites no line numbers, so the file is named rather than located:

```
[pre-push] scope: everything (no cuts were asked for)
[pre-push] typecheck
error TS4111 in packages/cli/test/commit-size.test.ts: Property 'committed_at' comes from an
index signature, so it must be accessed with ['committed_at'].
[pre-push] ascend gate FAILED (exit 2) -- push blocked
```

**The `head` is the evidence, not the error.** Neither `62a85e6` nor `55aee39` is a commit on the
branch being pushed; both are GitButler workspace commits, the moving HEAD of the shared checkout.
And the error is not reachable from any commit the push carries: the committed test file is 205 lines
and mentions `committed_at` zero times, while the working-tree file is 242 lines and uses it, and the
committed source has no `commitSizeProperties` at all.

**Bound: n = 2**, on one machine, in one repository, in one checkout shared by several agent sessions.
That is an anecdote, well under `MIN_N`, and it estimates nothing about how often a push is blocked
this way in general. What the readings do establish is the mechanism, deterministically: the check's
subject is the tree, and the tree contains work that is not in the commits.

## The pattern

**A check is only as good as its subject, and "the tree" is not "the thing being shipped."** This is
`dogfood/0095` one step further along the same axis. There, the gate did not run for the commit it
guarded — the delivery path was wrong. Here it runs, promptly, in full, and guards something that is
not the commit either: the checkout, at whatever moment the push happens.

The two defects are the same assumption read from opposite ends. `0095` assumed the gate guards
commits on the way in; this record is what happens when the gate runs on the way out and guards the
directory instead. Between them, the gate's subject is wrong in both directions — too narrow on
commit, too wide on push.

## Why nothing else would have caught it

- **Not a test.** The gate's tests stub the steps; the hook tests drive pre-commit. A pre-push test
  that stubs the steps would exercise the same decision logic and still not have a second session's
  dirty file in the tree. The defect lives in the *intersection* of two sessions, which no fixture
  represents.
- **Not the gate log.** It records the failure faithfully and names a `head` that cannot be traced to
  the pushed branch. `0095` leaned on this log for its own metric; this record is a reminder that the
  log's `head` field means something different from what its name suggests under GitButler.
- **Not a review.** Both trees are individually legitimate. Nothing is wrong with the peer's edit
  (it is mid-bead, not broken code) and nothing is wrong with the branch.

## Consequences and constraints

- **One session's unfinished work can block another session's push, and the message names no one.**
  The blocked session sees a path that belongs to a bead it never touched. In this instance the
  resolution was a one-character edit to another session's file — which is exactly the cross-session
  write the repo's own instructions reserve to the owner. The gate, in other words, does not merely
  observe this coupling; it manufactures the pressure to violate a rule. And releasing that block did
  not release the push: with the peer's type error fixed, the same tree failed twenty-two more tests in
  the gate's own suite, for a reason that has nothing to do with anyone's working tree — the pre-push
  hook exports the mode it is in, the suite it spawns inherits it, and the gate's control-flow tests
  then assert a hook mode and a step list they were not handed. That is recorded separately. The point
  for *this* record is that the first blocker was never the whole story, and the failure message could
  not say so.
- **The natural fix is scoping the check to the commits, and it is not free.** A pre-push check that
  typechecked and tested the pushed commits would need a clean tree of its own — a temporary checkout
  or worktree of the branch tip — which is a real amount of machinery for a hook that today is one
  `node` invocation. The cheaper alternative is to make the coupling *legible*: have the pre-push run
  refuse to start when the tree is dirty, and say whose dirty paths those are, rather than gating and
  failing with an unrelated error.
- **`0095`'s asymmetry survives untouched.** `but commit` runs no gate at all; `but push` runs the
  whole one. Fixing the subject here does not change that.
- **Nothing needs reverting.** The pre-push hook does what it was built to do. What is wrong is the
  claim implicit in its name — that it gates the push, when it gates the checkout the push is made
  from.

## Resolution (2026-10-19) — the push gates the commits

The hook no longer typechecks and tests the shared checkout. `.githooks/pre-push` captures git's ref
lines (and re-points stdin at them, so beads' block still receives them) and hands them to
`scripts/push-gate.mjs`, which for each pushed commit creates a detached worktree, installs
`pnpm install --offline --frozen-lockfile`, runs this checkout's `scripts/gate.mjs` with that worktree
as its working directory, and removes the worktree in a `finally`.

Measured on this repository: the offline install of a fresh worktree is **11.3 s** including its
`prepare: tsc -b`, and the full gate inside one is **3,867 collected / 3,865 passed in 165 files** --
against the same suite run in the checkout. A live run of the installed hook, verbatim:

```
[pre-push] gating a86aeb7 for refs/heads/demo
...
test count: 3867 collected / 3865 passed in 165 files -- baseline 3049 / 3047, 818 above baseline
[pre-push] ascend gate ok
```

and the row it wrote, which is the fact this record says the old row could not state:

```
{"head":"a86aeb79c21a203095a21095c7154ec95e9b6dbf","tree":"decc188684ea5530304ce85a8ed4468c3c4ea495","work":"decc188684ea5530304ce85a8ed4468c3c4ea495","outcome":"ok","scope":"full"}
```

`head` is the pushed commit; `tree` and `work` are its tree. `pnpm ungated` reports that commit as
covered by the run that guarded it — the loop `dogfood/0095` asked for, closed on the push side.

Both consequences this record named are gone. An uncommitted edit in the checkout is not in the
commit's worktree, pinned by a test that dirties a fixture checkout, materialises the commit, and
asserts the worktree's `git status` is empty and its tree is the commit's. And the row names the pushed
sha rather than a workspace `head`.

The cost is one full gate per pushed tip, where the old arrangement ran one gate on the checkout and
answered a second ref from the memo (`dogfood/0099`). That verdict was about the directory, which was
the defect.

**And the first live run failed** — not on this mechanism, but because the new suite asserted the
repository holds exactly one worktree while running inside the second one. That is `dogfood/0119`
(`asc-9ve8`), fixed in the same change.

## Links

- Bead: `asc-n0if`
- The same shape one step earlier: `dogfood/0095`
- The log that measured it: `.ascend/gate-runs.jsonl` (machine-local, gitignored)
