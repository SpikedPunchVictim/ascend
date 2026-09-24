// Spike asc-6ola.5 (throwaway). Candidate A: strict YAML 1.2 handlers (SPEC-A.md).
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import Y from '../../node_modules/.pnpm/node_modules/yaml/dist/index.js';
import { tokens } from './reference.mjs';

const FIELD_TYPES = {
  kind: 'string', seq: 'number', call: 'number', tool: 'string', id: 'string', ok: 'boolean',
  head: 'string', argv: 'array', via: 'string', pattern: 'string', hits: 'number', path: 'string',
  before: 'string', after: 'string', text: 'string', ts: 'string', session: 'string', file: 'string',
};
const TOP = new Set(['on', 'capture', 'where', 'each', 'window', 'emit']);
const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'matches', 'contains', 'any_matches', 'followed_by', 'exists', 'shares_token']);

class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Parse strictly; returns { spec, hash } or throws Refused. */
export function load(src) {
  const doc = Y.parseDocument(src, { version: '1.2', merge: false, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) refuse(`parse: ${doc.errors[0].message.split('\n')[0]}`);
  Y.visit(doc, {
    Alias() { refuse('aliases are refused'); },
    Node(_, n) {
      if (n.anchor) refuse(`anchor &${n.anchor} is refused`);
      if (n.tag) refuse(`explicit tag ${n.tag} is refused`);
    },
    Pair(_, p) { if (Y.isScalar(p.key) && p.key.value === '<<') refuse('merge keys are refused'); },
  });
  const spec = doc.toJS();
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) refuse('a handler is a map');
  for (const k of Object.keys(spec)) if (!TOP.has(k)) refuse(`unknown key ${k}`);
  if (typeof spec.on !== 'string') refuse('on: must be a string event kind');
  if (!spec.emit || typeof spec.emit !== 'object') refuse('emit: is required and is a map');
  return { spec, hash: createHash('sha256').update(canonical(spec)).digest('hex') };
}

// ---------- compile ----------
const fieldType = (path) => {
  if (path.startsWith('$')) return 'string';
  const [head, idx] = path.split('.');
  if (head === 'argv' && idx !== undefined) return 'string';
  return FIELD_TYPES[head] ?? refuse(`unknown field ${path}`);
};
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const re = (s, flags) => (typeof s === 'string' ? new RegExp(s, flags ?? '') : refuse(`regex must be a string, got ${JSON.stringify(s)}`));

function typeOf(v) { return Array.isArray(v) ? 'array' : typeof v; }

// A value: `$name` resolves against the environment, anything else is a literal.
function valueFn(v) {
  if (typeof v === 'string' && v.startsWith('$')) { const name = v.slice(1); return (env) => env.ref(name); }
  return () => v;
}

function compileWhere(where) {
  if (where == null) return () => true;
  if (typeof where !== 'object' || Array.isArray(where)) refuse('where: must be a map');
  const tests = Object.entries(where).map(([key, m]) => {
    if (key === 'any' || key === 'all') {
      if (!Array.isArray(m)) refuse(`${key}: must be a list`);
      const fs = m.map(compileWhere);
      return key === 'any' ? (ev, env) => fs.some((f) => f(ev, env)) : (ev, env) => fs.every((f) => f(ev, env));
    }
    if (key === 'not') { const f = compileWhere(m); return (ev, env) => !f(ev, env); }
    const ftype = fieldType(key);
    const read = key.startsWith('$') ? (ev, env) => env.ref(key.slice(1)) : (ev) => get(ev, key);
    let op, arg, flags;
    if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
      const keys = Object.keys(m).filter((k) => k !== 'flags');
      if (keys.length !== 1 || !OPS.has(keys[0])) refuse(`${key}: one operator expected, got ${keys.join(',')}`);
      [op] = keys; arg = m[op]; flags = m.flags;
    } else { op = 'eq'; arg = m; }
    const isRef = typeof arg === 'string' && arg.startsWith('$');
    if (!isRef && ['eq', 'ne'].includes(op) && typeOf(arg) !== ftype) refuse(`${key}: ${JSON.stringify(arg)} is a ${typeOf(arg)}, the field is a ${ftype}`);
    if (!isRef && ['gt', 'gte', 'lt', 'lte'].includes(op) && (ftype !== 'number' || typeof arg !== 'number')) refuse(`${key}: ${op} needs a number field and value`);
    if (['contains', 'any_matches', 'followed_by'].includes(op) && ftype !== 'array') refuse(`${key}: ${op} needs an array field`);
    const val = valueFn(arg);
    const absent = (x) => x === undefined || x === null;
    switch (op) {
      case 'eq': return (ev, env) => { const x = read(ev, env); return !absent(x) && x === val(env); };
      case 'ne': return (ev, env) => { const x = read(ev, env); return absent(x) || x !== val(env); };
      case 'gt': return (ev, env) => { const x = read(ev, env); return !absent(x) && x > val(env); };
      case 'gte': return (ev, env) => { const x = read(ev, env); return !absent(x) && x >= val(env); };
      case 'lt': return (ev, env) => { const x = read(ev, env); return !absent(x) && x < val(env); };
      case 'lte': return (ev, env) => { const x = read(ev, env); return !absent(x) && x <= val(env); };
      case 'in': { if (!Array.isArray(arg)) refuse(`${key}: in needs a list`); const s = new Set(arg); return (ev, env) => s.has(read(ev, env)); }
      case 'matches': { const r = re(arg, flags); return (ev, env) => { const x = read(ev, env); return typeof x === 'string' && r.test(x); }; }
      case 'contains': return (ev, env) => { const x = read(ev, env); return Array.isArray(x) && x.includes(val(env)); };
      case 'any_matches': { const r = re(arg, flags); return (ev, env) => { const x = read(ev, env); return Array.isArray(x) && x.some((a) => r.test(a)); }; }
      case 'followed_by': {
        if (!Array.isArray(arg) || arg.length !== 2) refuse(`${key}: followed_by needs [a, b]`);
        const [a, b] = arg;
        return (ev, env) => { const x = read(ev, env); return Array.isArray(x) && x.some((v, i) => v === a && x[i + 1] === b); };
      }
      case 'exists': return (ev, env) => absent(read(ev, env)) !== Boolean(arg);
      case 'shares_token': return (ev, env) => {
        const x = read(ev, env); const y = val(env);
        if (typeof x !== 'string' || typeof y !== 'string') return false;
        const t = new Set(tokens(y)); return tokens(x).some((k) => t.has(k));
      };
    }
  });
  return (ev, env) => tests.every((t) => t(ev, env));
}

