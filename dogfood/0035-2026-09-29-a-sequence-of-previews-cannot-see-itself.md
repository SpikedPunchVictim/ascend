# 0035 — five line producers that were each equivalent alone, and unusable in sequence

| | |
|---|---|
| **Bead** | none filed — found and fixed in-flight under `asc-i5tj.4.1` (uncommitted as of 2026-09-29) |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | a throwaway probe (`packages/store/test/zz-seq.test.ts`, 3 tests, since deleted) written to check that the producers could be called the way `asc import` will call them |
| **Entry type(s)** | none — the finding is in the store's line producers (`packages/store/src/line-producers.ts`), which no CLI command reaches yet |
| **Severity** | P1 — the project's severity-zero class ("reports success wrongly": a green suite certified a stage that could not do the one thing it exists for) |
| **Status** | fixed in-flight under `asc-i5tj.4.1` |

## What was found

E12.4b1 shipped five functions that each computed the lines a write would produce, each by running
its real writer inside its own `withRollback` and undoing it. Every one was correct. A **sequence**
of them was not, and a sequence is the only way anything calls them: with a rollback per call, the
second production reads a store where the first never happened. `asc annotate` registers a scheme
and the pass that belongs to it, so the pass could not see the scheme registered one call earlier;
`asc import` replays a corpus where each version depends on the one before it, so every type came
out version 1; and a batch of invalidations re-registered the reserved scheme per claim, emitting
the same scheme line twice into a `merge=union` tree, where a duplicate never collapses.

## How it surfaced

By refusing to trust the shape of the test rather than the colour of the result. The suite at the
time had **14 tests, all passing**, and every one of them made a **single** production — which is
structurally unable to see this defect, because a sequence reduced to one call is exactly the case
that works. The gap was noticed while reading the file back against b3's write-site survey, where
every one of the five sites turned out to be a sequence (`import.ts` is four loops; `annotate.ts`
pairs a scheme with its pass; `invalidate.ts` batches claims).

Nobody was looking for it. The question under test was the **equivalence** — producer line versus
export line, byte for byte — and that question was answered correctly, 14 times, for the wrong unit
of work. The probe was written to answer a different question (`can b3 call these at all?`) and
answered it in the negative three times out of three.

## The metric

Before, the shipped file's own suite (`npx vitest run packages/store/test/line-producers.test.ts`):

```
Test Files  1 passed (1)
     Tests  14 passed (14)
```

The throwaway probe, one call per sequence — three sequences, three failures, exact output:

```
annotate: scheme then the pass that needs it
  SchemeError: annotation scheme 'screening' has no version 1. Its versions: (none).
import: two type versions in one sequence
  expected [ 1, 1 ] to deeply equal [ 1, 2 ]
invalidate: two claims in one sequence
  expected [ 2, 2 ] to deeply equal [ 2, 1 ]
```

The fix is a shape rather than a test, so the discriminating evidence is a **mutation**: reverting
`produceLines` to one rollback per production, which is the old code, and running the new suite:

```
     Tests  4 failed | 14 passed (18)
```

Exactly the four sequence tests, and only those — with the symptoms above verbatim. The invalidate
one, whose exact array diff the original probe could not report because it had counted scheme
*versions* rather than line kinds:

```
  Array [
    "scheme",
    "annotation",
+   "scheme",
    "annotation",
  ]
```

Interleaved, not grouped — which was a guess until this run produced it, and is wrong in the first
draft of the test's own comment. After the fix:

```
Test Files  1 passed (1)
     Tests  18 passed (18)
```

and the full gate:

```
 Test Files  119 passed (119)
      Tests  2768 passed | 2 skipped (2770)
```

The n here is 1 — one defect found in one probe; an anecdote under `MIN_N` (20,
`packages/analysis/src/proportion.ts:50`), reported as the incident it is, not a rate.

## The pattern

Severity-zero, with a mechanism worth naming: **a per-call preview idiom is green under per-call
tests and broken for every real caller, because real callers use sequences.** Two lessons inside one
incident:

- **The unit of correctness was wrong, not the code.** Each function satisfied its contract; the
  contract was about the wrong thing. When a module's whole purpose is to be *composed* by a caller
  that does not exist yet, testing it one call at a time measures the one case that cannot fail.
- **A precondition enforced by convention is not enforced.** What the code needed was not a comment
  saying "callers must wrap the sequence in one transaction" — `withRollback`'s own doc says exactly
  that, and this module was written by someone who had read it. What it needed was for the mistake
  to be **unspellable**: the five producers are now private, and the only way to reach one is through
  `produceLines`, which owns the transaction.

## Why nothing else would have caught it

Honestly: **a test would have caught it, and that is the argument for the four that now exist.** The
suite's blindness was a property of its shape, not of its rigour — it was thorough about the wrong
unit. Every other instrument was green and would have stayed green: `tsc -b` and
`tsc -p tsconfig.eslint.json` pass (the functions' types are identical either way), `eslint` passes,
`align check` is green (no import moved), and code review of any single function would find nothing,
because there is nothing wrong with any single function. The defect lived in the *composition*, and
the composition had never been run.

## Consequences and constraints

No store entries are affected: nothing reachable before E12.4b3 calls these, so no invalidation or
annotation applies and no data needs rewriting. Two consequences for the work that follows:

- **b3's five write sites are unblocked**, and each gains a simplification — its dry run and its real
  run now differ only in whether `writeLines` is called.
- **The `db.ts` alternatives were rejected on measured grounds**, not taste, and are recorded in the
  `decision` entry so they are not re-proposed: a `withRollback` that joins an enclosing rollback
  makes a per-call rollback legal again (the footgun restored), and producers that refuse to run
  outside a caller-opened rollback leave the caller free to wrap in `withTransaction`, where the probe
  would **commit** — `SqlDatabase.isTransaction` cannot tell a rollback from a commit, so no guard in
  this package could catch it.

## Links

- Bead: `asc-i5tj.4.1` (E12.4b1); the defect and its fix are recorded in `IMPLEMENTATION_PLAN.md`
  under E12.4b1
- Entries recorded at the time: `117b7486-1664-4fdd-8683-7be3e50987cc` (stage_transition,
  in_progress → complete), `d65c288a-70f1-42a6-83b2-7e4a79719f30` (decision — the fix's shape and the
  two rejected alternatives)
- Code: `packages/store/src/line-producers.ts` — `produceLines` and the five private productions
- Tests: `packages/store/test/line-producers.test.ts` — the four sequence tests
