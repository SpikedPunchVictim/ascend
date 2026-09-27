# 0019 — the reviewer route CLAUDE.md names never mentions the tool that makes a finding count

| | |
|---|---|
| **Bead** | `asc-gtnu.14` |
| **Surfaced** | 2026-09-27 |
| **Surfaced by** | building the reviewer brief for `asc-gtnu.8`, and a headless probe of whether a reviewer can reach `ReportFindings` at all |
| **Entry type(s)** | `review_finding` (derived) |
| **Severity** | P2 |
| **Status** | fixed by `.claude/skills/lens-review/` (`asc-gtnu.14`); superseded by `handlers/review-finding-nudge.yaml` and the skill removed (`asc-tuur.6`), because sending reviewers to a project skill changed the user's workflow |

## What was found

This is an **absence**. The project `CLAUDE.md` section *"Reviewers report findings with
`ReportFindings`"* says the lenses "are the nine headings in `~/.claude/skills/bug-hunt/SKILL.md`",
so the documented way to run a review is that skill. The skill never names `ReportFindings`. Its
`allowed-tools` leave it out, its Step 7 mandates a Markdown report under `.agents/research/`, and
four of its steps require `AskUserQuestion`, which a headless reviewer cannot answer. So a reviewer
that follows the route `CLAUDE.md` points at writes prose. The same section says prose "is not
counted". The recording half of `asc-gtnu` is reachable only by a reviewer that is told about the
tool somewhere other than where the instruction sends it.

## How it surfaced

`asc-gtnu.8` needed one brief, byte-identical across three arms, and the bead said that brief was
"the 9-lens reviewer instruction already in CLAUDE.md". Reading that instruction's target to turn it
into a prompt showed the target contradicts it. The plan's reconnaissance flagged it as a
*candidate*. Stage 0 then measured the other half: whether the tool is reachable at all once
something does name it.

Nobody was looking for it. The question was "can a headless reviewer call `ReportFindings`". The
route the instruction names came up only because the brief had to be written down word for word.

## The metric

The skill, measured on 2026-09-27 (home directory shown as `~`):

```
$ grep -c "ReportFindings" ~/.claude/skills/bug-hunt/SKILL.md
0
$ grep -rl "ReportFindings" ~/.claude/skills/ | wc -l
       0
$ grep -n "Step 7" -A2 ~/.claude/skills/bug-hunt/SKILL.md
224:## Step 7: Generate the Report
225-
226-Write to `.agents/research/YYYY-MM-DD-bug-hunt-<scope>.md` using the structure in `references/report-template.md`. Display the same content inline. [...]
```

The corpus, from the `asc-gtnu` close (commit `bbd290c`), not re-measured here: `ReportFindings`
called **0 times across 1,236 transcript files and 640,404 records**.

The route that does name the tool, measured in `asc-gtnu.8` Stage 0: two `claude -p` sessions
(`claude-sonnet-5`) given an explicit brief that names `ReportFindings`.

| session | brief | `ReportFindings` calls | findings | `review_finding` entries after ingest |
|---|---|---|---|---|
| `115cb22a` | 4-line fixture | 1 | 2 | 2 |
| `c5cf4106` | `handler.ts`, `spike/recall/brief.md` | 1 | 12 | 12 |

**2 of 2 sessions is an anecdote, under `MIN_N` = 20.** It shows the tool is reachable headless and
that the derived path closes end to end. It does not measure how often a reviewer calls the tool.

## The pattern

An instruction that delegates to a document it does not own, where that document has its own
contradicting instruction for the same step. The delegation holds for the part that was checked
(the lens names) and fails for the part that was not (the output). The same shape would fire for
any `CLAUDE.md` section that says "do X, as described in skill Y" when Y was written before X
existed. The skill is v1.0.0, dated 2026-07-25. The `ReportFindings` section is from `asc-gtnu`,
2026-09-26.

## Why nothing else would have caught it

The recording half is green on fixtures, and a fixture calls the tool by construction. No test can
see which instruction a real reviewer follows. The only evidence that would have shown it is the
zero in the corpus, and `asc-gtnu` read that zero as "no reviewers have run yet", not as "the route
cannot produce one". Both readings fit the zero, and the zero cannot tell them apart.

## Consequences and constraints

The skill lives in `~/.claude/skills/`, outside this repository, so fixing it there is not a change
this repo can make or test. `asc-gtnu.8` works around the gap on purpose: its brief is its own file
(`spike/recall/brief.md`) and names the tool. So the recall it measures is recall **given a brief
that names the tool**, not recall of the route `CLAUDE.md` describes.

## The fix, and its measurement

Recorded 2026-09-27. The fix is a project skill, `.claude/skills/lens-review/SKILL.md`. It holds the
nine slugs, names `ReportFindings`, and allows it in `allowed-tools`. It never asks a question.
`CLAUDE.md` now sends reviewers to that skill and keeps bug-hunt only as the source of the lens
definitions. `derived-types.test.ts` pins the properties that bug-hunt lacks.

`spike/lens-review/probe.mjs` tests it. Each run is one headless `claude -p` session
(`claude-sonnet-5`) in a fresh tree, with the default toolset and Write/Edit denied. The prompt is
written in ordinary words and never names the tool. `before` is the tree with `CLAUDE.md` as of
`e7cc416` and no project skill. `after` is the tree with the fix.

```
run            skills                     RF calls  findings  stored  asked  denials  $
before-hunt    ["bug-hunt"]                      0         0       0      0        2  0.7461
after-hunt     ["lens-review"]                   1         2       2      0        1  0.6594
before-review  []                                2         4       4      0        0  0.6201
after-review   ["lens-review"]                   1         2       2      0        0  0.6157
total spent $2.6413
```

**One session per cell, so four sessions in all: an anecdote, under `MIN_N` = 20.**

- **`before-hunt` reproduces the bug.** "Hunt for bugs" loaded bug-hunt. The session made 0
  `ReportFindings` calls, and its one `Write` call (the Markdown report) was denied.
- **`after-hunt` takes the new route** for the same prompt: it loaded `lens-review` and its
  findings reached the store.
- **"Review" was never broken.** `before-review` loaded no skill and followed `CLAUDE.md`'s own
  instruction to use the tool. So the defect was specific to the bug-hunt route, which is the one
  the old `CLAUDE.md` named.
- **Not measured: thoroughness.** The two `after` sessions reported 2 findings each, against 4
  for `before-review`. That is n=1 per cell, so it is not a finding. But it is the next thing to
  watch, because a route that reports fewer findings would fix the counting and lose recall.

## Links

- Bead: `asc-gtnu.14`
- Found during: `asc-gtnu.8` (`spike/recall/PREREG.md`)
- Parent: `asc-gtnu`, closed not delivered
