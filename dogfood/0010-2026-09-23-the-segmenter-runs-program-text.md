# 0010 — the segmenter reads program text as commands

| | |
|---|---|
| **Bead** | `asc-7gz2` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | spike `asc-bolz`, eyeballing the `command.run` head distribution before trusting a matcher |
| **Entry type(s)** | `verification_run` (derived), potentially |
| **Severity** | P2 |
| **Status** | fixed in `a755937` (`verification_run` derivation 4); live store migrated |

## What was found

`execSegments` (`packages/adapter-claude-code/src/derive.ts`) ends a command at every newline,
including newlines inside a quoted argument. The body of a multi-line `node -e '…'` or
`python3 -c "…"` is therefore segmented into "commands" whose heads are JavaScript or Python
tokens.

## How it surfaced

Spike `asc-bolz` replayed the frozen transcript corpus through `execSegments` to build a
`command.run` event per segment. The run produced 525,502 `command.run` events from 110,463 tool
calls. The ratio looked wrong, so the heads were counted before any matcher was trusted, following
the repo rule "never trust a matcher whose output you have not eyeballed". Nobody was looking for
this. The spike was about `stage_transition` and `search_miss`.

## The metric

Head counts over all 1,007 frozen files, exact output:

```
[('echo', 76317), ('grep', 61092), ('head', 35737), ('sed', 30254), ('tail', 18438), ('git', 17001), ('python3', 13465), ('cat', 13308), ('node', 12129), ('const', 10438), ('ls', 7024), ('for', 6843), ('cut', 6365), ('"', 5245), ...
bash calls 88494 max segs [('toolu_01W2RETHmHN44vFDTf3ZAmVv', 155), ...
```

`const`, `"` and `}` (3,170) are not commands. The effect on stored `verification_run` entries is
**not measured**.

## The pattern

A tokenizer that is correct for the case it was tested on (heredoc bodies, which the rule already
excludes) and wrong for a sibling syntax (quoted multi-line arguments). This is the same class as
`readline-is-not-a-jsonl-reader`: a line-oriented reader whose idea of a line differs from the
format's.

## Why nothing else would have caught it

`verification_run` asks whether a *check token* heads a segment. Program text rarely starts a line
with `pnpm test`, so the stored count is probably barely affected, and no test compares segment
counts with call counts. The defect shows only when every segment becomes an event.

## Consequences and constraints

Entries are immutable. If measurement finds fabricated `verification_run` rows, the response is
an invalidation annotation plus a fix at write time, not deletion.

## Resolution

The segmenter now reads the shell's quoting, which it did not do before:

- A newline inside a quote no longer ends a command. Physical lines are joined while a quote is
  open.
- Quoted characters are masked before splitting on `;`, `&&`, `||` and `|`, so an operator inside
  program text is not a boundary.
- A `#` that starts a word ends the line.
- A heredoc opener is found in the masked text, and its tag is read from the real text, so
  `<<'EOF'` is still recognised.
- A step that runs `sh -c '…'` (or `bash -c`) is replaced by the steps of its script. The last of
  those inherits the outer step's operator.

**The metric.** The same frozen set of 99,553 Bash commands was run through `checkRun` and
`execSegments` before and after (`measure.mjs`, scratchpad, not committed). The exact output:

```
before  commands 99553
        segments 606875 checks 8687 max segs 163
        heads const/"/} 10809 5520 3290
after   segments 434263 checks 8638 max segs 102
        heads const/"/} 3 7 865
        [ [ 'check LOST', 49 ], [ 'ownership false->true', 5 ] ]
```

- **Checks lost: 49.** Every one of them is a check token inside program text or quoted
  arguments, so none was a real run. No checks were gained.
- **Ownership false→true: 5.** In these 5, a `;` inside quotes had split a chain, which hid the
  call that really owns the exit status.
- **`sh -c`: 6 real runs.** The first quote-aware pass lost 6 real runs inside `sh -c` scripts,
  which is why `sh -c` is now expanded. After that change, all 6 are kept.
- **The `}` heads (865)** that remain were not characterised. A shell group or function body
  also ends with a lone `}`, so they are not all program text, but no count separates the two.

**The live store.** `ingest --full` wrote the v4 rows. Then:

- 1,225 v3 rows with an identical v4 twin were invalidated as `superseded`, each pointing at its
  twin (dry run `ok=1225 failed=0`, then write `ok=1225 failed=0`).
- 1 row was invalidated as `wrong_value`. In it, a `;` inside a `perl -e` script had credited
  `npm run build` with a status that an earlier call owns.
- 17 v3 rows are left open. Their transcripts have been deleted, so there is nothing to re-derive
  them from, and they cannot be shown wrong.

Read back afterwards with `asc query`:

```
v                   n     invalidated
------------------  ----  -----------
verification_run@2  1189  1189
verification_run@3  1243  1226
verification_run@4  1231  0
```

The v4 row with no v3 counterpart is one this session wrote after the migration.

## Links

- Bead: `asc-7gz2`; spike `asc-bolz`, `spike/replay/FINDINGS.md`
