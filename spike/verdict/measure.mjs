// asc-6ola.6 (throwaway). For every check run that ingest recognizes, where does the check sit in
// its command, and does is_error agree with the output's own summary?
//   node spike/verdict/measure.mjs <corpus-frozen>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkRunner } from '../../packages/adapter-claude-code/dist/index.js';

const [corpus] = process.argv.slice(2);
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : []; });
const HEREDOC = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

// Position of the first check in the command: 'last' (nothing runs after it), or the operator that follows it.
function position(command) {
  const pieces = []; // [text, operatorAfter]
  let heredoc;
  for (const line of command.split('\n')) {
    if (heredoc !== undefined) { if (line.trim() === heredoc) heredoc = undefined; continue; }
    const opened = HEREDOC.exec(line);
    const parts = line.split(/(\|\||&&|;|\|&|\|(?!&)|(?<![<>&])&(?![>&]))/);
    for (let i = 0; i < parts.length; i += 2) pieces.push([parts[i], parts[i + 1] ?? '\n']);
    if (opened) heredoc = opened[1];
  }
  const live = pieces.filter(([t]) => t.trim().length > 0);
  const at = live.findIndex(([t]) => checkRunner(t) !== undefined);
  if (at < 0) return 'unfound';
  if (at === live.length - 1) return 'last';
  const op = live[at][1];
  return op === '\n' ? 'newline' : op;
}

// The output's own verdict, from a runner summary; undefined when no summary is recognized.
function outputVerdict(text) {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (/Test Files\s+[^\n]*\b[1-9]\d* failed/.test(t) || /Tests:?\s+[^\n]*\b[1-9]\d* failed/.test(t) || /test result: FAILED/.test(t) || /error TS\d+:/.test(t)) return 'failed';
  if (/Test Files\s+\d+ passed/.test(t) || /test result: ok\./.test(t)) return 'passed';
  return undefined;
}

const cmds = new Map();
const tally = {};
const pipefail = { with: 0 };
for (const f of walk(corpus)) {
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const c = r.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use' && b.name === 'Bash') cmds.set(b.id, b.input?.command ?? '');
      if (b.type !== 'tool_result' || !cmds.has(b.tool_use_id)) continue;
      const command = cmds.get(b.tool_use_id);
      if (checkRunner(command) === undefined || typeof b.is_error !== 'boolean') continue;
      if (/pipefail/.test(command)) pipefail.with++;
      const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n');
      const pos = position(command);
      const out = outputVerdict(text);
      const isErr = b.is_error ? 'failed' : 'passed';
      const k = tally[pos] ??= { runs: 0, withSummary: 0, agree: 0, errPassedOutFailed: 0, errFailedOutPassed: 0 };
      k.runs++;
      if (out) { k.withSummary++; if (out === isErr) k.agree++; else if (isErr === 'passed') k.errPassedOutFailed++; else k.errFailedOutPassed++; }
    }
  }
}
const total = Object.values(tally).reduce((s, v) => s + v.runs, 0);
console.log('check runs with a boolean is_error', total, '| commands mentioning pipefail', pipefail.with);
for (const [p, v] of Object.entries(tally).sort((a, b) => b[1].runs - a[1].runs)) console.log(`after check: ${JSON.stringify(p).padEnd(10)} ${JSON.stringify(v)}`);
