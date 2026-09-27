// asc-tuur.1 (Stage 0): which hook stages does a typed handler's lifecycle hook get to run at,
// and what does each one's input carry? Descriptive, not pre-registered.
//   node spike/capture-hooks/probe.mjs <scratch-dir> [model]
//
// Questions (spike/exposure/FINDINGS.md already answers UserPromptSubmit `prompt` and Stop
// `stop_hook_active`, both under -p):
//   Q1 does PostToolUse with matcher `Skill` fire, and does tool_input carry the skill name?
//   Q2 does it fire for a Skill call made INSIDE a subagent, and does its input carry agent_id?
//   Q3 does SubagentStop fire, and with which keys?
//   Q4 does the JSON additionalContext a Skill PostToolUse hook returns reach the model?
// Everything runs in a throwaway project under <scratch-dir>; this repository's settings are not
// touched.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const [scratch, model = 'claude-haiku-4-5-20251001'] = process.argv.slice(2);
const dir = join(scratch, `capture-hooks-${Date.now()}`);
mkdirSync(join(dir, '.claude', 'skills', 'probe-skill'), { recursive: true });
writeFileSync(
  join(dir, '.claude', 'skills', 'probe-skill', 'SKILL.md'),
  '---\nname: probe-skill\ndescription: A probe. When run, reply with the single word PROBED.\n---\n\nReply with the single word PROBED.\n',
);

const log = join(dir, 'events.jsonl');
const nonce = `NONCE-SKILL-${randomBytes(4).toString('hex')}`;
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const capture = { type: 'command', command: `cat >> "${log}"; echo >> "${log}"`, async: true };
const nudge = join(dir, 'nudge.sh');
writeFileSync(
  nudge,
  `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Skill note: ${nonce}` } })}'\n`,
);
chmodSync(nudge, 0o755);
const hooks = Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [capture] }]]));
hooks.PostToolUse.push({ matcher: 'Skill', hooks: [{ type: 'command', command: nudge }] });
writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2));

const prompt = [
  '1. Use the Skill tool to run the skill named probe-skill.',
  '2. Use the Agent tool to start ONE general-purpose subagent with this task: "Use the Skill tool to run the skill named probe-skill, then reply done."',
  '3. Finally reply with every string beginning with NONCE- that you have seen anywhere in this conversation, verbatim, one per line, or NONE.',
].join('\n');
const argv = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose',
  '--allowedTools', 'Skill,Agent,Task', '--permission-mode', 'dontAsk'];
const child = spawn('claude', argv, { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const out = [];
child.stdout.on('data', (c) => out.push(c));
child.stdin.end(prompt);
const code = await new Promise((r) => child.on('close', r));
await new Promise((r) => setTimeout(r, 3000)); // let async hooks finish
const stream = Buffer.concat(out).toString('utf8');
writeFileSync(join(dir, 'stream.jsonl'), stream);
const lines = stream.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const result = lines.find((e) => e?.type === 'result');
// Main-stream assistant text only: a subagent's text carries parent_tool_use_id.
const said = lines.filter((e) => e?.type === 'assistant' && e.parent_tool_use_id == null)
  .flatMap((e) => e.message.content.filter((c) => c.type === 'text').map((c) => c.text)).join('\n');
const skillCalls = lines.filter((e) => e?.type === 'assistant')
  .flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use' && c.name === 'Skill')
    .map((c) => ({ id: c.id, inSubagent: e.parent_tool_use_id != null, input: c.input })));

const captured = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
const BASE = ['session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'permission_mode', 'effort', 'hook_event_name'];
console.log(JSON.stringify({ model, exit: code, costUsd: result?.total_cost_usd, captured: captured.length, dir }));
console.log('skill tool calls in stream:', JSON.stringify(skillCalls));
for (const e of captured) {
  const extra = Object.keys(e).filter((k) => !BASE.includes(k));
  const peek = e.tool_name === 'Skill' ? ` tool_input=${JSON.stringify(e.tool_input)}` : '';
  const who = e.agent_id !== undefined ? ` agent_id=${String(e.agent_id).slice(0, 8)} agent_type=${e.agent_type}` : '';
  console.log(`${e.hook_event_name.padEnd(17)} ${(e.tool_name ?? '').padEnd(6)} keys+=[${extra.join(',')}]${who}${peek}`);
}
console.log(`Q4 nonce reported by model: ${said.includes(nonce)}`);
console.log('--- model said:\n' + said.slice(0, 600));
