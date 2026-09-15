# EV-9: can the five derived entry types be extracted from real transcripts — at what N, and under what rule?

**Question**    `asc-qib` specifies five entry types derived from Claude Code transcripts:
                `tool_denial`, `verification_run`, `context_compaction`, `skill_activation`,
                `user_correction`. Three things were unknown:

                1. **N.** For each type, how many entries does the real corpus actually yield? A type
                   with tens of entries cannot support a pattern, however sound its definition.
                2. **Identity.** A derived type's N is its count of DISTINCT PER-EVENT IDENTIFIERS,
                   never its line count. Which identifier is per-event is a per-type question, and
                   getting it wrong inflates N — measured: `attributionSkill` appears on 6,395
                   transcript records and yields **87** activations, because a skill that stays
                   active across 54 consecutive messages is ONE activation.
                3. **The extraction rule for `verification_run`.** "A check command ran" is not a
                   reading; it is a judgement, and the corpus does not make it.

**Method**      The production deriver (`createDeriver`, `packages/adapter-claude-code`) driven over
                `~/.claude/projects` **read-only** through `streamCorpus`, with every emitted entry
                validated against its own `TypeSpec` using core's `validateEntry`. No fixtures: the
                input is the real 1.19 GiB corpus.

                Scripts: `/tmp/qib/drive.mjs` (the end-to-end drive), `facts.mjs` (per-property
                coverage), `decomp.mjs` / `why122.mjs` (the heredoc decomposition), `ab.mjs` (the
                controlled A/B). Throwaway, aggregates-only; no raw transcript text was returned to
                anything that prints, per the reader's contract.

                **The corpus is LIVE.** `~/.claude/projects` gains this session's own transcript as
                it runs, so any two-arm comparison over two sweeps is confounded by drift — measured:
                72,009 → 72,011 → 72,014 Bash commands across minutes. Every A/B below therefore runs
                **both arms over one frozen input**, or walks the corpus once with both derivers in
                the same process.

## Measurement

Corpus sweep, 2026-09-15, shipping build:

| | |
|---|---|
| transcript files | **843** |
| bytes | **1,279,984,678 (1.19 GiB)** |
| records | **431,039** |
| wall clock | **5.2 s** |
| malformed / failures | **0 / 0** |

Entries, all validated against their own definitions:

| type | N | per-event identity | shape |
|---|---|---|---|
| `verification_run` | **486** | session + `tool_use_id` | EVENT |
| `tool_denial` | **457** | session + `tool_use_id` | EVENT |
| `context_compaction` | **438** | session + record `uuid` | EVENT |
| `skill_activation` | **87** | session + first record `uuid` | EVENT |
| `user_correction` | **20** | session + record `uuid` | EVENT |

**1,488 entries, 0 invalid, 0 warnings, 0 duplicate keys, 0 unkeyable, 0 unverdictable, 6 key
collisions.** Property coverage is reported rather than assumed, because a required property that is
always present and an optional one that is always present are different facts:

| | |
|---|---|
| `occurred_at` | **1,488 of 1,488** (present, and deliberately not `required`) |
| `tool_denial.tool_name` | 457 of 457 (join-dependent, so not `required`) |
| `tool_denial` kinds | permission-rule 228, user-rejected 160, automode-unavailable 39, automode-blocked 30 |
| `context_compaction.discovered_tools` | **282 of 438** — absent on the other 156, and the absence is not an empty list |
| `skill_activation.agent` | **51 of 87** — the other 36 are the main thread, which is not an empty string |
| `verification_run.previous_verdict` | **134 of 486** — omitted on a first verified pass |
| `user_correction.tool_name` | 20 of 20 |

### The rule, and why it is a judgement

Five defensible rules, one corpus, for `verification_run`:

| rule | N |
|---|---|
| count `node -e` one-liners as runners | 16,352 |
| match a check token anywhere in the command text | 10,893 *(of 72,014 commands)* |
| a newline always ends a command | 6,940 |
| …and a heredoc BODY is not a command | 6,826 |
| …and only a verdict CHANGE, or a first verified pass, is an entry | **486** |

Nothing in the data picks between them. The filter does. The corpus contains **6,826** commands that
run a check and **486** moments where the gate actually moved; the difference is 6,340 rows of a
red-green loop recording its own keystrokes.

### The controlled A/B — heredoc bodies are file contents, not commands

A newline is a command separator, so splitting on one turns the body of `cat > x.mjs <<'EOF'` into
segments, and a body containing the line `pnpm test` then reads as a check that ran. Arm A is the
shipping build with **one line** changed (`if (opened !== null)` → `if (false)`, so the body-skip
never arms); the two `dist` trees are otherwise identical, which is what makes this an experiment
rather than two unrelated runs.

Both arms over one **frozen list of 72,014 Bash commands**:

| | segments | commands that check | entries |
|---|---|---|---|
| arm A — a newline always ends a command | 922,333 | 6,940 | 493 |
| arm B — heredoc bodies skipped | **424,353** | **6,826** | **486** |

**497,980 of those segments (54%) are file CONTENTS rather than commands.** 12,818 heredoc openers
hold 462,574 body lines; **149** of those lines match a check label, and **145 of the 149 sit in the
122 commands whose label the rule changes** (the other four are in commands whose own head already
resolved to the same label).

