You are reviewing code in this repository for defects: places where the code behaves wrongly for
some input, state, or ordering of events. Nobody is available to answer questions, so do not ask
any; make reasonable assumptions and keep going.

Scope: `packages/core/src/handler.ts`. Its tests are in `packages/core/test/handler.test.ts`. The
language is TypeScript and the runtime is Node 22 or later. Do not modify any file.

Apply each of these nine lenses to the file in scope. The slug before each one is the category
name you will report it under.

- `assumption_audit` -- implicit assumptions per function ("this collection is non-empty", "this key exists", "this string is in format X", "the caller already normalized this", "this enum never grows") that can be violated, with a wrong result and no guard.
- `state_machine` -- any mutable status: dead-end states, mutually exclusive states that can both be true, transitions interrupted mid-way, and reset paths after an error or cancellation.
- `boundary_conditions` -- for every conditional and size-dependent operation: zero, one, maximum, negative, just past a threshold; empty collections and strings; index arithmetic; values that pass one check but fail a stricter one downstream.
- `data_lifecycle` -- follow each entity through creation, modification, persistence, and deletion: validated where, partial writes, created but never persisted, deleted with references remaining.
- `error_paths` -- every catch, optional chain, fallback, and async boundary: is the error surfaced or swallowed, is state consistent afterwards, can the caller retry, is the error branch dead code.
- `time_concurrency` -- timezone and locale dependence, expiry without an expiry check, rapid repeats and duplicates, check-then-act races, dedupe keys that do not survive input variation, retries without idempotency.
- `environment_divergence` -- behavior that varies by runtime version, OS, locale, environment variable, or configuration, where one variant is clearly less tested.
- `cross_implementation_divergence` -- the same invariant implemented in more than one place where one implementation guards and another does not; the guarded sibling is the specification, cite it.
- `write_read_asymmetry` -- a value normalized on one side of storage or comparison but not the other: case folding, trimming, encoding, derived keys.

Report every finding with the `ReportFindings` tool. A finding that is not reported through
`ReportFindings` is not counted, and a written report file is not read. You may call the tool more
than once; call it as soon as you have findings worth keeping rather than saving them all for the
end. For each finding give:

- `file` -- the path relative to the repository root, e.g. `packages/core/src/handler.ts`
- `line` -- the 1-indexed line where the defect is
- `summary` -- one sentence stating the defect
- `failure_scenario` -- the concrete input or state, and the wrong output or crash it produces
- `category` -- exactly one of the nine slugs above
- `verdict` -- `CONFIRMED` if you verified it, `PLAUSIBLE` if you did not

If you finish and have found nothing, call `ReportFindings` with an empty `findings` array.
