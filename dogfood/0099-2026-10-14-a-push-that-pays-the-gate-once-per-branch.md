# 0099 — a push that pays the gate once per branch

| | |
|---|---|
| **Bead** | `asc-bo87` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | reading `.ascend/gate-runs.jsonl` after a `but push` of a two-branch stack, to ask what that push cost |
| **Entry type(s)** | none — this is about the gate's own cost, not the store |
| **Severity** | P2 |
| **Status** | fixed in `working tree` |

## What was found

The pre-push gate is paid once per **branch** of a push, not once per push — and the hook's own cost
note said the opposite, in the paragraph a reader consults precisely to decide whether to care.

```
# COST. This is the expensive path, and it is on purpose: the whole suite plus a repo scan. It is paid
# once per push rather than once per commit, which is the trade the cut is made of.
```

"Once per push rather than once per commit" is true of the *hook* — that trade is Cut 3's whole design —
and false of the *cost*, which is what the sentence is about. Git runs a pre-push hook once per
`git push` **command** it is handed, not once per ref, and GitButler publishes a stack one branch at a
time. A stack of N branches therefore pays N times over one index that does not move between them.

The second half of the finding is why the cut that already exists for exactly this did not absorb it.
`memoAllowed` in `scripts/gate.mjs` refused the memo wholesale under `ASCEND_PRECOMMIT_FULL`, the flag
`.githooks/pre-push` sets — the condition was deliberate and its stated reason was right ("a hit there
would skip the full suite at the one moment the full suite is the point"), but it was written about a
record left by a **commit**, and it took the push path's own record down with it. The distinction that
matters is not commit-versus-push, it is *what a record has actually run*.

## How it surfaced

**Nobody was looking for it.** It was a check on a different claim. `dogfood/0097`'s fix had just let a
push pass the gate for the first time, and the question put to the log afterwards was the ordinary one
— what did that push cost, step by step — because a cut that cannot show its number is a candidate for
removal. The answer was two rows where one was expected.

The mechanism was then established rather than assumed, in a throwaway repository with a hook that
appends its stdin to a file: one `git push` carrying **two refs** produced **one** hook run, listing
both refs; two separate `git push` commands produced two runs. So the count is per push command, and
the cost is per branch only because the client issues one command per branch. Both halves are needed
for the defect to exist, and neither is visible in the hook.

## The metric

Two rows, verbatim from `.ascend/gate-runs.jsonl` (the file `scripts/gate-log.mjs` appends, one JSON
object per run), quoted here with the fields that carry the claim and nothing else:

```
{"at":"2026-10-14T08:43:02.559Z","head":"23f1c4d37e0ac72c1a84c59afb0f247e2c1db53a","scope":"full","outcome":"ok","wall_ms":302366,"total_ms":302360,"skipped":[],"steps":"format:check=0/6088 typecheck=0/4778 store verify --staged=0/1518 lint=0/15000 test=0/273069 test count=0/138 align check=0/1769"}
{"at":"2026-10-14T08:47:23.830Z","head":"23f1c4d37e0ac72c1a84c59afb0f247e2c1db53a","scope":"full","outcome":"ok","wall_ms":259010,"total_ms":259006,"skipped":[],"steps":"format:check=0/5609 typecheck=0/4351 store verify --staged=0/1279 lint=0/12941 test=0/233438 test count=0/69 align check=0/1319"}
```

`at` is written at the **end** of a run, so a start is `at` minus `wall_ms`: `08:38:00.193Z` for the
first and `08:43:04.820Z` for the second, a **2.261 s** gap between them — the lock handover, not a
person. Both ran inside one `but push` whose own window was `08:37:59Z` to `08:47:27Z` (**568 s**), so
the gate held it for `302.366 + 259.010 = 561.376 s`, **98.8%** of the push.

Three facts in those rows say the cut did not apply, and none of them is the outcome: `skipped` is
`[]` (nothing was skipped, so no record was consulted), `scope` is `full`, and the two rows carry the
same `head` on the same tree. The test list is seven labels — `duplicate entry ids` is absent because
it did not exist yet when these ran; today's push plans eight.

The demonstration of the fix, run by hand at the hook's own settings on one tree, both invocations
quoted from `.ascend/gate-runs.jsonl`:

```
{"v":1,"at":"2026-10-14T22:51:24.011Z","head":"9779aea588825c4d49b33efc71adb3d8b0bc4143","steps":[{"label":"format:check","ms":6568,"status":0},{"label":"typecheck","ms":5316,"status":0},{"label":"store verify --staged","ms":1414,"status":0},{"label":"duplicate entry ids","ms":533,"status":0},{"label":"lint","ms":34581,"status":0},{"label":"test","ms":408164,"status":0},{"label":"test count","ms":366,"status":0},{"label":"align check","ms":6777,"status":0}],"total_ms":463719,"wall_ms":463757,"scope":"full","skipped":[],"outcome":"ok","blocked_at":null,"loadavg":[41.94287109375,30.68701171875,19.525390625]}
{"v":1,"at":"2026-10-14T22:51:25.169Z","head":"9779aea588825c4d49b33efc71adb3d8b0bc4143","steps":[],"total_ms":0,"wall_ms":1,"scope":"full","skipped":[{"step":"format:check","why":"this tree already passed the gate"},{"step":"typecheck","why":"this tree already passed the gate"},{"step":"store verify --staged","why":"this tree already passed the gate"},{"step":"duplicate entry ids","why":"this tree already passed the gate"},{"step":"lint","why":"this tree already passed the gate"},{"step":"test","why":"this tree already passed the gate"},{"step":"test count","why":"this tree already passed the gate"},{"step":"align check","why":"this tree already passed the gate"}],"waited_ms":0,"broke_lock":null,"outcome":"ok","blocked_at":null,"loadavg":[41.94287109375,30.68701171875,19.525390625]}
```

Both invocations carry the hook's own settings (`ASCEND_GATE_HOOK=pre-push`, `ASCEND_PRECOMMIT_FULL=1`),
the same `head`, and `scope: full`; 1.158 s separates them, and the tree between them is untouched. The
first is the price of a push as it always was — `skipped: []`, eight steps, `wall_ms` 463757. The second
is the second branch of a stack: `steps: []`, `total_ms: 0`, `wall_ms` 1, and every one of those eight
steps named in `skipped` with the reason, so an absent step is never mistaken for one that passed.
`align check` is in both lists, which is the bar doing its work: it is the step only a run with no cuts
plans, and it is why the record the *first* invocation left can answer a push while no commit-level
record ever could.

A first attempt at this pair blocked at `test` in both runs, for a reason that had nothing to do with
this fix — a drifted `core.hooksPath` in `.git/config`, which is `dogfood/0101`. The rows above are the
re-run after that was restored, and they are the ones this record's claim rests on.

## The pattern

A cost claim in a comment, written from the design rather than from the log, and never checked against
the log — in the one file whose subject is cost. The number was not wrong by accident: "once per push"
is exactly what the hook's *author* believed the hook was, and the mechanism that makes it false is one
level away, in the client that calls it. This is `dogfood/0095` read from the other end again: there,
the gate's reach was assumed to cover `but commit` and did not; here, the gate's frequency was assumed
to be per push and is per branch. Both are claims about a mechanism the repository controls but that
nothing in the repository measures — the caller, not the callee.

## Why nothing else would have caught it

No test could. The runner is correct, the hook is correct, and the suite is green; the defect is the
*number of times* a correct thing is run, which lives in two programs' interaction (`git` runs one hook
per push; GitButler issues one push per branch) and in a comment. Nothing asserts a comment.

