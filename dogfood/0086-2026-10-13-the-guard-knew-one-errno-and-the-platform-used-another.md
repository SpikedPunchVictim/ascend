# 0086 — the guard for "the reader went away" knew one errno, the platform uses another, and the test asserting it was false passed by luck

| | |
|---|---|
| **Bead** | `asc-zimu` |
| **Surfaced** | the failure was logged 2026-09-30; characterized 2026-10-13 |
| **Surfaced by** | the pre-commit gate's own failure log (`test-failures.log`), read while working Stage E32.3 of the wave-5 plan |
| **Entry type(s)** | n/a — the defect is in the CLI's stream guard and in a test that asserted a property the CLI did not have |
| **Severity** | P2 for the defect; **severity-zero by the class**, because the test reported a guarantee it was not checking |
| **Status** | fixed in the working tree (uncommitted; the conservative git profile is in force) |

## What was found

`asc query`'s broken-pipe guard (`packages/cli/src/streams.ts`) acts on **`EPIPE` alone**, on the
stated reasoning that *"`EPIPE` is the only shape this acts on"*. It is not:

1. **A reader that closes GRACEFULLY never produces the guard's errno at all.** `asc query ... | head -1`
   on a 5,000-row result: 150 of 150 runs clean, exit 0, empty stderr.
