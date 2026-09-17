/**
 * EV-18 arm B: what one `asc record` call costs a REAL session, and does a permission prompt fire?
 *
 * Arm A (record-cost.mjs) can answer neither question. It spawns the binary directly, so it never
 * meets the permission gate, and its token figures are `estimateTokens` -- a calibrated constant,
 * not a count. Arm B is a real headless session doing real recordings, so its numbers are realized
 * and its friction is observed rather than reasoned about.
 *
 * THE GRANT IS THE SMALLEST ONE THAT WORKS, and it is bounded rather than bypassed:
 *
 *   --allowedTools "Bash(asc record:*)"   the only tool, and only the one command prefix
 *   --permission-mode dontAsk             anything else is refused, not prompted for
 *
 * The permission gate is left ON and narrowed -- never disabled. There is no flag here that turns
 * the gate off, and no wildcard tool grant. If the session reaches for a tool outside the grant it
 * is denied, and the denial lands in the transcript as evidence rather than being suppressed --
 * which is the whole point of asking question 4 this way.
 *
 * THE CONTENT IS THE SAME 20 ENTRIES AS ARM A, read by the same query in the same order, so the two
 * arms are measuring the same work. They are the real property sets already in this repo's own
 * dogfood store, not entries authored to be convenient -- and they were not authored to be
 * convenient for the MODEL either, which matters here in a way it did not in arm A: 14 values carry
 * an apostrophe, 23 carry a double quote, 3 carry a backtick, 2 carry a backslash and 2 carry a
 * NEWLINE. The flag surface has to survive being driven by something that must quote them itself.
 *
 * The session runs with the scratch project as its cwd and `asc` as a shim on PATH that execs the
 * BUILT binary, so the store it writes is a scratch store and the code it runs is the code under
 * test. `HOME` is deliberately NOT overridden here (arm A overrides it): the session is a real
 * Claude Code session and needs the real credentials, and nothing in ascend writes to `$HOME` --
 * checked before running, `homedir()` appears once in the CLI, expanding `~` in `asc query` globs.
 *
 * This file runs ONE session and dumps everything it saw. Analysis is a separate step so that a bug
 * in the analysis cannot cost a re-run, and so the raw stream survives as the primary record.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const bin = join(root, 'packages/cli/dist/bin.js');
const model = process.env.EV18_MODEL ?? 'claude-haiku-4-5-20251001';
const N = 20;

/** The same 20 entries arm A recorded: same query, same ORDER BY, so the two arms match. */
function realEntries(limit) {
  const sql =
    "SELECT type_name, properties_json, na_json FROM entries " +
    "WHERE type_name IN ('decision','stage_transition','stuck_event') " +
    `ORDER BY type_name, id LIMIT ${String(limit)}`;
  const out = spawnSync(process.execPath, [bin, 'query', '--json', sql], {
    cwd: root,
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error(`asc query failed: ${out.stderr}`);
  return JSON.parse(out.stdout).rows.map((row) => {
    const record = { type: row.type_name, properties: JSON.parse(row.properties_json) };
    if (row.na_json !== null) record.na = JSON.parse(row.na_json);
    return record;
  });
}

/**
 * A scratch project with an initialised store, and `asc` on PATH pointing at the built binary.
 *
 * A shim rather than the path itself, because the command the model types is part of what is being
 * measured: `asc record ...` is what an agent with ascend installed writes, and the absolute path
 * to a checkout is not. The shim is also why the allowlist entry can be short.
 */
function scratch(dir) {
  mkdirSync(join(dir, '.git'));
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  const shim = join(shimDir, 'asc');
  // Single quotes around the path: `process.execPath` and `root` are absolute and the harness
  // controls them, but a shim that breaks on a space in a checkout path is a harness bug that
  // would look like a product failure.
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${bin}' "$@"\n`);
  chmodSync(shim, 0o755);
  return { shimDir, shim };
}

/** The instruction. Stated as a measurement protocol, because that is what is being asked for. */
function buildPrompt(records) {
  const listed = records
    .map((record, index) => `${String(index + 1)}. ${JSON.stringify(record)}`)
    .join('\n');
  return `You are a measurement instrument, not an assistant. Do exactly this and nothing else.

The current directory is a project with an initialised ascend store, and \`asc\` is on PATH.
Below are ${String(records.length)} records. Record every one of them, in order, by running exactly
one shell command per record:

    asc record <type> --prop=<name>=<value> [--prop=<name>=<value> ...] [--na=<name> ...]

Pass one \`--prop=<name>=<value>\` flag per property, in the order shown, and one \`--na=<name>\` flag
per element of the \`na\` array when one is present. Quote the values so the shell passes them
through to the command unchanged -- some contain quotes, backticks and line breaks. The value of a
property that is not a string is its JSON form.

Run the ${String(records.length)} commands one at a time. Do not read any files, do not run any other
command, do not summarise, and do not explain. When all ${String(records.length)} have been run, reply with
exactly this and nothing else: done

RECORDS:
${listed}
`;
}

const records = realEntries(N);
if (records.length < N) throw new Error(`only ${String(records.length)} real entries available`);

const dir = mkdtempSync(join(tmpdir(), 'ev18-arm-b-'));
const { shimDir } = scratch(dir);
const init = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8' });
if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);

/**
 * The grant is overridable so the harness can also be pointed at a tool the session is NOT allowed.
 * That is the negative control for the one question a real session is the only way to answer: the
 * count of permission denials is the evidence that the allowlist worked, and a count of zero is not
 * evidence of anything until the detector has been shown to fire on a denial. Same harness, same
 * bounded grant mechanism, one tool narrower -- never a bypass flag either way.
 */
const allowed = process.env.EV18_ALLOWED ?? 'Bash(asc record:*)';
const prompt =
  process.env.EV18_PROMPT === undefined
    ? buildPrompt(records)
    : readFileSync(process.env.EV18_PROMPT, 'utf8');
mkdirSync(join(root, 'spike', 'tmp'), { recursive: true });
writeFileSync(join(root, 'spike', 'tmp', 'ev18-arm-b-prompt.txt'), prompt);

const argv = [
  '-p',
  '--model',
  model,
  '--output-format',
  'stream-json',
  '--verbose',
  '--allowedTools',
  allowed,
  '--permission-mode',
  'dontAsk',
];

/**
 * Verify the instrument before spending a session on it. Everything up to the spawn is exercised --
 * the real entries, the prompt's bytes, the scratch store, the shim -- and the spawn alone is
 * skipped. A harness whose prompt was malformed would otherwise report "the model recorded 0 of 20",
 * which looks like a finding about the product and would not be one.
 */
if (process.env.EV18_DRY_RUN === '1') {
  const probe = spawnSync(process.execPath, [bin, 'record', '--help'], {
    cwd: dir,
    encoding: 'utf8',
  });
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        record_help_exit: probe.status,
        scratch: dir,
        prompt_bytes: prompt.length,
        prompt_lines: prompt.split('\n').length,
        records: records.length,
        records_with_na: records.filter((record) => record.na !== undefined).length,
        invocation: ['claude', ...argv],
        store_rows_before: spawnSync(
          process.execPath,
          [bin, 'query', '--json', 'SELECT COUNT(*) AS n FROM entries'],
          { cwd: dir, encoding: 'utf8' },
        ).stdout,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const started = Date.now();
const replay = process.env.EV18_REPLAY;

/**
 * `EV18_REPLAY=<stream.jsonl>` re-analyses a session already on disk instead of spending another one.
 * The stream is the expensive half of this harness and the analysis is the half that gets edited, so
 * without this every correction to a percentile or a denominator costs a session to re-verify -- and
 * the temptation in that situation is to trust the new code because re-running it is annoying. With
 * it, a change to the analysis is checked against the same bytes the run produced.
 */
let exitCode;
let wallMs = null;
let stderrBytes = null;
let stream;
let errChunks = [];
if (replay !== undefined) {
  stream = readFileSync(replay, 'utf8');
  exitCode = 0;
  /**
   * A replay re-analyses the stream and cannot know how long the session took, so the wall clock is
   * carried in explicitly rather than defaulted. `EV18_WALL_MS` is passed from the run's own record;
   * without it the field stays null and says so, because a replay that quietly reported 0 ms would
   * be a fast session that never happened.
   */
  wallMs = process.env.EV18_WALL_MS === undefined ? null : Number(process.env.EV18_WALL_MS);
  stderrBytes =
    process.env.EV18_STDERR_BYTES === undefined ? null : Number(process.env.EV18_STDERR_BYTES);
} else {
  const child = spawn('claude', argv, {
    cwd: dir,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => errChunks.push(chunk));
  child.stdin.end(prompt);

  exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });
  wallMs = Date.now() - started;

  stream = Buffer.concat(chunks).toString('utf8');
  errChunks = Buffer.concat(errChunks);
  stderrBytes = errChunks.length;
  writeFileSync(join(root, 'spike', 'tmp', 'ev18-arm-b-stream.jsonl'), stream);
  writeFileSync(join(root, 'spike', 'tmp', 'ev18-arm-b-stderr.txt'), errChunks);
}

/**
 * Read the store back rather than trusting the session's own report of what it did. This is the
 * primary evidence for question 4: an entry that exists was written by a command that ran, and a
 * command that ran is a command that was not stopped by a prompt.
 */
const storeDir = process.env.EV18_STORE_DIR ?? dir;
const count =
  replay !== undefined && process.env.EV18_STORE_DIR === undefined
    ? null
    : spawnSync(process.execPath, [bin, 'query', '--json', 'SELECT COUNT(*) AS n FROM entries'], {
        cwd: storeDir,
        encoding: 'utf8',
      });
/**
 * `null`, not `0`, when the store was not read back. A replay re-analyses a stream and the scratch
 * store it was recorded against is a `mktemp` directory that may be gone; reporting `0` there would
 * turn "not looked at" into a measured absence, which is the distinction this project's rule 7
 * exists to keep. The shortfall check below is skipped when it is null for the same reason.
 */
const inStore = count === null || count.status !== 0 ? null : JSON.parse(count.stdout).rows[0].n;

/** Walk the stream once, collecting the four things the record needs. */
const events = stream
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

/**
 * The directory the session actually ran in, which in a replay is NOT the scratch directory this
 * process just made. The stream's own `init` event names it, so a replay takes it from there rather
 * than recording a path no session ever used.
 */
const initCwd = events.find((event) => event.subtype === 'init')?.cwd;
const ranIn = replay !== undefined ? (initCwd ?? null) : dir;

const recordCalls = [];
const toolResults = [];
const usageByTurn = [];
const contextByTurn = [];
const denials = [];
let resultEvent = null;

for (const event of events) {
  if (event.type === 'result') resultEvent = event;
  const message = event.message;
  if (message === undefined) continue;
  if (event.type === 'assistant') {
    const usage = message.usage ?? null;
    let calls = 0;
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use' && block.name === 'Bash') {
        recordCalls.push({ command: block.input.command, tool_use_id: block.id });
        calls += 1;
      }
    }
    usageByTurn.push(usage);
    contextByTurn.push({ input_tokens: usage?.input_tokens ?? 0, calls });
  }
  if (event.type === 'user') {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      toolResults.push({ tool_use_id: block.tool_use_id, is_error: block.is_error === true, text });
      /**
       * A denial is the thing question 4 is asking about, so it is searched for by the words the
       * harness would actually emit -- "permission", "denied", "not allowed" -- AND recorded whole
       * in the dump, so a denial phrased in words this filter does not know is still in the
       * evidence file for a reader to find, rather than being filtered away by a guess.
       */
      if (block.is_error === true && /permission|denied|not allowed/i.test(text)) {
        denials.push({ tool_use_id: block.tool_use_id, text });
      }
    }
  }
}

