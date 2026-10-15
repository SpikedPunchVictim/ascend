# 0107 — A probe that thought it was isolated, and wrote into the project

| | |
|---|---|
| **Bead** | `asc-zvzx` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | Building `asc-09wx.8.5`'s brief block, and driving it through a scratch project made by redirecting `HOME` |
| **Entry type(s)** | `intervention` (the row that landed — and the one type where a stray row is permanently visible, because it is what `asc types brief` reads to say a grade is owed) |
| **Severity** | P2 |
| **Status** | open |

## What was found

**A store is found by walking UP from the process's working directory, so `HOME` isolates nothing.** I
wanted a scratch project to drive `asc types brief` end-to-end without touching this repo. I set
`HOME=$D` and ran `asc init` followed by `asc record intervention -` from the repo root. The store that
was opened was not `$D`'s. It was **this repo's own**, and the row went into the repo's tracked record
tree at `.ascend/entries/intervention-61c12e2ee039/0001.jsonl`:

```
id         d4662211-42c2-49a1-a912-17b31324473b
change     `handlers/x.yaml`
status     applied
applied_at 2020-01-01T00:00:00.000Z
grading_point 1
```

Every field is legal, so nothing refused it. Its `applied_at` is 2020 and its wait is one active day,
so the row is due — and `asc types brief` therefore printed a `grade owed:` line in this repository
from that moment on, for a handler that does not exist, in a project that had never proposed it.

**There is no supported removal path.** `asc store` offers `rewrite` (types lines) and `verify`;
entries are append-only, and `asc record` has no counterpart that takes one back. The repair was a
hand edit of the tracked JSONL to drop that one line, followed by `asc index build`.

*The probe had done everything the surrounding habits say to do: a fresh directory, an environment
variable that is supposed to relocate per-user state, and no `cd` into the project. The one thing it
did not do is change the process's working directory — which is the only thing that mattered.*

## How it surfaced

`asc types brief` printed a `grade owed:` line the moment after, and I read it as one more line of my
own feature's output rather than as a fact about the repo. What made it visible was the brief's own
wording: the line named a handler (`handlers/x.yaml`) that I had never written, so the line was
self-evidently not mine. **Had the probe recorded a plausible handler path, the row would have sat
there and been graded as part of the ordinary work.**

**Nobody was looking for it.** The task was a payload-composition change in `brief-text.ts`. Nothing
in it was about store resolution, and the probe existed to avoid touching the repo at all.

## The metric

**What the stray row cost the tracked tree**, measured as file bytes on
`.ascend/entries/intervention-61c12e2ee039/0001.jsonl`:

```
with the stray row    4048 bytes
after removing it     3519 bytes   <- 529 bytes, the stray line
rows in the file         1         <- the real EV-55 row, still present
stray id present         0         (`grep -c d4662211-42c2-49a1-a912-17b31324473b`)
```

The two files that agree there is nothing wrong with the result:

```
asc store verify -> no conflict markers, no unreadable lines, no lost record ids
```

**A stray row is indistinguishable from a real one by every check the store has**, which is the
finding: `verify` asks whether the file parses and whether ids are unique, and this row parses and is
unique. Nothing counts rows against an expectation, because nothing in the design says how many rows
a project *should* have.

**n = 1, so this is an anecdote and is named as one** (`MIN_N` is 20,
`packages/analysis/src/proportion.ts`). What is not an anecdote is the mechanism, which is a fact
about the code and not a rate: the resolution order is cwd-walking, and `HOME` is not consulted on the
path from `cwd` to a store.

## The pattern

**"Run it somewhere scratch" is a claim about the caller's discipline, not a mechanism, whenever the
tool resolves its own state.** An environment variable relocates state only if the tool reads that
variable. A tool that walks up from `cwd` — which is the right behaviour for a per-project store, and
the reason `asc` works inside a monorepo — can only be moved by moving the process. The isolation has
to be applied to the *one axis the tool actually uses*, and the mistake is to reach for the axis that
is conventional instead of the one that is real.

The second half is what makes the first half expensive: **an append-only store turns a test's side
effect into a permanent artifact.** Every other kind of scratch state can be deleted. A row cannot,
because the type's whole value is that entries are immutable — the same property that makes the ledger
trustworthy makes a stray row un-erasable through the tool.

## Why nothing else would have caught it

- **The type's own validation cannot.** Every field the row carried is one a real row carries; the
  schema's job is to refuse malformed rows, and this one was well-formed. `starterEntryIssue` refuses
  a metric with no rule, and this row has no metric at all.
- **`asc store verify` cannot**, and this is the sharpest version: it reports 12,188 record ids and no
  conflict markers, and it said exactly that both before and after the repair. It checks the file, not
  the project.
- **The test suite cannot.** `interventionRow`'s fixtures use `mkdtempSync` and pass `cwd` to
  `spawnSync` — the mechanism that works — so no test in the repo ever sets `HOME` to relocate a store,
  and none therefore encodes the mistake to be caught.
- **Review cannot**, because the probe and its cleanup were two shell commands in one session, and the
  artifact is a 529-byte line in a file of 3,519.

## Consequences and constraints

- **The repair is a hand edit plus `asc index build`**, and it has to be: entries are immutable, and a
  `note` correcting a row would leave the false `grade owed:` line in place, since `dueGrades` reads
  `status` and the chain's newest entry, not prose. Recording the mistake would not have removed it.
- **`.ascend/entries/` is tracked**, so a stray row is a repository change rather than a local one. A
  probe that writes one has modified the thing it was trying to leave alone, and the diff is a new
  file in `git status` that belongs to nobody's feature.
- **The prevention is to move the process, not the environment.** A scratch probe must make its
  scratch directory the `cwd` of the child — which is what every fixture in this repo already does:
  `spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...process.env, HOME: cwd, ... } })`. The
  `HOME` there is belt and braces; the `cwd` is the mechanism.
- **Nothing in the tool changed.** This is a finding about how to hold `asc`, not a defect in it: cwd
  resolution is correct, and a store that could be redirected by an environment variable would be a
  store that two projects could silently share.

## Links

- Bead: `asc-zvzx`
- The row's home: `.ascend/entries/intervention-61c12e2ee039/0001.jsonl`
- Built by: `asc-09wx.8.5` (whose `grade owed:` line is what made the stray row visible, and is the
  only reader that ever showed it)
- Found by: a second finding in the same window about the fixtures behind `asc-09wx.8.5`'s mutation
  spec — three mutants survived because the fixtures could not observe them — recorded separately
