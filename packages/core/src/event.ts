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
};

/**
 * Every kind, and the fields it carries beyond the envelope. A field may be absent on a given
 * event (the transcript did not carry it); absent is never written as a default.
 */
export const EVENT_KINDS: Readonly<Record<string, Readonly<Record<string, EventFieldType>>>> = {
  /** The user's own message. */
  'prompt.submit': { text: 'string' },
  /** `skill` is the skill a skill-loading call names, and is absent on every other call. */
  'tool.use.start': { tool: 'string', id: 'string', role: 'string', skill: 'string' },
  /** `is_error` is the harness's flag, kept under the harness's name. It is not an exit status. */
  'tool.use.end': { tool: 'string', id: 'string', role: 'string', is_error: 'boolean' },
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
   * changes (asc-6ola.10). It is the stratification key for a holdout comparison, because
   * compliance differed by model.
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
