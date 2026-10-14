# 0085 — the sweep-payer's bound is tighter than the bound the same file gives the identical sweep, and the corpus is 3.2x the size the file states

| | |
|---|---|
| **Bead** | `asc-9pto` |
| **Surfaced** | 2026-10-13 |
| **Surfaced by** | the full pre-commit gate (`pnpm test`) run for Stage E32.2 of the wave-5 plan, on a tree whose diff is unrelated to this file |
| **Entry type(s)** | n/a — the defect is in the test harness, not in a stored entry. The file it lives in exercises `derived` types over the live corpus |
| **Severity** | P2 |
| **Status** | fixed in the working tree (uncommitted; the conservative git profile is in force) |

## What was found

Two in-repo facts about `packages/adapter-claude-code/test/derive-real-corpus.test.ts`, neither of
which is the machine being busy:

1. **The test that pays for the file's shared sweep is bounded at 120 s, while the same file gives the
   identical independent sweep 180 s.** The file memoizes one sweep (`let shared: Promise<Sweep> |
   undefined; const once = () => (shared ??= sweep());`), so the first test in the file pays for it and
   every later test awaits an already-resolved promise. The bound that reddens is therefore on the
   *payer* — and it is the tighter of the two bounds the file assigns to the same work.
2. **The file's own docblock states its cost and its corpus size as measured fact, and both are stale
   by a wide margin.** It says *"COST, stated plainly: one pass over ~1.2 GiB, roughly 7 s."* The corpus
   is 3.8 GiB and one sweep measures 69,451 ms.

The attribution problem is the part that made this hard to see: when the sweep exceeds the payer's
bound, the red is charged to whichever test happens to be running, and the *next* test inherits the
remainder of the same in-flight promise and reports that as its own duration. No single test's name
reflects what actually took ~169 s.

## How it surfaced

The gate for an unrelated stage came back red with a single failure:

```
FAIL  packages/adapter-claude-code/test/derive-real-corpus.test.ts > the deriver against the real corpus > derives entries that all satisfy their own definitions
Error: Test timed out in 120000ms.
```

**Nobody was looking for it.** The work in flight was `asc-pcu` (an event-time order mode for paging).
Nothing in that diff touches this file, and nothing was being measured about test bounds. The gate
handed it over unasked.

What made it visible rather than dismissible was reading the durations *around* the red instead of the
red alone. In the same gate run, the very next test in the file reported 48,743 ms for a body whose
only statement is `await once()` — 48.7 seconds to await a memoized promise is not a test doing work,
it is the tail of somebody else's. That number is what pointed at the shared `once()` and turned
"a test timed out" into a named mechanism.

This is the **fourth** occurrence of the corpus-bound class: `dogfood/0007` (2026-09-18, fixed by
lowering `maxForks` 12 → 6) → `dogfood/0063` → `asc-pcaw` / `EV-46` (2026-10-09, closed on acceptance
branch (B): an explicit decision to leave it) → here. It is the **first recorded failure of this
particular file**: `grep -c "derive-real-corpus" test-failures.log` returns `1`, and the single entry
is this one.

## The metric

**A single sweep, solo, at loadavg 30.14, nothing else of mine running** (per-test durations from
`npx vitest run packages/adapter-claude-code/test/derive-real-corpus.test.ts --reporter=json`):

| Test | Solo | Under the gate |
|---|---|---|
| `derives entries that all satisfy their own definitions` (pays the shared sweep; 120 s bound) | `69450.85670799999` passed | `120033` **timed out** |
| `repeats a key only across FILES, and drops nothing for want of an identity` | `0.24779100000159815` passed | `48743` passed |
| `produces keys that are stable across two independent sweeps` (its own 180 s bound) | `70663.78912500001` passed | `125698` passed |

The 0.25 ms solo is the confirmation of the mechanism: that test body is `await once()` on a promise
the previous test already resolved, so it costs nothing — and under the gate its 48,743 ms is the
remainder of the preceding test's sweep (120 + 48.7 ≈ 169 s for one sweep).

**The gate's own record** (`test-failures.log`, verbatim):

```
{"at":"2026-10-13T08:22:31.062Z","file":"packages/adapter-claude-code/test/derive-real-corpus.test.ts","test":"the deriver against the real corpus > derives entries that all satisfy their own definitions","duration_ms":120033,"error":"Test timed out in 120000ms.","loadavg":"37.59 42.15 42.65","run_tests":3407,"run_summed_ms":4499823}
```

**The corpus, measured**: `du -sh ~/.claude/projects` → `3.8G`. The file's docblock claims ~1.2 GiB.

**The two bounds, in the same file**: seven tests at `}, 120_000);` and one at `}, 180_000);`
(`grep -nE '^\s*\}, ?[0-9_]+\);'`).

**The fit**: 7 s × 3.2 (corpus bytes) × ~2.5–3 (ambient load on 12 cores, `hw.ncpu` = 12) ≈ 67 s,
against 69.5 s measured. Two factors multiplying, rather than either alone.

`n = 1` failure of this file, so the *rate* is not established and is not claimed — this is a
characterization of one red, and the mechanism is what generalizes.

## The pattern

