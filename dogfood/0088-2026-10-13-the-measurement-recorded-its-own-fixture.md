# 0088 — a log that a test wrote, and the before-number that read it back

| | |
|---|---|
| **Bead** | `asc-09wx.14` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | reading `.ascend/gate-runs.jsonl` to take the gate's before-number |
| **Entry type(s)** | none — this is about the tooling, not about a record |
| **Severity** | P2, matching the bead |
| **Status** | fixed in the working tree (`.githooks/pre-commit` and `scripts/gate.mjs` are uncommitted at the time of writing) |

## What was found

The gate's new run record — the JSONL file `asc-09wx.14`'s first step exists to write, and the file
its step 6 is going to grade the whole task from — was being appended to by the test suite.

`scripts/gate.mjs` resolves the record's path from `process.cwd()`. That is correct for the hook,
which `cd`s to the repository root before calling it. But `packages/cli/test/dev-hooks.test.ts`
invokes the **real** `.githooks/pre-commit` with `cwd` set to the **real repository root** and only
`pnpm` and `node` stubbed on `PATH`. That is deliberate and correct on its own terms — the file is
testing that hook, and it stubs the two binaries so the test does not depend on this checkout's
index. It now runs `node scripts/gate.mjs`, whose one new side effect is to append a row. So each
of the test's six invocations wrote a row to the real log.

Nothing about this is visible from the suite. The rows are schema-valid, they carry the real HEAD,
and the test's own assertions are about stdout strings and pass either way.

## How it surfaced

**Nobody was looking for it, and no question had been asked whose answer it is.** The row count
was found by accident: I read the log expecting one row, the before-number for a 27-minute gate
run, and found seven. That is the whole detection mechanism — a human-readable file with an
expected size and seven lines in it.

It is also a finding about a *change*, not about the code as found. The previous hook had no side
effects, so a test that ran it against the real repository was harmless. Adding the record made an
untouched, unmodified, passing test unsafe. Nothing in the diff of `dev-hooks.test.ts` would have
shown it, because `dev-hooks.test.ts` is not in the diff.

## The metric

Seven rows in `.ascend/gate-runs.jsonl`, obtained by reading the file after the gate run finished.
Six of them are the test's:

```
$ wc -l < .ascend/gate-runs.jsonl
7
$ python3 -c "
import json
for i,l in enumerate(open('.ascend/gate-runs.jsonl')):
    d=json.loads(l)
    print(i+1, d['at'], 'total_ms=', d['total_ms'], 'steps=', len(d['steps']),
          'blocked_at=', d['blocked_at'], 'head=', (d['head'] or '')[:8],
          'format:check ms=', d['steps'][0]['ms'])
"
1 2026-10-13T20:52:06.589Z total_ms= 227 steps= 6 blocked_at= None head= cce0502d format:check ms= 196
2 2026-10-13T20:52:07.847Z total_ms= 281 steps= 1 blocked_at= format:check head= cce0502d format:check ms= 281
3 2026-10-13T20:52:09.658Z total_ms= 275 steps= 6 blocked_at= None head= cce0502d format:check ms= 232
4 2026-10-13T20:52:13.223Z total_ms= 237 steps= 3 blocked_at= store verify --staged head= cce0502d format:check ms= 227
5 2026-10-13T20:52:15.202Z total_ms= 297 steps= 6 blocked_at= None head= cce0502d format:check ms= 270
6 2026-10-13T20:52:17.136Z total_ms= 202 steps= 6 blocked_at= test count head= cce0502d format:check ms= 173
7 2026-10-13T20:54:50.802Z total_ms= 1621182 steps= 5 blocked_at= test head= cce0502d format:check ms= 32556
```

The six are identified by their shapes, not by their timestamps alone: rows 1, 3, 5 are
`runGate(0)`, row 2 is `runGate(1)` (blocked at the first step, one step recorded), row 4 is
`runGate(0, 1)` (blocked at the store guard, three steps), row 6 is `runGate(0, 0, 1)` (blocked at
the test-count check, six steps). That is every call the test makes, in file order.

The separation is not subtle:

| | the six fixture rows | the one real run |
|---|---|---|
| span | `20:52:06.589Z` – `20:52:17.136Z` (11.0 s) | one run, `20:54:50.802Z` |
| `total_ms` | 202 – 297 | 1,621,182 |
| `test` step | 4 – 12 ms | 1,427,295 ms |

The fixture rows were written *during* the real run — `pnpm test` is what executes
`dev-hooks.test.ts` — so the real run's own log line is the last one, written 2 min 33 s after the
sixth fixture row.

## The pattern

**A fixture that runs production code against production state.** More precisely: a test that
drives the real artifact in the real environment is safe only as long as the artifact has no side
effects, and nothing re-checks that invariant when a side effect is added.

This is a recurring shape in this repository rather than a one-off. The same test file already
stubs `pnpm` and `node` for exactly this reason, and says so — left real, the store guard would run
against this checkout's index and the gate's control-flow test would become a test of whatever
happens to be staged. The reasoning was applied to the *inputs* and the *verdict* and not to the
*outputs*, because until this change there were none.

The generalizing question is worth carrying forward: when a test drives a real artifact, what does
that artifact write, and where?

## Why nothing else would have caught it

- **`scripts/gate.test.ts` cannot.** It is careful in the opposite direction: every run happens in a
  throwaway directory with its own log, and it asserts the row it finds there. It was written before
  the defect existed and passes either way.
- **`dev-hooks.test.ts` asserts on stdout**, and every one of its assertions still passes. It has no
  reason to look at a file.
- **No test asserts the log's row count**, and there was no test for the log at all — the log is a
  measurement, and a measurement is exactly the artifact this project does not otherwise test.
- **A code review of the diff would have caught it only by asking an unasked question**: what else
  in the tree runs `scripts/gate.mjs`? The answer is discoverable in one `grep`, which is the
  argument for having asked.

The one thing that *did* catch it was that the file is human-readable and small. A binary record,
or a record nobody reads until the end of the task, would have carried the six rows all the way
into the grading, where they would have been averaged in as though they were runs.

## Consequences and constraints

The record is **append-only**, which is the property that gives it its value and the reason this
could not be repaired in place. There is no `UPDATE`; a row that should not exist has to be either
lived with or removed, and removal is a hand edit to evidence.

`docs/evidence/EV-70.md` grades the gate from these rows. Six rows totalling under 300 ms, mixed
into a sample whose real runs total 27 minutes, would not merely be noise — they would be the
rows that make the median look good, in the record whose entire purpose is to say what a commit
costs. The rows that a test writes are the measurement.

The fix is a flag the caller sets (`ASCEND_GATE_NO_RECORD`) rather than a property the gate infers.
Inferring "this is not a real run" from the row's own shape — a duration too short to be a suite —
would be a guard that reads as a guard and is not one, which is the failure `asc-9flv` named: a
check that cannot find what it looks for must not read like a check that looked.

## Links

- Bead: `asc-09wx.14`
- Evidence record: `docs/evidence/EV-70.md` (the grading this row set feeds)
- The pre-existing reasoning this is an instance of: the `runGate` docblock in
  `packages/cli/test/dev-hooks.test.ts`, which stubs `pnpm` and `node` but could not stub a file
