# 0063 — the deadline came back, and it was load: the instrument that was built for this caught it

| | |
|---|---|
| **Bead** | `asc-pcaw` |
| **Surfaced** | 2026-10-05 |
| **Surfaced by** | running the full pre-commit gate twice, on an unchanged tree, for Stage 4 of `asc-049w` |
| **Entry type(s)** | `verification_run` (derived) |
| **Severity** | P2 |
| **Status** | open |

## What was found

**The gate blocked an unrelated commit because the machine was oversubscribed, not because anything in
the commit was wrong.** A test in `packages/adapter-claude-code/test/normalize-real-corpus.test.ts`
reads the live `~/.claude/projects` corpus and carries its own `180_000` ms bound. Under load it
exceeded that bound, `pnpm test` exited 1, and the gate reported red naming a normalizer test with no
relationship to the staged change. Fifteen minutes later, on the same tree, the same test passed.

**This is the third occurrence of a class this project has already diagnosed twice, and `dogfood/0007`
predicted it in writing:**

> The deadline will come back. The corpus grows with every dogfooding session, and this record's own
> session added 18.2 MB to it. The headroom bought here is 5x, not permanent.

What is new is not the recurrence — it is the *attribution*, which neither prior pass could make. The
first was fixed by reducing workers (`asc-3x1`, `c5a417f`, 2026-09-18). The second could not name its
own red at all — *"no red in the 6 full-suite runs this session"* (`asc-9ac`, `21f443f`,
2026-09-28) — so it attributed the class to **load, not growth** and, unable to prove it, built an
instrument to name the next one. This is that instrument's **first catch**, and the number it recorded
closes the question the previous pass had to leave open.

## How it surfaced

**Nobody was looking for it.** It arrived from the least exotic act available: running the gate twice.
The first run of Stage 4's drive went red and blocked; a later run of the same gate, over the same
tree, was green. The only difference between them was the state of the machine.

Worth naming how ordinary the trigger was. `asc-049w` Stage 4 exists to drive a *new* check end to end,
and the arm that needed a clean full suite is the one that hit this. The check under construction was
not involved in the failure at all — which is the point. Any commit would have read the same way.

**The first draft of this record named the wrong cause**, and that is part of the finding. Reading only
the two runs, the natural story was the one `dogfood/0007` was written about — the corpus grew past a
fixed bound. That story is wrong, and what killed it was checking the artifact rather than the report:
the failure log, and the one test `asc-3x1`'s decision was actually based on.

## The metric

**The line `asc-9ac` built the instrument to capture.** `vitest.failure-log.ts` appends every failed
test with the load average; this is the entry from the red run, verbatim:

```
{"at":"2026-10-05T08:27:41.700Z","file":"packages/adapter-claude-code/test/normalize-real-corpus.test.ts","test":"the normalizer against the real corpus > emits only declared kinds and fields, in seq order, one session.end per stream","duration_ms":180086,"error":"Test timed out in 180000ms.","loadavg":"95.34 63.96 40.16","run_tests":3049,"run_summed_ms":1723832}
```

**`loadavg 95.34` on a 12-core machine**, against the **2.8–4.0** at which `asc-9ac` measured this
class at 7.9% of budget. Roughly 8x oversubscribed. **Which process produced that load is not
established by this measurement** — the number is attributed to the machine, not to the suite, and not
to any particular cause.

**The same test, same tree, next run** — green, at a sixth of the bound:

```
   ✓ the normalizer against the real corpus > emits only declared kinds and fields, in seq order, one session.end per stream 29489ms
```

So the red required a **~6.1×** slowdown, and `180086 / 29489` measures the margin a load spike has to
eat for this test. No prior record carries that number. `n = 2` runs: an **anecdote** under `MIN_N`
(20, `packages/analysis/src/proportion.ts:50`), supporting *"this varies with the machine on an
unchanged tree"* and no rate.