**A bound that was priced against one factor, while the cost is the product of two.** `dogfood/0007`
priced 5x headroom against a corpus that grows every session and said so: *"The deadline will come
back. The corpus grows with every dogfooding session… The headroom bought here is 5x, not permanent."*
That prediction is now measured: the corpus grew 3.2x, and the machine's ambient load multiplies on
top of it.

`asc-pcaw`'s close reason corrects the *other* corpus file's diagnosis — *"The corpus did not grow past
the bound. The machine was oversubscribed."* — and that correction is right for the file it was measured
on. It does not transfer: for this file the corpus growth is live and measured, and the two factors
multiply rather than substituting for each other.

The sharper instance of the class, and the one that is purely in-repo: **the same file disagrees with
itself about how much the identical work is worth** — 120 s for the sweep-payer, 180 s for the
independent sweep. A bound that is tight relative to a sibling bound on the same operation will redden
first, under exactly the conditions where the sibling stays green.

## Why nothing else would have caught it

- **`tsc`, `eslint`, `vitest` and `align check` are all structurally blind to a number in a docblock**
  — the same blindness `dogfood/0065` records. `~1.2 GiB, roughly 7 s` type-checks, lints, and passes;
  nothing compares it to the corpus on disk.
- **The gate's own failure log could not have caught it alone.** It records the red with `loadavg`, and
  `asc-pcaw` already names the limit: `asc-5swk` / `dogfood/0071` — the log's loadavg *"cannot tell a
  busy machine from a quiet one carrying low-priority work."* The corpus-size factor is not in the log
  at all.
- **The solo run alone would not have caught it either.** Solo it *passes*, with a comfortable-looking
  ~50 s of headroom against 120 s. Only the pair — solo passing at 69.5 s and the gate reddening at
  169 s — shows that the headroom is negative precisely when the gate is running.
- **A review would plausibly have caught the 120-vs-180 mismatch**, and that is an argument for the
  fix: one `grep` for the bounds in a file settles it. Said plainly rather than claimed as a win.

## The fix

The owner chose the hoist over the one-line bound bump (2026-10-13). One sweep is now paid in
`beforeAll` under a named, measurement-derived budget, so no test body is charged for it at all:

- `const SWEEP_BUDGET_MS = 300_000` — ~1.8x the worst measured sweep (169 s under the gate) and
  ~4.3x the quiet one (69.5 s), with the derivation and the re-pricing instruction written into the
  constant's own docblock.
- The lazy `shared ??= sweep()` memo is gone. `let swept: Sweep | undefined` is assigned in
  `beforeAll(async () => { swept = await sweep(); }, SWEEP_BUDGET_MS)`, and `once()` becomes a
  synchronous accessor that **throws** if the assignment never happened rather than reading
  `undefined` — fail fast, and it makes the failure name itself.
- The stability test's own deliberate second sweep moves from `180_000` to the same
  `SWEEP_BUDGET_MS`, so the file stops disagreeing with itself about what the identical walk is
  worth. That internal inconsistency was the thing that reddened first.
- The seven test bodies that called `await once()` no longer await anything, so `async` came off
  them — `@typescript-eslint/require-await` caught all seven, which is the rule doing its job.
- The docblock's present-tense cost and corpus-size claims are replaced with the measured values,
  and the dated 2026-09-15 measurement above them is **left intact** as the history that shows the
  decay, rather than rewritten.

**The class sweep, per `dogfood/0065`'s lesson that a correction must reach every copy.** `grep -rn`
for `1.2 GiB` and `roughly 7 s` across `packages/`, `docs/` and this repo's Markdown found two other
sites, both deliberately left alone and named here rather than silently skipped:
`dogfood/0007` carries it as a **historical record and entries here are immutable**; and
`packages/cli/test/ingest.test.ts` uses it rhetorically (*"A test that silently swept 1.2 GiB of the
operator's own transcripts would be slow…"*), which reads as "however large the corpus is" rather
than as a measurement, so correcting it would be churn in a file unrelated to this finding. Neither
is a claim that the number is current.

## Consequences and constraints

- **The gate is commit-blocking and this red is not attributable to the diff that hit it.** Under the
  owner's decision of 2026-10-13 (`asc-pi5a`, option (a)) the live-corpus checks stay on the blocking
  path, so this will recur and will keep costing an 884 s gate run each time.
- **`asc-pcaw` is closed and its close reason is an owner decision, not an oversight.** Three
  pre-registered remedies were refuted by measurement there (serialized corpus project; bounded retry;
  load-aware guard). Nothing in this record reopens them. What is new is the internal inconsistency and
  the corpus-growth factor, neither of which that adjudication considered.
- **The corpus is live and grows without a ceiling.** Any fix that prices a bound against a measured
  duration inherits the same decay; the honest options are a bound priced with explicit slack, a budget
  derived at run time, or accepting the red.
- Nothing in this finding is a cleanup task: no stored entry is involved and nothing is immutable here.

## Links

- Bead: `asc-9pto`
- Prior art: `asc-pcaw` (closed), `asc-3x1`, `asc-9ac`, `asc-5swk`; `docs/evidence/EV-46.md`
- Dogfood series: `dogfood/0007`, `dogfood/0063`, `dogfood/0071`, `dogfood/0085` (this record)
- The stage whose gate reddened: `asc-pcu` (Stage E32.2, `IMPLEMENTATION_PLAN.md`)
