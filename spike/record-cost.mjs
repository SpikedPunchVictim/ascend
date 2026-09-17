/**
 * EV-18 arm A: what one `asc record` call costs, without a model in the loop.
 *
 * Throwaway, in the sense ARCHITECTURE.md gives the word: it is the instrument for one measurement,
 * not the foundation. It lives in `spike/` because the project's own rule is that a recorded
 * decision must be re-runnable -- deleting the harness would make the numbers in EV-18 unarguable.
 *
 * TWO SURFACES, because `asc record` ships two and the bead's decision rule ("if a record costs
 * more than a few hundred tokens, simplify the surface") presumes there is one:
 *
 *   S1  asc record <type> --prop=<k>=<v> --prop=...      the entry travels in argv
 *   S2  asc record <type> -   (document on stdin)        the entry travels in a JSON document
 *
 * THE CONTENT IS REAL. The 20 entries are read out of this repo's OWN dogfood store -- the records
 * ascend has been writing at every task close -- so the sizes are the sizes an agent actually
 * produced, not ones chosen to make a surface look good.
 *
 * WHAT IS COUNTED AS "THE COST TO AN AGENT". A model pays for the text it must EMIT and the text it
 * must READ. So per call:
 *
 *   context text = the shell command the model writes
 *                + the stdin document, when the surface has one
 *                + stdout
 *                + stderr
 *
 * The shell command is rendered with MINIMAL quoting -- an argv element is single-quoted only when
 * it holds a character the shell would otherwise act on. That is the nearest thing to what a model
 * emits, and it is stated here because a different quoting rule would move the S1 number.
 *
 * TOKENS come from `estimateTokens` in the BUILT package, not from a copy of its arithmetic: the
 * point is to measure the estimator this product actually ships. `CHAR_FOR_CHAR` below is not used
 * for counting; it is used only to report what a naive 4-chars-per-token guess would have said, so
 * the record can show what the calibrated constant buys.
 *
 * `~/.claude/projects` is not read by this file at all. Each surface gets its own scratch store so a
 * duplicate from one surface cannot affect the other's exit code.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARS_PER_TOKEN, estimateTokens } from '../packages/cli/dist/budget.js';

const root = process.cwd();
const bin = join(root, 'packages/cli/dist/bin.js');
const N = 20;

/** One real entry: the type and the two property bags the document envelope carries. */
function realEntries(limit) {
  const sql =
    "SELECT type_name, properties_json, na_json FROM entries " +
    "WHERE type_name IN ('decision','stage_transition','stuck_event') " +
    `ORDER BY type_name, id LIMIT ${String(limit)}`;
  const out = spawnSync(process.execPath, [bin, 'query', '--json', sql], {
    cwd: root,
    encoding: 'utf8',
  });
  /**
   * The store this reads is the repo's own dogfood store, and reading it through `asc query` rather
   * than through `node:sqlite` is deliberate: "only @ascend/store may touch SQLite" is the product's
   * rule, and a measurement harness is a poor place to look like an exception to it.
   */
  if (out.status !== 0) throw new Error(`asc query failed: ${out.stderr}`);
  const rows = JSON.parse(out.stdout).rows;
  return rows.map((row) => {
    // `JSON.parse` returns `any`; naming the shape here is what makes a renamed column fail loudly
    // rather than arrive as `undefined` and be counted as a zero-length property bag.
    const properties = JSON.parse(row.properties_json);
    const na = row.na_json === null ? undefined : JSON.parse(row.na_json);
    return { type: row.type_name, properties, na };
  });
}

/** A scratch project with an initialised store, and `HOME` pointed inside it. */
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'));
  const env = { ...process.env, HOME: dir, XDG_CACHE_HOME: join(dir, '.cache') };
  const init = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8', env });
  if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);
  return { dir, env };
}

