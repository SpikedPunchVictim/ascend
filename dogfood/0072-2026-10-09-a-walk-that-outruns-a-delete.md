# 0072 — A corpus walk that lists files another process is deleting under it

| | |
|---|---|
| **Bead** | `asc-e74x` |
| **Surfaced** | 2026-10-09 |
| **Surfaced by** | the pre-commit gate, running the full suite for the second of three authorized commits |
| **Entry type(s)** | — (a defect in ascend's own test suite, not in a stored type) |
| **Severity** | P3 |
| **Status** | open |

## What was found

`packages/adapter-claude-code/test/reader-real-corpus.test.ts` walks the live
`~/.claude/projects` corpus, then reads every path the walk listed, then asserts
`expect(totals.failures).toEqual([])`. That assertion holds only if the corpus is still there
when the read catches up with the walk. When another process is deleting a project's
transcripts in between — which is what deleting a Claude Code session looks like — every
listed-but-gone file arrives as `ENOENT`, `totals.failures` is no longer empty, and the test
fails.

The failure is not a false *reading*: the reader is right that it did not read those files. What
is wrong is the invariant it is asserted against. "The corpus I walked is the corpus I read" is
not a property of a directory that other processes write and delete.

## How it surfaced

I was running `git commit` for the second of three commits the owner had authorized. The gate
runs the whole suite, so it ran a corpus test unrelated to the diff — which was the median
extraction in `packages/analysis`, a change that cannot make a file in another project's
transcript directory disappear. The commit was blocked, the script's `set -e` stopped it, and
the third commit never ran.

**Nobody was looking for it.** The reader's `failures` list exists precisely to surface files it
could not read, and it fired correctly and said exactly what went wrong and why. The instrument
worked. What nobody had asked was whether the *test's* assumption about a live corpus was ever
true on a machine where someone else is working.

This is the second distinct way the same gate step reddens for reasons external to the diff.
`dogfood/0063` and `asc-pi5a` record the first — a wall-clock bound that fires under load. The
mechanism here is not time; it is a race between the walk and a delete, and it reddens on a
quiet machine as readily as a busy one.

## The metric

The failing suite, quoted from the gate's own output for commit 2 on 2026-10-09 (`~/tmp` script
log `/tmp/ascend-commit-b.log`, the pass beginning `Start at 16:31:59`):

```
 Test Files  1 failed | 137 passed (138)
      Tests  1 failed | 3190 passed | 2 skipped (3193)
   Start at  16:31:59
   Duration  308.82s (transform 5.04s, collect 19.19s, tests 1694.10s, environment 21ms, prepare 9.12s)
```

The failing test, and the assertion:

```
 FAIL  packages/adapter-claude-code/test/reader-real-corpus.test.ts > the reader against the real corpus > holds the corpus in memory only as PATHS, not as bytes
AssertionError: expected [ { …(3) }, { …(3) }, { …(3) }, …(51) ] to deeply equal []

 ❯ packages/adapter-claude-code/test/reader-real-corpus.test.ts:410:29
    410|     expect(totals.failures).toEqual([]);
```

Counted in that block, not estimated — `awk 'NR>=1987 && NR<=2283' … | grep -c '"reason": "ENOENT"'`
returns **54**, and every one of the 54 is `ENOENT`. The `"path"` fields in the same range name
**exactly one** project directory:

```
$ awk 'NR>=1987 && NR<=2283' /tmp/ascend-commit-b.log | grep '"path"' | sed 's|.*projects/||; s|/.*||' | sort -u
-Users-spikedpunchvictim-projects-grizzly-grizzly-exp
```

The session directory those paths named is gone now, which is the whole finding:

```
$ ls -d ~/.claude/projects/-Users-spikedpunchvictim-projects-grizzly-grizzly-exp/82bcb136-2562-49be-bfca-c91ca4b4caf1
ls: …: No such file or directory
```

**Not the timeout.** The same file, in the immediately preceding pass of the same gate on the
same tree:

