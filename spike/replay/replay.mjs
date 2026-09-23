// Spike asc-bolz (throwaway). Replay a frozen transcript corpus as a normalized event stream,
// run declarative handlers over it, and score them against hand-recorded ground truth.
// PREREG.md holds the questions and predictions; this file only measures.
//
//   node spike/replay/replay.mjs <frozen-corpus-dir> <out-dir>

import { readdirSync, statSync, createReadStream, writeFileSync, createWriteStream } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gzipSync } from 'node:zlib';
import { execSegments } from '../../packages/adapter-claude-code/dist/index.js';

const [corpus, out, onlyProject, projectRoot] = process.argv.slice(2);
// Scope (user, 2026-09-23): only this project's sessions, through this project's handlers.

// ---------- read: split on \n only (readline invents breaks at U+2028/9 -- see bd memory) ----------
async function* lines(path) {
  const dec = new StringDecoder('utf8');
  let carry = '';
  for await (const chunk of createReadStream(path)) {
    const parts = (carry + dec.write(chunk)).split('\n');
    carry = parts.pop();
    yield* parts;
  }
  carry += dec.end();
  if (carry) yield carry;
}

function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (n.endsWith('.jsonl')) acc.push({ path: p, bytes: s.size });
  }
  return acc;
}

// ---------- normalize: transcript records -> harness-neutral events ----------
// Raw: session.start, prompt.submit, tool.use.start, tool.use.end.
// Synthetic: command.run (one per exec segment), search.run, file.changed.
const SEARCH_HEADS = new Set(['grep', 'rg', 'ugrep', 'find', 'ag']);

function hitCount(tool, input, result, isError) {
  if (tool === 'Grep' || tool === 'Glob') {
    if (result && typeof result === 'object') {
      if (typeof result.numFiles === 'number' && result.mode !== 'content') return result.numFiles;
      if (typeof result.numLines === 'number') return result.numLines;
      if (Array.isArray(result.filenames)) return result.filenames.length;
      if (typeof result.content === 'string') return result.content.trim() ? result.content.trim().split('\n').length : 0;
    }
    return undefined;
  }
  // Bash: a search's hit count is its non-empty stdout lines; `grep -c` prints counts, so sum them.
  const stdout = result && typeof result === 'object' ? String(result.stdout ?? '') : '';
  if (isError && !stdout.trim()) return 0; // grep exits 1 on no match; the harness marks it an error
  const ls = stdout.split('\n').filter((l) => l.trim());
  if (/(^|\s)-c(\s|$)|--count/.test(String(input.command))) {
    return ls.reduce((a, l) => a + (Number(l.split(':').pop()) || 0), 0);
  }
  return ls.length;
}

function* normalize(rec, file, pending) {
  const base = { ts: rec.timestamp, session: rec.sessionId, file, cwd: rec.cwd };
  const content = rec.message?.content;
  if (rec.type === 'user' && typeof content === 'string') yield { ...base, kind: 'prompt.submit', text: content.slice(0, 200) };
  if (rec.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      pending.set(c.id, { tool: c.name, input: c.input ?? {}, ts: rec.timestamp });
      yield { ...base, kind: 'tool.use.start', tool: c.name, id: c.id };
    }
  }
  if (rec.type === 'user' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      const start = pending.get(c.tool_use_id);
      if (!start) continue;
      pending.delete(c.tool_use_id);
      const { tool, input } = start;
      const ok = !c.is_error;
      yield { ...base, kind: 'tool.use.end', tool, id: c.tool_use_id, ok };
      if (tool === 'Bash') {
        const segs = execSegments(String(input.command ?? ''));
        for (const argv of segs) {
          yield { ...base, kind: 'command.run', id: c.tool_use_id, head: argv[0], argv, ok };
          if (SEARCH_HEADS.has(argv[0]) && segs.length <= 3) {
            yield { ...base, kind: 'search.run', id: c.tool_use_id, via: argv[0], pattern: argv.slice(1).join(' '),
              hits: hitCount('Bash', input, rec.toolUseResult, c.is_error), ok };
          }
        }
      }
      if (tool === 'Grep' || tool === 'Glob') {
        yield { ...base, kind: 'search.run', id: c.tool_use_id, via: tool, pattern: String(input.pattern ?? ''),
          hits: hitCount(tool, input, rec.toolUseResult, c.is_error), ok };
      }
      if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && ok) {
        yield { ...base, kind: 'file.changed', id: c.tool_use_id, path: String(input.file_path ?? ''),
          before: String(input.old_string ?? ''), after: String(input.new_string ?? input.content ?? '') };
      }
    }
  }
}

// ---------- handlers: declarative where possible ----------
// A handler is { on, where (predicate over one event), emit (event -> entries[]) } or, when it
// needs context, { on, window: n, where, emit(event, following) }. Q4 is whether the first form
// suffices; the object shapes are the answer, not the code in them.
const BEAD_ID = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/;
const STATUS = /\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)/i;
const norm = (s) => s.toLowerCase().replace(/\s+/g, '_');

