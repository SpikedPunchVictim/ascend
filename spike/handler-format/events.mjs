// Spike asc-6ola.5 (throwaway). The normalized event stream every candidate reads: the
// normalizer of spike/replay/replay.mjs, plus `seq` (order within the file) and `call` (index of
// the tool call an event belongs to, within the file). One array per transcript file; a file is
// the window key, as in spike/replay.
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { execSegments } from '../../packages/adapter-claude-code/dist/index.js';

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
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (n.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

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
  const stdout = result && typeof result === 'object' ? String(result.stdout ?? '') : '';
  if (isError && !stdout.trim()) return 0;
  const ls = stdout.split('\n').filter((l) => l.trim());
  if (/(^|\s)-c(\s|$)|--count/.test(String(input.command))) {
    return ls.reduce((a, l) => a + (Number(l.split(':').pop()) || 0), 0);
  }
  return ls.length;
}

function* normalize(rec, st) {
  const base = { ts: rec.timestamp, session: rec.sessionId };
  const content = rec.message?.content;
  if (rec.type === 'user' && typeof content === 'string') yield { ...base, call: st.calls, kind: 'prompt.submit', text: content.slice(0, 200) };
  if (rec.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      const call = ++st.calls;
      st.pending.set(c.id, { tool: c.name, input: c.input ?? {}, call });
      yield { ...base, call, kind: 'tool.use.start', tool: c.name, id: c.id };
    }
  }
  if (rec.type === 'user' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      const start = st.pending.get(c.tool_use_id);
      if (!start) continue;
      st.pending.delete(c.tool_use_id);
      const { tool, input, call } = start;
      const ok = !c.is_error;
      const at = { ...base, call, id: c.tool_use_id, ok };
      yield { ...at, kind: 'tool.use.end', tool };
      if (tool === 'Bash') {
        const segs = execSegments(String(input.command ?? ''));
        for (const argv of segs) {
          yield { ...at, kind: 'command.run', tool, head: argv[0], argv };
          if (SEARCH_HEADS.has(argv[0]) && segs.length <= 3) {
            yield { ...at, kind: 'search.run', tool, via: argv[0], pattern: argv.slice(1).join(' '),
              hits: hitCount('Bash', input, rec.toolUseResult, c.is_error) };
          }
        }
      }
      if (tool === 'Grep' || tool === 'Glob') {
        yield { ...at, kind: 'search.run', tool, via: tool, pattern: String(input.pattern ?? ''),
          hits: hitCount(tool, input, rec.toolUseResult, c.is_error) };
      }
      if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && ok) {
        yield { ...at, kind: 'file.changed', tool, path: String(input.file_path ?? ''),
          before: String(input.old_string ?? ''), after: String(input.new_string ?? input.content ?? '') };
      }
    }
  }
}

/** [{ file, events: [{ file, seq, call, kind, ... }] }] for one project directory of the corpus. */
export async function loadEvents(corpus, project) {
  const files = walk(corpus).filter((p) => p.slice(corpus.length).replace(/^\//, '').split('/')[0] === project);
  const out = [];
  for (const path of files.sort()) {
    const file = path.slice(corpus.length).replace(/^\//, '');
    const st = { calls: 0, pending: new Map() };
    const events = [];
    for await (const line of lines(path)) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      for (const e of normalize(rec, st)) events.push({ file, seq: events.length, ...e });
    }
    out.push({ file, events });
  }
  return out;
}