```
 ✓ packages/adapter-claude-code/test/reader-real-corpus.test.ts (6 tests | 1 skipped) 57184ms
 ❯ packages/adapter-claude-code/test/reader-real-corpus.test.ts (6 tests | 1 failed | 1 skipped) 84358ms
```

84,358 ms against a 300,000 ms bound. The failing run is 1.5× the passing one and nowhere near
its limit, so this is not `dogfood/0063`'s oversubscription timeout wearing a new face — it is a
different cause that happens to red the same step.

The corpus afterwards, so the churn is legible as a batch that finished rather than a machine
still failing:

```
$ find ~/.claude/projects/-Users-spikedpunchvictim-projects-grizzly-grizzly-exp/ -name '*.jsonl' | wc -l
     328
```

— read twice, unchanged. The walk was overtaken by a delete, not by a corpus that stayed broken.

## The pattern

**An assertion over a live, externally-mutated corpus.** The test's contract quietly includes
"and nothing changed underneath me", which is a property of the machine and not of the code. It
is the same shape as `dogfood/0063` and `asc-pi5a` — a check that is honest only under a
condition the repository cannot guarantee — reached through a different door.

The generalisation worth keeping: when a tripwire reads a corpus that other processes own, the
question is not only *is the bound generous enough* but *is the invariant even about my code*.
A wall-clock bound asks "was this fast enough"; this asks "was this still there", and the second
is not something the committer controls at all.

## Why nothing else would have caught it

The reader is not at fault and neither is its failure list — both did their job and the message
named the exact reason for all 54 files. No unit test can catch it: a fixture corpus is created
by the test and cannot be deleted out from under it mid-run, which is exactly why the live-corpus
test exists. No review would have caught it either, unless the reviewer happened to be deleting
another project's sessions at the moment the suite ran.

It took a third party running a delete concurrently. That is the honest answer, and it is why the
record is here rather than as a comment on the test.

**The race is already named in the code, which makes the assertion's silence harder to defend.**
`streamCorpus` (`packages/adapter-claude-code/src/reader.ts`) awaits the whole walk —
`const scan = await scanTranscripts(root, …)` — and only then begins `for (const file of scan.files)`,
so the window between listing a path and opening it is a whole directory walk wide. And the stat
path inside that loop already catches this exact case, in a comment: *"Unreadable, or removed
between the walk and here."* So this repository knows the corpus can change mid-sweep, and says so
in the reader. What never happened is that knowledge reaching the assertion, three layers up, which
still requires the list to be empty. The defect is not an unknown race; it is a known one that one
caller accounts for and another does not.

## Consequences and constraints

- **Do not read this as "the corpus tests are flaky, ignore them".** `dogfood/0063`, `asc-pcaw`
  and `asc-pi5a` all rejected weakening the tripwire, on measured grounds. This finding does not
  argue for a weaker check; it argues that one particular invariant is stated over the wrong
  thing.
- **A plausible in-repo remedy exists, which is what separates this from `asc-pi5a`.** `ENOENT` is
  specifically *the file went away*; it is not *the file could not be understood*, and it is not
  an `EACCES` or a parse failure. A reader that counted a vanished path apart from an unreadable
  one would keep every tripwire that exists today and stop reddening on a delete it cannot
  control. Whether that weakens the check, or whether the test should instead be scoped to a
  corpus it knows is not being mutated, is the design question — and it is a question answerable
  with code, unlike the one `asc-pi5a` had to leave open.
- **The cost of leaving it.** Two of three authorized commits were lost to this on 2026-10-09:
  the second was blocked, and the third never ran. That is the same class of harm
  `dogfood/0063` records, reached without any load at all.

## Links

- Bead: `asc-e74x`
- Related, and deliberately not merged with it: `asc-pi5a` (the load-induced red, no in-repo
  lever), `dogfood/0063` (the timeout under 8× oversubscription), `dogfood/0007` / `asc-3x1`
  (the earlier rounds)
- Gate log quoted above: `/tmp/ascend-commit-b.log`, the pass beginning `Start at 16:31:59`
