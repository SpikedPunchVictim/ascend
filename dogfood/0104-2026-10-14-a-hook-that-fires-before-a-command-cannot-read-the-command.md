# 0104 — A hook that fires before a command cannot read the command

| | |
|---|---|
| **Bead** | `asc-hvnx` |
| **Surfaced** | 2026-10-14 |
| **Surfaced by** | writing `handlers/session-commit.yaml` (`asc-09wx.10`) and asking, from its own header, what a handler at the *other* moment could match on |
| **Entry type(s)** | none — this finding is about the event vocabulary, not about an entry |
| **Severity** | P3 |
| **Status** | open |

## What was found

**A handler cannot be selective about a shell command *before* that command runs.** The one event
kind that carries `argv` is `command.run`, and `pre-tool-use` does not deliver it. The only kind
`pre-tool-use` delivers is `tool.use.start`, whose fields are `tool`, `id` and `role`. So the
narrowest predicate a pre-command handler can express is `tool: {eq: Bash}` — which matches every
Bash call the session makes, whether or not it is the call the handler was written for.

The command text is **not** missing at the boundary, and this is the part that makes the finding
worth a record rather than a shrug. `toolRecords` in the adapter puts the hook's entire
`tool_input` into the synthetic `tool_use` record it hands the normalizer, so at `pre-tool-use` the
normalizer *is given* `{command: 'git commit -m "a b"'}`. What comes out of it is
`{tool: "Bash", id: "toolu_1", role: "exec"}`. The command is dropped by the **event**, not by the
harness and not by the hook input.

## How it surfaced

`handlers/session-commit.yaml` is written on `on: command.run`, and its own header has to say why
it is not the nudge — the row exists only *after* the commit landed. Writing that sentence turned
it into a question with an answer nobody had: *what could a handler at the other moment match on?*
Three plausible selectors were tried against the strict loader, and one loaded.

**Nobody was looking for it.** The work in progress was landing a post-commit handler; this is the
absence of its counterpart, and an absence is exactly the shape a code review does not produce,
because there is no line to point at. It was found only because the artifact was made to justify
its own bucket in prose — the sentence *"it is not the nudge and cannot be"* is what had to be
defended, and the defence is what did not hold up.

## The metric

**The selector matrix.** Four `pre-tool-use` handlers with `say:` and `stage: pre`, loaded through
the strict loader (`loadHandler` + `sayStage`, both from `packages/cli/dist`):

```
REFUSED  stage: pre + argv contains commit  -> where.argv: tool.use.start has no field "argv"
REFUSED  stage: pre + argvs field  -> where.argvs: tool.use.start has no field "argvs"
REFUSED  stage: pre + head git  -> where.head: tool.use.start has no field "head"
LOADS    stage: pre + tool Bash  -> pre-tool-use
```

**What the one loadable selector yields**, for the same Bash call a commit handler is written for
(`hookEvents('pre-tool-use', …)` with `tool_input: {command: 'git commit -m "a b"'}`):

```json
[
  { "kind": "tool.use.start", "session_id": "s", "agent_id": "main", "seq": 0, "call": 1,
    "derive_version": 12, "segment": 0, "batch": 1,
    "tool": "Bash", "id": "toolu_1", "role": "exec" },
  { "kind": "session.end", "session_id": "s", "agent_id": "main", "seq": 1, "call": 1,
    "derive_version": 12, "segment": 0 }
]
```

No `argv`, no `head`, and the call is left unfinished — no result is invented for it, which is
deliberate and correct. The second event is the drain closing a session the hook input never
opened.

**The cost of the narrowest available predicate**, `asc handlers check <handler> --all-projects`,
2026-10-14, over the live corpus:

```
pre-bash  rows                               158242
pre-bash  triggers                           158242
(log)     files                              2275
(log)     events                             1363265
```

and the same replay for the commit predicate the handler is actually written for, in the next pass
over the same corpus:

```
session-commit  rows                               4483
session-commit  triggers                           4483
(log)     files                              2275
(log)     events                             1363272
```

**4,483 of 158,242 — 2.8%.** A handler that can only say *"you are about to run a Bash command"*
is right 2.8% of the time and fires 35 times for every time it is right. The two events counts
differ by 7 because the corpus is live and this session is writing into it; the row counts are what
the finding rests on.

## The pattern

**Where a derived event's shape includes a field that only exists *after* the fact, the event
cannot be delivered before the fact — and the field it needed to be useful is not the field that
gates it.** `command.run` carries `is_error`, which cannot exist pre-call, so its emit sits inside
the `tool_result` handler; and the consequence is not that `is_error` is missing pre-call, but that
`argv` is. The cost lands on a field that had nothing to do with the decision.

The class is worth naming because it recurs wherever a normalizer derives an event from a
*completed* pair rather than from a call: `tool.use.end`, `check.run` and `search.run` all read
results, and `tool.use.start` is the only kind that does not — which is exactly why it is the only
kind `pre-tool-use` can deliver. **A stage's vocabulary is not chosen; it falls out of which events
are result-free.**

## Why nothing else would have caught it

The suite is green and stays green: nothing in it asserts that a pre-command handler *is*
expressible, and a refusal is not a failure. `sayStage`'s own tests (`project-handlers.test.ts`)
cover the refusal that exists — `stage: pre` on a kind no pre stage delivers — and this finding is
one level down, about the *fields* of the one kind that is delivered. A reviewer reading
`HOOK_STAGES` would see a stage that works as documented.

What would have caught it is a test that a `stage: pre` handler **can express a predicate about
something other than the tool name**, which no design has ever asked for because the only live say
handler runs at `post-tool-use` (`asc-eve4`'s close reason records that no handler opts into
`stage: pre` at all). The gap sat behind a feature nobody had yet used.

## Consequences and constraints

**This is not a forgotten line, which is why the record does not end in a patch.** `command.run`'s
shape includes a result-derived field, so the emit is gated on the result by design, and
`hook-input.ts` states the rule in its own docblock: a pre call *"normalizes to the start alone — a
handler reading an end there would be reading a result that does not exist yet."* Making a
pre-command handler expressible means changing what an event carries, not fixing a branch.

**A precedent exists for exactly that change.** `tool.use.start` carries `skill` on a `Skill` call
for one reason — so `review-finding-nudge` can match *which* skill loaded (`asc-tuur.2`). The same
shape could carry the command's head, or a result-free `command.about.to.run`, and the argument for
it is the same argument that put `skill` there.

**The cost is a version bump and a re-derivation.** `tool.use.start`'s fields are covered by
`EVENT_DERIVE_VERSION`, so widening them re-derives the recorded corpus. That price is the reason
this is filed as a decision rather than applied: **`asc-hvnx` is P3 and its only blocked work is
`asc-09wx.12`, also P3** — a holdout experiment for a nudge that does not yet exist. Nothing else
in the repo asks for a pre-command handler today.

**No entry type is affected**, so `entries_are_immutable` does not bite here: this finding is about
the event vocabulary and the handler DSL, and it corrects no stored row.

## Links

- Bead: `asc-hvnx` (P3, open) — blocks `asc-09wx.12`
- The artifact that forced the question: `handlers/session-commit.yaml` (`asc-09wx.10`, closed)
- The other half of the pair: `docs/evidence/EV-65.md` (`asc-09wx.4`)
- The refusal this finding sits one level below: `sayStage`, `packages/cli/test/project-handlers.test.ts`, `asc-eve4`
- The precedent for widening a start event: `asc-tuur.2` (`tool.use.start` carries `skill`)
