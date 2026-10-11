// asc-xn4g (Stage 0): what does a hook input ACTUALLY carry, key by key?
//   node spike/hook-input-keys/probe.mjs <scratch-dir> [model]
//
// Why this exists. `spike/capture-hooks/FINDINGS.md` prints `keys+=[...]` computed as
// `Object.keys(e).filter((k) => !BASE.includes(k))`, where BASE is a literal list that CONTAINS
// `transcript_path`. A key in BASE therefore can never appear in the output, so that spike cannot
// distinguish "the harness sent transcript_path" from "nobody looked". This probe prints the whole
// key list and the values of the keys this bead would depend on.
//
// Questions, fixed before running:
//   Q1 is `transcript_path` present, and on which events?
//   Q2 is it an absolute path that EXISTS at hook time?
//   Q3 does that file already hold `isCompactSummary` records, so a segment index is countable
//      from it (checked against the real corpus, which is where compacted sessions actually are)?
//   Q4 does SessionStart carry `source`, and what is it on a normal start?
//
// Everything runs in a throwaway project under <scratch-dir>; this repository's settings are not
// touched. The capture hook is a shell append, async, so it cannot block the session.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [scratch, model = 'claude-haiku-4-5-20251001'] = process.argv.slice(2);
const dir = join(scratch, `hook-keys-${Date.now()}`);
mkdirSync(join(dir, '.claude'), { recursive: true });
writeFileSync(join(dir, 'note.txt'), 'PROBE NOTE\n');

const log = join(dir, 'events.jsonl');
const capture = { type: 'command', command: `cat >> "${log}"; echo >> "${log}"`, async: true };
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
writeFileSync(
  join(dir, '.claude', 'settings.json'),
  JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [capture] }]])) }, null, 2),
);

const prompt = 'Read the file note.txt in the current directory, then reply with the single word DONE.';
// `--strict-mcp-config` with no config: the first run died at `init` with a user MCP server stuck
// at status `pending`, so the model never took a turn and no tool stage ever fired. Pinning the
// MCP config shut removes that variable; it touches nothing outside the throwaway dir.
const argv = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--allowedTools', 'Read', '--permission-mode', 'dontAsk'];
const child = spawn('claude', argv, { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const out = [];
child.stdout.on('data', (c) => out.push(c));
child.stdin.end(prompt);
const code = await new Promise((r) => child.on('close', r));
await new Promise((r) => setTimeout(r, 3000)); // let async hooks finish

const stream = Buffer.concat(out).toString('utf8');
writeFileSync(join(dir, 'stream.jsonl'), stream);

const captured = existsSync(log)
  ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

console.log(JSON.stringify({ model, exit: code, dir, captured: captured.length }));
for (const e of captured) {
  const keys = Object.keys(e).sort();
  const tp = e.transcript_path;
  const exists = typeof tp === 'string' ? existsSync(tp) : false;
  console.log(`\n${e.hook_event_name}`);
  console.log(`  KEYS (${keys.length}): ${keys.join(', ')}`);
  console.log(`  transcript_path: ${tp === undefined ? 'ABSENT' : tp}`);
  console.log(`  transcript exists at hook time: ${String(exists)}`);
  if (e.source !== undefined) console.log(`  source: ${JSON.stringify(e.source)}`);
  if (e.cwd !== undefined) console.log(`  cwd: ${e.cwd}`);
}

// Q3, against the real corpus rather than the throwaway session: do compacted transcripts on this
// machine actually carry `isCompactSummary`, and is more than one compaction per file real?
const corpusRoot = join(process.env.HOME ?? '', '.claude', 'projects');
let files = 0;
let withCompact = 0;
let maxCompact = 0;
const walk = (at) => {
  for (const name of readdirSync(at)) {
    const full = join(at, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full);
    else if (name.endsWith('.jsonl')) {
      files += 1;
      let n = 0;
      try {
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          if (line.includes('"isCompactSummary"') && line.includes('true')) n += 1;
        }
      } catch { /* unreadable file is not a zero, it is a miss */ }
      if (n > 0) { withCompact += 1; maxCompact = Math.max(maxCompact, n); }
    }
  }
};
if (existsSync(corpusRoot)) walk(corpusRoot);
console.log(`\nQ3 corpus: files=${files} with-compaction=${withCompact} most-in-one-file=${maxCompact}`);
console.log('  (read-only; nothing is copied out of the corpus)');
