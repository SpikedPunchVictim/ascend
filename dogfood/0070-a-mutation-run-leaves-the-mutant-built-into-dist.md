# 0070 — A mutation run leaves the mutant built into `dist/`

| | |
|---|---|
| **Bead** | `asc-e9zm` |
| **Surfaced** | 2026-10-09 |
| **Surfaced by** | `pnpm mutate derive-key-identity`, then a dry-run of the built CLI against the real corpus during the `asc-hbxl` end-to-end check |
| **Entry type(s)** | none — the defect is in `scripts/mutate.mjs` and the test harness, not in a recorded type |
| **Severity** | P2 |
| **Status** | fixed in the working tree, uncommitted as of 2026-10-09 — see **Resolution** |

## What was found

`pnpm mutate <spec>` plants a mutant into a source file, runs the owning test file with
vitest, and restores the source. But those test files' `beforeAll` runs `tsc -b`, a full
project build that WRITES `dist/`. The runner restores only the source files it read and
verifies that restore by sha256 — the build output it caused, and cannot see, is left as a
build of the mutant. So a mutation run that reports *"killed by every named killer"* and
*"restored"* still leaves `packages/cli/dist/**` holding mutated code, and the next use of
the built CLI runs it.

This is an absence as much as a defect: **nothing rebuilds or checks the build output after a
mutation run.** A code review of `scripts/mutate.mjs` would not catch it, because the
mechanism lives in a *different* file — the `beforeAll` of the test the runner spawns.

## How it surfaced

Not by asking. The `asc-hbxl` verification plan called for a dry-run of the built CLI over
the real corpus, and the dry-run printed the mutant's warning sentence — the retired-suffix
text that the spec's M6 mutant plants. The first reading was "the change did not land"; the
source was clean, and only the build output was not. Then it was reproduced deliberately, in
six steps, and it was deterministic.

**Nobody was looking for it.** The question being asked was "does the deriver mint an id
free of `#`", and the stale build briefly answered a different one. What made it visible was
driving the *built artifact* rather than the test suite: `pnpm test` rebuilds at the start of
the run and hides it, so every earlier check in this session had been blind to it.

## The metric

The mechanism, measured on this tree, 2026-10-09. `dist/` grep is for the M6 mutant's own
string, `within a transcript and were disambiguated`.

1. Plant the mutant in `packages/cli/src/commands/ingest/claude-code.ts`.
2. Run the owning test — `npx vitest run packages/cli/test/ingest.test.ts -t "recognises two
   files carrying the SAME event"`. Result: `Tests  1 failed | 38 skipped (39)`.
3. Grep the build output: `grep -c "within a transcript and were disambiguated"
   packages/cli/dist/commands/ingest/claude-code.js` → `1`.
