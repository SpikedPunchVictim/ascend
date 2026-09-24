# 0015 — `prettier --write` is recorded as a verification run

| | |
|---|---|
| **Bead** | `asc-6ola.15` |
| **Surfaced** | 2026-09-24 |
| **Surfaced by** | `asc handlers check handlers/edit-verified.yaml`, reading which runners verified an edit |
| **Entry type(s)** | verification_run (derived); the `check.run` event (normalized) |
| **Severity** | P1 |
| **Status** | fixed in the asc-6ola.15 commit; store re-derived and v2 retired 2026-09-24 (see **Resolution**) |

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
~~35 of the 54 prettier rows that can still be joined are `--write`. The 29 whose transcript is
gone cannot be classified, so no share is claimed for them.~~

**Corrected the same day.** The "transcript gone" figure was the probe's error. It took the tool
call id as the text after the last `toolu_`, but 27 of the 83 ids are `call_…` ids, and one has
a `#2` duplicate-key suffix. With the id taken as the text after the last `:`, all 83 join:

```
store prettier entries: 83 {"write passed":53,"check/other passed":6,"check/other failed":14,"write failed":10}
```

That still classifies by command text, and a command that runs both `prettier --write` and
`prettier --check` is not a write for its entry. The accurate count comes from the re-derivation
(see **Resolution**). Of the 83, 44 came from a `--write` segment: 35 were re-read as the later
check in the same command (`pnpm format:check` 17, vitest 12, tsc 4, eslint 1, lint 1), and 9
derive nothing under the fixed rule. 38 were real prettier checks and re-derived unchanged. 1 was
a real `prettier --check` whose transition came from a `--write` earlier in its chain.

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

## Resolution

`checkLabel` now counts prettier only with `--check`, `-c`, `--list-different` or `-l`
(`CHECK_MODE` in `derive.ts`). Without one, the segment is not a check, and a later check in the
same command is found instead. `verification_run` is at derivation 3 and `EVENT_DERIVE_VERSION`
is at 2. `ruff format` would need the same treatment; the corpus runs ruff zero times, so it is
named in the comment and not coded.

The re-ingest (`asc ingest claude-code --full`, 2026-09-24), exact:

```
entry   verification_run    1193 new
```

Old rule (HEAD's adapter, built in a worktree) against the new one, over the same live corpus:

```
old 1202, new 1193 {"both_same":1154,"both_changed":36,"old_only":12,"new_only":3}
old-only by runner {"npx prettier":10,"npx eslint":1,"npx tsc":1}
```

The eslint and tsc rows are the chain effect. An entry is written only on a first pass or a
verdict change, and the chain runs per file, so dropping a `--write` "pass" from a chain can
erase a later run's transition. The v2 rows were then retired by `spike/verdict/retire-v2.mjs`
in one transaction. Rows with no v3 sibling were invalidated only when the old rule still
derives them and the new rule does not:

```
v2 open 1189, v3 1193 {"superseded_same":1142,"superseded_changed":35,"wrong_value":8,"chain_changed":3,"transcript_gone":1,"unexpected":0}
wrote 1188 of 1188 invalidation(s)
```

Afterwards, by derivation:

```
v2||1
v2|superseded|1177
v2|wrong_value|11
v3||1193
```

The one row left open was not an orphan: it is the `#2` duplicate-key copy of a `--write` row
the script had just invalidated, and the script read its suffix as a missing transcript. It was
invalidated by hand, `wrong_value`, with the reason saying so, and the script now strips the
suffix. The final state, exact:

```
v2|superseded|1177
v2|wrong_value|12
v3||1193
```

The v3 prettier rows are all check-mode by construction: 40 in all (`npx prettier` 25 passed, 12 failed; `prettier` 2 passed, 1 failed).

## Links

- Bead: `asc-6ola.15` (found under `asc-6ola.7`)
- Evidence record: `docs/evidence/EV-23.md`
