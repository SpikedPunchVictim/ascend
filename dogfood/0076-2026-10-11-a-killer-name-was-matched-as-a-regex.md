# 0076 — A killer's test name was matched as a regex, so a name holding `$` killed nothing and blamed the spec

| | |
|---|---|
| **Bead** | `asc-hs7p` |
| **Surfaced** | 2026-10-11 |
| **Surfaced by** | running `pnpm mutate handler-saw`, the first run of the spec written for `asc-gtnu.7` |
| **Entry type(s)** | none — the defect is in `scripts/mutate.mjs`, not in the store |
| **Severity** | P2 |
| **Status** | fixed in the working tree (uncommitted at the time of writing) |

## What was found

`scripts/mutate.mjs` documents a killer's `test` as a *name* — the `Killer` typedef calls it "the one
test name that must notice this mutant" — and then passes it to `vitest -t`, which is a **regex**.
Nothing reconciled the two, so the pattern a spec author wrote was never the pattern that ran.

That is one defect with two faces, and only one of them is loud:

- **Too narrow, and loud.** `$` is an end-of-string anchor. A killer named for the test
  `resolves a $ reference in saw.where against the TRIGGER, not the watched event` matched *no test at
  all*. `vitest` exits 0 with everything skipped, `executed()` reads zero, and the run refuses with
  `DEAD KILLER … matched no test` — which reads as *the spec is wrong*, when the pattern that ran was
  never one its author wrote.
- **Too wide, and silent.** `.` matches any character, so the killer
  `warns when settings.json names the hook but the script is gone` also matches any test name differing
  only at that dot. A mutant is then certified by a test that is **not the one the spec names** — a
  kill it did not earn, arriving as a green verdict.

The second face was never observed firing. It is reported as a mechanism, not as an incident.

## How it surfaced

**Nobody was looking for it.** The task was `asc-xqf1` and then `asc-gtnu.7`; `pnpm mutate` was the
last step of the second of those, run because the repo's own convention says a finished feature gets a
mutation spec and the spec gets run. It was the *first* invocation of that spec.

The runner did its job: it refused the whole run rather than issuing a verdict, which is the behaviour
`asc-e9zm` and `dogfood/0070` were each written to install. What it could not do was say *why*. Its one
sentence — "matched no test, so it is no one's evidence" — is exactly true and points at the spec.

What made it visible was reading a name that should obviously have matched a test that obviously
exists, and then asking what `-t` does to it. Ten seconds of `vitest` settled it.

## The metric

Measured 2026-10-11, on the tree at `8bbc3f3` plus the uncommitted `scripts/mutate.mjs` change.

**The run that surfaced it** — `pnpm mutate handler-saw`:

```
DEAD KILLER  "resolves a $ reference in saw.where against the TRIGGER, not the watched event" matched no test, so it is no one's evidence

no verdict: every named killer must run, and pass, before a mutant is applied.

rebuild: node_modules/typescript/bin/tsc -b ok -- no build output is left holding a mutant
[ELIFECYCLE] Command failed with exit code 1.
```

**The mechanism, isolated.** The same file, the same test, two patterns:

```
$ npx vitest run packages/core/test/handler.test.ts \
    -t 'resolves a $ reference in saw.where against the TRIGGER, not the watched event'
      Tests  117 skipped (117)          # 0 executed -- the `$` anchors to end-of-string

$ npx vitest run packages/core/test/handler.test.ts \
    -t 'reference in saw.where against the TRIGGER'
 Test Files  1 passed (1)
      Tests  1 passed | 116 skipped (117)   # 1 executed -- same test, no `$` in the pattern
```

**The measurement is complete for the class.** Every killer name in every spec:

```
11 specs, 74 killer names
  2 containing `$`   (one distinct test, named by handler-saw M1 and M4)
  1 containing `.`   (hook-generation-freshness)
```

74 names is above `MIN_N`, so *"how many killer names carry a regex metacharacter"* is a rate for
this repo, not an anecdote: 3 of 74. The **over-match** face, though, has n = 1 and is named as an
anecdote — `hook-generation-freshness`'s `.` is the only instance in the tree, and no run has been
observed to certify a mutant with the wrong test.

