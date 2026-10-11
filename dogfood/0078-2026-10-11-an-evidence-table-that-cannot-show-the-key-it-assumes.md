# 0078 — an evidence table that cannot show the key it is cited for

| | |
|---|---|
| **Bead** | `asc-s05g` |
| **Surfaced** | 2026-10-11 |
| **Surfaced by** | spiking `asc-xn4g` Stage 0, which needs `transcript_path` at the tool stage |
| **Entry type(s)** | none — the finding is about an evidence document, not about a stored entry |
| **Severity** | P2, matching the bead |
| **Status** | open |

## What was found

`spike/capture-hooks/FINDINGS.md` is the document `packages/adapter-claude-code/src/hook-input.ts`
cites as the authority on what a hook input carries. Its central table is printed by a line that
computes `Object.keys(e).filter((k) => !BASE.includes(k))` against a literal

```js
const BASE = ['session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir',
  'permission_mode', 'effort', 'hook_event_name'];
```

`transcript_path` is in `BASE`. A key in its own exclude list can never appear in the output, so
the line **cannot distinguish "the harness sent `transcript_path`" from "nobody looked"** — and it
is the one line a reader would take as an enumeration of what arrives. The underlying fact turned
out to be true; the defect is that this document could not have told anyone so.

`spike/exposure/capture-probe.mjs` carries the same filter, so the exposure spike has the same
blind spot.

## How it surfaced

**Nobody was looking for it.** The spike I set out to run was a different one — whether
`transcript_path` reaches the tool stage — and I went to this document expecting to find the answer
already recorded, because `hook-input.ts`'s docblock names it as the source.

What made it visible was reading the *generator* rather than the *result*. The table is convincing
in isolation. It stops being convincing one file over, where `keys+` is defined: the notation
`keys+=[...]` already says "beyond a baseline", and the baseline is a hand-written assumption the
output never tests. The mechanism is worth naming because it repeats: **a measurement whose
display is a delta against an unverified constant reads as a total.**

The corrected measurement, for the record, is in `spike/hook-input-keys/FINDINGS.md`: two live
runs, `transcript_path` present at SessionStart and UserPromptSubmit with the file existing at hook
time, and the key documented as a common field on every event.

## The metric

| value | how obtained |
|---|---|
| 8 | keys in `BASE`, each structurally unable to be printed by the `keys+` line (`spike/capture-hooks/probe.mjs:65`) |
| 1 of those 8 | the key (`transcript_path`) that `hook-input.ts` cites this document for |
| 2 | occurrences of the same filter, in `spike/capture-hooks/probe.mjs:69` and `spike/exposure/capture-probe.mjs:38` |
| 0 of 7 | events whose `transcript_path` the original run could have shown (7 = the 6 event rows plus the subagent repeat in its output block) |

The last row is the finding in one number, and it is not an estimate: the filter is
`!BASE.includes(k)`, so the count of BASE keys the output can show is zero by construction, not by
outcome. **`n = 2` runs behind the original spike is under `MIN_N` (20,
`packages/analysis/src/proportion.ts:50`), so its own results are an anecdote** — which the document
says plainly, and which is the point: it is careful about its sample size and silent about its key
set.

No corpus-wide count is claimed. How many other spike documents print a delta against an unchecked
constant was **not measured** — a grep would count textual matches, not documents with the defect.

## The pattern

**A check that cannot fail is not a check.** This is the same class as `dogfood/0076` (a killer name
matched as a regex, so a name with a metacharacter matched nothing) and `dogfood/0075` (guidance
stranded on a superseded type version, undetected): an instrument whose result is consistent with
both the good and the bad case. Here the instrument is a printed key list whose display excludes
the keys it exists to confirm.

The narrower instance is worth naming separately because it is what fooled me: **an assumption
rendered as silence rather than as a satisfied-or-violated marker.** `BASE` is a claim about the
world printed nowhere. Had the line printed `transcript_path: present|ABSENT` per event, the same
run would have carried the answer and this record would not exist.

## Why nothing else would have caught it

Nothing in the tree consumes this document programmatically — it is prose plus a pasted output
block, so no test can fail on it, and `spike/` is not covered by the lint or format gates beyond
parsing. A reader would have to do what I did: move from the table to the code that prints it,
which is one file away and which nobody has a reason to open once the table looks complete.

Saying so plainly: **a reviewer reading only `FINDINGS.md` would not catch this, and should not be
expected to.** The remedy is not more review; it is to make the instrument print the assumption.

## Consequences and constraints

- **The record is immutable.** `spike/capture-hooks/FINDINGS.md` documents a run that happened, and
  its output block is what that run printed. It must **not** be rewritten to look as though it
  measured the key set. A corrected table comes from a new run, and the new run is
  `spike/hook-input-keys/`.
- **The fix is in the generator**, both copies, since a new run of the same probe would reproduce
  the same blind spot.
- **The blast radius is bounded and known:** two files, both under `spike/`. The one document that
  cites it, `hook-input.ts`'s docblock, cites it for the *event×field* survey, which the run does
  establish; the key set was never what it was cited for.

## Links

- Bead: `asc-s05g`
- The corrected measurement: `spike/hook-input-keys/FINDINGS.md`
- Sibling findings of the same class: `dogfood/0075`, `dogfood/0076`, `dogfood/0077`
- The document itself: `spike/capture-hooks/FINDINGS.md`
