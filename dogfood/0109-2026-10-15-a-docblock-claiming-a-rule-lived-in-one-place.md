# 0109 — A docblock said the rule lived in one place, and it lived in two

| | |
|---|---|
| **Bead** | `asc-bj4e` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | `pnpm mutate handlers-review` — a third survivor, after the flaky fixture behind the first two was fixed |
| **Entry type(s)** | `intervention` (the rows this rule is about) |
| **Severity** | P3 |
| **Status** | open |

## What was found

**`reviewRows` restated the four-valued rule's `unheld` answer as a literal and returned before the
function that owns the rule was ever called — and a docblock directly above it claimed the
opposite.** `packages/cli/src/commands/handlers/review.ts` read:

```ts
if (life.holdings.length === 0) {
  rows.push({ [HANDLER]: path, [FIELD]: 'state', [VALUE]: 'unheld' });
  ...
  return rows;              // <- returns before the next line ever runs
}

const state = stateOfLife(life);
```

with this sentence above it:

> `stateOfLife` is still what decides a handler with no holdings at all, and its answer is printed
> once because there is nothing for it to disagree with.

**Both halves are false.** `stateOfLife` was never asked about that case, so its own guard —
`if (life.holdings.length === 0) return 'unheld';` — was unreachable from the command. The rule had
two homes, and the documentation said it had one.

**That "one home" claim is the part with teeth**, because it is the sentence that tells a reader
*where not to look*. A reader who trusts it will never open `review.ts` to check for a second copy of
the state rule, and will read `stateOfLife` as the complete definition of the four states. It was
three quarters of one.

## How it surfaced

`pnpm mutate handlers-review` reported a mutant **SURVIVING** every killer it named. Following it
home gave a second-order answer: the mutation runner had been measuring its *killers*, not its
mutants — the fixture was non-deterministic, so three "kills" were coins (recorded separately as
`dogfood/0108`). With the fixture made deterministic, the survivor count went from two to three, and
the third one was real:

```
| no-holdings-falls-through | SURVIVED a named killer | - | reads a still-open row as the strongest claim on a handler two rows name |
```

**Nobody was looking for a documentation defect.** The stage was `asc-09wx.8.5`'s fifth — write the
mutation specs, run the gate, drive it end-to-end — and the path was four levels down from anything
that stage is about: a survivor investigated as a spec error, the spec error as a fixture gap, the
fixture as random, and then the last survivor as *code that could not be reached*. At no point was
"and does the docblock describe this correctly" the question; the docblock simply contradicted the
thing the mutant had just proved.

## The metric

**The guard's reachability, and the number of places the four-valued rule is stated:**

```
$ grep -rn "stateOfLife" --include='*.ts' packages/ | grep -v "src/handler-life.ts"
packages/cli/src/commands/handlers/review.ts:38:  stateOfLife,
packages/cli/src/commands/handlers/review.ts:121:  const state = stateOfLife(life);
```

**One caller**, `review.ts`, and one call site. Before the fix that call site was inside a path the
zero-holdings case returned before reaching, so the function had one caller and that caller could not
reach one of its four answers.

**The mutant's verdict, from the runner's own table** (`pnpm mutate handlers-review --allow-dirty`):

```
| no-holdings-falls-through     | SURVIVED a named killer       | - | reads a still-open row ... |
... after the fix ...
| no-holdings-falls-through     | killed by every named killer  | 1 | - |
8 mutant(s), 0 problem(s). Every named killer killed its mutant.
```

`n = 1` file, `n = 1` mutant, `n = 1` checkout — named as an anecdote under `MIN_N` (20,
`packages/analysis/src/proportion.ts`). What is not an anecdote is the structure: **a branch guarded
by a condition its only caller has already excluded is unreachable, and a mutation runner is the
instrument that says so.**

## The pattern

**A claim of division of responsibility is a claim about reachability, and only the second one is
checkable.** The docblock said *"`stateOfLife` decides this"*. Whether that is true is not a matter of
style or intent — it is a matter of whether control flow arrives. The sentence read as a design note
and was in fact a testable assertion that nothing tested, and the failure was invisible for exactly
that reason: it was written in a comment, where no assertion can live and no reviewer looks with a
mutation in hand.

The narrower instance is the one to carry forward: **"function X owns rule Y" is a claim that X is
*asked*.** Code that restates a rule's answer and returns early satisfies a reader who checks the
output and violates the sentence that says where the rule lives. The fix that satisfies both is
always to *ask* X and then decide how much of its answer to print — which is also what makes the rule
single-sourced in fact rather than in prose.

This is the same class as `dogfood/0103` (two docblocks stating a measured zero the corpus had
stopped saying) and `dogfood/0105` (a field described as what it is not): **the doc and the code
disagree, and the doc is the one a reader trusts.** Three instances in two days, all found while
building `asc-09wx.8`.

## Why nothing else would have caught it

- **No test can catch a false comment.** The output was correct: `handlers/delta.yaml` really did
  report `unheld`. Every assertion about behaviour passed, because the behaviour was right — only the
  attribution was wrong.
- **Review is the natural instrument and it did not fire.** Reading `review.ts` top to bottom, the
  early return and the docblock reading "`stateOfLife` is still what decides" sit two lines apart and
  look like a summary of the code below them. They are the opposite of it.
- **Lint cannot.** Both functions are exported and used; there is no unused code, no unreachable-code
  warning, because the branch *is* reachable — just not from the only caller. Reachability across a
  call boundary is not what a linter models.
- **The mutation runner could, and did** — but only after the fixture under it was deterministic. On
  the flaky fixture this mutant was reported as *killed*, by the coin. **Two defects were stacked: a
  fixture that could not be trusted, hiding a branch that could not be reached.**

## Consequences and constraints

- **The fix is a reordering, not a behaviour change.** `const state = stateOfLife(life);` moved above
  the branch, and both the branch and the fall-through now push that value. `handlers/delta.yaml`
  printed `unheld` before and after; what changed is that a function was asked a question rather than
  a literal supplied in its place.
- **The obvious alternative — deleting the unreachable guard — is wrong.** `stateOfLife` is exported
  with a documented contract (*"`unheld` when nothing holds it"*), and removing the guard would make
  it answer `retired` to "what is a handler nothing holds?", which is the opposite of the design
  intent and would push the wrong answer to any future caller. The guard was correct; the caller was
  bypassing it.
- **A mutation spec measures its killers as much as its mutants.** The `_` rationale in
  `scripts/mutations/handlers-review.json` claimed *"SEVEN of the eight are killed only by"* one test.
  That sentence was produced by a run that was measuring a broken fixture, and it has been replaced by
  what the deterministic run actually showed. A spec written against a fixture nobody has checked for
  determinism cannot tell a kill from a coincidence.
- **Nothing else in the tool changed.**

## Links

- Bead: `asc-bj4e`
- The spec that found it: `scripts/mutations/handlers-review.json`
- The finding stacked underneath it: `dogfood/0108` (the flaky fixture that was hiding it)
- Same class: `dogfood/0103`, `dogfood/0105` (doc and code disagree, doc is trusted)
- Built by: `asc-09wx.8.5`
