/**
 * Can a review finding reach the implementer's events — and how far does it have to reach?
 *
 * `asc-gtnu` need (2) is "a join from each finding to the implementer's events for the same files
 * (did it run a `catchable_by` check?)". The handler DSL cannot express it today, and the question
 * this file answers is HOW MUCH it must be extended: a bounded backward reference inside one stream
 * is a small change, while a session-scoped partition is a large one that touches the invariant
 * every existing handler rests on.
 *
 * There is no finding data to measure against. `ReportFindings` has been called 0 times across
 * 1,236 transcript files and 637,258 records (re-measured 2026-09-26, `asc-gtnu.1`), so the stand-in
 * for a finding is its subject: **a subagent stream, and the paths it read.** A reviewer that read a
 * file is the reviewer that can report on it, and that proxy exists today.
 *
 * For every (stream, distinct path read) pair, where does a `file.changed` for that path land?
 *
 *   (a) same stream        expressible in one stream today, and — see `a_backward` — in which order
 *   (b) the session's main stream       needs SESSION scope
 *   (c) another agent's stream          needs SESSION scope
 *   (d) nowhere in the session          unsatisfiable, and reported as such, never zero-filled
 *
 * (a) alone is not enough to justify a *backward* reference: the DSL's `before:` needs an edit
 * strictly EARLIER in the stream than the trigger, and an edit that only ever follows the read
 * cannot satisfy it. So (a) is split into `a_backward` (some edit's `seq` is below the earliest
 * read's) and `a_forward_only`, and the same split is given for (b) and (c). The direction turned
 * out to be role-sensitive and the scope did not — see `FINDINGS.md`'s limits.
 *
 * The same classification over main-stream reads is the control: if (a) dominates there too, the
 * shape is a property of the corpus rather than of subagents.
 *
 * THREE INSTRUMENT TRAPS, and each has a check rather than an assurance.
 *
 * 1. **Spelling.** A read and an edit of one file can be spelled differently (absolute against
 *    relative, `./x` against `x`), so an exact-string join reports (d) for a file that was plainly
 *    edited. Both spellings are measured; the gap between the two tables is the size of the error an
 *    exact match would have made. An exact match alone would not be evidence. The absolute/relative
 *    split of the read population is printed so the source of that error is visible.
 * 2. **`check.run` carries no path** — `EVENT_KINDS['check.run']` declares
 *    `{ id, runner, verdict, verdict_state, verdict_source }`. So "did a check run on THIS file" is
 *    not derivable at any scope, and the count of `check.run` events is the size of the population
 *    that cannot be joined. The field set is READ OFF THE EVENTS below rather than quoted from the
 *    source, so a field added later cannot leave this comment quietly wrong.
 * 3. **One file is one stream.** A subagent transcript's records carry the PARENT's session id, so
 *    `(session, agent)` is the stream key and sessions holding more than one stream are counted —
 *    if that count were 0, cross-stream scope would be vacuous and the whole question would be moot.
 *
 * Counts only. No path string is printed and no transcript prose is read: this repository is
 * public, and a real working directory in it is a leak. `asc-gtnu.1`.
 */
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createNormalizer, streamCorpus } from '../../packages/adapter-claude-code/dist/index.js';

const ROOT = process.env['ASC_TRANSCRIPT_ROOT'] ?? join(homedir(), '.claude', 'projects');
const PROJECT = process.argv[2] ?? '-Users-spikedpunchvictim-projects-ascend';

const keyOf = (session, agent) => `${session}\u0000${agent}`;
const mainKey = (session) => `${session}\u0000main`;