const handlers = {
  'stage_transition/bead-close': {
    on: 'command.run',
    where: (e) => e.ok && e.head === 'bd' && e.argv[1] === 'close',
    emit: (e) => e.argv.slice(2).filter((a) => BEAD_ID.test(a)).map((id) => ({ stage: id, to_status: 'complete' })),
  },
  'stage_transition/bead-claim': {
    on: 'command.run',
    where: (e) => e.ok && e.head === 'bd' && e.argv[1] === 'update' &&
      (e.argv.includes('--claim') || e.argv.some((a) => /^--status[= ]?in_progress$/.test(a)) ||
        (e.argv.includes('--status') && e.argv[e.argv.indexOf('--status') + 1] === 'in_progress')),
    emit: (e) => e.argv.slice(2).filter((a) => BEAD_ID.test(a)).map((id) => ({ stage: id, to_status: 'in_progress' })),
  },
  'stage_transition/plan-status-edit': {
    on: 'file.changed',
    where: (e) => /IMPLEMENTATION_PLAN\.md$|PLAN\.md$/i.test(e.path) && STATUS.test(e.after) &&
      (e.before.match(STATUS)?.[1] ?? '') !== e.after.match(STATUS)[1],
    emit: (e) => [{ stage: basename(e.path), from_status: e.before.match(STATUS)?.[1] && norm(e.before.match(STATUS)[1]),
      to_status: norm(e.after.match(STATUS)[1]) }],
  },
  'search_miss/empty-then-found': {
    on: 'search.run',
    window: 5, // the next 5 tool calls in the same session
    where: (e) => e.hits === 0,
    emit: (e, following) => {
      const terms = new Set(tokens(e.pattern));
      const hit = following.find((f) => f.kind === 'search.run' && f.hits > 0 && tokens(f.pattern).some((t) => terms.has(t)));
      return hit ? [{ pattern: e.pattern, returned: '0', corrected_by: hit.pattern, search_tool: e.via }] : [];
    },
  },
};
function tokens(p) {
  return String(p).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 4 && !/^(src|dist|test|users|projects|head|type|json|jsonl)$/.test(t));
}

// ---------- run ----------
const t0 = performance.now();
const files = walk(corpus).filter((f) => !onlyProject || f.path.slice(corpus.length).replace(/^\//, '').split('/')[0] === onlyProject);
let outsideCwd = 0, cwdEvents = 0;
const corpusBytes = files.reduce((a, f) => a + f.bytes, 0);
const matches = Object.fromEntries(Object.keys(handlers).map((k) => [k, []]));
const kinds = {};
let records = 0, malformed = 0, events = 0;
const log = createWriteStream(join(out, 'events.jsonl'));
const logChunks = [];
let logBytes = 0;

for (const f of files) {
  const pending = new Map();
  const project = basename(dirname(f.path)).startsWith('-') ? basename(dirname(f.path)) : basename(dirname(dirname(dirname(f.path))));
  const sessionEvents = [];
  for await (const line of lines(f.path)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { malformed++; continue; }
    records++;
    for (const e of normalize(rec, f.path, pending)) {
      e.project = project;
      sessionEvents.push(e);
    }
  }
  for (let i = 0; i < sessionEvents.length; i++) {
    const e = sessionEvents[i];
    events++;
    if (projectRoot && e.cwd) { cwdEvents++; if (!(e.cwd === projectRoot || e.cwd.startsWith(projectRoot + '/'))) outsideCwd++; }
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    // the normalized log keeps structure, never payload bodies (P8)
    const { before, after, text, ...slim } = e;
    const row = JSON.stringify({ ...slim, file: undefined, argv: e.argv?.slice(0, 4) }) + '\n';
    logBytes += Buffer.byteLength(row);
    logChunks.push(row);
    log.write(row);
    for (const [name, h] of Object.entries(handlers)) {
      if (h.on !== e.kind || !h.where(e)) continue;
      let following = [];
      if (h.window) {
        for (let j = i + 1, calls = 0; j < sessionEvents.length && calls < h.window; j++) {
          if (sessionEvents[j].kind === 'tool.use.end') calls++;
          following.push(sessionEvents[j]);
        }
      }
      for (const emitted of h.emit(e, following)) matches[name].push({ ts: e.ts, session: e.session, project, ...emitted });
    }
  }
}
log.end();
const elapsed = (performance.now() - t0) / 1000;
const gz = gzipSync(Buffer.from(logChunks.join(''))).length;

const summary = {
  scope: onlyProject ?? 'all', files: files.length, cwdEvents, outsideCwd, corpusBytes, records, malformed, events, kinds, elapsedSeconds: +elapsed.toFixed(1),
  normalizedLogBytes: logBytes, normalizedLogGzipBytes: gz,
  logPctOfCorpus: +((100 * logBytes) / corpusBytes).toFixed(2), gzPctOfCorpus: +((100 * gz) / corpusBytes).toFixed(3),
  matchCounts: Object.fromEntries(Object.entries(matches).map(([k, v]) => [k, v.length])),
};
writeFileSync(join(out, 'matches.json'), JSON.stringify(matches, null, 1));
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
