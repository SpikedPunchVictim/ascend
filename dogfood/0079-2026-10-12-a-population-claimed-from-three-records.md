# 0079 — a population property written into a docblock from three records

| | |
|---|---|
| **Bead** | `asc-mg1b` |
| **Surfaced** | 2026-10-12 |
| **Surfaced by** | `normalize-real-corpus.test.ts`, run to confirm a newly added event kind was green over the real corpus |
| **Entry type(s)** | `review_finding` (`derived`) |
| **Severity** | P3 |
| **Status** | docblock fixed in the working tree; the class is open |

## What was found

`hook.delivery` was added to `EVENT_KINDS` (`packages/core/src/event.ts`) to make a hook
injection checkable in replay (`asc-xn4g`), and its docblock stated three properties of the
population it would fire on. **Three records** — read read-only out of `~/.claude/projects` to
work out the *shape* of a `hook_success` attachment — were enough to design the field set, and
they were treated as enough to state how the field set would behave. All three statements were
false, and the corpus said so the first time it was asked:

1. *"`id` … is ABSENT on a hook that runs for no tool call (every `SessionStart`)."* It is present
   on **86,877 of 86,877**. What a `SessionStart` hook carries is a UUID — an invocation id, not
   a tool-call id.
2. *"carries the stdout that was injected."* `content` **is not the stdout**. It equals `stdout`
   on 9,453 deliveries, `stderr` on 10,631, and neither on the other 66,809.
3. *"UNEXERCISED for ascend's own hook."* It is exercised 86,877 times, of which ascend's own hook
   is 197.

The third is the mildest — it was a caveat, and it was right that it was unmeasured. The first two
are the ones that matter, because each named a **field value** rather than a field's existence:
`id` on a `SessionStart`, and which string `sha256` digests. An implementation built from either
sentence would have compiled, run, and produced events that were quietly wrong in a way no test
in the package could distinguish from a correct one.

## How it surfaced

**Nobody was looking for it.** The run was a confirmation, not an investigation: a new event kind
needs the two corpus tests green, and the corpus test reads `EVENT_KINDS` and rejects any event
whose kind or field name is undeclared (`normalize-real-corpus.test.ts`, the `undeclared` set). It
passed. What it did not do was report **counts**, so the same sweep was then replayed with a
throwaway node script that counted by kind — and printed 86,877 where the design had been based on
three.

The design was correct. That is what makes the mechanism worth recording: the sweep did not
contradict the *design*, it contradicted the *prose attached to it*, and prose is the part nothing
is watching.

## The metric

Read-only over `~/.claude/projects`, 2026-09-12 → 2026-10-12 (30 days), via
`packages/adapter-claude-code/dist/index.js` and `streamCorpus`. Attachment records by
`attachment.type`, verbatim:

```
attachment records, by attachment.type: {"agent_listing_delta":2732,"auto_mode":1418,"auto_mode_exit":1,"bash_output_audience_note":4329,"batching_reminder_sent":2945,"command_permissions":105,"compact_file_reference":2504,"credential_org":1662,"date":2929,"date_change":65,"deferred_tools_delta":4864,"deferred_tools_record":30077,"dynamic_skill":1,"edited_text_file":1292,"environment":12764,"file":2492,"hook_additional_context":516,"hook_non_blocking_error":15,"hook_success":86877,"instructions":2807,"invoked_skills":529,"mcp_instructions_delta":2724,"model":2690,"nested_memory":445,"opened_file_in_ide":2,"output_style":23,"plan_file_reference":204,"plan_mode":76,"plan_mode_exit":20,"plan_mode_reentry":12,"prompt_snapshot":5028,"queued_command":4274,"read_truncation_notice":93,"remote_session_change":2787,"session_context":2786,"silent_turn_reminder":2354,"skill_listing":2295,"task_reminder":2043,"task_status":548,"thinking_drop":256,"thinking_stripped":121,"total_tokens_reminder":100844}
hook.delivery events: 86877  (of 290549 attachment records)
```

`hook_success` is the second most common attachment type in the corpus and **29.9%** of all
290,549 attachment records.