A review could have caught it, and this is worth stating plainly rather than claiming otherwise: the two
facts sit in files a reviewer reads, and `git`'s hook contract is documented. What no review could have
caught is that the number was wrong *in the direction that costs five minutes*, because the claim looks
like a design decision and reads true for a single-branch push — which is every push anyone had made
until the one measured here.

The one artifact that could answer it already existed and was not being read for this question:
`.ascend/gate-runs.jsonl`, which `asc-09wx.14` was built to write, and which is machine-local and
gitignored, so a test cannot read it and `docs/evidence/EV-64.md` does not grade the push path at all
(the word "push" does not appear in it). A mechanism whose only witness is a gitignored file has to be
asked a question before it answers one.

## Consequences and constraints

- **The fix is a bar, not a coverage rule**, and that distinction is load-bearing rather than
  stylistic: `scripts/gate-memo.mjs` records — measured, not reasoned about — that the first draft
  required a record to cover every step the new run would take, and that this vetoed every amend there
  is, because after `git commit` the index equals `HEAD`, `git diff --cached` is empty, and the scope
  derives as `full` (six steps wanted against a five-step record). So the caller now names the steps a
  record must have **run** — `requiredOf` returns `align check` for a run that took no cut, and nothing
  for a commit — and the bar is a floor: a push's record answers a commit, and a commit's record cannot
  answer a push.
- **The hook's prose is part of the artifact.** `.githooks/pre-push` is a source; git runs
  `.beads/hooks/pre-push`. Correcting the paragraph requires the splice, and the installer refuses to
  run in this workspace — see `dogfood/0100`, which is the second finding this one produced.
- **The measurement is an anecdote.** `n = 1` push, `n = 1` machine, `n = 1` client, well under `MIN_N`.
  What generalizes is the mechanism (per command, not per ref) and the arithmetic from the rows; the
  561.4 s belongs to one afternoon's machine load.

## Links

- Bead: `asc-bo87`
- `dogfood/0096` (the push side checks the working tree), `dogfood/0097` (the push could never pass),
  `dogfood/0095` (the commit side never ran) — the same series of questions about the same two hooks
- `dogfood/0100` — the splice cannot be re-run, so this correction had to be applied by hand
- `docs/evidence/EV-70.md` grades the gate from these same rows; the push path is not graded there
- Entries recorded at the time: `verification_run-2718f4117ffe` (the gate-run log readings)
