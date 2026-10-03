# 0056 — A clean run printed `fatal: Needed a single revision`, because `execFileSync` inherits the child's stderr

| | |
|---|---|
| **Bead** | `asc-9flv` (the gate-wiring follow-up); the leaking call itself is fixed in the commit that added it |
| **Surfaced** | 2026-10-02 |
| **Surfaced by** | running `asc store verify --staged` on this repo's own store, having just written it |
| **Entry type(s)** | none — this is about a subprocess boundary, not about entries |
| **Severity** | P3 (no data at risk; a false alarm in a log) |
| **Status** | fixed in the `asc-98e1` commit |

## What was found

`asc store verify --staged` returned **exit 0** and printed its clean note — and, just before it, the
line `fatal: Needed a single revision`. The command was working exactly as designed; the noise came
from a git call that is *supposed* to fail. `mergeHead()` asks git for `MERGE_HEAD` and treats a
missing one as the ordinary case, but `execFileSync` **writes the child's stderr to the parent's
stderr by default**, so every non-merge run printed git's `fatal:` for a failure the code had already
decided was normal. A `fatal:` on a successful command is a false alarm in any CI log that greps for
one, and it is the reader's first impression of a guard whose entire job is to be trusted.

This is an *absence* of a kind: the code was correct and the output was wrong, which a test written
against the code would not have caught.

## How it surfaced

**Nobody was looking for it.** I ran the finished command against the real store — the
`empirical-planning` "drive the real thing" step — and read what it printed. Every test in the suite
was green at that moment and stayed green after the fix was written; what found this was looking at
the bytes on stderr, not at a failing assertion.

It is the first finding in this series that came from ascend code that runs a *subprocess*. Until
`asc-98e1`, nothing in `packages/*/src` invoked `git` or any other external binary (verified: no
`child_process` import outside test helpers), so this whole class — an inherited stderr channel
turning an expected failure into an alarming line — had no way to reach the product before.

## The metric

Verbatim, before the fix (`node packages/cli/dist/bin.js store verify --staged`):

```
fatal: Needed a single revision
{"ascend_output":3,"rows":[],"row_count":0,"coverage":{"shown":0,"total":0,"has_more":false}}
Note: 22 record file(s), 10754 record id(s), 1 baseline(s) — no conflict
markers, no unreadable lines, no lost record ids.
exit=0
```

After the fix the first line is gone and the exit code is unchanged at 0. The regression test asserts
`stderr` contains neither `fatal` nor `Needed a single revision` on `[]` and `['--staged']`
(`store-verify.test.ts`, "prints no git `fatal:` on a clean run"). One instance, one command — an
anecdote, not an estimate.

## The pattern

**An expected failure of a subprocess is still a failure to the subprocess's stderr, and the default
`child_process` plumbing does not know the difference.** The general form: any boundary that has two
channels — a return value and a side channel — will report an expected outcome on the side channel
too, where the caller's decision to treat it as normal is invisible. `execFileSync`'s inherited
stderr is one instance; the same shape appears wherever a library logs to a stream the caller did not
elect. The fix is always the same: capture the side channel and decide about it explicitly.

## Why nothing else would have caught it

The suite was green and stayed green. Lint, typecheck, `format:check` and `align` are all silent on
it — nothing about the code is wrong. A test written before the fix would have had to assert on
stderr content, which is not what a test of a *guard* naturally checks; the guard's own tests assert
on exit status and on whether a refusal was named. Only reading the output of a real run surfaced it,
which is the argument for the `empirical-planning` "drive the real thing" step rather than another
unit test.

## Consequences and constraints

Nothing is at risk and nothing was written — the command is read-only. The fix is `stdio:
['ignore','pipe','pipe']` on every git call in `git-records.ts`, so the caught error carries the real
message and nothing leaks to the terminal. Stated as general guidance for the next ascend code that
shells out, since this is now the first module that does.

## Links

- Bead: `asc-98e1` (this feature), `asc-9flv` (wiring the guard into this repo's own gate)
- Evidence: `docs/evidence/EV-31.md`; `spike/git-layout/FINDINGS.md` W3
- Code: `packages/cli/src/git-records.ts`, `packages/cli/test/store-verify.test.ts`
