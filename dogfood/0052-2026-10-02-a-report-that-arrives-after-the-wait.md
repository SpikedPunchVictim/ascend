# 0052 — the report ascend would have printed arrives after a wait the reporter cannot end

| | |
|---|---|
| **Bead** | `asc-kyhh` |
| **Surfaced** | 2026-10-02 |
| **Surfaced by** | the same E12.14 adversarial review, reproduced on a real pty |
| **Entry type(s)** | `decision` (starter) and the unknown-type path — the defect is in the order of two operations in `record.ts` |
| **Severity** | P3 — the session path is unaffected; a human following the brief's own line is not |
| **Status** | fixed in the working tree |

## What was found

`asc record TYPE -` read standard input **before** it resolved the type. On a terminal nothing is
piped, so `for await (const chunk of process.stdin)` never yields: the process prints nothing and
never exits, and an unknown type — which ascend would have refused instantly had it been asked first
— is never reached. The wait is unbounded, and it is indistinguishable from a slow store, a hung
filesystem, or a process that has crashed without a message.

Both facts that would end the wait are known before the read starts: there is no document, and the
type may not exist. The command chose to learn the one that requires the wait.

## How it surfaced

**Nobody was looking for it, and it was not reachable before this week.** The review reproduced an
earlier finding on a real pty and the reproduction hung. What made it worth a bead rather than a note
is the second half: E12.14 had just made `asc record TYPE -` **the form the brief teaches in every
session**, so a latent ordering defect moved onto the recommended path for a human reader. The
session path was never affected — Claude Code's Bash tool closes stdin, which is what made the
process exit — and that is precisely why it survived: it needed a terminal to exist, and every
automated check on this project provides a closed pipe.

## The metric

On a real pty — `script -q /dev/null node packages/cli/dist/bin.js record <type> -` — **before** the
fix, both arms:

- `bogus_type`: **still running after 6 s, output `''`**
- `decision` (a registered type): **still running after 6 s, output `''`**

On an open non-TTY pipe the same read blocked **4.1 s** until the writer closed it — so the wait is
not a terminal artifact, the terminal just removes the thing that would end it.

**After** the fix, both return immediately, and in the order the owner chose (type check first, then
the terminal guard), measured on the same pty:

```
$ script -q /dev/null node …/bin.js record bogus_type -
Error: There is no entry type named 'bogus_type' in this project. The types in
this project are: decision, review_completed, stage_transition, stuck_event.

$ script -q /dev/null node …/bin.js record decision -
Error: standard input is a terminal, so nothing is being piped into it: ascend
would wait for a document nobody is sending. Pass a file path instead of -, or
pipe a document in.
```

The unknown type is named **without** the terminal message, which is the order asserted in
`cli/test/record.test.ts` rather than left to whichever guard happened to run first.

## The pattern

**A blocking operation placed ahead of a decision that was already decidable.** The command had two
things to do and did them in the order that requires the caller to supply input before they can be
told their input is unusable. Nothing about either operation is wrong alone; the defect is entirely in
the sequence.

The sub-shape worth naming: **the same rule was already written down one step too narrow.** The top of
`cli/src/input.ts` says there is deliberately no default for the input operand, because *"a command
that reads stdin when given no operand looks like it is waiting for input when it is actually waiting
for a keypress, which is the hang `cli-best-practices` rule 3 exists to prevent."* That is exactly
this hang, described correctly, scoped to a **missing** operand — and the failing case is a present
operand whose input is a terminal. A written rule that covers the case you thought of does not audit
the neighbours.

## Why nothing else would have caught it

**The whole suite was green, and no portable test could have been otherwise.** Every CLI test passes
its input through `spawnSync(..., { input })`, which writes the buffer and closes stdin; the read
therefore always completes, and the hang lives only where a terminal is attached. A unit test cannot
allocate a pty, so the one environment that reproduces this is the one the suite excludes by
construction — and the reproduction that found it was hand-rolled and thrown away.

**The fix had to be testable without a pty, and that shaped it.** `terminalStdinRefusal(operand,
isTTY)` is a pure function of the two facts it needs rather than a `process.stdin.isTTY` read at each
call site, so the decision is covered by an ordinary test and two commands sharing `input.ts` cannot
drift into disagreeing about when the refusal applies. The pty run above is the end-to-end
confirmation that the pure function is wired to the real world; it is not the regression test.

## Consequences and constraints

**Nothing was recorded, so nothing needs invalidating.** Both guards run before any write.

**The pre-read type check must swallow `IndexStaleError`, or it introduces a new failure on a path
that self-heals.** `openIndex` refuses a stale index; `writeProducedLines` calls `buildIndex` first
and repairs one. A read-only pre-open before the read therefore sits on the refusing side of an
asymmetry the write path already handles — so the guard steps aside on a stale tree and lets the read
proceed to the path that rebuilds, and `cli/test/record.test.ts` asserts exactly that (a stale index
still records). Checking the type first is worth a pre-open only if it does not cost the behaviour it
was placed in front of.

## Links

- Bead: `asc-kyhh`
- Related: `dogfood/0051` — the other E12.14 review finding closed in the same pass: there a fix could
  not be run, here a refusal could not be delivered
- Entries recorded at the time: none — both guards run before any write