4. Restore the source only — what the runner does — then grep it: `0`. The source is clean.
5. Grep the build output again:
   ```
   855:            this.warn(`${String(counters.repeatedKeys)} event key(s) repeated within a transcript and were disambiguated with a #2 suffix (retired) ` +
   ```
   The mutant is still built into `dist/`.
6. `npx tsc -b`, then grep again → `0`.

The `pnpm mutate` run that opened this was itself green —
`6 mutant(s), 0 problem(s). Every named killer killed its mutant.` The false artifact is
produced by a *successful* run, which is what makes it worth a record.

**Honest size.** This is one measured instance, `n = 1`, well under `MIN_N` (20,
`packages/analysis/src/proportion.ts:50`) — an anecdote, and named as one. Whether the other
specs (`derive-accept`, `statement-count`, `types-capture`) do the same was NOT measured;
they target files whose owning tests also rebuild the tree, so the class is plausibly wider,
but that is inferred, not measured, and is stated as inference.

## The pattern

A restore that verifies a **partial** thing reads as full restoration. The runner's own
docblock already names this hazard one artifact over — *"a mutant left in the tree would be
reported as a kill it did not earn and would silently poison every later run"* — and then
verifies the source by sha256 while the artifact it caused sits unchecked. The class is
**"verified what I wrote, not what I caused"**: any step that writes a file and also *builds*
from it has two restores to do, and the second is the one nobody owns.

It is a near-miss of severity-zero: a false observation almost entered a verification record
as a product behaviour. It did not, because the built artifact was driven directly — which is
the argument for driving the product's own path, not the suite, before writing a number down.

## Why nothing else would have caught it

`pnpm test` rebuilds at the top of every run, so the suite is structurally blind to a stale
`dist/`: it repairs the artifact before it would notice it. The full quality gate likewise
starts with a build. The only thing that catches it is running the built binary *without*
building first, which no gate step does — and `align check` reads source, not `dist/`.

## Consequences and constraints

- Local and transient: a rebuild clears it, and the working tree's *source* is genuinely
  restored (step 4 measured `0`).
- Not covered by the runner's sha256 check, which is why a green mutation run does not imply
  a clean tree.
- The fix must also cover the OTHER test files that rebuild in `beforeAll`, not just
  `ingest.test.ts`; naming a single file's fix would leave the class open.

## Resolution

Fixed in `scripts/mutate.mjs`, in the working tree, 2026-10-09. The restore is two jobs and the runner
now does both: `restoreAll()` puts back the source bytes the run wrote, and a new `repairBuild()` then
runs the same incremental build the killers' `beforeAll` runs — `node
node_modules/typescript/bin/tsc -b` from the repo root, this repo's own compiler, no `npx`, no PATH
dependence, no network — so the build output is put back in agreement with the sources. It runs from
`main`'s `finally`, which every exit path already went through, **and** from the signal handler:
interrupting a hung killer is the likelier way to leave a mutant in `dist/`, so that path needed it at
least as much as a clean finish did.

A rebuild that FAILS is not folded into the green. It prints on its own line, and it fails the run, so
exit 0 now means *every named killer killed its mutant **and** the tree still builds*.

**Restoring the bytes `dist/` happened to hold was the alternative, and it was rejected.** It needs
every output directory enumerated, a deletion path for the files a build creates, and it restores a
*pre-existing* staleness rather than repairing anything — it restores correctly by luck. The hazard is
not that `dist/` differs from what it was; it is that `dist/` disagrees with the source. A rebuild
re-establishes that by construction, for every artifact, including ones nobody enumerated.

**The metric, re-run as the proof.** The six steps above were run as one `pnpm mutate
derive-key-identity`, and the step-3 / step-5 measurement repeated afterwards:

```
$ grep -c "within a transcript and were disambiguated" packages/cli/dist/commands/ingest/claude-code.js
0
```

It was `1` before this change. The run that leaves it `0` still reports `6 mutant(s), 0 problem(s).
Every named killer killed its mutant.` — with the repair said aloud, so its absence is visible too:

```
rebuild: node_modules/typescript/bin/tsc -b ok -- no build output is left holding a mutant
```

**The failure path was driven, not reasoned about.** A single file was added to `packages/analysis/src`
holding `export const buildBreakProbe: number = 'not a number';`, making the real `tsc -b` fail, and
the spec re-run against it. Measured output:

```
rebuild: FAILED -- node_modules/typescript/bin/tsc -b exited 2, so the tree does not build and
  packages/*/dist may still hold a build of a mutant. The verdict above is not trustworthy
  until it does, and the built CLI must not be run.
  packages/analysis/src/__build-break-probe.ts(4,14): error TS2322: Type 'string' is not assignable to type 'number'.

5 mutant(s), 0 problem(s). Every named killer killed its mutant, but the run left the tree unbuildable.
```

`5 mutant(s), 0 problem(s)` — every killer killed its mutant — and the run still **exits 1**. That is
the whole point: the green was true and insufficient, and the run says so. The probe was deleted
immediately after; `tsc -b` then reported `No errors found`.

**The class, measured rather than inferred.** "Consequences and constraints" above says the other
specs "also rebuild the tree, so the class is plausibly wider, but that is inferred, not measured."
Measured 2026-10-09 by reading each spec's killer files for a `beforeAll` that invokes `tsc`: of the
four specs, **2** leave `dist/` holding a mutant — `derive-key-identity`, through `ingest.test.ts`, and
`types-capture`, through `types-capture.test.ts:27`, which is the same `execFileSync(process.execPath,
[…typescript/bin/tsc, '-b'])` from the repo root as `cli.test.ts:35` — and **2** do not:
`derive-accept` and `statement-count` both kill through pure unit tests that never build. The repair
is unconditional, so it covers the second pair at the cost of one wasted build rather than leaving a
silent gap.

**The new assertions are mutation-tested**, because a check added to the instrument every other check
rests on is the last one that should go untested. `scripts/mutations/mutate-build-repair.json` plants
five mutants in `scripts/mutate.mjs` — swallow a failed repair into a green verdict, drop the
instruction the message exists to give, keep the *first* lines of the build output instead of the last,
stop naming what the success line claims, stop labelling the failure — and each is killed by a named
test in `scripts/mutate-core.test.ts`.

**Honest limits.** The repair is a `tsc -b`. If this repo's build ever stops being `tsc -b`, the repair
degrades to a no-op that still exits 0, and no test here would notice, because the runner would be
faithfully running a build that no longer produces the artifact the killers spawn. What is measured
about the other three specs is their `beforeAll`, not their behaviour end to end. And a repair that
succeeds is proven to leave *no mutant in `dist/`*; it is not proven to leave the identical bytes that
were there before, which it does not — it leaves a build of the restored source.

## Links

- Bead: `asc-e9zm`
- Surfaced during: `asc-hbxl` (the change that retired the `#2` suffix)
- Evidence record: `docs/evidence/EV-45.md` (the measurement the same spec's change rests on)
