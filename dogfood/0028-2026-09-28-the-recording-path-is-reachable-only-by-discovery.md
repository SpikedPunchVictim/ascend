# 0028 — a session can only record if it discovers the command, and the artifacts it reads teach one the allowlist denies

| | |
|---|---|
| **Bead** | `asc-uftd`, `asc-l38f` |
| **Surfaced** | 2026-09-28 |
| **Surfaced by** | `spike/ev16-arms.mjs` arms F and G, run for `asc-4so.3` — a session told to "record an entry about what you did in this project's store" |
| **Entry type(s)** | none. The defect is in the brief and in the installed hook script |
| **Severity** | P2 |
| **Status** | **closed 2026-10-01** — both halves implemented. `asc types brief` prints `Record with: asc record TYPE --json -` as line 1, so the digest's `asc record` count went **0 → 1** (3,381 → 3,419 bytes, 4,619 free); the brief and the hook script read that spelling from **one constant** (`RECORD_COMMAND`), which is the structural form of the fix; and `.claude/ascend-hook.sh` carries a comment naming what to run by hand and stating that its own path resolution is not a form to copy. **Three claims in the body above are wrong and are corrected here rather than edited there, because the body is immutable** (`dogfood/0037`'s precedent, itself `asc-4wx6`'s). **(1) "was denied, and stopped" overstates the wall.** The harness ran `--permission-mode dontAsk`, which *auto-denies* rather than prompting — so F2's four denials would have been **prompts** in a real interactive session. The finding is friction, not a barrier, and it does not change the fix. **(2) The "no branch yields a permitted form" asymmetry was a property of that arm's grant, not of Claude Code.** `spike/ev16-arms.mjs:169` creates the `.shim` and `:428` prepends it to `PATH` — the shim was the *harness's*, not something ascend installs; and `:295` granted `Bash(asc:*)` with `Bash(node test.js)` and nothing else. "Bare `asc` works, `node …` is refused" is what *that* grant permitted. On this checkout the script's own path form **is** allowed (`Bash(node *)` in `.claude/settings.local.json`), so the body's "in either layout" is true only of the two layouts measured. **(3) "Naming the command ... converts a discovery problem into a denial problem, which is worse" is false for the remedy the README already ships.** An **alias does work in a Bash tool call** — Claude Code sources the user's shell rc at session start — so §Install's `alias asc='node …/bin.js'` is a spelling that both runs *and* is granted, and it is what §Quickstart now points at. The owner overrode the body's conclusion on this measurement; the decision is recorded in `IMPLEMENTATION_PLAN.md` (E12.13) and the second artifact in this class is `dogfood/0050`. |

## What was found

**Two absences, and the second is what makes the first fatal.**

