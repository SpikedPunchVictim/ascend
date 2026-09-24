# 0015 — `prettier --write` is recorded as a verification run

| | |
|---|---|
| **Bead** | `asc-6ola.15` |
| **Surfaced** | 2026-09-24 |
| **Surfaced by** | `asc handlers check handlers/edit-verified.yaml`, reading which runners verified an edit |
| **Entry type(s)** | verification_run (derived); the `check.run` event (normalized) |
| **Severity** | P1 |
| **Status** | open |

## What was found

The check rule (`checkRun`, `packages/adapter-claude-code/src/derive.ts`) takes bare `prettier` as
a check runner whatever its flags. So `prettier --write` is recorded as a check: it is a
formatting step that rewrites files, yet it becomes a `verification_run` entry, verdict
`passed` on exit 0, and a `check.run` event that any handler reads as "a check ran here".
`--write` does fail on a file it cannot parse, so it is not an empty check. But a passed
`--write` records verification that did not happen.

## How it surfaced

asc-6ola.7 asks how often an edit reaches the next prompt with no check run after it. Its
companion handler, `handlers/edit-verified.yaml`, emits the runner of the first check after each
edit. Grouping those runners to sanity-check the verified side put `npx prettier` (198) and
`prettier` (124) among the top runners. Nearly all of this project's prettier invocations
are `--write` from the pre-commit formatting routine, which made the count implausible.

Nobody was looking for it. The question was about edits, and the handler's own output was
read as a check on it.

## The metric

The first-check runners over the frozen corpus (`eu-analyze`-style grouping of
`asc handlers check ... --samples 1000000 --json`):

```
[["pnpm format:check",485],["pnpm typecheck",467],["pnpm build",324],["npx vitest",303],["vitest",250],["npx prettier",198],["tsc",163],["prettier",124],["npx tsc",117],["npx eslint",53],["pnpm lint",33],["pnpm test",30],["pnpm tsc",21],["npx align",8],["eslint",7]]
```

The `check.run` events with a prettier runner on the frozen corpus, this project, classified by
the argv of every segment of the same Bash call:

```
prettier check.run: 203 {"write":135,"check":68,"neither":0}
```

(A first pass keyed each call by its last segment only and printed
`{"write":4,"check":39,"neither":160}`. That was the probe's error, not the data's.)

The store's prettier `verification_run` v2 entries, joined by tool_use id to the live
transcripts:

```
runner        verdict_state  verdict  n
------------  -------------  -------  --
npx prettier  measured       passed   39
npx prettier  measured       failed   21
prettier      measured       passed   20
prettier      measured       failed   3
```
```
store prettier entries: 83 {"write passed":29,"check/other passed":6,"check/other failed":13,"transcript gone passed":24,"transcript gone failed":5,"write failed":6}
```

The store holds 1,189 `verification_run` v2 rows (`select count(*) from v_verification_run_v2`).
35 of the 54 prettier rows that can still be joined are `--write`. The 29 whose transcript is gone
cannot be classified, so no share is claimed for them.

The effect on asc-6ola.7's own question is small. With `--write` runs dropped before the
handler sees them, the unverified share moves from 13.7% to 14.6% (EV-23):

```
as derived: unverified 411/2994 = 13.7% (code paths 266), triggers 3046, unclosed 52
prettier --write dropped: unverified 437/2991 = 14.6% (code paths 282), triggers 3046, unclosed 55
```

## The pattern

A tool that shares a check's name, used in a mode that changes files rather than checking them.
The rule matches the program and ignores the mode. The same shape probably exists for
`ruff format` and `ruff check --fix`. `eslint --fix` still exits non-zero on what it cannot fix,
so it is probably a real check. `BARE_RUNNERS` is the list to audit.

It is the "reports success wrongly" class. A passed `verification_run` is a claim that something
was verified.

## Why nothing else would have caught it

The check rule's tests pin labels and verdict sources. None asks whether a labelled run
examines anything. The derive-rule measurements in `derive.ts` counted segments and entries, not
what the matched programs do. A test that fed `prettier --write` to `checkRun` would have caught
it, if anyone had thought to write one. Nobody had.

## Consequences and constraints

Entries are immutable, so the existing rows stay. The fix is at derivation: a
`derivationVersion` bump for `verification_run`, plus an invalidation annotation for the rows
already written. `check.run` carries `derive_version`, so handler results computed before the fix
remain distinguishable.

## Links

- Bead: `asc-6ola.15` (found under `asc-6ola.7`)
- Evidence record: `docs/evidence/EV-23.md`