**After the fix**, with `literalPattern()` applied in `runKiller`:

```
$ npx vitest run packages/core/test/handler.test.ts \
    -t 'resolves a \$ reference in saw\.where against the TRIGGER, not the watched event'
      Tests  1 passed | 116 skipped (117)

$ npx vitest run packages/cli/test/doctor.test.ts \
    -t 'warns when settings\.json names the hook but the script is gone'
      Tests  1 passed | 31 skipped (32)

$ pnpm mutate handler-saw

| id | verdict | killers that died | survivors |
|---|---|---|---|
| M1 | killed by every named killer | 2 | - |
| M2 | killed by every named killer | 2 | - |
| M3 | killed by every named killer | 1 | - |
| M4 | killed by every named killer | 1 | - |

4 mutant(s), 0 problem(s). Every named killer killed its mutant.
```

Each escaped pattern matches exactly one test — the one it names.

## The pattern

**A value crosses a boundary where its meaning changes, and both sides believe they agreed.** The
spec author writes a *name*; the harness reads a *pattern*; the typedef documents the name. Nothing
tests the seam, so the two conventions coexist until one of them is violated — and the failure is
attributed to whichever side is holding the data, which is the side that was right.

`dogfood/0075` is the same shape one directory over: guidance stored *per version* while every reader
read it *per name*. Both are a value whose contract is stated in one place and executed under another.

The other half of this one is the symmetry that made it findable. `applyMutant()` already had its `$`
handling right on the *write* side, with a test naming the reason — *"substitutes the replacement
literally, so a `$&` in it is not back-referenced"*. The same class was handled in one direction and
not the other, which is what `bug-hunt`'s write/read-asymmetry lens exists to catch, and no review had
pointed it here.

## Why nothing else would have caught it

**There was no test for it, and the tool it breaks is the one that would have found it.** The runner's
own tests (`scripts/mutate-core.test.ts`) cover `executed()`, `asRecord()`, `validateSpec()`,
`applyMutant()` and `parseArgs()` — the pure decisions — and `runKiller` is deliberately not exported,
because "a test that exercised it would be a test that mutated the tree it is running in". The
argument is sound and it is also why the escaping function had to be extracted to be testable.

`pnpm quality-gate` cannot see it: the suite is green either way, and so is `align`.

What *would* have caught the loud face is a spec whose killer name happens to hold a metacharacter —
which is to say, nothing deliberate. Ten of the eleven specs are written with plain names and would
never have exercised it. It took a test name containing `$` to surface, and that `$` is there because
the test is about `$` references.

## Consequences and constraints

No stored data is involved; the fix is four lines in a repo script and four tests. Nothing here
collides with entry immutability.

Three things recorded rather than resolved:

- **`literalPattern()` makes `test` a literal substring, which is what the typedef always said.** A
  spec that was *relying* on pattern behaviour would break — none was: every killer in the tree is a
  substring of the name it targets, measured above. This is why the fix is safe rather than a
  behaviour change.
- **`executed() === 0` remains the only guard that a killer ran at all**, and it is the guard that
  turned a silent no-match into a refusal (`asc-9ac`, 2026-10-08). It caught the loud face here. It
  cannot catch the quiet one: an over-matching pattern executes *something*, so `executed()` returns
  non-zero and the count says nothing about *which* test ran.
- **The quiet face is now unreachable rather than detected.** Escaping removes over-matching by
  construction, which is the cheap half. Nothing verifies that a killer's escaped pattern matches
  exactly one test, so a killer naming a *prefix* shared by two tests still selects both.

## Links

- Bead: `asc-hs7p`
- The spec that surfaced it: `scripts/mutations/handler-saw.json` (`asc-gtnu.7`)
- The other spec sitting in the quiet half: `scripts/mutations/hook-generation-freshness.json`
- Prior findings on this runner: `dogfood/0070` (a run left the mutant built into `dist/`), `asc-e9zm`
- The write-side escape that made the asymmetry visible: the `applyMutant()` test
  *"substitutes the replacement literally, so `` $& `` in it is not back-referenced"*
- The same shape, one directory over: `dogfood/0075` (data per-version, readers per-name)
