/**
 * The normalized event: what a harness adapter turns its raw log into, and the only thing a
 * handler may match on (asc-6ola.12).
 *
 * Harness-neutral by construction: nothing here names Claude Code. An adapter maps its own
 * records onto these kinds; a handler written against them runs unchanged over any adapter that
 * emits them, live or replayed.
 *
 * FLAT RATHER THAN NESTED. A handler addresses a field by name (`head`, `argv.1`), and the
 * registry below is what lets the loader refuse a name that no event of the handler's kind
 * carries. A typo in a field name is otherwise a `where` that is silently never true -- a
 * handler that runs green and matches nothing, which is the severity-zero class.
 *
 * THE STREAM KEY IS `(session_id, agent_id)`. A subagent's transcript carries its parent's
 * session id, so `session_id` alone merges two conversations. `seq` and `call` count within one
 * stream, and every window is defined over `call` within one stream -- never over file order or
 * timestamps (asc-6ola.5, requirement (b)).
 *
 * PER-RECORD FACTS ONLY, IN THE DOCBLOCKS BELOW (asc-mg1b). What is said of a field here is what
 * is true of ONE record: what the field means, which record carries it, how the adapter sets it.
 * A FREQUENCY claim about a population -- *always*, *never*, *every*, *most*, *usually*, *absent
 * on* -- needs the sweep it came from named beside it, and a claim with no sweep is removed rather
 * than softened. `dogfood/0079` is the reason this is written down: `hook.delivery`'s docblock
 * stated three properties of the population it would fire on, from three records read only to work
 * out the field's *type*, and all three were false the first time the corpus was counted. The type
 * generalises from a handful of records; the values do not.
 */

/** A field's value type, as the loader checks a handler's literal against it. */
export type EventFieldType = 'string' | 'number' | 'boolean' | 'array';

/** What kind of tool call an event belongs to, independent of the tool's own name. */
export const EVENT_ROLES = ['exec', 'read', 'edit', 'search', 'spawn', 'ask', 'other'] as const;
export type EventRole = (typeof EVENT_ROLES)[number];

/** `agent_id` of the stream a session's own transcript produces. */
export const MAIN_AGENT = 'main';

/** Fields every event carries, whatever its kind. */
export const ENVELOPE_FIELDS: Readonly<Record<string, EventFieldType>> = {
  kind: 'string',
  session_id: 'string',
  agent_id: 'string',
  /** Position in the stream, from 0. Total order within one `(session_id, agent_id)`. */
  seq: 'number',
  /**
   * The tool call this event belongs to, from 1 in the order calls started. 0 before the first
   * call. Every event of one call shares it.
   */
  call: 'number',
  /** The assistant message that issued the call, from 1. Calls issued together share it. */
  batch: 'number',
  ts: 'string',
  /** The adapter's derivation version. A count moves when this moves, with no handler changed. */
  derive_version: 'number',
  /**
   * The compaction segment within the stream, from 0: it advances at each `segment.start`. The
   * holdout unit asc-6ola.4 settled on, so a handler can stratify by it (asc-73cb).
   */
  segment: 'number',
};

/**
 * Every kind, and the fields it carries beyond the envelope. A field may be absent on a given
 * event (the transcript did not carry it); absent is never written as a default.
 */
