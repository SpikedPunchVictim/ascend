---
name: lens-review
description: 'Review code in the ascend repository for defects through nine analysis lenses, reporting every finding with the ReportFindings tool so it is counted as a review_finding. Use for any review, bug hunt, or "what could go wrong" pass in this repository, including one run by a subagent or headless -- in this repository, use it instead of the user-level bug-hunt skill, whose report is prose and is not counted. Triggers: "review", "code review", "bug hunt", "hunt for bugs", "find bugs", "what could go wrong".'
allowed-tools: [Read, Grep, Glob, Bash, ReportFindings]
---

# Lens review

You are reviewing code in this repository for defects: places where the code behaves wrongly for
some input, state, or ordering of events. This skill never asks a question, because a reviewer is
often a subagent or a headless session with nobody to answer. Make reasonable assumptions, say what
you assumed in a finding's `failure_scenario` where it matters, and keep going.

**Do not modify any file.** A review reports; it does not fix.

## Scope

Review what you were asked to review. If no scope was given, review the files changed on the
current branch relative to `main` (`git diff --name-only main...HEAD`, plus uncommitted changes
from `git status --short`). If that is empty too, review the most recently changed source files.

## The nine lenses

Apply each lens to the code in scope. The slug before each one is the category you report it
under -- exactly as spelled, because a value outside these nine is refused when the finding is
recorded.

- `assumption_audit` -- implicit assumptions per function ("this collection is non-empty", "this key exists", "this string is in format X", "the caller already normalized this", "this enum never grows") that can be violated, with a wrong result and no guard.
- `state_machine` -- any mutable status: dead-end states, mutually exclusive states that can both be true, transitions interrupted mid-way, and reset paths after an error or cancellation.
- `boundary_conditions` -- for every conditional and size-dependent operation: zero, one, maximum, negative, just past a threshold; empty collections and strings; index arithmetic; values that pass one check but fail a stricter one downstream.
- `data_lifecycle` -- follow each entity through creation, modification, persistence, and deletion: validated where, partial writes, created but never persisted, deleted with references remaining.
- `error_paths` -- every catch, optional chain, fallback, and async boundary: is the error surfaced or swallowed, is state consistent afterwards, can the caller retry, is the error branch dead code.
- `time_concurrency` -- timezone and locale dependence, expiry without an expiry check, rapid repeats and duplicates, check-then-act races, dedupe keys that do not survive input variation, retries without idempotency.
- `environment_divergence` -- behavior that varies by runtime version, OS, locale, environment variable, or configuration, where one variant is clearly less tested.
- `cross_implementation_divergence` -- the same invariant implemented in more than one place where one implementation guards and another does not; the guarded sibling is the specification, cite it.
- `write_read_asymmetry` -- a value normalized on one side of storage or comparison but not the other: case folding, trimming, encoding, derived keys.

Before reporting a finding, try to refute it: look for a guard upstream, a caller that cannot
produce the input, or a test that pins the behaviour. Report what survives. You may run the test
suite (`npx vitest run <file>`) to confirm one.

## Reporting

Report every finding with the `ReportFindings` tool. **A finding that is not reported through
`ReportFindings` is not counted**, and a written report file or a prose summary is not read. You
may call the tool more than once; call it as soon as you have findings worth keeping rather than
saving them all for the end. For each finding give:

- `file` -- the path relative to the repository root, e.g. `packages/core/src/handler.ts`
- `line` -- the 1-indexed line where the defect is
- `summary` -- one sentence stating the defect
- `failure_scenario` -- the concrete input or state, and the wrong output or crash it produces
- `category` -- exactly one of the nine slugs above
- `verdict` -- `CONFIRMED` if you verified it, `PLAUSIBLE` if you did not

If you finish and have found nothing, call `ReportFindings` with an empty `findings` array, so the
review is still on record.

**Do not run `asc record` for a finding.** Each `ReportFindings` element becomes a `review_finding`
entry when `asc ingest claude-code` next runs; the type is derived, never recorded by hand.

After the tool call, a short prose summary for the person who asked is fine. It is for them, not
for the record.