The brief — `asc types brief`, the entire text a session reads at `SessionStart` — never names the
recording command. It names twelve types and their `record_when` prose, and the string `asc record`
occurs in it **zero times**. The only `asc <verb>` strings in the whole document are `asc ingest`
(six, all inside derived types' "Never by hand" text) and `asc query` (one).

And the artifact a session reads *instead*, when the brief is silent and it goes looking, teaches a
form the documented allowlist refuses. `.claude/ascend-hook.sh` — the script `asc install-hook`
writes — resolves the binary through a priority order whose first three branches are all
path-form, then runs the `.js` result as `node "$bin"`. In this repository that branch fires, so the
script's own body invokes ascend as:

```
node /Users/spikedpunchvictim/projects/ascend/packages/cli/dist/bin.js
```

`ARCHITECTURE.md:331` names `Bash(asc record:*)` as the settings.json entry that makes recording
frictionless — "Stable command prefix so `Bash(asc record:*)` works as an allowlist entry." That
prefix matches the command *name* `asc`. It matches neither `node …/bin.js` nor an absolute shim
path. Measured: a session in arm F produced that exact `node …/bin.js` command, was denied, and
stopped.

## How it surfaced

A measurement was running and **nobody was looking for this**. `asc-4so.3` pre-registered the
question "does a task that asks for a record produce one?" and predicted, in writing, that arm F
would record in ≥ 2 of 3 sessions *because* "the brief names both the command and the types". That
rationale is false — the brief names the types and never the command — and the prediction's
threshold held anyway (2 of 3) for a reason the pre-registration did not anticipate: the two
sessions that recorded did so by **discovery**, not by instruction.

The mechanism is worth naming precisely, because it is the part that repeats. The recording rate here
is a rate over *discovery routes*, not over willingness:

- **F1 and F3** ran `ls -R` / `find`, saw a `.shim` directory, and tried the bare command `asc
  --help`. That form is allowed, so it ran. Neither read the hook script first.
- **F2** ran `find …/.ascend …/.claude …/.shim -type f`, then read both `.shim/asc` and
  `.claude/ascend-hook.sh`, and concluded the invocation was an absolute node path. It never tried
  the bare name. Its four attempts, verbatim:

  ```
  .shim/asc --help 2>&1 | head -60                                                            DENIED
  /opt/homebrew/Cellar/node@24/24.18.0/bin/node /Users/…/packages/cli/dist/bin.js --help 2>&1 | head -60   DENIED
  .shim/asc say --help 2>&1 | head -40                                                         DENIED
  sqlite3 …/.ascend/ascend.db ".tables" 2>&1                                                    DENIED
  ```

  and its closing message: *"The bug fix and tests are done, but I've hit a wall on the final step
  and am stopping per the three-attempt rule."*

**The bug was fixed and the tests passed in all three F sessions.** What separated them was which
artifact they happened to read first — a coin flip on file-read order, deciding whether a completed
piece of work could be recorded at all.

The second route is its own small finding. G2, with no brief at all, reached for a *different*
recorder entirely: `Skill(forgetful-plugin:memory-save)` with the argument "Record a project entry:
fixed the median() bug in calc.js". A session that wants to record and cannot find ascend's command
does not stop wanting to record; it records somewhere else.

## The metric

All of it obtained on 2026-09-28 from the run whose full record is `docs/evidence/EV-30.md`.

**The brief** (`node packages/cli/dist/bin.js types brief`, 3,603 bytes stdout):

```
$ node packages/cli/dist/bin.js types brief | grep -c 'asc record'
0
$ node packages/cli/dist/bin.js types brief | grep -o 'asc [a-z-]*' | sort | uniq -c
   6 asc ingest
   1 asc query
```

**The allowlist line and the script's own invocation.** `ARCHITECTURE.md:331`:

```
- **Stable command prefix** so `Bash(asc record:*)` works as a `settings.json` allowlist entry.
```

`.claude/ascend-hook.sh`, lines 24–41 — the resolution order and the `*.js` branch:

```
elif [ -f "$root/node_modules/.bin/asc" ]; then
  bin="$root/node_modules/.bin/asc"
elif [ -f "$root"'/packages/cli/dist/bin.js' ]; then
  bin="$root"'/packages/cli/dist/bin.js'
elif command -v asc >/dev/null 2>&1; then
  bin="$(command -v asc)"
...
case "$bin" in
  *.js)
    command -v node >/dev/null 2>&1 || exit 0
    run() { node "$bin" "$@"; }
```

`ls -l node_modules/.bin/asc` → `No such file or directory`. The README is explicit that this is
expected ("Nothing links an `asc` binary onto your PATH"). So the second branch fires, the `*.js`
branch runs, and the script's invocation is the denied form. In the harness's scratch layout the
last branch fires instead, and `command -v asc` resolves to the shim — also an absolute path, also
not covered. **No branch of the shipped script yields a form `Bash(asc:*)` covers**, in either
layout.

**The outcome, read off the scratch stores** (`source='self'` entries, never the agent's report):

| arm | sessions run | recorded | rate |
|---|---|---|---|
| F, prompted + hook | 3 | 2 | 2 of 3 |
| G, prompted, no hook | **2** | 0 | 0 of 2 |

**This is an anecdote, not a proportion.** n = 5 sessions against `MIN_N` = 20
(`packages/analysis/src/proportion.ts:50`). Arm G is 2 sessions rather than the pre-registered 3
because the $3 ceiling was crossed at $3.2169350000000003; see EV-30's Limits. The finding here does
not rest on the rate — it rests on the two zero-counts and the four denials, which are exact.

## The pattern

**A path that is permitted but not documented is reachable only by luck, and the artifacts a session
consults when it is lost are the ones most likely to teach the wrong form.** The brief is the
documented route and it is silent; the hook script is the incidental route a session finds by
`find`, and it demonstrates an invocation the permission system refuses.

The class is *the discoverability of the happy path*: every individual piece was correct — the brief
describes types, the hook script works (hooks are not subject to the Bash allowlist), and the
allowlist entry is documented. What was never checked is whether a session that *wanted* to comply
could get from "record an entry" to a command that runs. Compare `dogfood/0019`: a reviewer route
that never names the reporting tool. Same class, different surface — **a route that names the goal
and not the mechanism**.

There is a cheap detector, and it is the same one `0018` states for its own class: **for every
documented capability, grep the text a consumer actually reads for the command that performs it.**
`grep -c 'asc record'` over the brief is 0. That check costs one line and would have caught this
before the measurement.

## Why nothing else would have caught it

- **No test can catch an absence in prose.** Nothing asserts that the brief names a command, and
  asserting it would be asserting a design choice rather than a behaviour.
- **A code review of the harness would not have.** The harness behaved correctly; it recorded the
  denials and the empty stores faithfully. The defect is in what the *session* was given.
- **Reading the brief would not have.** It reads well. The types, their purposes and their
  `record_when` prose are all clear — a human reader knows the command already, so the omission is
  invisible to the person best positioned to spot it. `0019` is the same blind spot.
- **A test *would* have caught the second half**, and saying so is an argument for one: a test that
  installs the hook into a throwaway store and asserts the script's resolved invocation matches the
  documented allowlist prefix would have failed here. That test does not exist.

## Consequences and constraints

- **The brief cannot be fixed by adding a sentence without deciding what the sentence says.** If the
  brief names `asc record`, the command must be runnable as written in every project that installs
  the hook — which depends on the allowlist, which depends on the *user's* settings.json, which
  ascend does not own. `asc install-hook` appends rather than rewrites, so a project may have the
  hook and not the allowlist entry. Naming the command in the brief and leaving the permission to
  the user converts a discovery problem into a denial problem, which is worse.
- **The two beads are one decision.** `asc-uftd` (the brief) and `asc-l38f` (the script) are the two
  halves of a single route; fixing either alone leaves a session that complies and is refused, or a
  session that is permitted and does not know it. They are filed separately because the fixes touch
  different files, and they should be decided together.
- `spike/ev16-arms.mjs` is uncommitted working state, and EV-30 is the only record of this run.

## Links

- Beads: `asc-uftd` (the brief), `asc-l38f` (the hook script), `asc-kzvi` (the harness ceiling that
  cut arm G short)
- Evidence record: `docs/evidence/EV-30.md`
- Measurement bead: `asc-4so.3`
- Entry recorded at the time: `e0cd54a9-2c11-402f-8c71-d360f1e4931c` (`evidence_record`)
- Related: `dogfood/0019` (a reviewer route that never names the reporting tool), `dogfood/0023`
  (`asc install-hook`'s consent text, the same script's other defect), `dogfood/0003` (recording is
  never one step — the friction this makes worse)
