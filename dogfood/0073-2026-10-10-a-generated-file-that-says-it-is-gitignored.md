# 0073 — A generated file that says it is gitignored, and the command that never wrote the line

| | |
|---|---|
| **Bead** | `asc-zser` (found while building it; fixed in the same bead rather than filed separately) |
| **Surfaced** | 2026-10-10 |
| **Surfaced by** | reading `asc init`'s output in a scratch project, to check a sentence in the README |
| **Entry type(s)** | — (a defect in ascend's own install path, not in a stored type) |
| **Severity** | P3 |
| **Status** | fixed in the `asc-zser` commit |

## What was found

`asc install-hook` writes the `asc` shim to `.ascend/bin/asc`, and the shim's own header says
*"This file is gitignored, written per machine, and rewritten in full by every run"*
(`hook-script.ts`, `shimScript`). Nothing made that true. `asc init` is the only command that
writes a project's `.gitignore`, and its list of ignored paths did not name `.ascend/bin/`, so a
project that ran `asc init` and then `asc install-hook` showed the shim as an untracked file in
`git status` for as long as the project lived.

It is an **absence**, which is the kind a code review does not catch: there is no wrong line to
find, only a missing one, and the file that asserts the missing line is correct is a different
file in a different command.

## How it surfaced

I was editing `README.md` §Install for `asc-zser`, whose old text said nothing links `asc` onto
`PATH`. To write the replacement accurately I wanted to know exactly what a fresh project's
`.gitignore` holds after `asc init`, so I ran the built CLI in a throwaway git repository under
`spike/tmp/` and read the file it wrote. The seven lines it holds were all derived *store* files,
and none of them was the directory the shim was about to land in.

**Nobody was looking for it.** The question I had opened was "does the README still describe what
`install-hook` does?" — a documentation question. The answer that mattered was in a file the
README does not mention, produced by a command the README points at one line earlier.

The mechanism worth keeping is the shape rather than this instance: **a generated artifact whose
own header promises an ignore rule, where the ignoring is done by a different command that has no
reason to know the artifact exists.** `DERIVED_ENTRIES` in `commands/init.ts` enumerates what git
must not see, and it was written before the shim existed; nothing connected the list to the new
writer.

## The metric

`asc init` in `spike/tmp/gin` (a `git init`-ed scratch directory, 2026-10-10), then the file it
wrote, verbatim:

```
$ cat .gitignore
.ascend/index.db
.ascend/index.db-wal
.ascend/index.db-shm
.ascend/ascend.db
.ascend/ascend.db-wal
.ascend/ascend.db-shm
.ascend/ingest-cursor.json
```

Seven lines, and `.ascend/bin/` is not among them. The shim path it would have had to name is
`.ascend/bin/asc` (`SHIM_RELATIVE_PATH`, `hook-script.ts`).

**n = 1: an anecdote, not an estimate.** One scratch project, checked once. What makes it worth
a record is that the check is exhaustive for its question — a fresh `asc init` writes the whole
list or it does not — rather than that the sample is large. A second project would have measured
the same list, because the list is a constant.

## The pattern

A promise in a generated file with no writer that enforces it. The general form: **two commands
each own half of one invariant, and neither imports the other.** Here the invariant is "the shim
is not visible to git", `install-hook` owns the shim and `init` owns `.gitignore`, and the split
was invisible because both halves are correct in isolation.

The repository already has a name for the cost of getting this wrong: `DERIVED_ENTRIES`' own
comment records that an un-ignored `index.db` "conflicts on every merge". The failure mode here is
milder — an untracked file rather than a conflict — but the same reader (`asc init`) and the same
list were already there to prevent it.

## Why nothing else would have caught it

Stated plainly: a test *would* have caught it, and one nearly did. `init.test.ts` asserts the
`.gitignore` contents byte for byte through its `DERIVED_IGNORES` fixture, so any change to the
list is caught — but the fixture is a copy of the list, and a line that was never added to the
list is a line the fixture correctly does not expect. The test protects the list against drift; it
cannot notice that the list is incomplete, because "complete" is not a property it has any way to
check.

`doctor` is the nearest thing to a check for this, and it cannot see it either: it compares the
generated *files* against what ascend would write, and an untracked file is byte-identical to a
tracked one.

So this rested on reading the two documents against each other, which is what happened, and only
because a README sentence was one revision out of date. Had §Install already been accurate, the
paragraph would not have been rewritten, the scratch project would not have been created, and the
gap would have shipped.

## Consequences and constraints

No stored data is involved, so nothing here collides with entry immutability.

Two constraints on the response, both recorded rather than resolved:

- **The fix is in `asc init`, so a project that ran an older `asc init` and then upgrades gets
  nothing.** `commands/init.ts` already describes itself as "the only upgrade path a `.gitignore`
  can have", so re-running `asc init` is the documented remedy and no new mechanism was invented
  for it. An `install-hook` that appended the line itself would close that case too, at the cost
  of a second command editing a file the user tracks; that trade was left on the table
  deliberately, not overlooked.
- **`asc-zser`'s own repository is exactly that upgrade case** and had to be fixed by hand: this
  checkout's `.gitignore` gained `.ascend/bin/` in the same change, with the reasoning beside it,
  because ascend dogfoods itself and its `.gitignore` predates the shim.

## Links

- Bead: `asc-zser`
- Evidence record for the feature this surfaced beside: `docs/evidence/EV-47.md`
- Files: `packages/cli/src/commands/init.ts` (`DERIVED_ENTRIES`),
  `packages/cli/src/hook-script.ts` (`shimScript`), `packages/cli/test/init.test.ts`
  (`DERIVED_IGNORES`)
