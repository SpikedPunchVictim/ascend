# 0016 — a refactor of the window match dropped the kind check, and a `tool.use.start` satisfied a `check.run` window

| | |
|---|---|
| **Bead** | none filed — found and fixed in-flight under `asc-6ola.8` (closed 2026-09-25) |
| **Surfaced** | 2026-09-24 |
| **Surfaced by** | the acceptance fixture replay of `handlers/edit-verified.yaml` (`packages/cli/test/project-handlers.test.ts`) after refactoring the window match |
| **Entry type(s)** | none — the finding is in the handler evaluator (`packages/core/src/handler.ts`), not the derived store; the involved event kinds are `check.run` and `tool.use.start` (normalized) |
| **Severity** | P1 — the project's severity-zero class ("reports success wrongly": a wrong handler runs green) |
| **Status** | fixed in-flight under `asc-6ola.8`; committed 2026-09-25 |

## What was found

The evaluator's `accept()` loop guarded window matching with
`event.kind === window.on && window.where(event, scope)` — the kind check lived in the accept
loop, next to the `where`. Replacing that condition with the compiled `window.match(...)`
(needed to introduce any-form windows for `read-unused`) dropped the kind check for
single-form windows, because the compiled `where` had never contained it. A `tool.use.start`
event carries `ts`, so it satisfied a `first: { on: check.run }` window's where-test: the
window closed on the wrong event, and the handler emitted a row whose `checked_at` was the
Bash call's start time and whose `runner` was undefined — a verification verdict computed from
the wrong event, reported as a result.

## How it surfaced

The refactor was part of asc-6ola.8's promotion of `window.<mode>.any`. The any-form's kind
check was mutation-tested and a named unit test killed the mutation; the single form had the
same hole, and the unit suite stayed green — the core handler tests passed, 50 of 50 — because
no unit corpus had two kinds sharing a field name where the cheaper kind arrives first. The
fixture replay of `edit-verified` failed on exactly that shape.

Nobody was looking for it. The question under test was `read-unused`'s window semantics; the
`edit-verified` fixture was replayed only as an acceptance check on the refactor.

## The metric

The unit suite at the moment of the defect (packages/core, vitest):

```
Tests  50 passed
```

The fixture failure that caught it — the emitted row, with `runner` resolved from the wrong
event:

```
expected [ [ '/p/a.ts', undefined ] ]
```

The scratch debug probe that localized it (exact, from the session transcript):

```
checked_at: '2026-09-24T10:00:04.000Z' — but the check.run's ts is 10:00:05! 10:00:04 is the
tool.use.start of b1! So `found` is the tool.use.start event, NOT check.run?!
```

`runner: undefined` was the tell: a `check.run` event always carries a runner, so a row with an
undefined runner could only mean the matched event was not a `check.run`.

After the fix, a unit test that discriminates the shape (`first: the window kind is part of the
match, not only the where` — a `tool.use.start` with an earlier `ts` offered to a
`check.run` window) is red under the pre-fix code and green under the fix. The four mutations
of the new compile/runtime paths were each killed by a named test; the suite then ran green at
full scale (96 files, 2,213 passed, 2 skipped).

The n here is 1 — one defect found in one replay; an anecdote under `MIN_N` (20,
`packages/analysis/src/proportion.ts:50`), reported as the incident it is, not a rate.

## The pattern

Severity-zero: the evaluator reported a verdict computed from the wrong event, and every test
that was supposed to catch it was green. Two lessons inside one incident:

- **A check that lives in the caller, not the callee, dies silently when the call shape
  changes.** Folding a guard into the thing it guards is right — but the move itself is the
  moment to re-verify the guard is still applied everywhere, because the diff looks equivalent.
- **A unit corpus that never offers two kinds sharing a field name cannot make a kind check
  load-bearing.** `tool.use.start` and `check.run` both carry `ts`; a fixture must contain the
  cheaper kind arriving first, or the kind test is decorative.

## Why nothing else would have caught it

The unit suite was green (50/50) and typecheck was green — the match closure's type is `Test`
either way, so the hole is invisible to the compiler. Code review of the diff would not flag
it: the kind check was still "there", in the accept loop, and the replacement condition reads
as equivalent. The only instrument that caught it was replaying a real handler whose fixture
contains two kinds sharing a field name — which is the fixture-corpus practice this project
already pins (`edit-unverified`/`edit-verified` partition identity).

## Consequences and constraints

No store entries are affected: the defect is in the handler runtime, not derivation, so no
`derivationVersion` bump, re-ingest, or invalidation applies, and `derive_version` is
unchanged. The fix folds the kind check into the compiled match for both forms, so `accept()`
can offer every event and the invariant lives in one place (`packages/core/src/handler.ts`,
comment at the single-form compile). The unit test pinning it was added in the same change.

## Links

- Bead: `asc-6ola.8` (closed 2026-09-25; the RESULT note records the find)
- Evidence record: `docs/evidence/EV-24.md` (Decision section)
- Code: `packages/core/src/handler.ts` — single-form `compileWindow` match, kind check folded in