By hook event, and the two fields in question, verbatim:

```
hook_event values: {"PreToolUse":46871,"PostToolUse":35895,"UserPromptSubmit":1295,"Stop":1254,"SessionStart":986,"SubagentStop":585}
with id: 86877  with exit_code: 86877
exit codes: {"0":86877}
bytes: n= 2170732 min= 0 max= 3756 mean= 25.0
```

`content` against the two strings it was said to be, verbatim:

```
content vs stdout: {"differs from both":66809,"content === stderr":10631,"content === stdout":9453}
```

The commonest difference is a trimmed trailing newline. One record, verbatim:

```
{"hookEvent":"SessionStart","command":"/Users/spikedpunchvictim/.config/iterm2/cc-status",
 "content":"Session status updated.","stdout":"Session status updated.\n","stderr":"","exitCode":0,
 "toolUseID":"953b38cd-dea3-49a7-9ffe-da790d42c469"}
```

23 bytes against 24. Hashing `stdout` would have compared a recomputed sentence against a
sentence-plus-newline on every delivery **forever**, and read as a permanent near-miss rather than
as a wrong choice of field.

`id` present on `SessionStart` — the claim that was explicitly false, verbatim:

```
id shape per hook event:
   SessionStart {"uuid":986}
   UserPromptSubmit {"uuid":1295}
   PreToolUse {"other":39926,"call_...":6961}
   Stop {"uuid":1254}
   PostToolUse {"other":30482,"call_...":5426}
   SubagentStop {"uuid":585}
```

`"other"` is not a third kind of id — it is `toolu_...`, and the same event in a different
project's transcripts, verbatim:

```
   20687 -Users-spikedpunchvictim-projects-grizzly-grizzly-pl|PreToolUse|toolu_...
   15733 -Users-spikedpunchvictim-projects-grizzly-grizzly-pl|PostToolUse|toolu_...
    6614 -Users-spikedpunchvictim-projects-ascend|PreToolUse|call_...
    5127 -Users-spikedpunchvictim-projects-ascend|PostToolUse|call_...
     542 -Users-spikedpunchvictim-projects-ascend|SessionStart|uuid
```

Zero-byte deliveries — the reason `bytes: 0` had to be stated as an outcome rather than a gap,
verbatim:

```
zero-byte deliveries, by command: {"rtk hook claude":10114,"/Users/spikedpunchvictim/.config/iterm2/cc-status":9453,"bd prime --hook-json":295,"\"${CLAUDE_PROJECT_DIR}\"/typescript/node_modules/.bin/mast hook claude session-start":150,"node \"/Users/spikedpunchvictim/projects/mast/dist/cli/index.js\" hook claude session-start":67,"[ ! -f \"$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh\" ] || sh \"$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh\" post-tool-use":3,"node \"/Users/spikedpunchvictim/projects/mast/dist/cli/index.js\" hook claude search":1}
```

20,084 of 86,877 (23.1%), every one of them digesting the empty string.

Whose hooks these are — the reason `command` is load-bearing rather than decorative, verbatim:

```
ascend project deliveries: 12598 of 12598
ascend commands:
   10675 "/Users/spikedpunchvictim/.config/iterm2/cc-status"
   1432 "rtk hook claude"
   294 "bd prime --hook-json"
   161 "[ ! -f \"$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh\" ] || sh \"$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh\""
    21 "[ ! -f \"$CLAUDE_PROJECT_DIR/packages/cli/dist/bin.js\" ] || [ ! -d \"$CLAUDE_PROJECT_DIR/.ascend\" ] || node \"$CLAUDE_PROJECT_DIR/packages/cli/dist/bin.js\" types brief"
     9 "[ ! -f '/Users/spikedpunchvictim/projects/ascend/packages/cli/dist/bin.js' ] || [ ! -d '/Users/spikedpunchvictim/projects/ascend/.ascend' ] || '/opt/homebrew/Cellar/node@24/24.18.0/bin/node' '/Users/spikedpunchvictim/projects/ascend/packages/cli/dist/bin.js' types brief"
     3 "[ ! -f \"$CLAUDE_PROJECT_DIR/packages/cli/dist/bin.js\" ] || [ ! -d \"$CLAUDE_PROJECT_DIR/.ascend\" ] || (node \"$CLAUDE_PROJECT_DIR/packages/cli/dist/bin.js\" ingest claude-code >/dev/null 2>&1; node \"$CLAUDE_PROJECT_DIR/packages/cli/dist/bin.js\" types brief)"
     3 "[ ! -f \"$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh\" ] || sh \"$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh\" post-tool-use"
```

