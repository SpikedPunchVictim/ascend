# 0080 — A killer that never ran is reported as a killer that matched no test

| | |
|---|---|
| **Bead** | `asc-5sdw` |
| **Surfaced** | 2026-10-12 |
| **Surfaced by** | `pnpm mutate holdout-arm`, the first run of the spec written for `asc-xn4g` |
| **Entry type(s)** | none — the defect is in `scripts/mutate.mjs`'s reporting, not in the store |
| **Severity** | P2 |
| **Status** | open |

## What was found

`executed()` reads the number of tests that actually ran off vitest's summary line, and the runner
treats a zero as one thing:

```
DEAD KILLER  "<name>" matched no test, so it is no one's evidence
```

Zero has more than one cause. `dogfood/0076` closed one of them — `vitest -t` is a regex, so an
unescaped name could match nothing — by exporting `literalPattern()` and applying it in `runKiller`.
A second cause is untouched: **the mutant does not type-check.** `executed()`'s own docblock claims
this case is handled ("a file that will not compile executes no test either, and is named rather than
scored"), and in a narrow sense it is — the run refuses instead of certifying a fake kill. What it
is *named as* is a statement about the spec's wording, and in this case that statement is false: the
pattern matched, the test exists, the file did not compile.

An absence, stated plainly: there is no point at which the runner asks whether the mutated tree
builds. Nothing separates the two causes before the sentence is printed, so the author is sent to
look at the one thing that is correct.

## How it surfaced

**Nobody was looking for it.** The task was `asc-xn4g`, and this spec was the last step of a feature
whose tests were already written and green — the repo's own convention is that a finished feature
gets a mutation spec and the spec gets run. It was the first invocation of this spec.

The spec named eleven mutants. Ten were killed by every named killer. The eleventh, M10, replaced
`if (split !== undefined) {` with `if (split === undefined) {` in `packages/cli/src/commands/handlers/compare.ts`.
That inverts the guard's *meaning* while leaving its *type* wrong: the narrowed branch is now the
`undefined` one, so `split.delivered` became a read off `undefined`. The verdict table said

```
| M10 | DEAD KILLER -- matched no test | - | says controlled and splits the after arm by the arm the hook assigned |
```

The named test exists — it is the fifth test in the holdout block of
`packages/cli/test/handlers-compare.test.ts`, spelled exactly as the spec has it. So the message was
immediately self-contradicting, and the thing that was actually wrong had to be found by hand:
replanting the mutant, running `tsc -b`, and reading the three type errors.

The mechanism that makes it a *silent* zero is one level down and worth naming: the killer test
drives the **built** CLI (`packages/cli/dist/bin.js`), so its `beforeAll` runs `tsc -b` with
`stdio: 'pipe'`. The type error throws inside `beforeAll`, every test in the file fails to execute,
and `executed()` reads zero. A spec whose killer test happens to import source directly rather than
running the binary would not reproduce this at all.

## The metric

**The spec, the run, and the one problem.** Verbatim, from `/tmp/asc-mutate1.log`:

```
| M8 | killed by every named killer | 1 | - |
| M9 | killed by every named killer | 1 | - |
| M10 | DEAD KILLER -- matched no test | - | says controlled and splits the after arm by the arm the hook assigned |
| M11 | killed by every named killer | 1 | - |

rebuild: node_modules/typescript/bin/tsc -b ok -- no build output is left holding a mutant

11 mutant(s), 1 problem(s). FAILS.
MUTATE_EXIT=1
```

11 mutants, 1 dead killer (9.1%). The dead killer is the finding; the ten that were killed are what
say the rest of the spec is sound.

**What the zero actually was.** With M10 planted and nothing else changed, `./node_modules/.bin/tsc -b`
printed, verbatim:

```
packages/cli/src/commands/handlers/compare.ts(138,36): error TS18048: 'split' is possibly 'undefined'.
packages/cli/src/commands/handlers/compare.ts(139,35): error TS18048: 'split' is possibly 'undefined'.
packages/cli/src/commands/handlers/compare.ts(140,33): error TS18048: 'split' is possibly 'undefined'.
```

Three errors, one file, all TS18048 — the mutant is not a behaviour the tests failed to notice; it is
a tree that does not build. (The line numbers are part of the pasted output, not a citation.)

**The named killer is not the defect.** The test the spec named is exactly the test that would have
caught the mutation had it compiled: inverting the split block drops the `after.delivered.*` rows
that test reads. The spec's `find`/`replace`/`killer` triple was right in every respect but
type-correctness, which is the one respect the runner does not check.

**Cost.** Two tool calls to find, after the verdict was read: one to `cp` the file aside and plant the
mutant, one to run `tsc -b`. Cheap only because the mechanism was already guessed from the docblock;
without that, the sentence points at a test name that matches, and the next step is not obvious.

## The pattern

**Two causes collapsing into one zero, where the report names only one — and the one it names is the
wrong one.** It is the same shape as `dogfood/0076` one level up: there, a *pattern* with two
behaviours (too narrow / too wide) was reported with one message; here, a *count* with two causes
(pattern matched nothing / tree did not build) is reported with one message. Both times the harness
was right to refuse, and both times the sentence it refused with was true of one cause and false of
the other.

The generalizable form: **when a guard fires on a measured zero, and more than one condition can
produce that zero, the message must name the condition it measured, not the condition it assumes.**
`executed() === 0` is exactly such a zero, and it now has three known producers: a name that matches
no test, a tree that does not compile, and — unmeasured — a `-t` whose only match is skipped.

## Why nothing else would have caught it

A test would have caught it only if someone had written a test for the *diagnostic path*, and the
runner's own tests are the one place nobody looks when the runner is misbehaving. `executed()` is
unit-tested for what it counts, not for what its caller says about why the count is zero.

The convention that would have caught it is `pnpm mutate` itself, run on `scripts/mutate.mjs` — and
the runner has no spec for its own reporting. That is not obviously wrong (most of the runner is
shelling out, which is not a mutation-testing target), but it means the reporter's messages are the
least-examined lines in the file, and this is the second record in a row about one of them.

## Consequences and constraints

- **The spec, not the runner, was wrong first.** M10's mutant was invalid; a mutant that does not
  compile tests the compiler, not the tests. The fix in the spec was to replace it with one that
  compiles and breaks a real property (`holdout-arm.json`, M10, now drops the `after.unassigned` row
  and is killed by `counts an after unit the hook never decided as unassigned`).
- **The direction the runner errs is the safe one.** It refuses the whole run rather than issuing a
  verdict, which is what `asc-e9zm` and `dogfood/0070` were each written to install. A misleading
  message on a refusal costs an author an hour; a false green would cost the series its meaning.
  Nothing here argues for relaxing the refusal.
- **Adding a build check to the reporter is not free.** A `tsc -b` per dead killer is seconds against
  a run that is already minutes, and it would run only on the zero path. The cheaper half — asking
  whether the `-t` pattern matches any test name at all — needs no build.
- **`asc-hs7p` is open** and its fix (escaping the pattern) is in the working tree; this finding is
  filed `discovered-from:asc-hs7p` because it is the same sentence, a different cause.

## Links

- Bead: `asc-5sdw`
- Related: `dogfood/0076` (the regex half of the same message), `asc-hs7p`
- Related: `dogfood/0070` (the rebuild the runner ends with — the reason a non-compiling mutant is
  named at all rather than scored)
- Spec: `scripts/mutations/holdout-arm.json`
- Runner: `scripts/mutate.mjs`
