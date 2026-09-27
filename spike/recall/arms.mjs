/**
 * asc-gtnu.8: run reviewer sessions over seeded and unseeded trees, one top-level `claude -p` per
 * run. Modelled on `spike/ev16-arms.mjs` and written BESIDE it rather than into it: that file
 * carries uncommitted work from another bead.
 *
 * ONE SESSION PER RUN, AND WHY IT MATTERS HERE. `review_finding` carries `session_id` and `project`
 * and no `agent_id`, so reviewers fanned out as subagents of one session would be
 * indistinguishable in the store. A top-level session per run makes `session_id` the reviewer's
 * identity; the tree path (one fresh `rv-XXXXXX` per run) makes `project` corroborate it. The
 * `Task` tool is not granted, for the same reason.
 *
 * WHAT COSTS MONEY. Every run is a billed session. `--dry-run` builds the tree and prints the
 * invocation and spends nothing. `--max-usd` is a TOTAL ceiling across the whole ledger (probes
 * included) and has no default; each session is additionally started with
 * `--max-budget-usd min(perRun, remaining)`, so the ceiling cannot be crossed by one session
 * rather than merely noticed after it.
 *
 * WHAT IS WRITTEN, AND WHERE. The raw stream goes to `spike/tmp/recall/<runId>-stream.jsonl`
 * BEFORE any analysis; the ledger `spike/tmp/recall/ledger.json` after every run, so a stop loses
 * nothing already paid for. The session's transcript is COPIED (never moved -- the source is the
 * ingest corpus and read-only) into the pruned root `spike/tmp/recall/root/`, which is what the
 * scratch ingest reads. Everything under `spike/tmp/` is gitignored and never committed: it holds
 * home paths and reviewer prose.
 *
 * A SESSION WITH NO BILLABLE ENVELOPE IS NOT DATA. If the stream ends without a `result` object
 * carrying `modelUsage` for the pinned model, the harness stops (exit 3) rather than recording a
 * run that reviewed nothing as a run that found nothing.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTree, recallEnv, REPO } from './trees.mjs';

const OUT = join(REPO, 'spike', 'tmp', 'recall');
const ROOT = join(OUT, 'root');
const LEDGER = join(OUT, 'ledger.json');
mkdirSync(ROOT, { recursive: true });

export const BRIEF = readFileSync(join(REPO, 'spike', 'recall', 'brief.md'), 'utf8');

/**
 * The only tools a reviewer has. `--tools` sets the AVAILABLE set (nothing else is loaded, so no
 * `Task`, no `Skill` -- the bug-hunt skill would steer to a Markdown report and `AskUserQuestion`
 * -- and no web); `--allowedTools` pre-approves within it. Bash is available so a reviewer CAN
 * run the suite; the writes it could do are refused by `dontAsk` unless granted, and only
 * test-running commands are granted.
 */
export const TOOLS = ['Bash', 'Read', 'ReportFindings'];
export const ALLOWED = [
  'Read',
  'ReportFindings',
  'Bash(npx vitest:*)',
  'Bash(pnpm test:*)',
  'Bash(pnpm vitest:*)',
  'Bash(pnpm exec vitest:*)',
  'Bash(npm test:*)',
  'Bash(npx tsc:*)',
];

export const MODELS = ['claude-sonnet-5', 'claude-opus-5-5'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function argvFor(model, budget) {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    TOOLS.join(','),
    '--allowedTools',
    ALLOWED.join(','),
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--max-budget-usd',
    budget.toFixed(2),
  ];
}

function loadLedger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { runs: [] };
}

export function spentOf(ledger) {
  return ledger.runs.reduce((s, r) => s + (r.spentUsd ?? 0), 0);
}

/** Parse a stream-json transcript into what the ledger and the manipulation checks need. */
export function analyse(stream, dir) {
  let result = null;
  let init = null;
  const toolUses = [];
  const toolResults = [];
  for (const line of stream.split('\n')) {
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a partial tail line is not a finding
    }
    if (obj.type === 'system' && obj.subtype === 'init') init = obj;
    if (obj.type === 'result') result = obj;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (obj.type === 'assistant' && c.type === 'tool_use') toolUses.push(c);
      if (obj.type === 'user' && c.type === 'tool_result') {
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content ?? '');
        toolResults.push({ id: c.tool_use_id, text });
      }
    }
  }
  const reports = toolUses.filter((u) => u.name === 'ReportFindings');
  const bash = toolUses.filter((u) => u.name === 'Bash').map((u) => String(u.input?.command ?? ''));
  const reads = toolUses.filter((u) => u.name === 'Read').map((u) => String(u.input?.file_path ?? ''));
  const bashIds = new Set(toolUses.filter((u) => u.name === 'Bash').map((u) => u.id));
  // Manipulation checks, reported whether or not they fire.
  const gitUse = bash.filter((c) => /\bgit\s+(diff|log|show|stash|blame|reflog)\b/.test(c));
  const realDir = dir.replace(/^\/var\//, '/private/var/');
  const outside = [...reads, ...bash].filter(
    (s) => /\/(Users|home)\//.test(s) && !s.includes(dir) && !s.includes(realDir),
  );
  const runnerRan = toolResults.some((r) => bashIds.has(r.id) && /Tests\s+\d+ (passed|failed)/.test(r.text));
  return {
    init: init ? { tools: init.tools, model: init.model } : null,
    result,
    reportCalls: reports.length,
    findings: reports.flatMap((u) => (Array.isArray(u.input?.findings) ? u.input.findings : [])),
    toolCounts: toolUses.reduce((m, u) => ({ ...m, [u.name]: (m[u.name] ?? 0) + 1 }), {}),
    bashCommands: bash,
    gitUse,
    outsideTreeRefs: outside.length,
    runnerRan,
  };
}

