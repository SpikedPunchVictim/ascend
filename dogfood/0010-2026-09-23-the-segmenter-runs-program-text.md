# 0010 — the segmenter reads program text as commands

| | |
|---|---|
| **Bead** | `asc-7gz2` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | spike `asc-bolz`, eyeballing the `command.run` head distribution before trusting a matcher |
| **Entry type(s)** | `verification_run` (derived), potentially |
| **Severity** | P2 |
| **Status** | open |

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

## Links

- Bead: `asc-7gz2`; spike `asc-bolz`, `spike/replay/FINDINGS.md`