const FILTERS = { basename: (s) => basename(s), snake: (s) => s.toLowerCase().replace(/\s+/g, '_') };
function compileTemplate(t) {
  if (typeof t !== 'string') refuse(`emit values are strings, got ${JSON.stringify(t)}`);
  const parts = [];
  const rx = /\$\{([^}|]+)(?:\|([a-z]+))?\}/g;
  let last = 0, m;
  while ((m = rx.exec(t))) {
    if (m.index > last) parts.push(t.slice(last, m.index));
    const [, name, filter] = m;
    if (filter && !FILTERS[filter]) refuse(`unknown filter ${filter}`);
    parts.push({ name: name.trim(), filter });
    last = rx.lastIndex;
  }
  if (last < t.length) parts.push(t.slice(last));
  const whole = parts.length === 1 && typeof parts[0] === 'object';
  return (scope) => {
    const vals = parts.map((p) => {
      if (typeof p === 'string') return p;
      let v = scope(p.name);
      if (v !== undefined && v !== null && p.filter) v = FILTERS[p.filter](String(v));
      return v;
    });
    if (whole) return vals[0] === undefined || vals[0] === null ? undefined : String(vals[0]);
    return vals.map((v) => (v === undefined || v === null ? '' : String(v))).join('');
  };
}

export function compile(spec) {
  const caps = Object.entries(spec.capture ?? {}).map(([name, c]) => {
    for (const k of Object.keys(c)) if (!['field', 'regex', 'group', 'flags'].includes(k)) refuse(`capture.${name}: unknown key ${k}`);
    fieldType(c.field);
    return { name, field: c.field, r: re(c.regex, c.flags), group: c.group ?? 1 };
  });
  const where = compileWhere(spec.where);
  let each;
  if (spec.each) {
    const { field, from = 0, matches, as } = spec.each;
    if (fieldType(field) !== 'array' || typeof as !== 'string') refuse('each: needs an array field and as:');
    each = { field, from, r: matches === undefined ? undefined : re(matches), as };
  }
  let win;
  if (spec.window) {
    const w = spec.window;
    if (typeof w.calls !== 'number') refuse('window.calls: must be a number');
    const which = w.first ? 'first' : w.count ? 'count' : refuse('window: needs first or count');
    const inner = w[which];
    win = { calls: w.calls, which, on: inner.on, where: compileWhere(inner.where), atLeast: w.at_least ?? 1 };
  }
  const emit = Object.entries(spec.emit).map(([k, t]) => [k, compileTemplate(t)]);
  return { on: spec.on, caps, where, each, win, emit };
}

// ---------- evaluate ----------
export function evaluate(name, h, files) {
  const rows = [];
  for (const { events } of files) {
    let byCall; // built lazily, only for windowed handlers
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind !== h.on) continue;
      const captured = {};
      for (const c of h.caps) {
        const src = get(e, c.field);
        const m = typeof src === 'string' ? src.match(c.r) : null;
        if (m) captured[c.name] = m[c.group];
      }
      const env = { ref: (n) => (n in captured ? captured[n] : get(e, n)) };
      if (!h.where(e, env)) continue;
      let bound = {};
      if (h.win) {
        if (!byCall) { byCall = new Map(); events.forEach((x, j) => { if (!byCall.has(x.call)) byCall.set(x.call, []); byCall.get(x.call).push(j); }); }
        const idx = [];
        for (let c = e.call; c <= e.call + h.win.calls; c++) for (const j of byCall.get(c) ?? []) if (j > i) idx.push(j);
        idx.sort((a, b) => a - b);
        const hits = idx.filter((j) => events[j].kind === h.win.on && h.win.where(events[j], env));
        if (h.win.which === 'first') { if (!hits.length) continue; bound = { first: events[hits[0]] }; }
        else { if (hits.length < h.win.atLeast) continue; bound = { count: hits.length }; }
      }
      const scope = (n) => {
        if (n.startsWith('window.')) { const rest = n.slice(7); return rest === 'count' ? bound.count : get(bound.first, rest.replace(/^first\./, '')); }
        return n in captured ? captured[n] : get(e, n);
      };
      const emitOne = (extra) => {
        const row = { handler: name, file: e.file, seq: e.seq };
        for (const [k, f] of h.emit) { const v = f((n) => (n in extra ? extra[n] : scope(n))); if (v !== undefined) row[k] = v; }
        rows.push(row);
      };
      if (h.each) {
        const arr = get(e, h.each.field) ?? [];
        for (let k = h.each.from; k < arr.length; k++) if (!h.each.r || h.each.r.test(arr[k])) emitOne({ [h.each.as]: arr[k] });
      } else emitOne({});
    }
  }
  return rows;
}

export { Refused };