const usageSum = usageByTurn.reduce(
  (total, usage) => {
    if (usage === null) return total;
    return {
      input_tokens: total.input_tokens + (usage.input_tokens ?? 0),
      output_tokens: total.output_tokens + (usage.output_tokens ?? 0),
      cache_creation_input_tokens:
        total.cache_creation_input_tokens + (usage.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens: total.cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
    };
  },
  { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
);

/**
 * The marginal context a recording adds -- the number the bead's question is actually about.
 *
 * `usage.input_tokens` on a turn is the WHOLE conversation the model was sent, not that turn's own
 * cost. Summing it across turns counts the growing context once per turn, and dividing that sum by
 * the call count produces a figure with no unit: the first live run of this harness reported
 * `realized_tokens_per_call: 82053.8` that way, against a prompt of 29,096 bytes. What a recording
 * costs is the context it APPENDS -- the difference in `input_tokens` between a turn that made a call
 * and the turn after it, which is the tool call the model wrote plus the result the tool returned.
 * That is also the quantity arm A measures, so the two arms are comparable at all.
 *
 * Nearest-rank percentiles, the same convention as `record-cost.mjs`, so the two arms' p50s are the
 * same statistic rather than two different ones that happen to share a name.
 */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const marginal = [];
for (let i = 1; i < contextByTurn.length; i += 1) {
  if (contextByTurn[i - 1].calls === 0) continue;
  marginal.push(contextByTurn[i].input_tokens - contextByTurn[i - 1].input_tokens);
}

const failed = recordCalls.filter((call) => !/^asc record /.test(call.command));
const errored = toolResults.filter((result) => result.is_error);

/**
 * A run that recorded nothing is not a measurement of anything, and it must not be allowed to look
 * like one. The first live run of this harness ended with `is_error: true` and 0 of 20 entries in the
 * store, and still wrote an analysis file whose `failures` array was empty -- because `failures` only
 * names bash calls that were not `asc record`, and there had been no bash calls at all. An instrument
 * that reports a clean run when nothing happened is the defect class this project ranks severity
 * zero, so the run-level reasons are collected separately and the process exits non-zero on any of
 * them. The session's own error text is carried into the record for the same reason: it is what
 * made this failure diagnosable, and reading it out of the raw stream by hand is not a substitute.
 */
const blocking = [];
if (resultEvent?.is_error === true) {
  blocking.push(`the session ended in error: ${String(resultEvent.result ?? '').slice(0, 400)}`);
}
/**
 * A negative control is EXPECTED to record nothing, so the count it is held to is stated by the run
 * rather than assumed to be 20. Defaulting it means the ordinary arm is unchanged.
 */
const expected = Number(process.env.EV18_EXPECT_ENTRIES ?? N);
if (inStore !== null && inStore < expected) {
  blocking.push(`the store holds ${inStore} of the ${expected} entries the prompt asked for`);
}
if (failed.length > 0) {
  blocking.push(`${failed.length} bash call(s) were not asc record`);
}

const meta = {
  invocation: ['claude', ...argv],
  grant: { allowedTools: allowed, permissionMode: 'dontAsk', bypass: false },
  model,
  cwd: ranIn,
  replayed: replay !== undefined,
  exit_code: exitCode,
  wall_ms: wallMs,
  wall_ms_source: replay === undefined ? 'measured' : wallMs === null ? 'not measured' : 'carried',
  stream_bytes: stream.length,
  stderr_bytes: stderrBytes,
  expected,
  entries_in_store: inStore,
  assistant_turns: usageByTurn.length,
  bash_calls: recordCalls.length,
  bash_calls_not_asc_record: failed.length,
  tool_errors: errored.length,
  permission_denials: denials.length,
  turn_input_tokens_summed: usageSum.input_tokens,
  turn_output_tokens_summed: usageSum.output_tokens,
  output_tokens_reported_per_turn: usageSum.output_tokens > 0,
  context_first_turn: contextByTurn[0]?.input_tokens ?? null,
  context_last_turn: contextByTurn[contextByTurn.length - 1]?.input_tokens ?? null,
  result_usage: resultEvent?.usage ?? null,
  result_num_turns: resultEvent?.num_turns ?? null,
  result_cost_usd: resultEvent?.total_cost_usd ?? null,
  result_duration_ms: resultEvent?.duration_ms ?? null,
  result_is_error: resultEvent?.is_error ?? null,
  result_text: resultEvent?.result ?? null,
  realized_tokens_per_call:
    marginal.length === 0
      ? null
      : {
          n: marginal.length,
          min: Math.min(...marginal),
          p50: percentile(marginal, 50),
          p95: percentile(marginal, 95),
          max: Math.max(...marginal),
          mean: Number((marginal.reduce((a, b) => a + b, 0) / marginal.length).toFixed(2)),
        },
  realized_ms_per_call:
    wallMs === null || recordCalls.length === 0
      ? null
      : Number((wallMs / recordCalls.length).toFixed(1)),
  arm_a_estimate_mean: 794.15,
  commands: recordCalls.map((call) => call.command),
  failures: failed.map((call) => call.command),
  blocking_failures: blocking,
  denials,
};
writeFileSync(
  process.env.EV18_OUT ?? join(root, 'spike', 'tmp', 'ev18-arm-b-analysis.json'),
  JSON.stringify(meta, null, 2),
);
console.log(JSON.stringify({ ...meta, commands: undefined, denials: undefined }, null, 2));
if (blocking.length > 0) process.exit(1);