ascend's own hook is **197 of 86,877 (0.23%)** — 161 + 21 + 9 + 3 + 3 — and the 76,054 deliveries
of `/Users/spikedpunchvictim/.config/iterm2/cc-status` are **87.6%**.

Every group above is well over `MIN_N` (20, `packages/analysis/src/proportion.ts`), so none of
these is an anecdote. The three records the docblock generalised from are, and are named as such.

## The pattern

**A property of a population stated from an anecdote, in prose that nothing reads.** Not "the
code is wrong" — the code was right — but "the comment describes a world that has not been
sampled". Three instances in one docblock, all in the same commit, all written from the same three
records.

The class is recognisable by its shape: a docblock that says *always*, *never*, *every*, *is*, or
*absent on* about a field, where the basis was a handful of samples read to work out the field's
*type*. The type generalises; the *values* do not. Designing a kind from three records is sound.
Stating a distribution from them is not, and the two are written in the same paragraph, in the
same voice, with nothing to tell them apart.

`review.finding` in the same file has a comparable sentence — *"`ReportFindings` has been called 0
times across 1,236 transcript files re-measured 2026-09-26"* — and that one is safe precisely
because it names its population and its date. It is a measurement of a specific sweep, not a claim
about the world. **The docblock that survives is the one that says which sweep it is talking
about.**

## Why nothing else would have caught it

- **The type system cannot.** Every one of the three statements was about values, not types.
- **`normalize.test.ts` cannot.** It drives synthetic records, so it can only ever confirm what the
  author already believed; a test written from the wrong sentence passes.
- **`normalize-real-corpus.test.ts` is the closest thing and it passed.** It checks that every
  event's kind and field names are *declared*, which is a structural property. It does not report
  counts, so a docblock claiming 3 where the answer is 86,877 is invisible to it.
- **`review_finding`'s nine lenses would not have caught it either**, and that is the interesting
  part: `cross_implementation_divergence` is *the* lens for the `call_`/`toolu_` split and it fires
  on **code**, comparing one implementation against another. Here there is one implementation and
  two prose claims, so the lens has nothing to compare.

A human review *might* have caught sentence 2, because "is not the stdout" is a sharp claim about a
field sitting three lines away from the code that reads it. That is an argument for keeping such
claims short, not an argument that they are safe.

## Consequences and constraints

Nothing was persisted with the wrong value: the corpus records were read, never written, and the
event kind had not been emitted into any store yet — `EVENT_DERIVE_VERSION` moved 11 → 12 in the
same change, so the first derivation under the new version is the first correct one. **There is no
backfill and no invalidated data.** If the kind had shipped a version earlier, the two false
sentences would have been the design, and the digest comparison would have been wrong from the
start with green tests.

The `id`-shape divergence is a real constraint on the replay design, not only on the prose:
`hook.delivery.id` joins the `decided` record the dispatcher wrote (both are the same `toolUseID`,
on every event), but it reaches `tool.use.start` only on `PreToolUse`/`PostToolUse`, and only in a
`call_...`/`toolu_...` form. Any consumer that treats `id` as a `tool_use` id unconditionally is
wrong for 4,120 deliveries.

## Links

- Bead: `asc-mg1b`
- The change the docblock belongs to: `asc-xn4g`, Stage E30.3 in `IMPLEMENTATION_PLAN.md`
- Sibling divergences found the same way: `VOCABULARY_IS_NOT_OURS` on `agent_type` and
  `model.context.model` in `packages/core/src/event.ts`