/** Copy the run's transcript into the pruned root. Source is read, never written. */
function copyTranscript(sessionId) {
  const projects = join(homedir(), '.claude', 'projects');
  for (const proj of readdirSync(projects)) {
    const src = join(projects, proj, `${sessionId}.jsonl`);
    if (existsSync(src)) {
      mkdirSync(join(ROOT, proj), { recursive: true });
      copyFileSync(src, join(ROOT, proj, `${sessionId}.jsonl`));
      return proj;
    }
  }
  return null;
}

export async function runOne({ runId, model, arm, cls, apply, runnable, maxUsd, perRunUsd, dryRun }) {
  const ledger = loadLedger();
  if (ledger.runs.some((r) => r.runId === runId && r.completed)) {
    console.error(`skip ${runId}: already in the ledger`);
    return null;
  }
  const spent = spentOf(ledger);
  const remaining = maxUsd - spent;
  const budget = Math.min(perRunUsd, remaining);
  if (budget < 0.5) {
    console.error(`CEILING: spent ${spent.toFixed(4)} of ${String(maxUsd)} USD; not starting ${runId}.`);
    process.exit(2);
  }
  const tree = buildTree({ runnable, apply });
  const argv = argvFor(model, budget);
  const meta = { runId, model, arm, cls, dir: tree.dir, runnable, budgetUsd: budget, invocation: ['claude', ...argv] };
  if (dryRun) return { ...meta, dryRun: true };

  const cache = mkdtempSync(join(tmpdir(), 'rv-cache-'));
  const started = Date.now();
  const child = spawn('claude', argv, { cwd: tree.dir, env: recallEnv(cache), stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  const errs = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', (c) => errs.push(c));
  child.stdin.end(BRIEF);
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const stream = Buffer.concat(chunks).toString('utf8');
  writeFileSync(join(OUT, `${runId}-stream.jsonl`), stream);
  writeFileSync(join(OUT, `${runId}-stderr.txt`), Buffer.concat(errs));

  const a = analyse(stream, tree.dir);
  const r = a.result;
  const billed = r?.modelUsage && Object.keys(r.modelUsage).includes(model);
  const run = {
    ...meta,
    exitCode,
    wallMs: Date.now() - started,
    sessionId: r?.session_id ?? null,
    spentUsd: r?.total_cost_usd ?? 0,
    modelUsage: r?.modelUsage ?? null,
    numTurns: r?.num_turns ?? null,
    isError: r?.is_error ?? null,
    subtype: r?.subtype ?? null,
    permissionDenials: r?.permission_denials ?? null,
    initTools: a.init?.tools ?? null,
    reportCalls: a.reportCalls,
    findings: a.findings.length,
    toolCounts: a.toolCounts,
    gitUse: a.gitUse,
    outsideTreeRefs: a.outsideTreeRefs,
    runnerRan: a.runnerRan,
    transcriptProject: r?.session_id ? copyTranscript(r.session_id) : null,
    completed: Boolean(billed),
  };
  ledger.runs = ledger.runs.filter((x) => x.runId !== runId).concat(run);
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  if (!billed) {
    console.error(`SESSION FAILED: ${runId} produced no billable envelope for ${model}. Stopping.`);
    process.exit(3);
  }
  return run;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const maxUsd = Number(arg('max-usd'));
  const perRunUsd = Number(arg('per-run-usd') ?? '3');
  const dryRun = process.argv.includes('--dry-run');
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd is required: the total ceiling');
  if (process.argv.includes('--pilot')) {
    const model = arg('model') ?? 'claude-sonnet-5';
    if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(', ')}`);
    const run = await runOne({
      runId: `pilot-${model}`,
      model,
      arm: 'C',
      cls: null,
      runnable: true,
      maxUsd,
      perRunUsd,
      dryRun,
    });
    const { invocation, ...shown } = run ?? {};
    console.log(JSON.stringify({ ...shown, argv: invocation?.slice(1) }, null, 2).replaceAll(homedir(), '~'));
  } else {
    throw new Error('only --pilot is implemented until the seeds exist (Stage 1)');
  }
}