2. **A reader that `destroy()`s the read end mid-write produces `ENOTCONN`** (`errno -57`, "socket is
   not connected"), not `EPIPE`. Exiting sends a FIN; `destroy()` sends an RST, and a write on the far
   side of an RST is reported as a socket that is no longer connected.
3. **`@oclif/core` installs its own handler with the same EPIPE-or-rethrow decision**, at
   `Command`-module load — before ascend's entry point runs. EventEmitter calls listeners in
   registration order and stops at the first that throws, so oclif's listener answered first and
   rethrew. The result is an uncaught exception: Node printed a **path-first** crash dump and the
   process exited **1**.

**The test at fault was not flaky; the property it asserted was false.** `query.test.ts`'s *"exits 0
with nothing on stderr when the reader closes the pipe"* asserts `stderr === ''` and `code === 0`. It
passed ~99% of runs by timing, and failed when the parent's destroy landed inside the child's write
window. That is a green that should not have been green — this project's severity-zero class.

The signature is what made it identifiable and it is worth writing down: **a stderr whose first byte
is `/`**. Every `asc` writer goes through `renderForStderr` (`packages/cli/src/errors.ts`) and always
prefixes a label (`Error: `, `Warning: `, `Note: `), so no ascend code path can emit a bare path. A
bare absolute path first is Node's header for an uncaught exception — reproduced directly by
truncating a compiled module and running it:

```
/private/tmp/zimu/truncated.js:2
/**

SyntaxError: Invalid or unexpected token
```

## How it surfaced

The gate logged it once, on 2026-09-30, and the plan for this stage named it as the one thing to
characterize. **Nobody was looking for it** when it happened — it arrived as a single red among
2,433 logged entries, in a run of 2,822 tests.

What made it tractable was refusing the two easy answers. *Machine load* was already falsified: the
recorded entry carries `loadavg 12.50 8.57 6.70`, unremarkable. And the *first* hypothesis — that
another worker's `tsc -b` was leaving `packages/cli/dist/bin.js` partially written for the child to
read — was measured and dropped: a Node reader sampled that file 180,752 times across two forced
rebuilds and never once saw a short read, and a `stat` loop over 716 samples saw one size only.

The hypothesis that replaced it came from reading the received value's *shape* rather than its
truncated content, then reproducing the shape from an unrelated cause and asking what in this repo
could produce it.

## The metric

**The recorded failure, verbatim** (`test-failures.log`):

```
{"at":"2026-09-30T04:16:43.060Z","file":"packages/cli/test/query.test.ts","test":"a reader that goes away > exits 0 with nothing on stderr when the reader closes the pipe","duration_ms":815,"error":"expected '/Users/spikedpunchvictim/projects/asc…' to be '' // Object.is equality","loadavg":"12.50 8.57 6.70","run_tests":2822,"run_summed_ms":831534}
```

**The arms, all driven through the real binary** (`node packages/cli/dist/bin.js query <5,000-row
CTE>`, home set to a scratch project), each measuring what the test measures — child stderr and exit
code:

| arm | N | anomalous | exit | stack origin |
|---|---|---|---|---|
| baseline, the test's exact spawn (reader destroyed on first chunk) | 300 | **3 (1.0%)** | 1 | `@oclif/core/lib/command.js` |
| control — reader DRAINS instead of destroying | 150 | **0** | 0 | — |
| the real pipeline, `asc query ... \| head -1` | 150 | **0** | 0 | — |
| `ENOTCONN` accepted, registration left as `on` | 300 | **2 (0.7%)** | 1 | `@oclif/core/lib/command.js` |
| `ENOTCONN` accepted **+ `prependListener`** | 600 | **0** | 0 | — |

Every anomaly in every arm carried the same text, byte for byte in shape:

```
/Users/spikedpunchvictim/projects/ascend/node_modules/.pnpm/@oclif+core@5.0.0/node_modules/@oclif/core/lib/command.js:60
    throw err;
    ^

Error: write ENOTCONN
    at afterWriteDispatched (node:internal/stream_base_commons:159:15)
    ...
    at console.log (node:internal/console/constructor:416:26)
  errno: -57,
  code: 'ENOTCONN',
```

The control is the load-bearing one: **the anomaly requires the reader going away.** Draining the
same 5,000 rows 150 times produced no error at all, and the graceful pipeline produced none either,
so the guard is not broken in general — it is broken for the abrupt reader specifically.

**The instrument was wrong once and it is recorded rather than hidden.** The first attempt at the
`| head -1` arm reported `clean=0 anomalous=150`. The cause was the instrument, not the pipeline:
`PIPESTATUS` is a bash array, this shell is zsh, and the variable read back empty so every iteration
was counted anomalous. Re-run with zsh's `$pipestatus[1]`, the same arm is 150 of 150 clean. A
measurement whose instrument is broken is not a measurement, and this one would have supported
exactly the wrong conclusion.

**The rate is not established, and the two estimates disagree by 17x.** The log holds **1** failure
of this test in **2,433** entries; the measured rate on this machine is **1 in 100**. Nothing here
explains the gap — the gate's timing, machine load and the exact point the parent's destroy lands all
move the window — and it is left as measured rather than fitted.

## The pattern

**One errno was written down where the condition needed two, and the platform supplied the other
one.** `EPIPE` is what a broken pipe looks like; `ENOTCONN` is what an abruptly broken pipe looks like
on this platform. The guard's own docblock declared the assumption — *"`EPIPE` is the only shape this
acts on"* — which is the shape of comment that reads as a measurement and is not one.

**And the harness could not see it, because the test could not fail reliably.** A check that fails
1% of the time is a check that passes. The docblock in `streams.test.ts` had already noticed the gap
and named it precisely — *"the trigger stays unproven until `asc query` can overrun the buffer"* —
and when the trigger did arrive, the end-to-end test that used it was **probabilistic in the same
way the bug was**, so it stayed green.

## Why nothing else would have caught it

- **The type system cannot see it.** `code === 'EPIPE'` type-checks and lints against every errno.
- **The gate's failure log could not have caught it.** It holds one entry, and the entry it holds
  truncates the received value at `…`, one character past the `/` that was the whole clue.
- **The end-to-end test could not have caught it**, and this is the sharp part: it was *already*
  asserting the right thing and passing. A 1% failure is indistinguishable from a pass in any single
  run, which is why `n = 1` in 2,433 was read for a year as noise rather than as a signal.
- **A review could plausibly have caught the errno**, since the assumption is written down in prose
  in two places. Not claimed as a win — it is an argument for the deterministic arms that now exist.

## The fix

The owner chose to fix the guard over changing the test (2026-10-13). Both halves were required, and
the second was only visible from measurement:

- **The errno set** is now `READER_GONE = new Set(['EPIPE', 'ENOTCONN'])`, with the measurement, the
  FIN-vs-RST distinction and both rates written into its docblock. The rethrow is now on *"not a
  reader-gone code"* rather than on *"not `EPIPE`"* — the false-green it guards against (ENOSPC, EIO)
  is unchanged.
- **The registration order** moved to `prependListener`, because oclif's equivalent handler is
  installed first and rethrows. Accepting `ENOTCONN` while leaving `on` measured **2 of 300** — the
  fix was incomplete without this and no amount of reading the diff would have shown that.
- **`ErrorEmitting` now declares both `on` and `prependListener`**, though only one is called, so that
  the mutation swapping them still *compiles*. A mutant that fails to typecheck makes its killer fail
  as `suite-failed`, which `scripts/mutate.mjs` refuses to read as a kill — declaring only
  `prependListener` would have turned the precedence hazard into a check the harness cannot exercise.
- **`streams.test.ts` gained the `beforeAll` build every other CLI test file has**, because it imports
  `@ascend/cli` from `dist/`; without it every arm tested whatever was built last, and as a mutation
  killer it would have reported a false survivor.
- **Two new arms**: `ENOTCONN` exits 0, and a real `EventEmitter` with an oclif-shaped handler
  registered *first* proves the guard answers before it. The second uses a real emitter rather than a
  fake because listener ORDER is the property, and a fake would have to reimplement it.
- **The end-to-end test in `query.test.ts` is left alone and is now honest** — it asserts the right
  thing and the code now satisfies it. Its docblock says plainly that it is probabilistic and that the
  deterministic half lives in `streams.test.ts`.
- **`scripts/mutations/pipe-guard-errno.json`** plants both halves; both killed, rebuild green.

## Consequences and constraints

- **The recorded failure is not evidence that the gate was flaky.** It was evidence of a defect, and
  it was one log line away from being dismissed as load for a year.
- **The rate discrepancy (1 in 2,433 against 1 in 100) is unresolved** and is not explained away.
- **`asc-zimu` named this as one flake; the same shape may exist elsewhere.** A guard acting on an
  enumerated errno set is the pattern, and this is its first measured counterexample.
- Nothing here is a cleanup task: no stored entry is involved and nothing is immutable.

## Links

- Bead: `asc-zimu`
- Mutation spec: `scripts/mutations/pipe-guard-errno.json`
- Prior art on the same guard: `packages/cli/test/8pp-truncation.test.ts`, `asc-8pp`
- Dogfood series: `dogfood/0071` (what the failure log's `loadavg` cannot tell), `dogfood/0085`
  (a bound that was wrong in a different way), `dogfood/0086` (this record)