/** @type {Map<string, {session: string, agent: string}>} */
const streams = new Map();
/** @type {Map<string, Map<string, number>>} streamKey -> path -> earliest read seq */
const reads = new Map();
/** @type {Map<string, Map<string, number[]>>} streamKey -> path -> edit seqs */
const edits = new Map();
/** @type {Map<string, Map<string, Set<string>>>} session -> path -> streamKeys that edited it */
const sessionEditors = new Map();
/** @type {Map<string, Map<string, Set<string>>>} session -> basename -> streamKeys that edited it */
const sessionEditorsByBase = new Map();
/** @type {Map<string, Set<string>>} kind -> field names actually seen on its events */
const kindFields = new Map();
/** @type {Map<string, number>} */
const kindCounts = new Map();
let events = 0;
let readsAbsolute = 0;
let readsRelative = 0;

const push = (map, outer, inner, value) => {
  let byInner = map.get(outer);
  if (byInner === undefined) {
    byInner = new Map();
    map.set(outer, byInner);
  }
  let set = byInner.get(inner);
  if (set === undefined) {
    set = new Set();
    byInner.set(inner, set);
  }
  set.add(value);
};

const offer = (event) => {
  events += 1;
  kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
  let fields = kindFields.get(event.kind);
  if (fields === undefined) {
    fields = new Set();
    kindFields.set(event.kind, fields);
  }
  for (const key of Object.keys(event)) if (key !== 'kind') fields.add(key);

  const key = keyOf(event.session_id, event.agent_id);
  if (!streams.has(key)) streams.set(key, { session: event.session_id, agent: event.agent_id });

  const path = typeof event['path'] === 'string' ? event['path'] : undefined;
  if (path === undefined) return;
  if (event.kind === 'file.read') {
    readsAbsolute += path.startsWith('/') ? 1 : 0;
    readsRelative += path.startsWith('/') ? 0 : 1;
    let byPath = reads.get(key);
    if (byPath === undefined) {
      byPath = new Map();
      reads.set(key, byPath);
    }
    const seen = byPath.get(path);
    if (seen === undefined || event.seq < seen) byPath.set(path, event.seq);
  } else if (event.kind === 'file.changed') {
    let byPath = edits.get(key);
    if (byPath === undefined) {
      byPath = new Map();
      edits.set(key, byPath);
    }
    const seqs = byPath.get(path);
    if (seqs === undefined) byPath.set(path, [event.seq]);
    else seqs.push(event.seq);
    push(sessionEditors, event.session_id, path, key);
    push(sessionEditorsByBase, event.session_id, basename(path), key);
  }
};

const normalizer = createNormalizer();
const totals = await streamCorpus(
  (record, file) => {
    for (const event of normalizer.accept(record, file)) offer(event);
  },
  { root: ROOT, projects: new Set([PROJECT]), includeEphemeral: true },
);
for (const event of normalizer.drain()) offer(event);

const isMain = (key) => streams.get(key).agent === 'main';

/**
 * Classify every (stream, distinct path read) pair.
 * `editorsOf(session, pathOrBase)` returns the streams that edited it, or undefined.
 */
const classify = (which, editorsOf) => {
  const o = {
    pairs: 0,
    a: 0,
    aBackward: 0,
    aForwardOnly: 0,
    b: 0,
    bBackward: 0,
    c: 0,
    cBackward: 0,
    d: 0,
  };
  for (const [key, byPath] of reads) {
    if (which === 'subagent' && isMain(key)) continue;
    if (which === 'main' && !isMain(key)) continue;
    const session = streams.get(key).session;
    for (const [path, readSeq] of byPath) {
      o.pairs += 1;
      const editors = editorsOf(session, path);
      if (editors === undefined || editors.size === 0) {
        o.d += 1;
        continue;
      }
      const backwards = (streamKey) => (edits.get(streamKey)?.get(path) ?? []).some((s) => s < readSeq);
      if (editors.has(key)) {
        o.a += 1;
        if (backwards(key)) o.aBackward += 1;
        else o.aForwardOnly += 1;
      } else if (editors.has(mainKey(session))) {
        o.b += 1;
        if (backwards(mainKey(session))) o.bBackward += 1;
      } else {
        o.c += 1;
        if ([...editors].some(backwards)) o.cBackward += 1;
      }
    }
  }
  return o;
};

const byPath = (s, p) => sessionEditors.get(s)?.get(p);
const byBase = (s, b) => sessionEditorsByBase.get(s)?.get(b);

