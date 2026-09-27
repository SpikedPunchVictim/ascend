/**
 * asc-tuur.4 probe: does the review-finding nudge -- a say: handler run by a PostToolUse hook on
 * the Skill call -- make a reviewer who loads the user-level bug-hunt skill call ReportFindings?
 *
 * PRE-REGISTERED before the first run (asc-tuur.4 bead comment, and here):
 *   before: 0 of 2 sessions call ReportFindings (spike/lens-review measured before-hunt at 0 of 1).
 *   after:  at least 1 of 2 sessions calls it. PostToolUse context was acted on 1/3 by sonnet in
 *           spike/holdout-unit, so 2 of 2 is not the prediction.
 * n=2 per arm: an anecdote under MIN_N (20), and reported as one.
 *
 * Both arms: the spike/recall allowlist tree, CLAUDE.md as of e7cc416 (it sends reviewers to the
 * user-level bug-hunt skill), `asc init`, `asc install-hook --yes` -- and then the SessionStart
 * entry is stripped from the tree's settings, so the types brief is not a difference between arms.
 * The ONLY difference: the after arm has handlers/review-finding-nudge.yaml, so install-hook also
 * wrote its PostToolUse hook (matcher Skill). Write is allowed, as it is in real use.
 *
 * Findings are counted three ways: ReportFindings elements in the stream; whether the nudge text
 * reached the session at all (the hook fired); and review_finding entries after ingesting the
 * transcripts into a scratch store that also runs handlers/review-finding-table.yaml, per route.
 *
 *   node spike/capture-hooks/nudge-probe.mjs --max-usd 6
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTree, REPO } from '../recall/trees.mjs';

const OUT = join(REPO, 'spike', 'tmp', 'capture-hooks-nudge');
const ROOT = join(OUT, 'root');
const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const MODEL = 'claude-sonnet-5';
const PER_RUN_USD = 1.5;
const RUNS_PER_ARM = 2;
const BUG_COMMIT = 'e7cc416';
const NUDGE = join(REPO, 'handlers', 'review-finding-nudge.yaml');
const TABLE = join(REPO, 'handlers', 'review-finding-table.yaml');
/** A phrase of the nudge's sentence, to tell whether the hook's context reached the session. */
const NUDGE_MARK = 'ascend records review findings';

const PROMPT = 'Hunt for bugs in packages/core/src/handler.ts. Do not change any source files.';
const ALLOWED = [
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'Write',
  'ReportFindings',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(npx vitest:*)',
];

function asc(args, cwd) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`asc ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}

function claudeMdAt(commit) {
  const res = spawnSync('git', ['show', `${commit}:CLAUDE.md`], { cwd: REPO, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git show ${commit}:CLAUDE.md failed: ${res.stderr}`);
  return res.stdout;
}

function setUp(arm) {
  const tree = buildTree({
    runnable: true,
    apply: (dir) => writeFileSync(join(dir, 'CLAUDE.md'), claudeMdAt(BUG_COMMIT)),
  });
  asc(['init'], tree.dir);
  if (arm === 'after') {
    mkdirSync(join(tree.dir, 'handlers'));
    copyFileSync(NUDGE, join(tree.dir, 'handlers', 'review-finding-nudge.yaml'));
  }
  asc(['install-hook', '--yes'], tree.dir);
  const settingsPath = join(tree.dir, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  delete settings.hooks.SessionStart;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { dir: tree.dir, hooks: Object.keys(settings.hooks) };
}

function analyse(stream) {
  const out = { result: null, skills: [], reportCalls: 0, findings: 0, writes: 0 };
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
      if (c.name === 'Skill') out.skills.push(String(c.input?.skill ?? '?'));
      if (c.name === 'Write') out.writes += 1;
      if (c.name === 'ReportFindings') {
        out.reportCalls += 1;
        out.findings += Array.isArray(c.input?.findings) ? c.input.findings.length : 0;
      }
    }
  }
  return out;
}

/** Copy the session's transcript (the source is read-only) into the pruned root. */
function copyTranscript(sessionId) {
  const projects = join(homedir(), '.claude', 'projects');
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    mkdirSync(join(ROOT, project), { recursive: true });
    copyFileSync(file, join(ROOT, project, `${sessionId}.jsonl`));
    return file;
  }
  return null;
}

