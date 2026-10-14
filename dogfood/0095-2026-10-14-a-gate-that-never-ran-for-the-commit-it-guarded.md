# 0095 — a gate that never ran for the commit it was meant to guard

| | |
|---|---|
| **Bead** | `asc-rzhr` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | `pnpm test` on the tree the gate cuts had just been committed into — the suite went red on a citation that no gate run had ever had the chance to see |
| **Entry type(s)** | none — this is about the gate's own delivery, not the store |
| **Severity** | P2 |
| **Status** | open |

## What was found

The pre-commit gate does not run for a commit made with `but commit`, which is the commit command this
repo's agent instructions mandate. Its verdict is therefore always a fact about some tree *earlier*
than the commit it is supposed to be guarding, and the commit that introduces a failure the gate would
have caught is never gated by it: the failure is deferred onto whoever next runs the suite.

Five commits were created that way with no gate run between them. The failure they carried — a file
added by the oldest of the five, carrying a citation the source-hygiene sweep forbids — was found by a
manual `pnpm test` minutes later, in a different session window, by an agent who was not looking for it.

## How it surfaced

**Nobody was looking for it.** The suite was being run to close the session out, not to audit the
commits. One test failed out of fifteen hundred, and the offender list held exactly one entry: a
docblock in `scripts/gate-scope.mjs` that spelled a citation in full, in a file whose whole argument is
that a reader who follows a stale citation learns something false.

Two things made it legible. The first is that the file was *new* — `git log --diff-filter=A` names the
gate-cuts commit as the one that added it, so the question "why did the gate not stop this?" was
available immediately. The second is that this repo's gate keeps a log of every run, which turns that
question from an argument into a query.

## The metric

Per-commit query of the gate's own log, verbatim output of a loop over
`git log --format='%h' 64fddce..asc-09wx-14-gate-cost` grepping each full sha against
`.ascend/gate-runs.jsonl`:

```
b2af2da -> 0 row(s)
0c61a47 -> 0 row(s)
da387e6 -> 0 row(s)
a0bc160 -> 0 row(s)
89c4577 -> 0 row(s)
0bf9ce7 -> 2 row(s)
cce0502 -> 7 row(s)
ece20ee -> 0 row(s)
```

The five committed with `but commit` have no row at all; their ancestors committed with `git commit`
have seven and two. The log holds nine rows in total, and its newest is at
`2026-10-14T01:41:49.114Z` — about five hours *before* those five commits were created. Nothing writes
that file but the gate runner.

Commit timestamps are not evidence here, and saying why is part of the measurement: all five commits
now carry a single committer timestamp, `2026-10-14T00:07:02-07:00`, because an amend made while this
record was being written rebased all five. The five-hour gap between the log and the commits is what
survives, and it is enough on its own.

The failure that motivated the query, verbatim from `pnpm test`, exit 1:

```
 Test Files  1 failed | 149 passed (150)
      Tests  1 failed | 3547 passed | 2 skipped (3550)
   Duration  421.91s
```

with the sweep's own report holding exactly one entry, naming the file and the citation it carries.

**Bound: n = 1.** One commit sequence, on one machine, in one repository, under one version control
client. That is an anecdote, well under `MIN_N`, and it estimates nothing about how often a gate is
bypassed in general. What the readings above do establish is the mechanism, deterministically, and that
it fired here.

## The pattern

**A check is only as good as its delivery, and the delivery path is not the one the check was measured
on.** Every instrument built for `asc-09wx.14` — the runner, the scope map, the cross-session lock, the
memo — was exercised by invoking `node scripts/gate.mjs` directly or by letting a real hook fire under
`git commit`. Nothing measured the path the work actually takes, and the work takes `but commit`.

This is `dogfood/0061` one level up. There, a check existed and was never wired up at all. Here the
check is wired, tested, mutation-specified, and green — and the commits that need it do not pass through
the wiring. The two records are the same shape at different depths: an instrument whose *existence* was
verified, rather than its *reach*.

The reason it is worth recording rather than fixing quietly is the direction of the surprise. Building
the gate cost a session, and the gate works exactly as designed; the defect is in the assumption that
"the gate guards commits" was ever a property of the repository rather than of the `git` client.

## Why nothing else would have caught it

- **Not a test.** Nothing asserts that a commit ran the gate. The one artifact that could — the run log
  — is gitignored and machine-local, so a test cannot read it, and it is the only place the answer
  exists.
- **Not a review.** Five commits made in one command look like five commits made in one command.
- **Not the command's own output.** `but commit` printed one line per commit and nothing about hooks. It
  never claimed to have run one.
- **Not the mutation specs.** They mutate the gate's decision logic; none of them can see whether the
  gate was invoked.

## Consequences and constraints

- **The push side was measured before this record was an hour old, and the answer is the opposite of
  the commit side.** `but push` ran the pre-push hook: it printed
  `[pre-push] scope: everything (no cuts were asked for)`, then format:check and typecheck, then
  `[pre-push] ascend gate FAILED (exit 2) -- push blocked`, and the push exited non-zero without
  pushing anything. The run appended a row — `scope full`, `outcome blocked`, `total_ms 18290`, with
  format:check green at `9656 ms` and typecheck at `8634 ms` status 2. So **GitButler runs the pre-push
  hook and not the pre-commit hook**, and Cut 3's bargain holds: related tests on commit, the full suite
  at pre-push. The asymmetry is the finding — the same client that skips the gate on the way in runs it
  in full on the way out.
- **A consequence of that answer, measured in the same minute: the pre-push gate checks the working
  tree, so it gates the checkout rather than the commits.** This push was blocked by *another session's*
  unfinished edit — three untracked files and five modified ones in one feature area, written two
  minutes earlier — whose type error is not reachable from any commit on this branch. One session's
  half-finished tree can block another session's push, and the row it writes names a `head` that has
  nothing to do with the failure. That deserves its own record; it is named here only so the answer
  above is not read as a clean one.
- **Nothing is broken and nothing needs reverting.** The pre-commit hook still guards every commit made
  with `git commit`, which is what it was spliced for. What was missing is a *claim*: nothing in the
  repository said which commits are gated, so an agent could reasonably have believed all of them were.
- **The offender is fixed, in the commit that introduced it.** The docblock now states the rule without
  spelling a citation; the fix is amended into the gate-cuts commit rather than left as a follow-up, so
  the tree that carries the defect is not left standing in history.
- **The instrument that found it was the suite, not the gate.** That is worth keeping in view when the
  gate's cost is next discussed: on this evidence the pre-push gate and a careful `pnpm test` are the
  same instrument, and the pre-commit gate is a third thing that runs on a different client.

## Links

- Bead: `asc-rzhr`
- The same shape one level down: `dogfood/0061`
- Evidence record for the cuts this finding is about: `docs/evidence/EV-70.md`
- The log that answered the question: `.ascend/gate-runs.jsonl` (machine-local, gitignored)
