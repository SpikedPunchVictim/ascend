# 0050 — the quickstart runs a command nothing links onto `PATH`, and the sentence that fixes it is 27 lines up in another section

| | |
|---|---|
| **Bead** | `asc-uftd`, `asc-l38f` — the README sentence shipped with that pair; there is no bead of its own |
| **Surfaced** | 2026-10-01 |
| **Surfaced by** | building the "which artifact names which form of the recording command" table for E12.13 (`asc-uftd` + `asc-l38f`) |
| **Entry type(s)** | none. The defect is in `README.md` |
| **Severity** | P3 — it costs a reader one failed command, not a lost session |
| **Status** | fixed in the working tree — §Quickstart now opens with the sentence it was missing: the sections are written as bare `asc`, that is §Install's alias, and without the alias each one is `node packages/cli/dist/bin.js` |

## What was found

**An absence, in prose, spanning a section boundary.** `README.md`'s §Install establishes the one
fact every later section depends on — *"Nothing links an `asc` binary onto your `PATH`"* — and then
offers a remedy, an alias, at the end of that section. §Quickstart, 27 lines below, begins `asc init`
and continues for four commands with no mention of the alias at all. The word *alias* occurs
**zero** times anywhere in §Quickstart.

The failure it sets up is mild and exact: a reader who starts at §Quickstart — which is what a
quickstart is for — types `asc init`, gets `command not found`, and has to infer that the missing
ingredient is a shell alias defined in a section they skipped. Nothing in the text they read names
that dependency.

## How it surfaced

**Partly looking, and not for this.** E12.13's investigation enumerated the artifacts that name a
form of the recording command, one row each: the brief, `README.md` §Install, `README.md`
§Quickstart, `ARCHITECTURE.md`. That table is what made the *between-rows* defect visible, and it
made it visible for a reason worth naming: **every row was individually accurate.** §Install does
explain that nothing is on `PATH` and does give the alias; §Quickstart does show real, correct
output from the commands as they ship. The finding is not in either row. It is in the relation
between two rows that the enumeration, by construction, could not represent — a table of artifacts
has one column per artifact and no column for *what an earlier one owed a later one*.

So this is the mechanism to carry forward: **an enumeration of places finds absences within places,
and is structurally blind to an absence that lives in the seam.** The fix is one sentence; noticing
it required a shape of record that the work did not have yet.

## The metric

Measured on 2026-10-01 against the committed text, `git show HEAD:README.md`, section bodies from
one `## ` heading to the next:

```
$ python3  # per-section scan of HEAD:README.md
## Install | lines 31 - 53
   lines starting with bare `asc `: 0
   occurrences of "alias": 2
   occurrences of "node packages/cli/dist/bin.js": 1
## Quickstart | lines 54 - 124
   lines starting with bare `asc `: 4
   occurrences of "alias": 0
   occurrences of "node packages/cli/dist/bin.js": 0
```

Four command lines that cannot run as written, in a section that never uses the word for the thing
that makes them run. The remedy exists one section up (`alias asc='node …/packages/cli/dist/bin.js'`,
`README.md:51`), which is what makes this an absence rather than a wrong instruction.

The count is a count of *text*, not of sessions: **no user or session is claimed here.** n = 1
repository, and the number that matters (0 uses of "alias" in the section that needs it) is exact
rather than estimated — but whether any real reader was stopped by it is unmeasured, and is not
asserted.

## The pattern

**The same class as `dogfood/0028`, a third time: a route that names the goal and not the
mechanism.** 0028 is the brief naming every type and no command; the same finding's other half is
the hook script demonstrating a form the allowlist refuses; this is the quickstart using a command
the reader has not been given. All three are *discoverability of the happy path*, and in all three
every individual artifact was correct.

What is new here is the sub-shape: **the mechanism is documented, in the wrong section.** 0028's
artifacts taught a *wrong* form; this one teaches nothing and depends on a right form defined
elsewhere. The detector `0028` states — *for every documented capability, grep the text a consumer
actually reads for the command that performs it* — needs one amendment to catch this one: the grep
has to run over the section the consumer actually reads, and then ask **where each spelling it finds
is defined**. That question is what turns up "defined 27 lines up, in a different section, with no
pointer".

## Why nothing else would have caught it

- **No test can catch an absence in prose**, and `0028` already says so. This is the second finding
  in the series to land in that gap, which is itself the argument: prose is where this class lives,
  and prose is what the suite does not read.
- **A code review would not have.** Both sections are well written in isolation; the defect is only
  visible if you read §Quickstart as a *first* reader rather than as someone who already knows.
  That is `0028`'s "invisible to the person best positioned to spot it" — here the author, who has
  the alias in their own shell.
- **Reading §Install would not have.** It is where the fact is stated correctly and completely.

## Consequences and constraints

- **The fix is a sentence, and a sentence is unverifiable.** There is no arm of the gate that reads
  the README for coherence. Recording that plainly is the point: the change is real and the class
  stays open.
- **The broader remedy is in another bead.** The reason the alias has to exist at all is that
  nothing puts `asc` on `PATH` for a shell a session runs in; §Install even names the mechanism that
  would (`CLAUDE_ENV_FILE`, which *is* executed, so `export PATH=…:$PATH` really expands) and does
  not use it. That root fix is `asc-zser`, filed separately rather than ridden onto
  this pair, because it changes what `asc install-hook` writes and needs its own measurement.

## Links

- Beads: `asc-uftd`, `asc-l38f`; `asc-zser` is the root fix for putting `asc` on `PATH`
  (`CLAUDE_ENV_FILE` is executed as a shell script, so `export PATH=…:$PATH` really expands — unlike
  `settings.json`'s `env`, whose values are literal and where a `PATH` value *replaces* the inherited one)
- Related: `dogfood/0028` (the same class, twice: the silent brief and the script that demonstrates
  a refused form), `dogfood/0019` (a reviewer route that never names the reporting tool)
- Plan: `IMPLEMENTATION_PLAN.md` E12.13, Stage 3
- Entries recorded at the time: `ee12ee78-ade6-41c5-8474-12a0eedf0d78`,
  `f15ef34b-1550-411c-992d-651769db575e` (both `stage_transition`, for Stages 1 and 2)
