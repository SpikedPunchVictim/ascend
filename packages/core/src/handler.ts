/**
 * Replay handlers: compile a parsed handler, then run it over a stream of normalized events
 * (asc-6ola.13; format decision b474b6f6).
 *
 * A handler is DATA, not code: a map naming the event kind that triggers it, conditions on that
 * event, an optional window over the events that follow, and the row to emit. The surface syntax
 * (strict YAML 1.2) is parsed outside core, because the parser is not pure; this module takes the
 * parsed value and owns everything that decides what a handler MEANS.
 *
 * STRICT, BECAUSE A WRONG HANDLER RUNS GREEN. A misspelled field, a number where a string was
 * meant, an operator on the wrong type -- each would otherwise be a condition that is silently
 * never true, and a handler that matches nothing looks exactly like a handler with nothing to
 * match. Every such mistake is refused here, with a message naming it. Measured in the spike
 * (spike/handler-format/FINDINGS.md): the one wrong YAML handler a model wrote was refused at
 * load; the SQL candidate's wrong handler lost a row with no error.
 *
 * ONE EVALUATOR, LIVE AND REPLAYED. `runHandler` takes events one at a time and returns the rows
 * each completes. A replay is the same calls in a loop, so a dry-run count is the count the live
 * path would have produced over the same events.
 *
 * IDENTITY is the sha256 of the canonical parsed form: comments and formatting do not change it,
 * and any change of meaning does.
 */

import { eventFieldType, EVENT_KINDS, type EventFieldType, type NormalizedEvent } from './event.js';
import { canonicalJson, sha256Hex, type Json } from './hash.js';

/** A handler the compiler refused, with the reason in the message. */
export class HandlerError extends Error {
  override readonly name = 'HandlerError';
}

const refuse = (message: string): never => {
  throw new HandlerError(message);
};

/**
 * Regex source longer than this is refused. Real handlers in the spike were under 80.
 *
 * BOUNDED, NOT PROVEN SAFE. The source length and the subject length are capped; the pattern's
 * shape is not analysed. A shape check was tried and refused `(\.[0-9]+)*`, which the spike's
 * own bead-close handler needs and which is linear, while missing other exponential shapes. A
 * catastrophic pattern still costs time on at most `MAX_SUBJECT_LENGTH` characters per event,
 * and project handlers need per-clone trust before they run at all.
 */
export const MAX_REGEX_LENGTH = 300;
/** A regex is tested against at most this many characters of a field. */
export const MAX_SUBJECT_LENGTH = 100_000;

const TOP_KEYS = new Set([
  'on',
  'description',
  'scope',
  'capture',
  'where',
  'before',
  'each',
  'window',
  'emit',
  'judged',
]);
const WINDOW_KEYS = new Set(['calls', 'until', 'first', 'count', 'absent', 'at_least', 'any']);
const WATCHER_KEYS = new Set(['on', 'where']);
const BEFORE_KEYS = new Set(['on', 'where']);
const OPERATORS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'matches',
  'contains',
  'any_matches',
  'followed_by',
  'exists',
  'shares_token',
]);
const REGEX_FLAGS = /^[ims]*$/;

/** Tokens too common in paths and commands to say two strings are about the same thing. */
const STOP_TOKENS = new Set([
  'src',
  'dist',
  'test',
  'users',
  'projects',
  'head',
  'type',
  'json',
  'jsonl',
]);

/** Lowercased runs of `[a-z0-9_]`, at least 4 long, minus the stop list. */
export function handlerTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter((one) => !STOP_TOKENS.has(one));
}

const FILTERS: Readonly<Record<string, (value: string) => string>> = {
  basename: (value) =>
    value
      .split(/[\\/]/)
      .filter((one) => one.length > 0)
      .pop() ?? value,
  snake: (value) => value.toLowerCase().replace(/\s+/g, '_'),
};

/** Why a window closed: its first match, its call limit, its `until` kind, or the stream's end. */
export type ClosedBy = 'match' | 'calls' | 'until' | 'session.end';

/** One emitted row, located at the event that triggered it. */
export interface HandlerRow {
  readonly session_id: string;
  readonly agent_id: string;
  readonly seq: number;
  readonly call: number;
  readonly ts?: string;
  /** Present when the handler has a window. */
  readonly closed_by?: ClosedBy;
  readonly fields: Readonly<Record<string, string>>;
  /**
   * Fields this handler reports as a judgment rather than a measurement -- names only, no values.
   *
   * **Present ONLY when the handler declares a `judged` key**, so a handler written before that
   * key existed produces rows byte-identical to the ones it produced then.
   *
   * **What this is for (asc-6ola.9).** The store's three states are `measured`,
   * `not_applicable` and `not_measured`, and `not_measured` is the default that needs no
   * encoding at all (`state.ts`). A candidate entry is therefore one whose judgment fields are
   * simply ABSENT, and the only thing a handler has to supply is the DECLARATION of which
   * absences are deliberate. Without it a reader cannot tell a field the handler chose not to
   * measure from one it forgot -- which is the difference between a candidate awaiting
   * confirmation and a handler with a hole in it.
   */
  readonly judged?: readonly string[];
}

type Scope = (name: string) => unknown;
type Test = (event: NormalizedEvent, trigger: Scope) => boolean;

interface Capture {
  readonly name: string;
  readonly field: string;
  readonly regex: RegExp;
  readonly group: number;
}

interface Each {
  readonly field: string;
  readonly from: number;
  readonly regex: RegExp | undefined;
  readonly as: string;
}

type WindowMode = 'first' | 'count' | 'absent';

/**
 * What the window watches. One kind (`on` + `where`), or a list of per-kind watchers (`any`),
 * each with its own `where` compiled against that kind -- "a later event mentions this path"
 * spans kinds whose fields do not overlap (asc-6ola.8). `on` is undefined for the list form, and
 * a template may not address the matched event's fields through it.
 */
interface Window {
  readonly calls: number | undefined;
  readonly until: string | undefined;
  readonly mode: WindowMode;
  readonly on: string | undefined;
  readonly match: Test;
  readonly atLeast: number;
}

type Template = (scope: Scope) => string | undefined;

/**
 * The partition a handler's windows and its `before` references live in (asc-gtnu.4).
 *
 * `stream` is the default and the only value that existed before this key, so a handler that does
 * not declare it partitions by `(session_id, agent_id)` exactly as it always has. `session` merges
 * a session's streams into one partition, which is what a cross-stream question needs -- Stage 0
 * measured 58.1% of the finding-to-implementer join as cross-stream (`spike/review-join`).
 */
