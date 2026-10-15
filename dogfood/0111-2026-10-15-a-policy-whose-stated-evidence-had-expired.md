# 0111 — a policy whose stated evidence had expired, upheld by an argument it does not make

| | |
|---|---|
| **Bead** | none filed — the correction is complete, and the record is the artifact |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | writing the in-place `entries.source` change for `asc-09wx.8.7`, and checking whether the written policy that licenses an in-place edit still applied |
| **Entry type(s)** | none — the finding is about a docblock |
| **Severity** | P3 — the conclusion is right; what is wrong is the reason a later reader would use to reach it |
| **Status** | corrected in the working tree |

## What was found

**The migration policy in `packages/store/src/schema.ts` licenses in-place schema edits on three
pieces of evidence, two of which are false — and the true argument for the same conclusion is a
different one the docblock does not make.**

The docblock's paragraph reads, verbatim:

> That reason does not hold yet, and the boundary is worth stating rather than
> assuming. ascend has never been released; no store has ever existed outside a test's
> temp directory, and none is committed (`.ascend/` is gitignored).

Clause by clause, measured today:

- *"ascend has never been released"* — **true.**
- *"no store has ever existed outside a test's temp directory"* — **false.** This checkout has one:
  `.ascend/index.db`, 35,397,632 bytes, built by `asc index build`.
- *"none is committed (`.ascend/` is gitignored)"* — **false.** `git ls-files .ascend | wc -l` returns
  **24**, and the JSONL tree under `.ascend/entries` **is** the store's canonical form, not a cache.

So a reader arriving at this docblock to answer "may I edit `INITIAL` in place?" is told there is no
store anywhere that the edit could break. There is one, in the repository the reader is standing in.

The conclusion survives — but on an argument the docblock never states: the SQL `CHECK` it is about
lives in exactly one place, `index.db`, and `index.db` **is** ignored (`git check-ignore
.ascend/index.db` → ignored) and is derived and regenerable. Regenerating it is one command, measured
at `records 12368`. That is what actually licenses an in-place edit: the artifact that would go stale
is a rebuildable cache, not the record tree. The docblock's stated reason is a stronger-sounding
claim that happens to be untrue.

## How it surfaced

While writing the change. `asc-09wx.8.7` adds a fourth value to `entries.source`, and the SQLite
`CHECK` cannot be altered, so the first question was whether this needed a migration — which meant
reading this docblock and taking it at its word. It was taken at its word for a while, and the
migration was designed and measured before it was noticed that the docblock's own policy pointed the
other way.

The mechanism worth repeating: **a docblock that justifies a live policy with stale evidence is read
as an instruction, not as a claim to be checked.** The reader's question was "what does the policy
say", and the policy reads as settled, so the three clauses under it were not re-measured — they were
re-measured only because the conclusion was inconvenient and something had to be re-derived to
challenge it. Every one of the three is a one-command check, and none of them is run by anything.

## The metric

```
$ git ls-files .ascend | sed 's|\(\.ascend/[^/]*\)/.*|\1|' | sort | uniq -c
   1 .ascend/.gitattributes
   7 .ascend/annotations
  14 .ascend/entries
   1 .ascend/schemes
   1 .ascend/types

$ ls -la .ascend/index.db | awk '{print $5, $9}'
35397632 .ascend/index.db

$ for p in .ascend/index.db .ascend/entries .ascend/types; do printf '%-24s ' "$p"; \
    git check-ignore -q "$p" && echo IGNORED || echo "NOT IGNORED"; done
.ascend/index.db         IGNORED
.ascend/entries          NOT IGNORED
.ascend/types            NOT IGNORED

$ asc index build
/Users/spikedpunchvictim/projects/ascend/.ascend/index.db  12368    7713a72a29a6b26c94aeebde6a5316…c7e1caf940eeba79f22ccc65195bb
```

**3 clauses of stated evidence, 2 of them false, in 1 docblock.** The regenerable-cache argument that
replaces them is 1 command and **12368** records.

`n = 1` docblock in `n = 1` checkout — an anecdote, not a rate. The class is the one that generalizes.

## The pattern

**Evidence quoted in support of a live rule expires like any other measurement, and it expires
silently because nothing asserts a docblock.** The sharper half is not the staleness — it is that the
conclusion was *right anyway*. A reader who checks the evidence, finds it false, and takes that as a
reason to abandon the policy would be wrong for the second time. This is the failure mode
`dogfood/0048` names one layer over (a bead's premise expiring while the count it was stated in still
agreed); here the count-like clause is not merely stale but false, and the sentence around it is an
instruction.

## Why nothing else would have caught it

Nothing reads a docblock. The suite was green through every commit of the period in which all three
clauses were already in their present state, and every one of the measurements above is a single
command that no test runs and no check requires. There is no signal at all — the only thing that
brought it up was a task that needed the policy to be *right* rather than merely present, and it
needed that for an unrelated reason.

## Consequences and constraints

The correction is prose, and the risk it carries is the one this record is about: a replacement
sentence is a fresh claim that will itself age. So the replacement states the check rather than the
value — that the artifact an in-place edit invalidates is the derived `index.db`, which
`asc index build` regenerates — so a later reader re-runs a command instead of accepting a fact.

## Links

- Bead: none — corrected in the working tree under `asc-09wx.8.7`, which is where the reading was needed
- Related: `dogfood/0048` (a premise that expired without saying so), `dogfood/0103` (a count the corpus had stopped saying)