const subExact = classify('subagent', byPath);
const subBase = classify('subagent', (s, p) => byBase(s, basename(p)));
const mainExact = classify('main', byPath);
const mainBase = classify('main', (s, p) => byBase(s, basename(p)));

const streamsPerSession = new Map();
for (const s of streams.values()) {
  streamsPerSession.set(s.session, (streamsPerSession.get(s.session) ?? 0) + 1);
}
const multi = [...streamsPerSession.values()].filter((n) => n > 1).length;
const subStreamKeys = [...streams.keys()].filter((k) => !isMain(k));

const table = (label, o, extra = '') => {
  const d = o.pairs === 0 ? 1 : o.pairs;
  const pct = (n) => `${((n / d) * 100).toFixed(1)}%`.padStart(6);
  console.log(
    [
      label.padEnd(24),
      String(o.pairs).padStart(7),
      String(o.a).padStart(6),
      String(o.aBackward).padStart(6),
      String(o.aForwardOnly).padStart(6),
      String(o.b).padStart(6),
      String(o.bBackward).padStart(6),
      String(o.c).padStart(6),
      String(o.cBackward).padStart(6),
      String(o.d).padStart(6),
      `a ${pct(o.a)}  bc ${pct(o.b + o.c)}  d ${pct(o.d)}`,
      extra,
    ].join(' '),
  );
};

console.log('project', PROJECT);
console.log('files', totals.files, 'events', events, 'streams', streams.size,
  `(${subStreamKeys.length} subagent, ${streams.size - subStreamKeys.length} main)`,
  'sessions', streamsPerSession.size);
console.log('sessions holding more than one stream', multi, 'of', streamsPerSession.size,
  multi === 0 ? '<-- cross-stream scope would be VACUOUS' : '');
console.log('read paths: absolute', readsAbsolute, 'relative', readsRelative);
console.log('');
console.log('pair = one (stream, distinct path read). aBackward = an edit exists in the same stream');
console.log('strictly before the earliest read of that path; bBackward is the same for the main stream.');
console.log(
  [
    'scope'.padEnd(24),
    'pairs'.padStart(7),
    'a'.padStart(6),
    'a<--'.padStart(6),
    'a-->'.padStart(6),
    'b'.padStart(6),
    'b<--'.padStart(6),
    'c'.padStart(6),
    'c<--'.padStart(6),
    'd'.padStart(6),
    'shares',
  ].join(' '),
);
table('subagent / exact path', subExact);
table('subagent / basename', subBase);
table('main (control) / exact', mainExact);
table('main (control) / basename', mainBase);
console.log('');
console.log('--- concentration: is one stream producing all the pairs? ---');
{
  const perStream = [];
  for (const [key, byPath] of reads) {
    if (isMain(key)) continue;
    perStream.push(byPath.size);
  }
  perStream.sort((a, b) => b - a);
  const total = perStream.reduce((a, n) => a + n, 0);
  const top = perStream[0] ?? 0;
  console.log('subagent streams that read anything', perStream.length, 'of', subStreamKeys.length);
  console.log('pairs', total, 'largest single stream', top,
    `(${total === 0 ? '0.0' : ((top / total) * 100).toFixed(1)}%)`,
    'top 5', perStream.slice(0, 5).join(','), 'streams with 1 pair',
    perStream.filter((n) => n === 1).length);
}
console.log('');
console.log('--- field sets, read off the events, not quoted from source ---');
for (const kind of ['file.read', 'file.changed', 'check.run', 'agent.spawn', 'agent.return']) {
  console.log(String(kindCounts.get(kind) ?? 0).padStart(7), kind.padEnd(14),
    [...(kindFields.get(kind) ?? [])].sort().join(' '));
}
console.log('');
console.log('normalizer counters', JSON.stringify(normalizer.counters));
console.log('kinds', JSON.stringify(Object.fromEntries([...kindCounts].sort((x, y) => y[1] - x[1]))));
