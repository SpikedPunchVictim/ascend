# 0084 — a stale anchor crashes the mutation runner instead of being refused

| | |
|---|---|
| **Bead** | `asc-38ss` |
| **Surfaced** | 2026-10-12 |
| **Surfaced by** | `node scripts/mutate.mjs annotate-replay` after `prettier --write` rewrapped the anchored line |
| **Entry type(s)** | none — the instrument is not an event source |
| **Severity** | P2 |
| **Status** | open |

## What was found

`pnpm mutate` throws an uncaught `TypeError` when a mutant's `find` anchor no longer occurs in its
target file, instead of reporting that mutant `NOT APPLIED` and the reason it has. The reason already
exists and is already correct: `applyMutant` returns ``{ ok: false, why: '`find` occurs 0 times' }``,
and its own test pins that exact string. It is the *caller* that loses it — `runMutant`'s docblock
declares `@returns {Promise<{ row: string[], failed: boolean, notes: string[] }>}`, its not-applied
early return omits `notes`, and `main` spreads `result.notes` on every result unconditionally.

The consequence is larger than one missing key. The crash lands *before* the verdict table is printed,
so a run in which fifteen mutants were measured and one anchor had drifted reports nothing at all —
not the fifteen verdicts it holds, not the one row that would have named the problem. A refusal the
runner is designed to make arrives at the caller as a stack trace.

## How it surfaced

Not from reading the runner. From running it, on the last step of a finished feature, which is the
step this repo's own convention requires: *"a finished feature gets a mutation spec, and `pnpm mutate`
runs it."*

The sequence was ordinary. A seven-mutant spec for `asc-cx9w` was written and its killers found
empirically; `pnpm format:check` then failed on the two changed source files; `prettier --write` fixed
them, and in doing so **rewrapped the line M1 anchored on** from one line to three. Re-running the
spec produced:

```
TypeError: result.notes is not iterable (cannot read property undefined)
    at main (/Users/spikedpunchvictim/projects/ascend/scripts/mutate.mjs:744:15)
```

**Nobody was looking for it.** The question on the screen was whether the replay spec was green, and
the answer that came back was about a property of an object three frames away from anything the spec
said. Nothing was being audited; the runner was being used the way it is meant to be used, and it
broke on the second-most-common thing that happens to a spec after it is written.

## The metric

Reproduced deterministically, with a **one-mutant copy** of `scripts/mutations/median-of.json` whose
`find` was edited from `/ 2;` to `/ 3;` so that it occurs zero times, run against a clean tree:

```
$ node scripts/mutate.mjs /tmp/asc-cx9w-stale-find.json
file:///Users/spikedpunchvictim/projects/ascend/scripts/mutate.mjs:744
        notes.push(...result.notes);
                             ^

TypeError: result.notes is not iterable (cannot read property undefined)
    at main (file:///Users/spikedpunchvictim/projects/ascend/scripts/mutate.mjs:744:15)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async file:///Users/spikedpunchvictim/projects/ascend/scripts/mutate.mjs:793:42

Node.js v24.18.0
```

`echo $?` → **1**. No verdict table is printed. The target file is restored (`shasum -a 256
packages/analysis/src/median.ts` → `20cf7bdf8e7220a9a7036d3f182442c5d17cf958e4049fca010c8a0afdbc8a19`,
unchanged) and the lockfile removed (`.mutate.lock: No such file or directory`), because both run in
the `finally` — **the run is clean; only its report is missing.**

**How close the class is to firing, measured over every spec in the repository:**

```
specs=22
mutants=149
target files=32
anchors occurring 0 times=0
anchors occurring >1 time=0
```

**Zero of 149 anchors are stale today**, so the whole class is latent: no current fixture makes the
crash reachable, which is why it has never been seen before and why no test would have been written
from the corpus as it stands. The trigger is not staleness arriving on its own — it is any rewrite of
a target file that moves the anchored text, and a formatter is the ordinary way to get one.

**Why no type checker saw it, measured rather than assumed:** `runMutant`'s `notes: string[]` is
declared in JSDoc, and JSDoc is inert here. `tsconfig.eslint.json` includes `scripts/**/*.mjs` with
`checkJs: false`, and the `pnpm typecheck` build (`tsconfig.json`) references only the five packages —
`core`, `analysis`, `store`, `adapter-claude-code`, `cli` — so `scripts/` is outside the build
entirely. The missing property was declared, unchecked, and never constructed by any test:
`scripts/mutate-core.test.ts` exercises `applyMutant`, which is the function that is correct.

## The pattern

**A guard that refuses correctly and a caller that cannot receive the refusal.** The behaviour under
test was right; the *shape* of the return was wrong; and because the wrong shape was only reachable on
a path no test constructs, the error surfaced as a crash in the reporting code rather than as the
refusal it was.

This is the third face of the same class, and the series now has all three:

- `dogfood/0076` — a *zero* that came from the pattern matching the wrong tests (a regex).
- `dogfood/0080` — a *zero* that came from the mutant failing to compile, reported under the name of
  the other cause.
- `0084` — no zero at all: the mutant is refused correctly, and the refusal has nowhere to go.

The portable form: **a refusal is only as good as the contract that carries it.** Where `applyMutant`
is a pure function whose `ok: false` branch is well tested, its consumer's declared return type is a
claim about *every* path, and one path not honouring it converts a clean refusal into an uncaught
exception at the point where the report is assembled.

## Why nothing else would have caught it

**The type checker was configured not to see `scripts/`**, and that is a fact about the build, not an
oversight to be blamed on this fix. `checkJs: false` on the one config that includes the directory,
and a `tsconfig.json` that references only packages, together mean every JSDoc `@returns` in
`scripts/mutate.mjs` is documentation.

**`scripts/mutate-core.test.ts` would plausibly have caught it — and is the honest argument for a
test.** It already has, four cases deep, a describe block for `applyMutant` including the
zero-occurrence refusal. What it does not have is one assertion that *consumes* a refusal through
`runMutant` and checks the shape that comes back. The gap is one level up from where the tests look,
and the fix direction is to close it there: `runMutant` over a spec whose `find` occurs 0 times must
return a result carrying `notes`, and the run must print `NOT APPLIED` for it and still exit nonzero.

**A code review would not have caught it**, because nothing about the early return looks wrong on the
line it is written — `return { row: [...], failed: true };` is a complete-looking object literal, and
the property missing from it is declared sixty lines above in a comment.

## Consequences and constraints

The run itself is safe: the `finally` restores the source and repairs the build on this path exactly
as on the others, so a crashed run cannot leave the tree mutated or `dist/` stale. The damage is
confined to the report, which is the part a person is reading.

This is `asc-5swk`'s neighbourhood (*"the failure log that exists to name a rare red is drowned by
mutation runs"*) without being the same defect: 0084 is not noise in a log, it is the absence of the
verdict table a person is waiting on.

## Links

- Bead: `asc-38ss` (P2, open)
- Prior faces of the class: `dogfood/0076` (`asc-hs7p`), `dogfood/0080` (`asc-5sdw`), `dogfood/0070`
  (`asc-e9zm`)
- The spec whose anchor drifted: `scripts/mutations/annotate-replay.json` (`asc-cx9w`)
- Reproduce: `/tmp/asc-cx9w-stale-find.json`
