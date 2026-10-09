# 0071 — the instrument built to name a rare red now buries it

| | |
|---|---|
| **Bead** | `asc-5swk` |
| **Surfaced** | 2026-10-09 |
| **Surfaced by** | reading `test-failures.log` to answer `asc-pcaw`'s question about a load-induced gate red |
| **Entry type(s)** | none — the defect is in a test reporter, not in a recorded type |
| **Severity** | P3 |
| **Status** | open |

## What was found

`vitest.failure-log.ts` appends one JSON line per failed test to `test-failures.log`, and its
docblock says why: *"A red run is rare and does not reproduce on demand -- it is contention,
measured -- so the only way to name it is to have written it down when it happened."* That was true
when `asc-9ac` built it. It no longer is. The log now holds **2078 lines across 278 distinct red
runs**, and **248 of those 278** are runs with `run_tests <= 200` — single-file runs, dominated by
the `pnpm mutate` mutant kills that arrive in bursts seconds apart, one killer file per mutant.

The instrument is not *wrong*. Every line carries `run_tests`, so a reader who knows to filter on it
can still find what they came for. The defect is that the one entry the instrument exists to name
sits among 2078 lines of deliberate, desired red, and nothing in the log says which is which.

## How it surfaced

**Nobody was looking for it.** The work in progress was `asc-pcaw` — does a load-induced timeout of
the corpus tests have a remedy inside this repo? — and the memory `ascend-gate-cost-and-corpus-flake`
says plainly to *"read `test-failures.log` before believing a diagnosis"*. So the log was read as an
instrument, and the first thing it did was refuse to answer: 2078 lines, and no way to tell a
mutant's kill from the red anyone would want to read about.

What made the size visible was having a **count** to compare against rather than an impression. The
log has an obvious volume and an obvious cause, and either alone is easy to wave off; measuring that
89.2% of its red runs are single-file runs is what turns "this file is long" into "this file is
mostly the mutation runner talking to itself".

## The metric

2026-10-09, `test-failures.log` as it stands on this checkout. Verbatim output:

```
$ node -e '...'   # lines, distinct (at, run_tests) runs, and regex /timed out/i over failure entries
lines: 2078
distinct red runs: 278
runs with run_tests<=200 (single/partial-file): 248
runs with run_tests>=2000 (full suite): 20
runs in between: 10
timeout lines: 1
   2026-10-05T08:27:41.700Z normalize-real-corpus.test.ts 180086 loadavg 95.34 63.96 40.16 run_tests 3049
```

248 / 278 = **89.2%** of red runs are single-file runs. This is a proportion at `n = 278`, above
`MIN_N` (20, `packages/analysis/src/proportion.ts`), so it is a rate and not an anecdote.

The bucket boundaries are a proxy, and it is worth saying so: `run_tests <= 200` is not a
`pnpm mutate` detector, it is a single-file-run detector. What confirms the reading is the shape —
the entries arrive in bursts seconds apart, which is one killer file per mutant:

```
2026-10-09T19:06:46.426Z derive.test.ts  run_tests=143
2026-10-09T19:06:48.281Z derive.test.ts  run_tests=143
2026-10-09T19:06:50.255Z derive.test.ts  run_tests=143
2026-10-09T19:07:01.635Z ingest.test.ts  run_tests=39
2026-10-09T19:07:02.775Z derive.test.ts  run_tests=143
```

Those five are the `derive-key-identity` spec of `asc-hbxl`, killed a minute ago in the session that
found this.

The instrument's own signal is a single line. Of the **20** full-suite red runs, **exactly one** is a
timeout, and it is the `dogfood/0063` red the whole thing was built to capture:

```
2026-10-05T08:27:41.700Z  loadavg 95.34 63.96 40.16  duration_ms 180086  run_tests 3049
  normalize-real-corpus.test.ts > the normalizer against the real corpus > emits only declared kinds and fields...
  "Test timed out in 180000ms."
```

**A second reading, from the same pass, that cuts against the instrument rather than the log.**
`loadavg` is recorded on every line *so that load can be read against growth*, and it does not mean
what it looks like it means. Twelve entries sit above `loadavg` 30, and they are overwhelmingly
mutant kills — `design-effect.test.ts` at **93.07** with `run_tests=23`, `install-skill.test.ts` at
**60.55** with `run_tests=58`. `loadavg` counts runnable threads regardless of scheduling class, so a
number built from low-priority work is not the same machine as one built from equal-priority work.
`docs/evidence/EV-46.md` measured the same thing from the other side: a corpus test at `loadavg 47.38`
on 12 cores ran at 2.6× and stayed green, because a `nice -n 20` thread never outranks it.

## The pattern

**An append-only instrument with no severity field.** The log was designed so a *later* green run
could not erase the one red anyone would want — *"Appending, not replacing, is the point"* — and
that decision is still right. What it did not account for is a *new source* of reds that are
deliberate and frequent. Nothing in the schema distinguishes "a test failed and nobody expected it"
from "a test failed and the runner required it to", so the second class grows without bound and
silently sets the price of reading the first.

The class is **"a signal whose usefulness depends on the rarity of what it reports, and rarity is not
a property the instrument can defend by itself."** It is also, narrowly, a **false-negative
generator**: an alert that fires 248 times for reasons the reader asked for is one people stop
reading, and the 249th is the one it was built for.

## Why nothing else would have caught it

The reporter is a `Reporter` registered in `vitest.config.ts`; no test asserts anything about
`test-failures.log`, and it could not — the file is gitignored (`*.log`), machine-local, and
append-only across sessions. A code review of `vitest.failure-log.ts` would find nothing wrong with
it, because nothing in that file is wrong: the defect lives in the *population* of runs, which is
invisible from the source and only visible from the data.

The one thing that would have caught it earlier is the thing that did catch it: reading the log as an
instrument, because `asc-pcaw` needed a number. Nothing in the suite or the gate had a reason to.

## Consequences and constraints

- **Not a cleanup task.** The 248 lines are honest history and the file is append-only by design.
  The options are prevention at write time — the reporter recording which reds were asked for — or
  leaving it and telling the reader what the numbers mean. There is no edit path, and there should
  not be one.
- **The cheap fix and the honest fix are different.** A `mode: 'mutate' | 'suite'` field would take
  an afternoon, but it needs `scripts/mutate.mjs` to tell the reporter something across a process
  boundary, and the runner already rebuilds the tree on exit — the places to thread it are not
  obvious. The zero-code alternative is to say, where the memory already sends people, that
  `run_tests >= 2000` is the filter.
- **The loadavg reading is the more consequential half.** It is currently cited as the reason to
  trust a diagnosis of a red, and it cannot distinguish competition from low-priority company.

## Links

- Bead: `asc-5swk`
- Evidence record where the second reading was measured: `docs/evidence/EV-46.md`
- The finding the log was built for: `dogfood/0063`; the instrument's own bead: `asc-9ac`
- The parallel-vs-serial premise it was measured against: `dogfood/0007`, `asc-3x1`
