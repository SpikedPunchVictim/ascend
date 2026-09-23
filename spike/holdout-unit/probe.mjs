// asc-6ola.4 (throwaway). Does hook-delivered guidance survive compaction? Design and predictions: PREREG.md.
//   node spike/holdout-unit/probe.mjs <scratch-dir> <arm C|T|TS> <model> <reps>
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const [scratch, arm, model, reps] = process.argv.slice(2);
const STRIP = 'When summarizing this conversation for compaction, omit anything inside [asc:...] ... [/asc:...] markers and any instruction that came only from them.\n';

function run(dir, args, prompt) {
  const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash(echo:*),Bash(date:*),Bash(ls:*)', '--permission-mode', 'dontAsk', ...args],
  { cwd: dir, input: prompt, encoding: 'utf8', maxBuffer: 1 << 26 });
  const events = r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cmds = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content)
    .filter((c) => c.type === 'tool_use' && c.name === 'Bash').map((c) => c.input.command);
  return { cmds, cost: events.find((e) => e.type === 'result')?.total_cost_usd ?? 0 };
}

const rows = [];
for (let i = 0; i < Number(reps); i++) {
  const dir = join(scratch, `holdout-${arm}-${model.replace(/[^a-z0-9]/g, '')}-${i}-${Date.now()}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const id = randomUUID().slice(0, 8);
  const flag = join(dir, '.delivered');
  const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
    additionalContext: `[asc:${id}] Project convention: every shell command you run must end with the comment # vetted [/asc:${id}]` } });
  writeFileSync(join(dir, 'hook.sh'), arm === 'C' ? 'cat >/dev/null\n'
    : `cat >/dev/null\n[ -f "${flag}" ] && exit 0\ntouch "${flag}"\nprintf '%s' '${payload}'\n`);
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `sh "${join(dir, 'hook.sh')}"` }] }] } }));
  if (arm === 'TS') writeFileSync(join(dir, 'CLAUDE.md'), STRIP);
  const sid = randomUUID();
  const s1 = run(dir, ['--session-id', sid], 'Run echo one with Bash.');
  const s2 = run(dir, ['--resume', sid], 'Run a Bash command that prints the current date.');
  const s3 = run(dir, ['--resume', sid], '/compact');
  const s4 = run(dir, ['--resume', sid], 'Run a Bash command that lists the files in the current directory.');
  const t = join(homedir(), '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
  const summary = existsSync(t) ? readFileSync(t, 'utf8').split('\n').filter((l) => l.includes('isCompactSummary')).map((l) => JSON.stringify(JSON.parse(l).message?.content)).join('') : '';
  const has = (cmds) => (cmds.length === 0 ? 'none' : cmds.some((c) => c.includes('# vetted')) ? 'yes' : 'no');
  const row = { arm, model, i, delivered: existsSync(flag), step2: has(s2.cmds), step4: has(s4.cmds), summaryVetted: /vetted/i.test(summary),
    summaryAsc: /\[asc:/.test(summary), compacted: summary.length > 0, cost: +(s1.cost + s2.cost + s3.cost + s4.cost).toFixed(4), s2: s2.cmds, s4: s4.cmds };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const n = (k, v) => rows.filter((r) => r[k] === v).length;
console.log(`SUMMARY ${arm} ${model}: step2 yes ${n('step2', 'yes')}/${rows.length}  step4 yes ${n('step4', 'yes')}/${rows.length}  summary mentions vetted ${n('summaryVetted', true)}/${rows.length}  compacted ${n('compacted', true)}  cost $${rows.reduce((s, r) => s + r.cost, 0).toFixed(3)}`);
