# 0077 — A `file:line` citation points at another line, and a wrong pointer reads exactly like a right one

| | |
|---|---|
| **Bead** | `asc-3sfk` |
| **Surfaced** | 2026-10-11 |
| **Surfaced by** | Checking whether an edit of mine had invalidated the citations pointing into `packages/core/src/handler.ts` |
| **Entry type(s)** | none — the defect is in the repo's comments, not in the store |
| **Severity** | P2 |
| **Status** | open; recorded, not swept |

## What was found

Comments in this repo cite source by `path:line`. Nothing reconciles the number with the line it
names, so a citation is correct only until the next edit above it, and after that it points
somewhere else **with no change to its text**.

That is the whole defect, and its cost is not the wrong number. It is that a stale citation and a
fresh one are indistinguishable. `handler.ts:1148` was cited for "core hashes the whole parsed
document"; at HEAD it lands on `if (!isMap(captureSpec)) return refuse('capture: must be a map')` —
a line that is true, about a different thing, in the right file. A reader who follows it finds code,
reads it, and is wrong. There is no signal at any point.

## How it surfaced

**Nobody was looking for it.** The task was `asc-eve4`, adding a lifecycle stage. The edit added
lines to `packages/core/src/handler.ts`, which would have shifted every citation into it, so I went
to find those citations and fix the ones I had invalidated.

The check was `git show HEAD:<file> | sed -n '<line>p'` — read the cited line **at HEAD**, before
the edit, so that "is this about to rot" and "has this already rotted" could not be confused. Five
of the seven were already pointing at another line. My edit had not broken them; they were broken,
and the edit was about to make three more.

The mechanism worth naming is that the *verification* produced the finding, not the work. Checking
whether a change invalidated something is the only reason anyone reads a cited line at all, and the
check is cheap. It is just never done for citations that are not about to move.

## The metric

Measured 2026-10-11 on the tree at `7ff8595`, with `git show HEAD:<file> | sed -n '<n>p'` and
`git show HEAD:<file> | grep -n '<construct>'`. Seven citations were checked — every `path:line`
found pointing into the three files `asc-eve4` edited.

| Citation | Cited as | Line at HEAD | Verdict |
|---|---|---|---|
| `packages/core/src/handler.ts:566` | `String(raw)` | `const parts = (matcher as …).map(…)` | **wrong** — actual 850, 284 off |
| `packages/core/src/handler.ts:1148` | the document hash | `if (!isMap(captureSpec)) return refuse(…)` | **wrong** — actual 1238, 90 off |
| `packages/cli/src/typed-handlers.ts:252` | the entry key | a provenance comment | **wrong** — actual 260, 8 off |
| `packages/cli/src/commands/install-hook.ts:146` | `process.execPath` | a prose comment | **wrong** — `grep -n execPath` finds no such construct at HEAD |
| `packages/cli/src/commands/install-hook.ts:411` | a refusal | `const located = locateAscendHook(current);` | **wrong** — nearest `throw refusal` is 396 |
| `packages/cli/src/typed-handlers.ts:106-112` | the ENOENT catch | the ENOENT catch | ok |
| `packages/cli/src/event-log.ts:156` | `openEventLog`'s first-append mkdir | `mkdirSync(dir, { recursive: true })` | ok |

**5 of 7 wrong. n = 7, under `MIN_N` (20, `packages/analysis/src/proportion.ts:50`), so this is an
anecdote and not a rate.** It is reported as an anecdote deliberately: "roughly 70% of citations are
stale" is exactly the estimate this project exists to refuse to make from seven samples.

Two of the five cite a *construct that has moved* (`execPath` is not in the file at all any more).
The other three cite a line that exists and says something else. The second kind is the dangerous
one and is the majority here, 3 of 5.

## The pattern

**A pointer whose validity depends on a fact outside itself, with no check that the two agree.**
`handler.ts:1148` and `handler.ts` plus a function name are the same claim, and only one of them can
rot. The class is the same one `dogfood/0076` names one directory over — a value crossing a boundary
where its meaning changes while both sides believe they still agree — and the same one
`dogfood/0075` names: data stored per-version, readers reading per-name. All three are a reference
that was true once.

The distinguishing feature here is that **the failure is silent in the direction that matters**. A
citation that no longer resolves is loud; nothing in this repo's citations fails to resolve, because
a line number always names *some* line. Deleting the number is not a style preference; it removes
the only part that can be wrong.

## Why nothing else would have caught it

Nothing reads these citations but a human, and only when about to move them. `pnpm quality-gate`
cannot see it: a comment is not compiled, and `align` reads imports rather than prose. A lint rule
could catch it and would be the wrong fix — it would have to renumber, which is what produced this
state.

The reason the count is 7 and not 70 is that the check was scoped to the files one edit touched.
Every other citation in the tree is unmeasured, and this record says so rather than implying the
other 5 were the whole of it.

## Consequences and constraints

**Entries are immutable, and so are these records.** `dogfood/` and `docs/evidence/` hold two of the
five wrong citations (`dogfood/0009` cites `install-hook.ts:146` and `:411`; `dogfood/0026` and
`docs/evidence/EV-27.md` cite the hash and `String(raw)`). They are **left alone deliberately** —
they are the record of what was true when they were written, and rewriting a measurement after the
fact is a worse defect than the one this record documents. The remedy belongs in live files only.

The remedy is `asc-3sfk`'s: remove the numbers from the live citations and name the construct. That
is the recorded rule (`no-line-numbers-in-beads-or-docs`), applied to source and test comments, and
it is why the earlier strip of 115 citations from `IMPLEMENTATION_PLAN.md` was the right call rather
than a cosmetic one.

## Links

- Bead: `asc-3sfk`
- The edit that triggered the check: `asc-eve4`
- The same shape, one class over: `dogfood/0076` (a killer name matched as a regex)
- And again: `dogfood/0075` (guidance stored per-version, read per-name)
- The rule this extends: `no-line-numbers-in-beads-or-docs` (via `bd remember`)
