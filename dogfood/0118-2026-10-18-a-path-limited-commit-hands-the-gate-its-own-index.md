# 0118 — A path-limited commit hands the gate its own index, and the suite reads it

| | |
|---|---|
| **Bead** | `asc-09wx.18` (P2, fixed) |
| **Surfaced** | 2026-10-13, committing `EV-64` to `EV-69` with `git commit -F - --` |
| **Surfaced by** | nobody — the commit failed its own hook |
| **Entry type(s)** | none — this is about `scripts/gate.mjs`, which is not itself instrumented |
| **Severity** | P2 |
| **Status** | fixed: the gate strips git's index variable, and the two steps whose subject *is* the index say so |

## What was found

**`git commit -- <paths>` hands the hook a temporary index, and `scripts/gate.mjs` handed it to every
step it spawned.** For a path-limited commit git builds an index holding only the named paths plus
`HEAD`, points `GIT_INDEX_FILE` at it, and runs the hook with it set. `stepEnv` (`scripts/gate-env.mjs`)
copied the environment through to each step, so every `git ls-files` below the gate enumerated *the
commit* rather than *the tree*. Tests that assert properties of the tracked tree saw one file.

Five tests failed: four in `packages/core/test/purity-enforcement.test.ts` and one in
`scripts/gate-scope.test.ts`. The 3,497 other tests passed, so the run read as a gate failure caused by
the change rather than by the way the change was committed.

## How it surfaced

**Nobody was looking for it.** The commit that failed was a documentation commit made with a path
limit because the tree held other work; the hook ran, five tests went red for reasons unrelated to the
diff, and the only way forward was to commit without the path limit. That workaround is what made it
look like an environmental nuisance rather than a defect in the gate: the same files committed without
a path limit were green.

It sat open from 2026-10-13 to 2026-10-18, and what closed it was reproducing the mechanism instead of
re-reading the symptom — building the index git would have built, and setting only that variable.

## The metric

Reproduced 2026-10-18 against a partial index built the way git builds one — `read-tree HEAD`, remove
everything but one path, add it back — with the one variable set:

```
GIT_INDEX_FILE=<one-file index> npx vitest run packages/core/test/purity-enforcement.test.ts
  Tests  4 failed | 16 passed (20)

npx vitest run packages/core/test/purity-enforcement.test.ts
  Tests  20 passed (20)
```

and end to end, through the real runner with a 26-file partial index (the record tree plus one source
file), every step green:

```
format:check 0  typecheck 0  store verify --staged 0  duplicate entry ids 0
lint 0  test 0 (385,796 ms)  test count 0
  Tests  3815 passed | 2 skipped (3817)
```

**The fix is a strip with two exceptions, and the exceptions are not conveniences.** `store verify
--staged` and `duplicate entry ids` both read `git ls-files -s`; the index is their *subject*, and
under a path-limited commit the temporary index is the right one to read. They declare `keeps:
INDEX_ENV` in the step list. That the exception is real was measured by accident and is worth keeping:
with a one-file index the staged step reported **12,412** problems across 0 record files — it was
reading the temporary index, which is exactly what it should do, and the run stopped because the
commit really did omit those records.

## The pattern

**A control variable that changes what a word means.** The gate already strips the four `ASCEND_`
variables for this reason (`dogfood/0097`): a step that inherits the runner's mode is answering a
question nobody asked it. `GIT_INDEX_FILE` is the same class with a sharper edge — it does not change
what the step *is told*, it changes what "the index", "the tree" and "tracked" *refer to*, so a test
written correctly against the tree silently measures the commit.

The recognition test: **a variable that redefines a noun the downstream code relies on.** Environment
leakage is usually about values; this was about referents. Nothing in the failing assertions mentioned
git, and nothing in the gate mentioned the index, so there was no single file where the mistake looked
like a mistake.

## Why nothing else would have caught it

The gate's own tests drive the runner with stubs, and a stub does not run `git ls-files`. The purity
tests pass against a normal index and against no index at all. `store verify --staged` passes, because
it wants the temporary index. And the failure only appears on a commit made with a path limit, which
nothing in the suite or the hooks does — it was a person using git's own argument.

## Consequences and constraints

- **`INDEX_ENV` is not completeness-checked, and cannot be.** `CONTROL_ENV` is checked against every
  `ASCEND_` name in the gate modules, because those modules are the source of truth for their own
  knobs. There is no equivalent source for the names *git* sets, so this is a short explicit list
  rather than a pattern — adding one is a decision on the record.
- **A person who sets `GIT_INDEX_FILE` deliberately when running the gate by hand now gets the default
  index for the suite.** That is the intended reading: the gate is about the tree.
- **The rejected options, and why.** Fixing the enumerators one at a time leaves every future
  enumerator to make the same mistake, and the enumerator has no clean way to ask for "the real index"
  other than unsetting the same variable. Refusing a path-limited commit protects the gate by removing
  a capability git provides, and the gate is not actually confused — only its children were.

## Resolution

Fixed in `scripts/gate-env.mjs` (`INDEX_ENV`, and a `keeps` argument to `stepEnv`), `scripts/gate.mjs`
(the two steps that mean the index), and `scripts/gate-env.test.ts`, which now asserts both directions
— the variable gone for the suite, kept for the two staged steps — in the pure layer *and* through the
real runner.

## Links

- Bead: `asc-09wx.18`
- The earlier leak of the same shape, for the runner's own mode: `dogfood/0097`
- The gate's environment module: `scripts/gate-env.mjs`
- The step that failed and the step that must not be fixed: `packages/core/test/purity-enforcement.test.ts`,
  `packages/cli/src/commands/store/verify.ts`