export const EVENT_KINDS: Readonly<Record<string, Readonly<Record<string, EventFieldType>>>> = {
  /** The user's own message. */
  'prompt.submit': { text: 'string' },
  /**
   * `skill` is the skill a skill-loading call names.
   *
   * `head` and `argv` are the shell command an `exec` call is about to run, so a PRE-tool-use
   * handler can be selective about a command before it runs (asc-hvnx). Both are ABSENT on a call
   * that is not an `exec`, rather than empty -- a handler matching `head` on a `Read` is then
   * matching nothing, not matching a default.
   *
   * **`argv` is the command's tokens FLATTENED ACROSS ITS SEGMENTS, which is deliberately not what
   * `command.run`'s `argv` is.** That event is one per executed segment and carries `index`; this
   * is one per call and has no index, so a per-segment choice would have to pick one. Picking the
   * first is the trap this field exists to avoid: MEASURED 2026-10-15 over 2,496 transcript files,
   * of 162,906 `Bash` calls, `[git, commit]` is in the first segment on 306 and ONLY in a later
   * segment on 3,508 -- so an `argv` holding segment 0 alone makes the commit predicate miss 92%
   * of commits, and a nudge built on it reads as working. Flattening costs, on the same corpus,
   * 36,136,724 bytes of JSON against 12,183,082 for the first segment alone, 0.381% of an 8.84 GiB
   * log, and `head` is `argv`'s first token either way.
   *
   * A flat token list also loses the segment boundary, and that is the price: `followed_by` cannot
   * see that two tokens were in different commands. It errs toward matching -- `echo git commit` in
   * ONE segment matches `[git, commit]` -- which is the same loose-inner-match direction
   * `handlers/beads-context-used.yaml` states for its own predicate.
   */
  'tool.use.start': {
    tool: 'string',
    id: 'string',
    role: 'string',
    skill: 'string',
    head: 'string',
    argv: 'array',
  },
  /**
   * `is_error` is the harness's flag, kept under the harness's name. It is not an exit status.
   *
   * `bytes` is the UTF-8 byte length of the result text the model received, which is what lets a
   * handler count the context a tool spent (asc-09wx.8.4). It is the same quantity under the same
   * name as `hook.context`'s `bytes`: both say how much text one record put in front of the model.
   * ABSENT, never `0`, when the record carried no result text -- a zero-byte result and a result
   * the harness did not write are different facts.
   */
  'tool.use.end': {
    tool: 'string',
    id: 'string',
    role: 'string',
    is_error: 'boolean',
    bytes: 'number',
  },
  /** One per executed segment of a shell call. `is_error` belongs to the whole call. */
  'command.run': {
    id: 'string',
    head: 'string',
    argv: 'array',
    index: 'number',
    is_error: 'boolean',
  },
  'search.run': { id: 'string', via: 'string', pattern: 'string', hits: 'number' },
  'file.read': { id: 'string', tool: 'string', path: 'string' },
  'file.changed': {
    id: 'string',
    tool: 'string',
    path: 'string',
    before: 'string',
    after: 'string',
  },
  /**
   * A check (test, lint, typecheck) ran. `verdict` is present only when `verdict_state` is
   * `measured`; `verdict_source` says whether it was the check's own exit status or its output.
   * There is deliberately no success boolean (asc-6ola.6).
   */
  'check.run': {
    id: 'string',
    runner: 'string',
    verdict: 'string',
    verdict_state: 'string',
    verdict_source: 'string',
    /**
     * The files the check named as its targets (`vitest run a.test.ts`), absent when it named
     * none and so ran over its whole config (asc-gtnu.10). As written in the command: relative
     * to where the check ran, unlike `file.changed`'s absolute `path`.
     */
    paths: 'array',
  },
  /** A subagent was started. `child_agent_id` is the `agent_id` of its own stream. */
  'agent.spawn': {
    id: 'string',
    child_agent_id: 'string',
    agent_type: 'string',
    description: 'string',
    model: 'string',
    async: 'boolean',
  },
  /** A subagent finished and its result reached this stream. */
  'agent.return': {
    id: 'string',
    child_agent_id: 'string',
    status: 'string',
    tokens: 'number',
    tool_uses: 'number',
    duration_ms: 'number',
  },
  /**
   * The model and harness version serving this stream, emitted when either first appears or
   * changes (asc-6ola.10). It is the stratification key for a holdout comparison.
   *
   * Both are STRINGS, never enums -- the same `VOCABULARY_IS_NOT_OURS` argument as `agent_type`,
   * and with a measured instance of why: one model is spelled `deepseek-v4.1-flash` here and
   * `deepseek-v4.1-flash:cloud` on `agent.spawn.model`. Two fields naming one model differently
   * is a reason to carry the string through, not to normalise it in the adapter.
   *
   * `previous_model` is present only on a model CHANGE, so its absence on the stream's first
   * emission and its presence later mean different things and neither is a default.
   */
  'model.context': { model: 'string', previous_model: 'string', harness_version: 'string' },
  /**
   * One finding a reviewer reported, from the harness's own `ReportFindings` tool call
   * (asc-gtnu). ONE EVENT PER ELEMENT of `findings[]`, not one per call -- so a window can
   * `first` on a single finding and an `emit` can name its fields with no `each` fan-out.
   *
   * `id` is the `tool_use` id and is therefore SHARED by every finding in one call, exactly as
   * `command.run`'s is: a finding is addressed by `(id, index)`, and `index` is its position in
   * `findings[]`. An `id` alone would name the call, not the finding.
   *
   * `category` is the harness's own field name and carries its raw string, which the harness
   * does NOT constrain -- `is_error` on `tool.use.end` is the same decision for the same reason.
   * The nine lens slugs `review_finding.class` accepts are OUR closed vocabulary, and the
   * mapping from this string to that enum happens in the deriver, which is the only place that
   * can count a value outside it. Closing the vocabulary here instead would turn the day a
   * tenth lens ships into a dropped event rather than a recorded one.
   *
   * UNEXERCISED, and this is a measurement rather than a caveat: `ReportFindings` has been
   * called 0 times across 1,236 transcript files re-measured 2026-09-26, so this field set comes
   * from the tool's declared schema and NOT from an event anyone has seen. The first reviewer to
   * report is the first evidence that the shape above is right.
   */
  'review.finding': {
    id: 'string',
    index: 'number',
    category: 'string',
    file: 'string',
    line: 'number',
    summary: 'string',
    failure_scenario: 'string',
    verdict: 'string',
    level: 'string',
    /**
     * The model of the record that made the call, as `review_finding.reviewer_model` holds it in
     * the store (asc-gtnu.11), so the log can stratify findings by reviewer model too.
     */
    reviewer_model: 'string',
  },
  /**
   * The stream's context was compacted, and the events after it belong to segment `index`.
   * `trigger` is the harness's own (`auto`, `manual`). Segment 0 has no such event: it starts
   * with the stream.
   */
  'segment.start': { index: 'number', trigger: 'string' },
  /**
   * A hook ran, read from the harness's own `attachment` record whose `attachment.type` is
   * `hook_success` (asc-xn4g). It is what makes a delivery checkable: the record names the event
   * and the exact command, and carries the text the hook produced.
   *
   * **The payload is not here, and its absence is the point.** Replay judges a delivery by
   * re-running the handlers, recomputing the sentence it would have said, and comparing `sha256`
   * against that -- equal is *delivered verbatim*, `bytes` shorter than the recomputed length is
   * *truncated*, no event at all is *not delivered*. So `bytes: 0` is a real and distinguishable
   * outcome rather than a missing value, and it is common. Storing the text instead would put every
   * hook's output in the event log, which is measured rolling at ~1.33 MB/day (`EV-39` Q1); this
   * population carries 2,170,732 bytes of it, mean 25.0 and max 3,756 per delivery.
   *
   * **`bytes: 0` has a SECOND cause, and this kind cannot name it.** `bytes` here is the hook's own
   * output length; the record that says what reached the MODEL is a different one, and `hook.context`
   * is that record. Measured 2026-10-15 over 2,496 files: all 672 attached contexts have at least one
   * `hook_success` in the contiguous attachment cluster before them, 1,260 records between them, 743
   * with no content at all and 517 carrying text. So a reader asking "did this hook put anything in
   * front of the model" reads this event AND `hook.context`, and `bytes` alone answers a narrower
   * question than it looks like. `hook.context`'s docblock has the run in which the two records
   * disagree about one delivery.
   *
   * MEASURED 2026-10-12, read-only over the real corpus, 30 days (2026-09-12 -> 2026-10-12):
   * 86,877 `hook_success` attachments. `hook_event` is PreToolUse 46,871 / PostToolUse 35,895 /
   * UserPromptSubmit 1,295 / Stop 1,254 / SessionStart 986 / SubagentStop 585, and is never absent
   * and never empty. 20,084 of the 86,877 carry no text at all. `exit_code` is 0 on all of them,
   * which is what `hook_success` means -- a hook that failed is a separate
   * `hook_non_blocking_error` attachment (15 in the same window), and this kind does not read it.
   *
   * `id` is the `toolUseID` the hook ran under, and it is present on ALL 86,877 -- including every
   * `SessionStart`, which has no tool call of its own, so this is NOT a `tool_use` id on that
   * event. Its SHAPE belongs to the streaming harness rather than to the hook event: ascend's own
   * transcripts spell it `call_...` (6,961 PreToolUse) while this machine's `grizzly` and `mast`
   * transcripts spell the same event `toolu_...` -- the same `VOCABULARY_IS_NOT_OURS` divergence as
   * `model.context`'s. All 4,120 `SessionStart`/`Stop`/`UserPromptSubmit`/`SubagentStop` deliveries
   * carry a UUID instead. So it joins a delivery to the `decided` record the dispatcher wrote
   * before it ran, because both are the same `toolUseID`, but it reaches `tool.use.start` only on
   * PreToolUse and PostToolUse, and only in a `call_...`/`toolu_...` form.
   *
   * `command` is the harness's own string, the same `VOCABULARY_IS_NOT_OURS` decision as `category`
   * on `review.finding`, and here it is not hypothetical: ascend's own hook is 197 of the 86,877
   * (0.23%). One person's iTerm2 status hook is 76,054 (87.6%). A reader who wants deliveries BY
   * ascend has to filter on this field, and this field is the only thing that can say so.
   */
  'hook.delivery': {
    id: 'string',
    hook_event: 'string',
    command: 'string',
    exit_code: 'number',
    bytes: 'number',
    sha256: 'string',
  },
  /**
   * The context a hook ATTACHED, one event per `hook_additional_context` attachment record
   * (asc-09wx.8.4). A different record from `hook.delivery`, and that is why this is a kind rather
   * than a field on that one.
   *
   * MEASURED 2026-10-15, read-only over this machine's `~/.claude/projects` (2,496 files): 672
   * `hook_additional_context` records, every one carrying `content` as a ONE-ELEMENT ARRAY of
   * strings.
   *
   * **The records written for ONE hook run disagree about it, and none of the others holds what was
   * attached.** Three consecutive records of a run in this checkout's own transcript: a
   * `hook_success` with empty `content`; a SECOND `hook_success` carrying the same `toolUseID` and
   * 3,567 bytes of the hook's own output; and the `hook_additional_context` whose `toolUseID` is
   * `SessionStart` and whose content -- the wrapper below -- is 1,538 bytes. The model was handed
   * those 1,538 and neither of the other two.
   *
   * So the two records do not join, and the join is not merely lossy. `toolUseID` here is the hook
   * EVENT NAME on 632 of the 672 (SessionStart, PostToolUse, PreToolUse), which is not the id the
   * sibling `hook_success` carries, and two `hook_success` records can hold ONE `toolUseID` between
   * them. Every one of the 672 has at least one `hook_success` in the contiguous attachment cluster
   * before it -- 1,260 records, 743 carrying no content at all and 517 carrying text -- so a reader
   * summing `hook.delivery.bytes` near a delivery gets a number that has nothing to do with what
   * the model read. That false reading is what this kind exists to replace, and it is why this is a
   * pure parse of ONE record: no correlation, and no assumption about which record came first.
   *
   * `bytes` is the byte length of the content this record carries, which IS what reached the model,
   * on both arms below. `persisted` says which arm: when the harness judges a delivery too large to
   * inline it writes the text to a file and puts a `<persisted-output>` wrapper holding a 2 KB
   * preview in the stream instead, so on that arm `bytes` is the WRAPPER's length and is small by
   * construction. The 672 split 313 persisted against 359 inlined, and the persisted lengths cluster
   * at 1,289-1,922 bytes. The wrapper is matched rather than inferred from its size, because a hook
   * whose own output happened to begin that way would otherwise be filed as persisted.
   *
   * The persisted file's PATH is deliberately NOT a field. A `where` compares a field against a
   * literal and never against another field, so a `path` here could not be joined to the
   * `file.read` that read the file back -- `EV-54` measured 8 tool calls naming a persisted hook
   * file -- and a field that looks like it makes that join expressible is worse than an absent one.
   * `bytes` and `persisted` are what a handler can actually use.
   */
  'hook.context': {
    hook_event: 'string',
    hook_name: 'string',
    bytes: 'number',
    persisted: 'boolean',
  },
  /** Synthetic: the stream ended. What closes every window still open. */
  'session.end': {},
};

/** A value an event field can hold. */
export type EventValue = string | number | boolean | readonly string[];

/** One normalized event. The envelope is typed; the kind's own fields are looked up by name. */
export interface NormalizedEvent {
  readonly kind: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly seq: number;
  readonly call: number;
  readonly batch?: number;
  readonly ts?: string;
  readonly derive_version: number;
  readonly [field: string]: EventValue | undefined;
}

/** The type of `field` on events of `kind`, or `undefined` when that kind has no such field. */
export function eventFieldType(kind: string, field: string): EventFieldType | undefined {
  return ENVELOPE_FIELDS[field] ?? EVENT_KINDS[kind]?.[field];
}
