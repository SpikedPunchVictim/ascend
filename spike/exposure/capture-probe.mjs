// asc-6ola capture survey (throwaway, NOT pre-registered -- descriptive only).
// If ascend captures events itself through async hooks, what does it see, and does it miss anything
// the transcript has?   node spike/exposure/capture-probe.mjs <scratch-dir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [scratch] = process.argv.slice(2);
const dir = join(scratch, `capture-probe-${Date.now()}`);
mkdirSync(join(dir, '.claude'), { recursive: true });
const log = join(dir, 'events.jsonl');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd', 'SubagentStop'];
const capture = { type: 'command', command: `cat >> "${log}"; echo >> "${log}"`, async: true };
writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [capture] }]])) }, null, 2));

const prompt = 'Run these two Bash commands, one at a time: `echo hi` and then `ls /definitely-not-here`. Then say in one sentence what happened.';
const argv = ['-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'stream-json', '--verbose',
  '--allowedTools', 'Bash(echo hi),Bash(ls /definitely-not-here)', '--permission-mode', 'dontAsk'];
const child = spawn('claude', argv, { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const out = [];
child.stdout.on('data', (c) => out.push(c));
child.stdin.end(prompt);
await new Promise((r) => child.on('close', r));
await new Promise((r) => setTimeout(r, 3000)); // let async hooks finish
const result = Buffer.concat(out).toString('utf8').split('\n').filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l))[0];

const captured = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
const slug = dir.replace(/[^A-Za-z0-9]/g, '-');
const tdir = join(homedir(), '.claude', 'projects', slug);
const tlines = (existsSync(tdir) ? readdirSync(tdir).filter((f) => f.endsWith('.jsonl')) : [])
  .flatMap((f) => readFileSync(join(tdir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const transcriptToolIds = new Set(tlines.flatMap((r) => (r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content : [])
  .filter((c) => c.type === 'tool_use').map((c) => c.id)));

console.log(JSON.stringify({ costUsd: result?.total_cost_usd, captured: captured.length, dir }));
for (const e of captured) {
  const extra = Object.keys(e).filter((k) => !['session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'permission_mode', 'effort', 'hook_event_name'].includes(k));
  const peek = e.tool_response !== undefined ? ` tool_response=${JSON.stringify(e.tool_response).slice(0, 90)}` : e.error !== undefined ? ` error=${JSON.stringify(e.error).slice(0, 90)}` : e.last_assistant_message !== undefined ? ` last_assistant_message=${JSON.stringify(e.last_assistant_message).slice(0, 90)}` : '';
  console.log(`${e.hook_event_name.padEnd(18)} ${e.tool_use_id ?? ''} keys+=[${extra.join(',')}]${peek}`);
}
const capturedToolIds = new Set(captured.map((e) => e.tool_use_id).filter(Boolean));
console.log('tool_use ids: transcript', transcriptToolIds.size, 'captured', capturedToolIds.size,
  'missing from capture', [...transcriptToolIds].filter((i) => !capturedToolIds.has(i)).length);
