# 0038 — a retirement the rebuild erased, and the seventh write site that hid it

| | |
|---|---|
| **Bead** | `asc-i5tj.4.1` — "give `writeLines` its callers -- the line producers, then **the five write sites**" |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | driving the real binary through the flip's own verification: `asc types deprecate`, then `asc index build`, then reading the type back |
| **Entry type(s)** | none — the finding is in the write path (`asc types deprecate`), not in a recorded entry |
| **Severity** | P1 — the project's severity-zero class: the operation whose whole job is "reproduce the store" reproduced a different store, and reported success |
| **Status** | fixed in-flight, uncommitted as of 2026-09-29 |

## What was found

A deprecation had nowhere to live. `deprecateType` updates the `status` column of the version rows
and mints no new version, so the tree held no line describing it — and the tree is the store. The
result was **two commands, each correct, that disagreed**:

- `asc types deprecate <name>` succeeded, and the index said `deprecated`;
- `asc index build` — whose entire purpose is to reproduce the store from the lines — replayed the
  tree, found no retirement in it, and gave the type back **`active`**, exiting 0.

The retirement was not lost data. It was a fact that only ever existed in a DERIVED file, which is
the one place the design promises nothing may only exist.

**The second finding is the one worth keeping.** Migrating this command onto the produce-and-append
path turned out to be a *seventh* write site. The approved plan names **five** (E12.4b3); exploration
while writing the plan found a **sixth** (`asc ingest claude-code`); nobody's survey found this one.
It surfaced because a defect happened to be sitting in it.

## How it surfaced

By running the flip's verification loop against a real project rather than a fixture, and reading a
value back **after** a rebuild instead of before one. Every other deprecation test read the store
directly after the command ran — the state where the two commands agree, because the index is what
the command wrote. The bug is only visible in the *second* state, after the derived file has been
thrown away and made again, which is exactly the state the epic exists to make normal (a fresh
clone, a branch switch, a `git pull`).

Nobody was looking for a deprecation defect. The rebuild was being exercised because the epic
requires it, and the type it happened to be holding had been retired earlier in the same session.

## The metric

- **Commands that must agree, and did not:** 2 (`asc types deprecate`, `asc index build`). Obtained
  by running them in sequence against a real project and reading `status` back after the build.
- **The value read back after the rebuild:** `active`, while the pre-build read was `deprecated`.
  Recorded at the time in `packages/cli/src/commands/types/deprecate.ts`'s header and in
  `packages/store/src/registry.ts`'s doc for `deprecateType`, both of which cite it with the
  command sequence that produced it.
- **Write sites the plan named: 5. Sites that existed: 7.** The sixth (`ingest/claude-code.ts`) was
  found by the plan's own exploration and is written into it; the seventh (`types/deprecate.ts`) was
  found by this defect. The count is checkable rather than recalled:
  `grep -rn "deprecateType\|recordEntry\|registerType\|registerScheme\|recordAnnotations\|recordInvalidation\|updateTypeProse" packages/cli/src` against `packages/store/test/writer-callers.test.ts`'s scanned list, which now carries all seven names.
- **The pre-flip handle refused the write outright** — `attempt to write a readonly database` — once
  the read path became read-only. That is what turned an erased fact into a loud failure for part of
  the transition, and it is why the defect is dated: it had one shape before the read flip and a
  different one after.

Both halves of the fix are load-bearing, checked by mutation rather than argued — each mutation
deleted one half and re-ran the suite, which then failed with the original defect:

```
removing `replayType`'s application of the field (jsonl-index.ts):
- "status": "deprecated"
+ "status": "active"

removing `register-document.ts`'s `produce.deprecate` call:
✗ asc types export and import > carries a retirement through export | import, and it survives the
  rebuild there
```

Both mutations were reverted, and the suite is green with the field in place.

## The pattern

**A fact that no line kind can carry is a fact the rebuild will erase, and nothing will say so** —
the same class `dogfood/0031` (a type line carries no version) filed from the other side. The
generalization that made this findable: whenever a writer changes state without minting a version,
ask which line says so. If the answer is "none", the write is real in the index and fiction in the
store.

**And its companion: a survey of write sites is a survey of the sites someone thought of.** The
instrument that would have caught this is not a better survey — it is
`packages/store/test/writer-callers.test.ts`, which scans the source for calls to the writer
functions and pins the modules allowed to make them. It could not catch this one either, because
`deprecateType` was simply not in its list: a guard whose list comes from the same survey as the fix
cannot see what the survey missed. It carries the name now, and the header says so.

## Why nothing else would have caught it

Nothing in the suite at the time read a type's status *after* a rebuild — every deprecation
assertion ran immediately after the command. A review would plausibly have caught it by asking "what
line carries this?", and that is the honest answer: this one was cheap to reason about and expensive
to notice, which is the failure mode of a survey-driven plan rather than of a hard design. The
`--dry-run` half was also silently wrong (it wrote into a read-only handle), and no test drove
`asc types deprecate --dry-run` at all before this.

## Consequences and constraints

The representation chosen (a `status` field on the type line, carried only when the type is retired)
means a retirement rides on a REPEAT of a `(name, version)` pair the tree already holds, so no
version is minted — `asc types deprecate` is still not a schema change, and `type_hash` is
unchanged. The replay rule is **monotone**: a line that omits the field says nothing, never
"active". That is strictly stronger than "last line wins" and is the only rule that survives a
`merge=union` file, where line order is not a fact.

## Links

- Plan: `IMPLEMENTATION_PLAN.md` E12.4b3 / E12.4c (amended in-flight with the seventh site)
- Related: `dogfood/0031` (a type line carries no version), `dogfood/0035` (five producers that each
  worked alone)
- Source: `packages/store/src/document.ts` (`TypeDocument.status`),
  `packages/store/src/line-producers.ts` (`deprecationLines`),
  `packages/store/src/jsonl-index.ts` (`replayType`),
  `packages/cli/src/register-document.ts`, `packages/cli/src/commands/types/deprecate.ts`
- Entries recorded at the time: none — surfaced from driving the binary, not from stored entries