export type HandlerScope = 'stream' | 'session';

/**
 * The trigger-side backward reference: the most recent event of `on` matching `where` before this
 * trigger, within the partition.
 *
 * **BOUNDED, WHICH IS THE WHOLE DESIGN.** One event is retained per partition, not the stream:
 * `runHandler` keeps a single last-match event beside each partition's open windows. The plan's
 * alternative, retaining the events themselves, was measured at 96,631 events for one project
 * (`spike/replay/FINDINGS.md`) and is not what this is.
 *
 * **`where` filters WHILE RECORDING, not while resolving.** An event of `on` is stored only if it
 * matches, so the reference is genuinely "the most recent MATCH" rather than "the most recent
 * event of that kind, if it happens to match". That is the difference between a bounded map and a
 * scan backwards, and it is why the filter is applied at the earliest possible moment.
 */
interface Before {
  readonly on: string;
  readonly match: Test;
}

/** A compiled handler. `spec` is the parsed form the hash is computed from. */
export interface CompiledHandler {
  readonly spec: Json;
  readonly hash: string;
  readonly on: string;
  readonly description: string | undefined;
  /** The partition this handler's windows and its `before` reference live in. */
  readonly scope: HandlerScope;
  readonly captures: readonly Capture[];
  readonly where: Test;
  readonly before: Before | undefined;
  readonly each: Each | undefined;
  readonly window: Window | undefined;
  readonly emit: readonly (readonly [string, Template])[];
  /**
   * The names declared under `judged`, in document order. Empty when none are declared, never
   * `undefined` -- so `handler.judged.length === 0` is the whole test a caller needs, and no
   * caller has to tell "declares none" apart from "has no such key".
   */
  readonly judged: readonly string[];
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string => (Array.isArray(value) ? 'array' : typeof value);

const absent = (value: unknown): boolean => value === undefined || value === null;

/** Read a dotted path (`argv.1`) from an event. */
function read(event: Readonly<Record<string, unknown>>, path: string): unknown {
  let at: unknown = event;
  for (const part of path.split('.')) {
    if (Array.isArray(at)) at = (at as readonly unknown[])[Number(part)];
    else if (isMap(at)) at = at[part];
    else return undefined;
  }
  return at;
}

/** A field path's type on events of `kind`: `argv.1` is a string element of an array field. */
function pathType(kind: string, path: string, where: string): EventFieldType {
  const [head, index, ...rest] = path.split('.');
  const type = head === undefined ? undefined : eventFieldType(kind, head);
  if (type === undefined) {
    return refuse(`${where}: ${kind} has no field ${JSON.stringify(head)}`);
  }
  if (index === undefined) return type;
  if (type !== 'array' || !/^\d+$/.test(index) || rest.length > 0) {
    return refuse(`${where}: ${JSON.stringify(path)} indexes a field that is not an array`);
  }
  return 'string';
}

function regex(source: unknown, flags: unknown, where: string): RegExp {
  if (typeof source !== 'string') {
    return refuse(`${where}: a regex is a string, got ${JSON.stringify(source)}`);
  }
  if (source.length > MAX_REGEX_LENGTH) {
    return refuse(
      `${where}: regex is ${String(source.length)} characters, over ${String(MAX_REGEX_LENGTH)}`,
    );
  }
  if (flags !== undefined && (typeof flags !== 'string' || !REGEX_FLAGS.test(flags))) {
    return refuse(`${where}: flags may be i, m, s; got ${JSON.stringify(flags)}`);
  }
  try {
    return new RegExp(source, typeof flags === 'string' ? flags : '');
  } catch (error) {
    return refuse(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const test = (pattern: RegExp, value: unknown): boolean =>
  typeof value === 'string' && pattern.test(value.slice(0, MAX_SUBJECT_LENGTH));

/**
 * Names a `$reference` may use: the trigger's fields and the handler's captures. Inside a
 * window's `where`, plain keys are the FOLLOWING event's fields and `$` names still refer here.
 */
interface RefContext {
  readonly triggerKind: string;
  readonly captures: ReadonlySet<string>;
  /**
   * When set, a `$reference` here is refused with this as the reason.
   *
   * `before.where` is the only place that sets it, and the mechanism is why: a window's `where` is
   * evaluated against an event that FOLLOWS the trigger, so the trigger's fields are in hand, but
   * a `before.where` filters events that were seen BEFORE the trigger existed, and there is no
   * trigger to read a field off at that moment. Refusing here rather than resolving to `undefined`
   * keeps a `$name` from becoming a silently-never-true condition -- the class this file refuses
   * everywhere else.
   */
  readonly noRefs?: string;
}

function refType(name: string, context: RefContext, where: string): EventFieldType {
  if (context.noRefs !== undefined) return refuse(`${where}: ${context.noRefs}`);
  if (context.captures.has(name)) return 'string';
  return pathType(context.triggerKind, name, where);
}

/** A literal, or a `$name` read from the trigger scope. */
function operand(
  value: unknown,
  context: RefContext,
  where: string,
): { type: string; get: (trigger: Scope) => unknown } {
  if (typeof value === 'string' && value.startsWith('$')) {
    const name = value.slice(1);
    const type = refType(name, context, where);
    return { type, get: (trigger) => trigger(name) };
  }
  return { type: typeOf(value), get: () => value };
}

function compileWhere(spec: unknown, kind: string, context: RefContext, where: string): Test {
  if (spec === undefined) return () => true;
  if (!isMap(spec)) return refuse(`${where}: must be a map`);

  const tests: Test[] = Object.entries(spec).map(([key, matcher]): Test => {
    const at = `${where}.${key}`;
    if (key === 'any' || key === 'all') {
      if (!Array.isArray(matcher) || matcher.length === 0)
        return refuse(`${at}: must be a non-empty list`);
      const parts = (matcher as readonly unknown[]).map((one, index) =>
        compileWhere(one, kind, context, `${at}[${String(index)}]`),
      );
      return key === 'any'
        ? (event, trigger) => parts.some((part) => part(event, trigger))
        : (event, trigger) => parts.every((part) => part(event, trigger));
    }
    if (key === 'not') {
      const inner = compileWhere(matcher, kind, context, at);
      return (event, trigger) => !inner(event, trigger);
    }

    // The left side: a field of the event under test, or a `$` reference into the trigger.
    const isRef = key.startsWith('$');
    const fieldType = isRef ? refType(key.slice(1), context, at) : pathType(kind, key, at);
    const left = isRef
      ? (_event: NormalizedEvent, trigger: Scope): unknown => trigger(key.slice(1))
      : (event: NormalizedEvent): unknown => read(event, key);

    let op = 'eq';
    let arg: unknown = matcher;
    let flags: unknown;
    if (isMap(matcher)) {
      const ops = Object.keys(matcher).filter((name) => name !== 'flags');
      const [only] = ops;
      if (ops.length !== 1 || only === undefined || !OPERATORS.has(only)) {
        return refuse(`${at}: expected exactly one operator, got ${JSON.stringify(ops)}`);
      }
      op = only;
      arg = matcher[only];
      flags = matcher['flags'];
      if (flags !== undefined && op !== 'matches' && op !== 'any_matches') {
        return refuse(`${at}: flags apply only to matches and any_matches`);
      }
    } else if (Array.isArray(matcher)) {
      return refuse(`${at}: a list is not a value; use in: [...]`);
    }

    switch (op) {
      case 'eq':
      case 'ne': {
        const right = operand(arg, context, at);
        if (right.type !== fieldType) {
          return refuse(
            `${at}: ${JSON.stringify(arg)} is a ${right.type}, the field is a ${fieldType}`,
          );
        }
        return op === 'eq'
          ? (event, trigger) => {
              const value = left(event, trigger);
              return !absent(value) && value === right.get(trigger);
            }
          : (event, trigger) => {
              const value = left(event, trigger);
              return absent(value) || value !== right.get(trigger);
            };
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const right = operand(arg, context, at);
        if (fieldType !== 'number' || right.type !== 'number') {
          return refuse(
            `${at}: ${op} compares numbers; the field is a ${fieldType}, the value a ${right.type}`,
          );
        }
        const compare = {
          gt: (a: number, b: number) => a > b,
          gte: (a: number, b: number) => a >= b,
          lt: (a: number, b: number) => a < b,
          lte: (a: number, b: number) => a <= b,
        }[op];
        return (event, trigger) => {
          const value = left(event, trigger);
          const bound = right.get(trigger);
          return typeof value === 'number' && typeof bound === 'number' && compare(value, bound);
        };
      }
      case 'in': {
        if (!Array.isArray(arg) || arg.length === 0)
          return refuse(`${at}: in needs a non-empty list`);
        for (const one of arg as readonly unknown[]) {
          if (typeOf(one) !== fieldType) {
            return refuse(
              `${at}: ${JSON.stringify(one)} is a ${typeOf(one)}, the field is a ${fieldType}`,
            );
          }
        }
        const allowed = new Set(arg as readonly unknown[]);
        return (event, trigger) => allowed.has(left(event, trigger));
      }
      case 'matches': {
        if (fieldType !== 'string') return refuse(`${at}: matches needs a string field`);
        const pattern = regex(arg, flags, at);
        return (event, trigger) => test(pattern, left(event, trigger));
      }
      case 'any_matches': {
        if (fieldType !== 'array') return refuse(`${at}: any_matches needs an array field`);
        const pattern = regex(arg, flags, at);
        return (event, trigger) => {
          const value = left(event, trigger);
          return (
            Array.isArray(value) && (value as readonly unknown[]).some((one) => test(pattern, one))
          );
        };
      }
      case 'contains': {
        if (fieldType !== 'array') return refuse(`${at}: contains needs an array field`);
        const right = operand(arg, context, at);
        if (right.type !== 'string') return refuse(`${at}: contains takes a string`);
        return (event, trigger) => {
          const value = left(event, trigger);
          return Array.isArray(value) && (value as readonly unknown[]).includes(right.get(trigger));
        };
      }
      case 'followed_by': {
        if (fieldType !== 'array') return refuse(`${at}: followed_by needs an array field`);
        if (
          !Array.isArray(arg) ||
          arg.length !== 2 ||
          !arg.every((one) => typeof one === 'string')
        ) {
          return refuse(`${at}: followed_by takes [a, b], two strings`);
        }
        const [first, second] = arg as readonly string[];
        return (event, trigger) => {
          const value = left(event, trigger);
          return (
            Array.isArray(value) &&
            (value as readonly unknown[]).some(
              (one, index) => one === first && value[index + 1] === second,
            )
          );
        };
      }
      case 'exists': {
        if (typeof arg !== 'boolean') return refuse(`${at}: exists takes true or false`);
        return (event, trigger) => absent(left(event, trigger)) !== arg;
      }
      case 'shares_token': {
        if (fieldType !== 'string' && fieldType !== 'array') {
          return refuse(`${at}: shares_token needs a string or array field`);
        }
        const right = operand(arg, context, at);
        if (right.type !== 'string') return refuse(`${at}: shares_token takes a string`);
        return (event, trigger) => {
          const value = left(event, trigger);
          const other = right.get(trigger);
          if (typeof other !== 'string') return false;
          const wanted = new Set(handlerTokens(other));
          const overlaps = (text: string): boolean =>
            handlerTokens(text).some((token) => wanted.has(token));
          if (typeof value === 'string') return overlaps(value);
          if (Array.isArray(value)) {
            return (value as readonly unknown[]).some(
              (one) => typeof one === 'string' && overlaps(one),
            );
          }
          return false;
        };
      }
      default:
        return refuse(`${at}: unknown operator ${op}`);
    }
  });
  return (event, trigger) => tests.every((one) => one(event, trigger));
}

/** Names a template may read, with the check that rejects anything else at compile time. */
interface TemplateNames {
  readonly triggerKind: string;
  readonly captures: ReadonlySet<string>;
  readonly each: string | undefined;
  readonly window: Window | undefined;
  /** The kind a `before:` reference reads, or `undefined` when the handler declares none. */
  readonly before: string | undefined;
}

function checkTemplateName(name: string, names: TemplateNames, where: string): void {
  if (names.captures.has(name) || name === names.each) return;
  if (name.startsWith('before.')) {
    const kind = names.before;
    if (kind === undefined) {
      return refuse(
        `${where}: \${${name}} is not available from this handler, which declares no before:`,
      );
    }
    pathType(kind, name.slice('before.'.length), where);
    return;
  }
  if (name.startsWith('window.')) {
    const rest = name.slice('window.'.length);
    const mode = names.window?.mode;
    if (rest === 'count' && mode === 'count') return;
    if (rest.startsWith('first.') && mode === 'first' && names.window !== undefined) {
      const windowOn = names.window.on;
      if (windowOn === undefined) {
        return refuse(
          `${where}: \${${name}} is not available from an any-window -- the watcher kinds differ`,
        );
      }
      pathType(windowOn, rest.slice('first.'.length), where);
      return;
    }
    refuse(`${where}: \${${name}} is not available from this handler's window`);
    return;
  }
  pathType(names.triggerKind, name, where);
}

function compileTemplate(value: unknown, names: TemplateNames, where: string): Template {
  if (typeof value !== 'string') {
    return refuse(`${where}: an emitted value is a string template, got ${JSON.stringify(value)}`);
  }
  const parts: (string | { name: string; filter: string | undefined })[] = [];
  const reference = /\$\{([^}|]+)(?:\|([a-z_]+))?\}/g;
  let last = 0;
  for (let found = reference.exec(value); found !== null; found = reference.exec(value)) {
    if (found.index > last) parts.push(value.slice(last, found.index));
    const name = (found[1] ?? '').trim();
    const filter = found[2];
    if (filter !== undefined && !Object.hasOwn(FILTERS, filter)) {
      return refuse(`${where}: unknown filter ${filter}`);
    }
    checkTemplateName(name, names, where);
    parts.push({ name, filter });
    last = reference.lastIndex;
  }
  if (last < value.length) parts.push(value.slice(last));

  const render = (
    scope: Scope,
    part: { name: string; filter: string | undefined },
  ): string | undefined => {
    const raw = scope(part.name);
    if (absent(raw)) return undefined;
    const text = Array.isArray(raw) ? (raw as readonly unknown[]).join(' ') : String(raw);
    const filter = part.filter === undefined ? undefined : FILTERS[part.filter];
    return filter === undefined ? text : filter(text);
  };
  const [only] = parts;
  // A template that is exactly one reference is omitted when the value is absent, rather than
  // emitted as an empty string -- absent and empty are different facts.
  if (parts.length === 1 && only !== undefined && typeof only !== 'string') {
    return (scope) => render(scope, only);
  }
  return (scope) =>
    parts.map((part) => (typeof part === 'string' ? part : (render(scope, part) ?? ''))).join('');
}

function compileWindow(spec: unknown, context: RefContext, scope: HandlerScope): Window {
  if (!isMap(spec)) return refuse('window: must be a map');
  for (const key of Object.keys(spec)) {
    if (!WINDOW_KEYS.has(key)) refuse(`window: unknown key ${key}`);
  }
  const calls = spec['calls'];
  if (calls !== undefined && (typeof calls !== 'number' || !Number.isInteger(calls) || calls < 1)) {
    refuse('window.calls: must be a whole number of calls, at least 1');
  }
  const until = spec['until'];
  if (until !== undefined && (typeof until !== 'string' || !Object.hasOwn(EVENT_KINDS, until))) {
    return refuse(`window.until: ${JSON.stringify(until)} is not an event kind`);
  }

  // Under `scope: session` the two constructs a `stream` window can be bounded by are BOTH refused,
  // and each for a measured reason rather than for tidiness:
  //
  //   `calls` -- `call` counts within one stream (`event.ts`: "seq and call count within one
  //   stream"). Merged into a session partition, two streams' call 7 are the same number, so a
  //   `calls` limit compares a limit from one stream against a call from another: it closes
  //   early, late, or never, and the handler reports a count with nothing saying which.
  //
  //   `until: session.end` -- `session.end` is emitted once per STREAM, not per session
  //   (`normalize.ts` `end()`, called on every transcript file). Under a session partition the
  //   first subagent stream to end would close every window in the session -- including windows
  //   whose session still has 83 files left to read. That is a verdict delivered over a log that
  //   was never read, which is the class this file refuses rather than reports.
  //
  // What is left is a window bounded by `until:` a kind, whose undecided windows are counted at
  // `finish()` rather than dropped when the replay stops.
  if (scope === 'session') {
    if (calls !== undefined) {
      return refuse(
        'window.calls: a session-scoped window cannot count calls -- `call` numbers count within ' +
          'one stream, so merged into a session they collide and the limit would close the window ' +
          'on an unrelated stream. Use until:, or scope: stream.',
      );
    }
    if (until === undefined) {
      return refuse(
        'window: a session-scoped window needs until: -- neither calls: nor session.end can bound ' +
          'it, and a window with no end is never decided.',
      );
    }
    if (until === 'session.end') {
      return refuse(
        'window.until: session.end is one event per STREAM, not one per session, so a ' +
          'session-scoped window would be closed by the first stream that ended rather than at ' +
          'the end of the session. Bound it with until: a kind, and the windows still open when ' +
          'the replay stops are counted as unclosed.',
      );
    }
  }

  if (calls === undefined && until === undefined) {
    refuse('window: needs calls, until, or both -- a window with no end is never decided');
  }
  const modes = (['first', 'count', 'absent'] as const).filter((mode) => spec[mode] !== undefined);
  const [mode] = modes;
  if (modes.length !== 1 || mode === undefined) {
    return refuse(
      `window: needs exactly one of first, count, absent; got ${JSON.stringify(modes)}`,
    );
  }
  const inner = spec[mode];
  if (!isMap(inner)) return refuse(`window.${mode}: must be a map`);
  for (const key of Object.keys(inner)) {
    if (key !== 'on' && key !== 'where' && key !== 'any')
      refuse(`window.${mode}: unknown key ${key}`);
  }
  const atLeast = spec['at_least'];
  if (atLeast !== undefined && mode !== 'count') refuse('window.at_least: applies only to count');
  if (
    atLeast !== undefined &&
    (typeof atLeast !== 'number' || !Number.isInteger(atLeast) || atLeast < 1)
  ) {
    refuse('window.at_least: must be a whole number, at least 1');
  }

  let on: string | undefined;
  /** The kinds this window watches -- one for a single form, each alternative for `any`. */
  let watched: readonly string[];
  let match: Test;
  if (inner['any'] !== undefined) {
    if (inner['on'] !== undefined || inner['where'] !== undefined) {
      return refuse(`window.${mode}: use on, or any -- not both`);
    }
    const list = inner['any'];
    if (!Array.isArray(list) || list.length === 0) {
      return refuse(`window.${mode}.any: must be a non-empty list`);
    }
    const watchers = list.map((one, index) => {
      const at = `window.${mode}.any[${String(index)}]`;
      if (!isMap(one)) return refuse(`${at}: must be a map`);
      for (const key of Object.keys(one)) {
        if (!WATCHER_KEYS.has(key)) refuse(`${at}: unknown key ${key}`);
      }
      const kind = one['on'];
      if (typeof kind !== 'string' || !Object.hasOwn(EVENT_KINDS, kind)) {
        return refuse(`${at}.on: ${JSON.stringify(kind)} is not an event kind`);
      }
      // $ references resolve against the TRIGGER here, and plain keys against this watcher's
      // kind -- the same rule as a single window's where.
      return { kind, test: compileWhere(one['where'], kind, context, at) };
    });
    on = undefined;
    watched = watchers.map((one) => one.kind);
    match = (event, scope) =>
      watchers.some((one) => event.kind === one.kind && one.test(event, scope));
  } else {
    const kind = inner['on'];
    if (typeof kind !== 'string' || !Object.hasOwn(EVENT_KINDS, kind)) {
      return refuse(`window.${mode}.on: ${JSON.stringify(kind)} is not an event kind`);
    }
    on = kind;
    watched = [kind];
    // The kind check belongs to the match itself: a where compiled for `kind` may still be
    // true of another kind's event (a tool.use.start carries `ts` too), and the accept loop
    // offers every event. Found the hard way -- the edit-verified fixture replay lost
    // `window.first.runner` to the Bash call's tool.use.start.
    const where = compileWhere(inner['where'], kind, context, `window.${mode}.where`);
    match = (event, scope) => event.kind === kind && where(event, scope);
  }

  // A window whose `until` is a kind it is itself watching can never decide anything, in any of
  // the three modes. The accept loop checks `until` BEFORE the window's own match and closes
  // there, so the very event the window waits for closes it instead: `first` emits nothing and
  // reports `unclosed: 0` (a handler green over its whole signal), `count` never reaches its
  // `at_least`, and `absent` emits its "nothing matched" verdict about an event that DID match.
  //
  // All three are the project's severity-zero class -- a wrong verdict reported as a result --
  // and all three are invisible to the unit suite, because the handler loads and runs cleanly.
  // Measured, not reasoned: `until: agent.return` with `first: {on: agent.return}` yields rows []
  // and unclosed 0 on the fixture in packages/core/test/handler.test.ts. Refused at compile time
  // so the class cannot be written down at all; asc-6ola.9's own handler was first drafted with
  // this shape and the draft was a silent zero.
  //
  // The any-form is covered too: an `until` equal to ANY alternative has the same effect for
  // that alternative, which is why `watched` is the whole list rather than `on`.
  const clash = until === undefined ? undefined : watched.find((kind) => kind === until);
  if (clash !== undefined) {
    return refuse(
      `window.until: ${clash} is a kind this window watches, and until is checked before the ` +
        `match -- the window would close on the event it is waiting for and could never decide ` +
        `anything. Use a different until, or session.end to let the stream end decide it.`,
    );
  }

  return {
    calls: calls as number | undefined,
    // No assertion: the `until` refusal above returns, which narrows `until` to `string | undefined`
    // here. It read as `unknown` when that refusal was a bare statement.
    until,
    mode,
    on,
    match,
    atLeast: (atLeast as number | undefined) ?? 1,
  };
}

/**
 * The `before:` key: the most recent event of `on` matching `where` before this trigger (asc-gtnu.4).
 *
 * **SHIPPED AS CAPABILITY, NOT AS THE JOIN'S MECHANISM, AND THE DIFFERENCE IS MEASURED.** The join
 * this was designed for -- a review finding to the implementer's earlier events for the same file
 * -- is backward AND cross-stream, and Stage 0 found the corpus holds no reviewers to say which
 * direction a reviewer's join is (`spike/review-join/FINDINGS.md`: 0 `review` subagent_type spawns
 * of 1,063; 34 of 831 read pairs admit an edit strictly earlier, 603 only after, and those are
 * explorers). So this construct is correct and bounded for the case it can serve -- a within-stream
 * "what did I see last" -- and the cross-stream case is refused below rather than approximated.
 */
function compileBefore(spec: unknown, scope: HandlerScope): Before {
  if (!isMap(spec)) return refuse('before: must be a map');
  for (const key of Object.keys(spec)) {
    if (!BEFORE_KEYS.has(key)) refuse(`before: unknown key ${key}`);
  }
  const kind = spec['on'];
  if (typeof kind !== 'string' || !Object.hasOwn(EVENT_KINDS, kind)) {
    return refuse(`before.on: ${JSON.stringify(kind)} is not an event kind`);
  }
  if (scope === 'session') {
    return refuse(
      'before: is not available under scope: session -- `seq` orders one stream, so "the event ' +
        'before this trigger" across two streams would be decided by which file the replay read ' +
        'first (sorted path order) rather than by which event came first in time. Use ' +
        "scope: stream, where the order is the stream's own seq.",
    );
  }
  // `triggerKind` is the before kind here, not the handler's: a plain key inside `before.where`
  // names a field of the event being recorded. `$` names are refused outright -- see RefContext.
  const context: RefContext = {
    triggerKind: kind,
    captures: new Set(),
    noRefs:
      'a $ reference names a field of the TRIGGER, and before.where filters events that were ' +
      'seen before the trigger existed, so there is no trigger to read one off. To compare ' +
      "against the trigger, put the comparison in the handler's top-level where: instead.",
  };
  return { on: kind, match: compileWhere(spec['where'], kind, context, 'before.where') };
}

/**
 * Compile a parsed handler, or throw `HandlerError` naming what is wrong.
 *
 * `parsed` must already be plain JSON-shaped data; the YAML loader guarantees that, and so must
 * any other front end.
 */
export function compileHandler(parsed: unknown): CompiledHandler {
  if (!isMap(parsed)) return refuse('a handler is a map');
  for (const key of Object.keys(parsed)) {
    if (!TOP_KEYS.has(key)) refuse(`unknown key ${key}`);
  }
  const on = parsed['on'];
  if (typeof on !== 'string' || !Object.hasOwn(EVENT_KINDS, on)) {
    return refuse(`on: ${JSON.stringify(on)} is not an event kind`);
  }
  const description = parsed['description'];
  if (description !== undefined && typeof description !== 'string')
    refuse('description: must be a string');

  const scopeSpec = parsed['scope'];
  if (scopeSpec !== undefined && scopeSpec !== 'stream' && scopeSpec !== 'session') {
    return refuse(`scope: ${JSON.stringify(scopeSpec)} -- expected stream or session`);
  }
  const scope: HandlerScope = scopeSpec === 'session' ? 'session' : 'stream';

  const captureSpec = parsed['capture'] ?? {};
  if (!isMap(captureSpec)) return refuse('capture: must be a map');
  const captures = Object.entries(captureSpec).map(([name, spec]): Capture => {
    const at = `capture.${name}`;
    if (!/^[a-z_][a-z0-9_]*$/.test(name))
      refuse(`${at}: a capture name is lowercase letters, digits and _`);
    if (eventFieldType(on, name) !== undefined)
      refuse(`${at}: shadows the trigger's own field ${name}`);
    if (!isMap(spec)) return refuse(`${at}: must be a map`);
    for (const key of Object.keys(spec)) {
      if (!['field', 'regex', 'group', 'flags'].includes(key)) refuse(`${at}: unknown key ${key}`);
    }
    const field = spec['field'];
    if (typeof field !== 'string' || pathType(on, field, at) !== 'string') {
      refuse(`${at}.field: must name a string field of ${on}`);
    }
    const group = spec['group'] ?? 1;
    if (typeof group !== 'number' || !Number.isInteger(group) || group < 0) {
      refuse(`${at}.group: must be a whole number`);
    }
    return {
      name,
      field: field as string,
      regex: regex(spec['regex'], spec['flags'], at),
      group: group as number,
    };
  });
  const captureNames = new Set(captures.map((one) => one.name));
  const context: RefContext = { triggerKind: on, captures: captureNames };

  const where = compileWhere(parsed['where'], on, context, 'where');

  const before =
    parsed['before'] === undefined ? undefined : compileBefore(parsed['before'], scope);

  let each: Each | undefined;
  const eachSpec = parsed['each'];
  if (eachSpec !== undefined) {
    if (!isMap(eachSpec)) return refuse('each: must be a map');
    for (const key of Object.keys(eachSpec)) {
      if (!['field', 'from', 'matches', 'as'].includes(key)) refuse(`each: unknown key ${key}`);
    }
    const field = eachSpec['field'];
    const as = eachSpec['as'];
    const from = eachSpec['from'] ?? 0;
    if (typeof field !== 'string' || pathType(on, field, 'each.field') !== 'array') {
      refuse(`each.field: must name an array field of ${on}`);
    }
    if (typeof as !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(as)) refuse('each.as: must be a name');
    if (captureNames.has(as as string) || eventFieldType(on, as as string) !== undefined) {
      refuse(`each.as: ${String(as)} shadows a field or capture`);
    }
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0)
      refuse('each.from: must be a whole number');
    each = {
      field: field as string,
      from: from as number,
      regex:
        eachSpec['matches'] === undefined
          ? undefined
          : regex(eachSpec['matches'], undefined, 'each.matches'),
      as: as as string,
    };
  }

  const window =
    parsed['window'] === undefined ? undefined : compileWindow(parsed['window'], context, scope);

  const emitSpec = parsed['emit'];
  if (!isMap(emitSpec) || Object.keys(emitSpec).length === 0)
    return refuse('emit: is required, a non-empty map');
  const names: TemplateNames = {
    triggerKind: on,
    captures: captureNames,
    each: each?.as,
    window,
    before: before?.on,
  };
  const emit = Object.entries(emitSpec).map(
    ([key, value]) => [key, compileTemplate(value, names, `emit.${key}`)] as const,
  );

  // `judged` is parsed AFTER `emit`, because one of its refusals is about the two together and
  // the check is a set intersection rather than something derivable from the source order.
  const judged = compileJudged(parsed['judged'], new Set(Object.keys(emitSpec)));

  return {
    spec: parsed as Json,
    hash: sha256Hex(canonicalJson(parsed)),
    on,
    description: description as string | undefined,
    scope,
    captures,
    where,
    before,
    each,
    window,
    emit,
    judged,
  };
}

/**
 * The `judged` key: names a handler reports as a judgment, not a measurement.
 *
 * **Names only, and that is what keeps this construct small.** A judged field has no value, so
 * `HandlerRow.fields` stays `Record<string, string>`, no template or operand type changes, and
 * the emitted-value refusal (`an emitted value is a string template`) is untouched. The whole
 * cost of this feature is one list of strings.
 *
 * **Why a field cannot be both.** A name in `judged` says "this field is deliberately absent,
 * and a later confirmation may fill it in"; a name in `emit` says "here is the value". Both at
 * once would be a handler asserting a value and disclaiming it in the same row, and every reader
 * downstream would have to pick which half to believe. The refusal resolves that at load time,
 * where the handler's author is the person reading it.
 *
 * **Not refused: a judged name that matches nothing.** The handler does not declare an entry
 * type, so there is no schema here to check the name against, and inventing one would mean
 * guessing which store type the row will be recorded as. A judged name that no analyst ever
 * confirms is a judgement that went unanswered, which is a fact about the corpus rather than a
 * mistake in the handler.
 */
function compileJudged(spec: unknown, emitted: ReadonlySet<string>): readonly string[] {
  if (spec === undefined) return [];
  if (!Array.isArray(spec) || spec.length === 0) {
    return refuse('judged: must be a non-empty list of names');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, name] of spec.entries()) {
    // The same name rule as `capture.<name>` and `each.as`, so there is one answer in this file
    // to "what is a name".
    if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(name)) {
      return refuse(`judged[${String(index)}]: ${JSON.stringify(name)} is not a name`);
    }
    if (seen.has(name)) return refuse(`judged: ${name} appears twice`);
    if (emitted.has(name)) {
      return refuse(`judged: ${name} is also emitted -- a field is either measured or it is not`);
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** A window waiting for the events that decide it. */
interface Open {
  readonly trigger: NormalizedEvent;
  readonly scope: Scope;
  readonly limit: number | undefined;
  count: number;
}

/** A handler running over an event stream. */
export interface HandlerRun {
  /** Offer one event; returns the rows it completed. */
  accept(event: NormalizedEvent): readonly HandlerRow[];
  /**
   * No more events will be offered: the replay is over, or the live source has stopped.
   *
   * **Load-bearing under `scope: session`, and the reason is the whole session-scope design.**
   * `session.end` is one event per STREAM, so a session-scoped window is never closed by one
   * (that would be the first stream's end deciding a session still being read) -- which means
   * nothing else would ever decide it. Without this call those windows would vanish when the
   * replay stopped: not emitted, not counted, invisible. Counting them as `unclosed` is the
   * honest resting place, and `unclosed` already means exactly "the log ended inside this window".
   *
   * A caller that never calls it gets no `unclosed` for session-scoped windows, so `replayHandlers`
   * calls it once after the stream and the drain.
   */
  finish(): void;
  /** Events that matched `on` and `where`, whatever their window then decided. */
  readonly triggers: number;
  /**
   * Windows still undecided when their stream ended: a `first` with no match yet, a `count`
   * below `at_least`, or an `absent` whose `until` never came. Counted, never emitted and never
   * silently dropped. An `absent` whose `until` IS `session.end` is decided by that end, not
   * unclosed.
   */
  readonly unclosed: number;
  /**
   * Windows DECIDED, with "no match" as the verdict, by a bound other than the stream ending: a
   * `first` closed by its `until` or its `calls` limit without a match, or a `count` closed below
   * `at_least` (asc-gtnu.4).
   *
   * **This counter closes a silence that predates this stage.** Before it, such a window emitted
   * nothing and incremented nothing, so a reader with `triggers: 3326, rows: 2782, unclosed: 56`
   * could not tell the remaining 488 windows from windows that never opened. Measured on
   * `handlers/edit-verified.yaml` over this project's log: 488 of its 3,326 triggers are this case
   * (14.7%), and they are the same class `asc-6ola.9` found -- a verdict reported as a result when
   * the verdict was "nothing matched".
   */
  readonly noMatch: number;
  /**
   * Triggers whose `before:` reference found no match earlier in the partition, so the `${before.…}`
   * fields are ABSENT on their rows rather than filled with a zero or an empty string
   * (asc-gtnu.4).
   *
   * **This is the reported verdict Stage 0's (d) asked for.** 194 of 831 subagent read pairs
   * (23.3%) and 98 of 257 main pairs (38.1%) had no event to join to anywhere in the session
   * (`spike/review-join/FINDINGS.md`), so an unsatisfiable reference is roughly a quarter of the
   * join rather than an edge -- it must be counted, never left to look like a field the handler
   * forgot to write.
   */
  readonly unsatisfiedBefore: number;
}

/**
 * Run a compiled handler. Streams are kept apart by `(session_id, agent_id)`, so events of
 * concurrent streams may interleave. A stream's `session.end` closes all its windows.
 *
 * A `calls: N` window holds the trigger's later events whose `call` is at most
 * `trigger.call + N`. Calls run in parallel and finish out of order, so it closes only once an
 * event past the limit arrives AND no call within the limit is still unfinished.
 *
 * **`scope: session` MERGES THE PARTITION, AND THAT IS A DIFFERENT ORDERING CLAIM.** `seq` and
 * `call` count within one stream (`event.ts`), so across two streams there is no order in the
 * event data at all -- the only order a merged partition has is the order the replay offered the
 * events, which is the corpus's sorted path order, not time. Two consequences, both deliberate:
 * the `seq > trigger.seq` guard applies only WITHIN a stream (an event of another stream is
 * neither before nor after the trigger, so `where` is the whole filter), and the constructs that
 * would silently turn that into a verdict -- `calls`, `until: session.end`, `before:` -- are
 * refused at compile time rather than left to mean whatever file order made them mean.
 */
export function runHandler(handler: CompiledHandler): HandlerRun {
  const open = new Map<string, Open[]>();
  /** Calls started and not yet ended, per stream. What makes a `calls` close safe. */
  const running = new Map<string, Set<number>>();
  /**
   * The most recent event matching `before:`, per partition (asc-gtnu.4). One event, not a buffer.
   *
   * Keyed by the partition, which under `scope: session` would be the session -- unreachable,
   * because `before:` is refused there. It follows the partition rather than hardcoding the stream
   * so that the two keys cannot disagree about what a partition is.
   */
  const lastBefore = new Map<string, NormalizedEvent>();
  let triggers = 0;
  let unclosed = 0;
  let noMatch = 0;
  let unsatisfiedBefore = 0;
  const window = handler.window;
  /** The handler-level scope. Named apart from the template `Scope` every row is built with. */
  const handlerScope = handler.scope;

  /**
   * The partition an event belongs to. Under `stream` this is `(session_id, agent_id)`, exactly the
   * key every handler used before `scope` existed.
   */
  const partition = (event: NormalizedEvent): string =>
    handlerScope === 'session' ? event.session_id : `${event.session_id}\u0000${event.agent_id}`;

  const row = (
    trigger: NormalizedEvent,
    scope: Scope,
    closedBy: ClosedBy | undefined,
  ): HandlerRow => {
    const fields: Record<string, string> = {};
    for (const [name, template] of handler.emit) {
      const value = template(scope);
      if (value !== undefined) fields[name] = value;
    }
    return {
      session_id: trigger.session_id,
      agent_id: trigger.agent_id,
      seq: trigger.seq,
      call: trigger.call,
      ...(trigger.ts === undefined ? {} : { ts: trigger.ts }),
      ...(closedBy === undefined ? {} : { closed_by: closedBy }),
      fields,
      // Spread like the envelope fields above, not set to `[]`: a handler that declares no
      // `judged` produces the same object literal it produced before this key existed, so
      // nothing downstream has to learn that `judged: []` and `judged: undefined` mean the same
      // thing. There is one row builder in this file, which is what makes this a one-line change.
      ...(handler.judged.length === 0 ? {} : { judged: handler.judged }),
    };
  };

  const rows = (
    trigger: NormalizedEvent,
    scope: Scope,
    closedBy: ClosedBy | undefined,
  ): HandlerRow[] => {
    const each = handler.each;
    if (each === undefined) return [row(trigger, scope, closedBy)];
    const list = read(trigger, each.field);
    if (!Array.isArray(list)) return [];
    const out: HandlerRow[] = [];
    for (const item of (list as readonly unknown[]).slice(each.from)) {
      if (each.regex !== undefined && !test(each.regex, item)) continue;
      out.push(row(trigger, (name) => (name === each.as ? item : scope(name)), closedBy));
    }
    return out;
  };

  /** Close one window; the rows it emits, if its verdict is decided. */
  const close = (spec: Window, one: Open, closedBy: ClosedBy): HandlerRow[] => {
    if (spec.mode === 'count') {
      if (one.count >= spec.atLeast) return rows(one.trigger, withCount(one), closedBy);
      if (closedBy === 'session.end') unclosed += 1;
      else noMatch += 1;
      return [];
    }
    if (spec.mode === 'absent') {
      // A window whose `until` IS session.end ends there by definition, so the end decides it:
      // nothing matched, and that is the verdict (asc-6ola.8, read.unused). A window waiting
      // for an until that never came is undecided, and counts as unclosed.
      if (closedBy === 'session.end' && spec.until !== 'session.end') {
        unclosed += 1;
        return [];
      }
      return rows(one.trigger, one.scope, closedBy);
    }
    // `first` emits at its match; closing without one decides nothing unless the window ran out.
    // A close by `until` or by `calls` IS a decision -- "no match before the bound" -- so it is
    // counted rather than dropped; only the stream's own end leaves it undecided.
    if (closedBy === 'session.end') unclosed += 1;
    else noMatch += 1;
    return [];
  };

  const withCount =
    (one: Open): Scope =>
    (name) =>
      name === 'window.count' ? one.count : one.scope(name);

  /**
   * Wrap a trigger's scope so `${before.<field>}` reads the reference instead of the trigger.
   *
   * Returns `scope` ITSELF when the handler declares no `before:`, so a handler written before that
   * key existed runs through exactly the same function it ran through then, not a wrapper that
   * happens to be equivalent.
   */
  const withBefore =
    (scope: Scope, earlier: NormalizedEvent | undefined): Scope =>
    (name) =>
      name.startsWith('before.')
        ? earlier === undefined
          ? undefined
          : read(earlier, name.slice('before.'.length))
        : scope(name);

  const step = (event: NormalizedEvent): readonly HandlerRow[] => {
    const key = partition(event);
    const out: HandlerRow[] = [];

    let calls = running.get(key);
    if (calls === undefined) {
      calls = new Set();
      running.set(key, calls);
    }
    if (event.kind === 'tool.use.start') calls.add(event.call);
    if (event.kind === 'tool.use.end') calls.delete(event.call);

    // First the windows this event may decide, so a trigger never sees itself.
    const waiting = open.get(key);
    if (window !== undefined && waiting !== undefined) {
      const still: Open[] = [];
      for (const one of waiting) {
        const limit = one.limit;
        const past = limit !== undefined && event.call > limit;
        let closedBy: ClosedBy | undefined;
        // `session.end` closes a STREAM's windows and never a session's: one is emitted per
        // transcript file, so honoring it under `scope: session` would close every window of the
        // session on the first subagent file that ended, with the session's other files unread.
        // Guarding the `open.delete` below is not enough -- this is where the close happens, and a
        // test written against the delete alone would pass while the window still closed early.
        if (event.kind === 'session.end' && handlerScope === 'stream') closedBy = 'session.end';
        else if (window.until !== undefined && event.kind === window.until) closedBy = 'until';
        else if (past && ![...calls].some((call) => call <= limit)) closedBy = 'calls';
        if (closedBy !== undefined) {
          out.push(...close(window, one, closedBy));
          continue;
        }
        // Held open for a straggling call: an event past the limit is outside the window.
        //
        // THE `seq` GUARD IS PER STREAM. Under `scope: stream` the partition IS the stream, so
        // `event.seq > one.trigger.seq` is the whole rule and every handler that existed before
        // `scope` reaches it unchanged. Under `scope: session` an event of ANOTHER stream is in the
        // same partition but its `seq` is a position in a different sequence -- neither before nor
        // after -- so the guard would drop it on a comparison that means nothing. There the
        // stream's own events are still held to `seq`, and a cross-stream event is filtered by
        // `where` alone. That is the honest reading of a merged partition, and it is why the
        // constructs that could turn file order into a verdict are refused at compile time.
        const after =
          handlerScope === 'session' && event.agent_id !== one.trigger.agent_id
            ? true
            : event.seq > one.trigger.seq;
        if (!past && after && window.match(event, one.scope)) {
          if (window.mode === 'first') {
            const found = event;
            out.push(
              ...rows(
                one.trigger,
                (name) =>
                  name.startsWith('window.first.')
                    ? read(found, name.slice('window.first.'.length))
                    : one.scope(name),
                'match',
              ),
            );
            continue;
          }
          if (window.mode === 'absent') {
            // Decided: something matched, so nothing is emitted and the window is done.
            continue;
          }
          one.count += 1;
        }
        still.push(one);
      }
      open.set(key, still);
    }

    // A stream's end closes its own windows. Under `scope: session` it must NOT: `session.end` is
    // one event per STREAM, so honoring it here would close every window of a session on the first
    // subagent file that ended, with the session's remaining files still unread. Session-scoped
    // windows are decided by their `until` and, failing that, counted by `finish()`.
    if (event.kind === 'session.end' && handlerScope === 'stream') {
      open.delete(key);
      running.delete(key);
    }

    if (event.kind !== handler.on) return out;

    const captured: Record<string, string> = {};
    for (const capture of handler.captures) {
      const source = read(event, capture.field);
      if (typeof source !== 'string') continue;
      const found = capture.regex.exec(source.slice(0, MAX_SUBJECT_LENGTH));
      const value = found?.[capture.group];
      if (value !== undefined) captured[capture.name] = value;
    }
    const scope: Scope = (name) =>
      Object.hasOwn(captured, name) ? captured[name] : read(event, name);
    if (!handler.where(event, scope)) return out;
    triggers += 1;

    // The backward reference, read BEFORE this event is recorded below -- so "the most recent
    // match before this trigger" can never mean the trigger itself.
    let earlier: NormalizedEvent | undefined;
    if (handler.before !== undefined) {
      earlier = lastBefore.get(key);
      if (earlier === undefined) unsatisfiedBefore += 1;
    }
    const emitScope = withBefore(scope, earlier);

    if (window === undefined) {
      out.push(...rows(event, emitScope, undefined));
      return out;
    }
    const list = open.get(key) ?? [];
    list.push({
      trigger: event,
      // The WRAPPED scope, so `${before.…}` reads this trigger's reference on a window row too.
      // Storing the raw scope here would make the reference resolve against the trigger's own
      // fields, i.e. to nothing, which is a silently absent value rather than a refusal.
      scope: emitScope,
      limit: window.calls === undefined ? undefined : event.call + window.calls,
      count: 0,
    });
    open.set(key, list);
    return out;
  };

  /**
   * Record the event as the partition's most recent `before:` match.
   *
   * AFTER the trigger body, which is what makes `before` mean strictly earlier. `before.where`
   * cannot hold `$` references (`compileBefore`), so the trigger scope this passes is never read.
   */
  const record = (event: NormalizedEvent): void => {
    const spec = handler.before;
    if (spec === undefined || event.kind !== spec.on) return;
    if (!spec.match(event, () => undefined)) return;
    lastBefore.set(partition(event), event);
  };

  const accept = (event: NormalizedEvent): readonly HandlerRow[] => {
    const out = step(event);
    record(event);
    return out;
  };

  const finish = (): void => {
    for (const list of open.values()) unclosed += list.length;
    open.clear();
    running.clear();
    lastBefore.clear();
  };

  return {
    accept,
    finish,
    get triggers() {
      return triggers;
    },
    get unclosed() {
      return unclosed;
    },
    get noMatch() {
      return noMatch;
    },
    get unsatisfiedBefore() {
      return unsatisfiedBefore;
    },
  };
}
