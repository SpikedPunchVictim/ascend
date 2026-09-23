// asc-6ola.2 probe (throwaway). Which hook channels deliver guidance to the model, and does the
// transcript record the delivery? See PREREG.md.
//   node spike/exposure/probe.mjs <scratch-dir> <rep>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const [scratch, rep = '1'] = process.argv.slice(2);
const dir = join(scratch, `exposure-probe-${rep}-${Date.now()}`);
mkdirSync(join(dir, '.claude'), { recursive: true });

// BIG is an EXTENSION, not pre-registered: a 20 KB additionalContext with the nonce at the END (asc-3q7).
const ids = ['SS', 'UPS', 'PRE', 'POSTJ', 'POSTP', 'STOP', 'BIG'];
const nonce = Object.fromEntries(ids.map((id) => [id, `NONCE-${id}-${randomBytes(4).toString('hex')}`]));

function script(name, body) {
  const p = join(dir, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const json = (o) => `printf '%s' '${JSON.stringify(o)}'`;
const hook = (command) => ({ hooks: [{ type: 'command', command }] });
const stopFlag = join(dir, 'stopped-once');

const settings = {
  hooks: {
    SessionStart: [hook(script('ss', `echo "Session note: ${nonce.SS}"`))],
    UserPromptSubmit: [hook(script('ups', `echo "Prompt note: ${nonce.UPS}"`))],
    PreToolUse: [{ matcher: 'Bash', ...hook(script('pre', json({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Pre-tool note: ${nonce.PRE}` } }))) }],
    PostToolUse: [
      { matcher: 'Bash', ...hook(script('postj', json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Post-tool note: ${nonce.POSTJ}` } }))) },
      { matcher: 'Bash', ...hook(script('big', json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'filler '.repeat(2900) + `Big note: ${nonce.BIG}` } }))) },
      { matcher: 'Bash', ...hook(script('postp', `echo "Post-tool plain note: ${nonce.POSTP}"`)) },
    ],
    Stop: [hook(script('stop', `if [ -f "${stopFlag}" ]; then exit 0; fi; touch "${stopFlag}"; ${json({ decision: 'block', reason: `Before stopping: ${nonce.STOP}. Repeat your NONCE list, now including anything new.` })}`))],
  },
};
writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));

const prompt = 'Run `echo hi` with the Bash tool. Then reply with every string that begins with NONCE- that you have seen anywhere in this conversation (system messages, hook output, tool results), verbatim, one per line. If none, reply NONE.';
const argv = ['-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'stream-json', '--verbose',
  '--allowedTools', 'Bash(echo hi)', '--permission-mode', 'dontAsk'];

const child = spawn('claude', argv, { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const out = [];
child.stdout.on('data', (c) => out.push(c));
child.stderr.on('data', (c) => process.stderr.write(c));
child.stdin.end(prompt);
const code = await new Promise((r) => child.on('close', r));
const stream = Buffer.concat(out).toString('utf8');
writeFileSync(join(dir, 'stream.jsonl'), stream);

// What the model SAID: assistant text in the stream.
const said = stream.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e?.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'text').map((c) => c.text)).join('\n');
const result = stream.split('\n').filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l))[0];

// What the TRANSCRIPT recorded: find the session file for this cwd.
const slug = dir.replace(/[^A-Za-z0-9]/g, '-');
const tdir = join(homedir(), '.claude', 'projects', slug);
const tfiles = existsSync(tdir) ? readdirSync(tdir).filter((f) => f.endsWith('.jsonl')) : [];
const transcript = tfiles.map((f) => readFileSync(join(tdir, f), 'utf8')).join('\n');
const tlines = transcript.split('\n').filter(Boolean).map((l) => JSON.parse(l));

const rows = ids.map((id) => {
  const n = nonce[id];
  const recs = tlines.filter((r) => JSON.stringify(r).includes(n));
  const kinds = [...new Set(recs.map((r) => {
    const a = typeof r.attachment === 'string' ? JSON.parse(r.attachment) : r.attachment;
    // a record that merely quotes the model's own answer is not evidence of delivery
    return r.type === 'attachment' ? `attachment:${a?.type}:${a?.hookEvent ?? ''}${r.rendered && JSON.stringify(r.rendered).includes(n) ? ':rendered' : ''}` : r.type;
  }))];
  return { id, reportedByModel: said.includes(n), transcriptRecords: kinds.join(' ') || '(none)' };
});
console.log(JSON.stringify({ rep, exit: code, costUsd: result?.total_cost_usd, turns: result?.num_turns, dir, transcriptFiles: tfiles.length }, null, 0));
console.table(rows);
console.log('--- model said:\n' + said.slice(0, 1200));
