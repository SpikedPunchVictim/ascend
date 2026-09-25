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

const TOP_KEYS = new Set(['on', 'description', 'capture', 'where', 'each', 'window', 'emit']);
const WINDOW_KEYS = new Set(['calls', 'until', 'first', 'count', 'absent', 'at_least', 'any']);
const WATCHER_KEYS = new Set(['on', 'where']);
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

/** A compiled handler. `spec` is the parsed form the hash is computed from. */
export interface CompiledHandler {
  readonly spec: Json;
  readonly hash: string;
  readonly on: string;
  readonly description: string | undefined;
  readonly captures: readonly Capture[];
  readonly where: Test;
  readonly each: Each | undefined;
  readonly window: Window | undefined;
  readonly emit: readonly (readonly [string, Template])[];
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
}

function refType(name: string, context: RefContext, where: string): EventFieldType {
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
}

function checkTemplateName(name: string, names: TemplateNames, where: string): void {
  if (names.captures.has(name) || name === names.each) return;
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

function compileWindow(spec: unknown, context: RefContext): Window {
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
    refuse(`window.until: ${JSON.stringify(until)} is not an event kind`);
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
    match = (event, scope) =>
      watchers.some((one) => event.kind === one.kind && one.test(event, scope));
  } else {
    const kind = inner['on'];
    if (typeof kind !== 'string' || !Object.hasOwn(EVENT_KINDS, kind)) {
      return refuse(`window.${mode}.on: ${JSON.stringify(kind)} is not an event kind`);
    }
    on = kind;
    // The kind check belongs to the match itself: a where compiled for `kind` may still be
    // true of another kind's event (a tool.use.start carries `ts` too), and the accept loop
    // offers every event. Found the hard way -- the edit-verified fixture replay lost
    // `window.first.runner` to the Bash call's tool.use.start.
    const where = compileWhere(inner['where'], kind, context, `window.${mode}.where`);
    match = (event, scope) => event.kind === kind && where(event, scope);
  }

  return {
    calls: calls as number | undefined,
    until: until as string | undefined,
    mode,
    on,
    match,
    atLeast: (atLeast as number | undefined) ?? 1,
  };
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
    parsed['window'] === undefined ? undefined : compileWindow(parsed['window'], context);

  const emitSpec = parsed['emit'];
  if (!isMap(emitSpec) || Object.keys(emitSpec).length === 0)
    return refuse('emit: is required, a non-empty map');
  const names: TemplateNames = { triggerKind: on, captures: captureNames, each: each?.as, window };
  const emit = Object.entries(emitSpec).map(
    ([key, value]) => [key, compileTemplate(value, names, `emit.${key}`)] as const,
  );

  return {
    spec: parsed as Json,
    hash: sha256Hex(canonicalJson(parsed)),
    on,
    description: description as string | undefined,
    captures,
    where,
    each,
    window,
    emit,
  };
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
  /** Events that matched `on` and `where`, whatever their window then decided. */
  readonly triggers: number;
  /**
   * Windows still undecided when their stream ended: a `first` with no match yet, a `count`
   * below `at_least`, or an `absent` whose `until` never came. Counted, never emitted and never
   * silently dropped. An `absent` whose `until` IS `session.end` is decided by that end, not
   * unclosed.
   */
  readonly unclosed: number;
}

/**
 * Run a compiled handler. Streams are kept apart by `(session_id, agent_id)`, so events of
 * concurrent streams may interleave. A stream's `session.end` closes all its windows.
 *
 * A `calls: N` window holds the trigger's later events whose `call` is at most
 * `trigger.call + N`. Calls run in parallel and finish out of order, so it closes only once an
 * event past the limit arrives AND no call within the limit is still unfinished.
 */
export function runHandler(handler: CompiledHandler): HandlerRun {
  const open = new Map<string, Open[]>();
  /** Calls started and not yet ended, per stream. What makes a `calls` close safe. */
  const running = new Map<string, Set<number>>();
  let triggers = 0;
  let unclosed = 0;
  const window = handler.window;

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
    if (closedBy === 'session.end') unclosed += 1;
    return [];
  };

  const withCount =
    (one: Open): Scope =>
    (name) =>
      name === 'window.count' ? one.count : one.scope(name);

  const accept = (event: NormalizedEvent): readonly HandlerRow[] => {
    const key = `${event.session_id}\u0000${event.agent_id}`;
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
        if (event.kind === 'session.end') closedBy = 'session.end';
        else if (window.until !== undefined && event.kind === window.until) closedBy = 'until';
        else if (past && ![...calls].some((call) => call <= limit)) closedBy = 'calls';
        if (closedBy !== undefined) {
          out.push(...close(window, one, closedBy));
          continue;
        }
        // Held open for a straggling call: an event past the limit is outside the window.
        if (!past && event.seq > one.trigger.seq && window.match(event, one.scope)) {
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

    if (event.kind === 'session.end') {
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

    if (window === undefined) {
      out.push(...rows(event, scope, undefined));
      return out;
    }
    const list = open.get(key) ?? [];
    list.push({
      trigger: event,
      scope,
      limit: window.calls === undefined ? undefined : event.call + window.calls,
      count: 0,
    });
    open.set(key, list);
    return out;
  };

  return {
    accept,
    get triggers() {
      return triggers;
    },
    get unclosed() {
      return unclosed;
    },
  };
}