async function runOne(arm, index, budget) {
  const tree = setUp(arm);
  const argv = [
    '-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose',
    '--allowedTools', ALLOWED.join(','), '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--max-budget-usd', budget.toFixed(2),
  ];
  // ASCEND_BIN is how the installed script finds this checkout's asc from inside the tree.
  const child = spawn('claude', argv, {
    cwd: tree.dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ASCEND_BIN: BIN },
  });
  const chunks = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', () => {});
  child.stdin.end(PROMPT);
  await new Promise((resolve) => child.on('close', resolve));
  const stream = Buffer.concat(chunks).toString('utf8');
  const runId = `${arm}-${String(index)}`;
  writeFileSync(join(OUT, `${runId}-stream.jsonl`), stream);
  const a = analyse(stream);
  const sessionId = a.result?.session_id ?? null;
  return {
    runId,
    arm,
    hooks: tree.hooks,
    sessionId,
    spentUsd: a.result?.total_cost_usd ?? 0,
    subtype: a.result?.subtype ?? null,
    skills: a.skills,
    reportCalls: a.reportCalls,
    findings: a.findings,
    writes: a.writes,
    denials: (a.result?.permission_denials ?? []).map((d) => d.tool_name),
    // stream-json does not echo hook context, so delivery is read from the transcript, where a
    // PostToolUse additionalContext is a `hook_additional_context` attachment. (Found on the
    // first run: `nudgeSeen` from the stream read false for a session whose transcript held it.)
    ...(() => {
      const file = sessionId ? copyTranscript(sessionId) : null;
      return { copied: file !== null, nudgeDelivered: file !== null && readFileSync(file, 'utf8').includes(NUDGE_MARK) };
    })(),
  };
}

/** review_finding entries per session and route, from a scratch store that runs the table handler. */
function storeCounts() {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-probe-'));
  asc(['init', '--json'], dir);
  mkdirSync(join(dir, 'handlers'));
  copyFileSync(TABLE, join(dir, 'handlers', 'review-finding-table.yaml'));
  asc(['ingest', 'claude-code', '--root', ROOT, '--include-ephemeral', '--json'], dir);
  const out = asc(['query', '--json', "SELECT properties_json FROM entries WHERE type_name = 'review_finding'"], dir);
  const counts = {};
  for (const row of JSON.parse(out).rows) {
    const p = JSON.parse(row.properties_json);
    const key = `${p.session_id}:${p.captured_by ?? '?'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const i = process.argv.indexOf('--max-usd');
const maxUsd = i === -1 ? Number.NaN : Number(process.argv[i + 1]);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd is required: the total ceiling');
mkdirSync(ROOT, { recursive: true });

const runs = [];
let spent = 0;
outer: for (let index = 1; index <= RUNS_PER_ARM; index += 1) {
  for (const arm of ['before', 'after']) {
    const budget = Math.min(PER_RUN_USD, maxUsd - spent);
    if (budget < 0.5) {
      console.error(`CEILING: spent ${spent.toFixed(4)} of ${String(maxUsd)} USD; stopping.`);
      break outer;
    }
    const r = await runOne(arm, index, budget);
    spent += r.spentUsd;
    runs.push(r);
    console.log(JSON.stringify(r));
  }
}
const stored = storeCounts();
for (const r of runs) {
  r.reported = r.sessionId ? (stored[`${r.sessionId}:reported`] ?? 0) : null;
  r.parsed = r.sessionId ? (stored[`${r.sessionId}:parsed`] ?? 0) : null;
}
writeFileSync(join(OUT, 'probe.json'), JSON.stringify(runs, null, 2));
console.log(`\nrun       hooks                 skills          nudge  RF calls  findings  writes  reported  parsed  $`);
for (const r of runs) {
  console.log(
    `${r.runId.padEnd(9)} ${JSON.stringify(r.hooks).padEnd(21)} ${JSON.stringify(r.skills).padEnd(15)} ${String(r.nudgeDelivered).padEnd(5)}  ${String(r.reportCalls).padStart(8)}  ${String(r.findings).padStart(8)}  ${String(r.writes).padStart(6)}  ${String(r.reported).padStart(8)}  ${String(r.parsed).padStart(6)}  ${r.spentUsd.toFixed(4)}`,
  );
}
console.log(`total spent $${spent.toFixed(4)}`);