/**
 * An argv element as a shell command would carry it.
 *
 * Single quotes when the value holds anything the shell acts on, and the POSIX `'\''` escape for an
 * embedded quote. A path or a bare word is left alone, because quoting those would inflate S1.
 */
function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Time one real invocation, from spawn to exit. */
function timed(argv, cwd, env, stdin) {
  const start = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [bin, ...argv], {
    cwd,
    encoding: 'utf8',
    env,
    input: stdin,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    ms,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    argv: [bin, ...argv],
  };
}

const entries = realEntries(N);
if (entries.length < N) throw new Error(`only ${String(entries.length)} real entries available`);

const s1 = scratch('ev18-s1-');
const s2 = scratch('ev18-s2-');

const calls = [];
for (const entry of entries) {
  // S1 -- one --prop per property, and --na for the properties this entry declared not applicable.
  const flags = [];
  for (const [key, value] of Object.entries(entry.properties)) {
    flags.push(`--prop=${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  for (const key of entry.na ?? []) flags.push(`--na=${key}`);
  const s1Argv = ['record', entry.type, ...flags];
  const s1Run = timed(s1Argv, s1.dir, s1.env);

  // S2 -- the same entry as the document envelope on stdin.
  const document = { properties: entry.properties };
  if (entry.na !== undefined) document.na = entry.na;
  const documentText = JSON.stringify(document);
  const s2Argv = ['record', entry.type, '-'];
  const s2Run = timed(s2Argv, s2.dir, s2.env, documentText);

  for (const [surface, run, emitted, stdinText] of [
    ['S1', s1Run, s1Argv, ''],
    ['S2', s2Run, s2Argv, documentText],
  ]) {
    const command = `asc ${emitted.map(shellQuote).join(' ')}`;
    const contextText = command + stdinText + run.stdout + run.stderr;
    calls.push({
      surface,
      type: entry.type,
      properties: Object.keys(entry.properties).length,
      status: run.status,
      ms: run.ms,
      command,
      command_chars: command.length,
      stdin_chars: stdinText.length,
      stdout_chars: run.stdout.length,
      stderr_chars: run.stderr.length,
      context_chars: contextText.length,
      tokens: estimateTokens(contextText),
      chars_per_token: CHARS_PER_TOKEN,
      // What the folklore figure would have claimed, for the record only -- never used to decide.
      naive_4_chars_per_token: Math.ceil([...contextText].length / 4),
    });
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

const summary = {};
for (const surface of ['S1', 'S2']) {
  const rows = calls.filter((call) => call.surface === surface);
  const failed = rows.filter((row) => row.status !== 0);
  summary[surface] = {
    n: rows.length,
    failed: failed.length,
    ms: {
      p50: percentile(rows.map((row) => row.ms), 50),
      p95: percentile(rows.map((row) => row.ms), 95),
      min: Math.min(...rows.map((row) => row.ms)),
      max: Math.max(...rows.map((row) => row.ms)),
    },
    tokens: {
      p50: percentile(rows.map((row) => row.tokens), 50),
      p95: percentile(rows.map((row) => row.tokens), 95),
      mean: rows.reduce((total, row) => total + row.tokens, 0) / rows.length,
    },
    command_chars: Math.round(
      rows.reduce((total, row) => total + row.command_chars, 0) / rows.length,
    ),
    stdout_chars: Math.round(rows.reduce((total, row) => total + row.stdout_chars, 0) / rows.length),
  };
}

const result = {
  n: entries.length,
  chars_per_token: CHARS_PER_TOKEN,
  summary,
  calls,
};

const out = join(root, 'spike', 'tmp', 'ev18-arm-a.json');
mkdirSync(join(root, 'spike', 'tmp'), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`\nwrote ${out}`);
if (summary.S1.failed > 0 || summary.S2.failed > 0) {
  throw new Error(
    `a surface failed: S1 ${String(summary.S1.failed)}, S2 ${String(summary.S2.failed)} -- ` +
      `a failed call is fast and cheap, so averaging it in would flatter the result`,
  );
}
