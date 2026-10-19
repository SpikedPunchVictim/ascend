# 0121 — a probe that believed HOME isolated the store

| | |
|---|---|
| **Bead** | `asc-zvzx` |
| **Surfaced** | 2026-10-15, while writing `asc-09wx.8.5`'s integration tests |
| **Surfaced by** | a throwaway probe that was supposed to be harmless, and `asc types brief` afterwards |
| **Entry type(s)** | `intervention` (the one that was written by accident) |
| **Severity** | P2 |
| **Status** | fixed — `asc record` now names the store it wrote to |

## What was found

The probe ran from this repository's root with `HOME` pointed at a fresh `mktemp -d`, on the belief that
`HOME` isolates the store. It does not: the project root is found by walking **up** from `process.cwd()`,
so the probe recorded into `.ascend/entries/intervention-61c12e2ee039/0001.jsonl` —
id `d4662211-42c2-49a1-a912-17b31324473b`, `status applied`, `grading_point 1`.

The damage is not the row. It is that `asc types brief` then printed a **`grade owed:` line for it** —
a permanent false signal, because the row can never honestly be graded and nothing can remove it.

## How it surfaced

**Nobody was looking for it.** The probe's output looked exactly like a working isolated probe. The
row surfaced afterwards, as a line in a brief that had nothing to do with the probe.

## The metric

- **1** entry written into a tracked file by a probe that was meant to write nowhere.
- **12,350** records re-indexed to repair it (`asc index build`, fingerprint `f46caf90.df`), and
  `asc store verify` passes afterwards.
- The repair was: filter the line out of the tracked JSONL by hand, then rebuild. Nothing said so at
  the moment the probe went wrong, because the record tree is editable and the index is derived —
  which is correct, and undocumented at the point of use.

`n = 1`: one probe, one machine. An anecdote under `MIN_N`; what it establishes is the mechanism.

## The pattern

**The command's output did not say which store it wrote to.** Every input to the mistake was a fact
the tool knew — the resolved root, the store directory — and none of it appeared anywhere in what the
probe printed. A write is the one direction that cannot be undone by the caller, and it was the
direction that reported the least about itself.

## The fix

`asc record` now sets `store` on its output: the JSON envelope carries `store: "/…/.ascend"`, and the
table starts with the same line. It is additive — no `OUTPUT_CONTRACT_VERSION` bump — and no other
command sets it, because no other command writes.

## Links

- Bead: `asc-zvzx`
- The same class from the hook side: `dogfood/0101` (a value that turns every hook off, silently)
