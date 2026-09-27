/**
 * asc-gtnu.14 probe: does a reviewer asked in ordinary words -- the tool is NOT named in the
 * prompt -- report through ReportFindings?
 *
 *   before: CLAUDE.md as it was at the bug (it sends reviewers to the user-level bug-hunt skill),
 *           no project skill.
 *   after:  CLAUDE.md as fixed, plus `.claude/skills/lens-review/`.
 *
 * Each arm runs in a fresh allowlist tree (spike/recall/trees.mjs) with the default headless
 * toolset. Write and Edit are not allowed, so a route that writes a report file is denied and the
 * denial is counted. Findings are counted twice: ReportFindings elements in the stream, and
 * review_finding entries after ingesting the transcript into a scratch store.
 *
 *   node spike/lens-review/probe.mjs --max-usd 6
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTree, REPO } from '../recall/trees.mjs';

const OUT = join(REPO, 'spike', 'tmp', 'lens-review');
const ROOT = join(OUT, 'root');
const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const MODEL = 'claude-sonnet-5';
const PER_RUN_USD = 1.5;
const BUG_COMMIT = 'e7cc416'; // CLAUDE.md as it stood when asc-gtnu.14 was open

const PROMPTS = {
  hunt: 'Hunt for bugs in packages/core/src/handler.ts. Do not change any files.',
  review: 'Review packages/core/src/handler.ts for defects. Do not change any files.',
};
const ALLOWED = [
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'ReportFindings',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(npx vitest:*)',
];

function claudeMdAt(commit) {
  const res = spawnSync('git', ['show', `${commit}:CLAUDE.md`], { cwd: REPO, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git show ${commit}:CLAUDE.md failed: ${res.stderr}`);
  return res.stdout;
}

const ARMS = {
  before: (dir) => writeFileSync(join(dir, 'CLAUDE.md'), claudeMdAt(BUG_COMMIT)),
  after: (dir) => {
    copyFileSync(join(REPO, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));
    cpSync(join(REPO, '.claude', 'skills', 'lens-review'), join(dir, '.claude', 'skills', 'lens-review'), {
      recursive: true,
    });
  },
};

function analyse(stream) {
  const out = { result: null, skills: [], reportCalls: 0, findings: 0, asked: 0, tools: {} };
  for (const line of stream.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'result') out.result = e;
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      out.tools[c.name] = (out.tools[c.name] ?? 0) + 1;
      if (c.name === 'Skill') out.skills.push(String(c.input?.skill ?? c.input?.command ?? '?'));
      if (c.name === 'ReportFindings') {
        out.reportCalls += 1;
        out.findings += Array.isArray(c.input?.findings) ? c.input.findings.length : 0;
      }
      if (c.name === 'AskUserQuestion') out.asked += 1;
    }
  }
  return out;
}

/** Copy the session's transcript (read-only source) into the pruned root, keeping its project dir. */
function copyTranscript(sessionId) {
  const projects = join(homedir(), '.claude', 'projects');
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    mkdirSync(join(ROOT, project), { recursive: true });
    copyFileSync(file, join(ROOT, project, `${sessionId}.jsonl`));
    return true;
  }
  return false;
}

async function runOne(arm, prompt, budget) {
  const tree = buildTree({ runnable: true, apply: ARMS[arm] });
  const argv = [
    '-p',
    '--model',
    MODEL,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    ALLOWED.join(','),
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--max-budget-usd',
    budget.toFixed(2),
  ];
  const child = spawn('claude', argv, { cwd: tree.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', () => {});
  child.stdin.end(PROMPTS[prompt]);
  await new Promise((resolve) => child.on('close', resolve));
  const stream = Buffer.concat(chunks).toString('utf8');
  const runId = `${arm}-${prompt}`;
  writeFileSync(join(OUT, `${runId}-stream.jsonl`), stream);
  const a = analyse(stream);
  const sessionId = a.result?.session_id ?? null;
  return {
    runId,
    arm,
    prompt,
    sessionId,
    spentUsd: a.result?.total_cost_usd ?? 0,
    subtype: a.result?.subtype ?? null,
    skills: a.skills,
    reportCalls: a.reportCalls,
    findings: a.findings,
    askUserQuestion: a.asked,
    denials: (a.result?.permission_denials ?? []).map((d) => d.tool_name),
    tools: a.tools,
    copied: sessionId ? copyTranscript(sessionId) : false,
  };
}

function storeCounts() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-probe-'));
  const run = (args) => {
    const res = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`asc ${args.join(' ')} failed: ${res.stderr}`);
    return res.stdout;
  };
  run(['init', '--json']);
  run(['ingest', 'claude-code', '--root', ROOT, '--include-ephemeral', '--json']);
  const out = run(['query', '--json', "SELECT properties_json FROM entries WHERE type_name = 'review_finding'"]);
  const counts = {};
  for (const row of JSON.parse(out).rows) {
    const sid = JSON.parse(row.properties_json).session_id;
    counts[sid] = (counts[sid] ?? 0) + 1;
  }
  return counts;
}

const i = process.argv.indexOf('--max-usd');
const maxUsd = i === -1 ? Number.NaN : Number(process.argv[i + 1]);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd is required: the total ceiling');
mkdirSync(ROOT, { recursive: true });

const runs = [];
let spent = 0;
for (const prompt of Object.keys(PROMPTS)) {
  for (const arm of Object.keys(ARMS)) {
    const budget = Math.min(PER_RUN_USD, maxUsd - spent);
    if (budget < 0.5) {
      console.error(`CEILING: spent ${spent.toFixed(4)} of ${String(maxUsd)} USD; stopping.`);
      break;
    }
    const r = await runOne(arm, prompt, budget);
    spent += r.spentUsd;
    runs.push(r);
    console.log(JSON.stringify(r));
  }
}
const stored = storeCounts();
for (const r of runs) r.stored = r.sessionId ? (stored[r.sessionId] ?? 0) : null;
writeFileSync(join(OUT, 'probe.json'), JSON.stringify(runs, null, 2));
console.log(`\nrun            skills                     RF calls  findings  stored  asked  denials  $`);
for (const r of runs) {
  console.log(
    `${r.runId.padEnd(14)} ${JSON.stringify(r.skills).padEnd(26)} ${String(r.reportCalls).padStart(8)}  ${String(r.findings).padStart(8)}  ${String(r.stored).padStart(6)}  ${String(r.askUserQuestion).padStart(5)}  ${String(r.denials.length).padStart(7)}  ${r.spentUsd.toFixed(4)}`,
  );
}
console.log(`total spent $${spent.toFixed(4)}`);
