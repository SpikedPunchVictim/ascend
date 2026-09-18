# 0001 — `asc explore` reports proportions as bare counts

| | |
|---|---|
| **Bead** | `asc-5x7` |
| **Surfaced** | 2026-09-17 |
| **Surfaced by** | A pre-registered prediction (EV-19, P5) tested against `asc explore tool_denial --json` |
| **Entry type(s)** | `tool_denial` (derived) |
| **Severity** | P1 |
| **Status** | open |

## What was found

**This is an absence, not a malfunction.** `asc explore` — the command whose entire purpose is
profiling a type, and the first one a user runs — prints every proportion as a bare count. No
confidence interval, no `n`, no flag when a group falls under `MIN_N`. A reader of the shipped
profile cannot tell an estimate from an anecdote.

The machinery to do it already exists and is already used elsewhere in the same binary.
`packages/analysis` exports `wilson()`, `isSmallGroup()` and `MIN_N`; `packages/cli/src/output.ts`
exports `renderProportion()`, which renders the fully qualified form including `n=0 (no estimate)`
for a null. **`explore` simply never calls it.**

## How it surfaced

EV-19 was pre-registered — question and five numbered predictions committed (`b4f4049`) before any
measurement ran, so that each could be marked hit or missed rather than reinterpreted. P5, written
before looking:

> The shipped `asc explore` reports tallies as bare counts, without the Wilson intervals or the
> `MIN_N` anecdote flag EV-3 treated as mandatory — so a reader of the shipped profile cannot tell
> an estimate from an anecdote.

This one was *suspected* rather than stumbled upon, which makes it the least characteristic finding
in this series — but it was suspected from having just built `--backtest` and noticed the contrast,
which is itself a dogfooding effect. The prediction was then confirmed by inspection, not assumed.

## The metric

`asc explore tool_denial --json` searched for every key that could carry an interval:

| key | present |
|---|---|
| `lower` | no |
| `upper` | no |
| `confidence` | no |
| `wilson` | no |
| `interval` | no |
| `proportion` | no |
| small-group / anecdote flag | no |

Its rows carry exactly two keys: `field` and `value`. So the profile prints, for example,
`automode-blocked 36` — 36 of 564 — with nothing stating how certain that is.

The same EV-19 run's `asc annotate --backtest`, over the same entries, emitted:

```
0.0% (95% CI 0.0-43.4%, n=5) [...treat as anecdote, not estimate]
```

Both numbers describe the same corpus. One is qualified; one is not.

## The pattern

**A discipline adopted in one command and not propagated to its siblings.** The project decided
intervals were mandatory, implemented them where they were freshly on someone's mind
(`--backtest`, built the same day), and left the older, more-used command untouched. The defect is
not a wrong line of code — it is a *call that does not exist*, which is why it is invisible to
review and to tests.

It generalizes: any capability added late is worth grepping for across every command that should
have had it from the start.

## Why nothing else would have caught it

- **Not a test failure.** Nothing asserts that `explore` reports intervals, because nothing ever
  decided it should. Tests encode intentions, and this intention was never written down.
- **Not a review finding.** The `explore` code is correct for what it does. The defect is only
  visible by comparing it against a *different* command's output over the same data.
- **Not a type error.** `renderProportion()` being uncalled is legal.

It took having both outputs side by side on a real corpus, which is what dogfooding produced.

## Consequences and constraints

None blocking. This is additive: `explore` gains the qualified form the rest of the CLI already
uses. Worth deciding once and applying everywhere rather than patching `explore` alone — the point
of the finding is the inconsistency, not the one command.

The stakes are set by EV-3, which made intervals mandatory for a measured reason: its most
statistically seductive result was an association at **χ²=153.11, p=8.61e-8** that its shuffled
control exposed as an artifact of the marginals. EV-3's own words — *"The asymptotic test alone
would have shipped a false finding."*

## Links

- Bead: `asc-5x7`
- Evidence record: `docs/evidence/EV-19.md` (prediction P5, confirmed)
- Prior art: `docs/evidence/EV-patterns.md` (EV-3), which established the discipline