Both arms were then walked over the corpus in one process, back to back, on the same records:

| type | arm A | arm B | delta |
|---|---|---|---|
| `verification_run` | 493 | **486** | **−7** |
| all four others | — | — | **0** |

Seven rows, isolated to the one type the mechanism can reach. The rule removes **7 fabricated
`verification_run` entries** — entries asserting a check ran when what happened is that someone wrote
a file. Seven is a small number and the reason to fix it is not its size: a ledger that fabricates
events is not one anything else in this project can be trusted against.

## Decision

**GO — all five types ship**, and the extraction rules above are the ones they ship with.

- **`verification_run` is verdict-change-only**, with the cost stated in the type's own description.
- **Heredoc bodies are skipped.** The cost is recorded rather than hidden: an unterminated opener
  swallows the rest of the command, so a check after it is missed — measured, **5 of 12,818 openers**
  are unterminated. False negatives, not fabrications: the safe direction, and still an error.
- **Machine-emitted vocabularies are `string`, never `enum`** (`denial_kind`, `trigger`, `skill`). A
  closed list of the values that existed on 2026-09-15 would turn the next new value into a REJECTED
  entry. The vocabulary of denial kinds belongs to Claude Code; the set of skills belongs to the
  user. Only `verdict` is an enum, because it is ours.
- **Absence and zero stay distinguishable.** `discovered_tools`, `agent`, `tool_name` and
  `previous_verdict` are omitted when the transcript does not carry them, and no required count is
  ever filled with `0`. This is the `asc-qib` requirement, and it is enforced by the three-state
  model rather than by convention.
- **`user_correction` ships with its limitation in its own description**: all 20 carry a
  `tool_denial` for the same event, so it is **not an independent corpus** and a count over
  corrections must not be corroborated by a count over denials.
- **No rule was added for an unmeasured case.** `npm run -w pkg test` is valid npm and is not
  recognised, because a flag placed after `run` defeats the flag skip. Measured: **0 of 72,014**
  corpus commands have a flag after `run`. The limitation is recorded in `derive.ts` rather than
  "fixed" with an untested branch.

## Confidence

What this establishes: five types extract from real transcripts at usable N, every entry validates
against the definition it claims, and the counts are the output of rules stated in the code.

What it does **not** establish:

- **The `occurred_at` coverage figure was false-green before it was true** — see below. It is reported
  here because a coverage number that was once measuring the wrong field deserves to carry that fact.
- **One corpus, one user, one machine.** n ≥ 2 still does not hold. Every N here is over-fit to this
  user's workflow.
- **N is not viability.** 87 activations and 20 corrections are small; whether a pattern emerges at
  those N is `EV-3`'s question, and `EV-3` answered it negatively for corrections.
- **Every number is a measurement with a date.** The corpus grows while this is read (measured:
  `tool_denial` rose 456 → 457 between two runs minutes apart, and the final drive moved
  `context_compaction` 437 → 438). The counts in the source are dated 2026-09-15 for that reason.
- **The rules are tested against fixtures, and against the corpus, but not against a second corpus.**
  `derive.test.ts` proves each rule on hand-built records; `derive-real-corpus.test.ts` proves the
  rules and the definitions agree on data nobody chose. Neither proves the rules generalise to
  another user's command vocabulary.

## What this overturned

**A false-green in ascend's own coverage reporting, found by a unit test rather than by a sweep.**

`emit` built its property bag as `{...properties, session_id, project}` and never wrote
`occurredAt` — while `derived-types.ts` stated that `occurred_at` was present on every entry, and a
drive "confirmed" it at 100 %.

Both were wrong, and the drive was wrong in the way this project rates severity-zero. It was
measuring the **envelope** field `DerivedEntry.occurredAt`, not the stored **property**. Every entry
in the store would have had `occurred_at` as `not_measured` while the sweep reported full coverage —
a green number computed over the wrong object.

It was caught by `derive.test.ts`, which asserts on the emitted properties rather than on the
envelope, and the fix is one spread in `emit`. Re-driven after the fix: `occurred_at` **1,488 of
1,488**. Recorded rather than quietly repaired, because the class — *a check that reports success
while measuring something else* — is the one that destroys trust in every other signal.

## Limitations, stated plainly

- **The heredoc A/B mutates a compiled artifact.** Arm A was produced by patching one line of
  `dist/derive.js`, not by reverting the source. The two trees were verified to differ by exactly
  that line; the source tree was never mutated for this comparison.
- **The frozen command list is a snapshot of 72,014 commands**, taken before the final drive. Its
  absolute counts therefore differ from the live corpus by the drift above (72,072 at the last
  count); its *comparison* is what it is for, and both arms saw identical input.
- **The 7-entry effect is measured over a live walk, not a frozen one.** Both arms ran in one process
  on the same 431,016 records, which removes inter-run drift; the mechanism is corroborated by the
  frozen-input label deltas, where the input is provably identical.
- **`derive.test.ts` pins the rules; it cannot pin the corpus.** Numbers that move are asserted as
  floors and invariants in `derive-real-corpus.test.ts`, never as counts.