**Growth ruled out separately**, which is the part the earlier passes could not do. The test `asc-3x1`
was decided on is `derive-real-corpus.test.ts`'s `derives entries that all satisfy their own
definitions`, and it is still on its original `120_000` ms budget — the raise was rejected and did not
happen (`120_000` survives in 7 places in that file; the `180_000` bounds predate the fix, introduced
at `75d482f`, 2026-09-15). Measured in this session:

```
   ✓ the deriver against the real corpus > derives entries that all satisfy their own definitions 25086ms
```

**25,086 ms = 20.9% of budget**, against the **24,094 ms / 20.1%** measured post-fix on 2026-09-18.
Four percent higher in seventeen days. A corpus that has not measurably eroded the headroom cannot be
what blew a bound six times away from it.

## The pattern

**A fixed deadline guarding a quantity that varies with the machine.** This is `dogfood/0007`'s own
pattern, unchanged; the recurrence confirms the pattern rather than extending it. What the three
passes together map is that the deadline has *two* independent dimensions, and only one has ever been
bounded:

| dimension | bounded by | status |
|---|---|---|
| corpus growth | headroom analysis, `maxForks 12 -> 6` (`asc-3x1`) | measured intact: 20.1% → 20.9% in 17 days |
| **machine load** | **nothing** | 6.1x spread on an unchanged tree; red at `loadavg 95.34` |

The second pass made the red **legible** (the log names it, with `loadavg`) and explicitly declined to
bound it, keeping the budget on the grounds that the sweep only does ~10 s of real work. That reasoning
is sound about the *sweep* and silent about the *machine*: a 10 s sweep under 8x oversubscription is a
180 s test.

There is a second, smaller pattern here, and it is the one that cost real time: **the two runs told a
coherent story that was the wrong one.** Growth-past-a-fixed-bound is a real, previously-recorded
failure mode in this exact file, which made it the comfortable explanation for a red that load
produced. A diagnosis that matches a known past finding is not therefore correct, and the check that
distinguished them was reading the prior record's *numbers* instead of its *shape*.

## Why nothing else would have caught it

- **No test asserts the suite's own duration**, and no test asserts the machine's state. There is no
  budget on `pnpm test`, so the only signal is the gate going red — after the fact, on an unrelated
  commit.
- **A code review would not see it.** The file is correct, well-commented, and explicitly reasons
  about its live input. What is missing is that nothing re-asks whether "generous" is still generous
  when the machine is 8x oversubscribed.
- **It cannot reproduce on demand.** The next run passed. A maintainer investigating the red would
  find nothing wrong with the test, re-run, get green, and dismiss it — which is exactly the state
  `asc-9ac` was already in when it closed, and why it built the log instead of a fix.
- **What did catch it was built for it.** The attribution in this record exists only because
  `asc-9ac` recorded `loadavg` at the moment of failure. That is the most reusable thing here: the
  instrument built for an unnamed red named this one, and the number it captured is what settled it.

## Consequences and constraints

- **The remedy is a decision, not an obvious fix.** Candidates: a bounded retry for corpus tests, a
  load-aware guard that defers, or moving the corpus files into their own serialized project. `0007`
  measured that the corpus files are slower in parallel than sequential (114.01 s racing, 75.00 s
  sequential), which is evidence for the third. None is free, and all need the same treatment the
  prior passes gave theirs: measured, with the rejected alternatives recorded.
- **`--no-verify` is one keystroke away from this red.** A gate that fails for reasons unrelated to
  the diff is a gate people learn to bypass, and that cost is the reason this is worth a bead rather
  than a shrug.
- **The count is a reading of this machine and this session.** macOS, this checkout, 12 cores.
- **Nothing here invalidates `dogfood/0061` or `asc-049w`.** The unrelated red made that drive hard to
  complete; it is recorded because it was *found* there, not because the new check caused it.

## Links

- Bead: `asc-pcaw`
- The class, twice before: `dogfood/0007` — `asc-3x1`, fixed `c5a417f`; then `asc-9ac`, fixed `21f443f`
  (`vitest.failure-log.ts`, whose first catch is quoted above)
- Evidence record: `docs/evidence/EV-hooks.md` — Q5, the drive this surfaced during
- Related work: `asc-049w`, `dogfood/0061` — the gate-red-for-the-wrong-reason class
