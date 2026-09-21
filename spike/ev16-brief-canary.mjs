/**
 * Does the `SessionStart` brief reach the MODEL's context, or only the stream?
 *
 * EV-16 arms C and D were read as "the hook fired" on the evidence that the brief's prose appears
 * in the session stream. It does -- in a `{"type":"system","subtype":"hook_response"}` event, which
 * is the CLI reporting what the hook printed. That is not the same claim as "the model saw it", and
 * arm D showed why the difference matters: its 121,753-byte brief appears in that event in full
 * (both `filler_type_000` and `filler_type_399` are present, so nothing was truncated) while the
 * session's cache-creation tokens stayed indistinguishable from the no-hook control --
 *
 *   arm A, no hook          42,939 / 50,802 / 40,358
 *   arm C, 1,353 bytes      51,576 / 52,741 / 43,146
 *   arm D, 121,753 bytes    52,561 / 43,199 / 44,954
 *
 * -- and ~30,000 tokens of brief entering context cannot hide inside that spread. So the stream
 * check cannot distinguish "delivered to the model" from "printed and dropped", and every EV-16
 * conclusion about the hook rests on which one is true.
 *
 * THE TEST. A type whose NAME is a nonce string is registered before the session starts, so the
 * name exists nowhere in the model's training data, nowhere in the task, and nowhere in the prompt.
 * The session is then asked to name the types it knows about, WITHOUT running anything -- the grant
 * withholds Bash precisely so the answer cannot come from `asc types brief`.
 *
 *   the nonce appears in the model's own text  ->  the brief reached the context
 *   it does not                                ->  the hook printed into the void
 *
 * The verdict is read ONLY from assistant text blocks. The nonce is guaranteed to appear in the
 * `hook_response` event either way, so searching the raw stream would confirm the hypothesis no
 * matter which way reality fell -- the same mistake that made the arm C check meaningless, repeated
 * one level deeper. Matching on the stream is the bug this file exists to avoid.
 *
 * Two sizes, because "reaches context" and "reaches context AT 400 TYPES" are different claims and
 * arm D only needs the second one to fail:
 *
 *   small   the 4 starter types + the canary        ~1.6 KB
 *   large   400 filler types + the canary           ~122 KB
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const bin = join(root, 'packages/cli/dist/bin.js');
const out = join(root, 'spike', 'tmp');
mkdirSync(out, { recursive: true });

const model = process.env['EV16_MODEL'];
if (model === undefined || model === '') {
  console.error('EV16_MODEL is required. Refusing to guess.');
  process.exit(2);
}
const maxUsd = Number(process.env['EV16_MAX_USD'] ?? 'NaN');
if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
  console.error('EV16_MAX_USD is required and must be a positive number of dollars.');
  process.exit(2);
}

/**
 * A nonce, not a word. It cannot be guessed, inferred from the task, or recalled from training, so
 * the model can only produce it by having been told -- which is the entire measurement.
 */
const CANARY = 'zqx_canary_4b1e7f';

/** No Bash: the answer must come from context, never from running `asc types brief`. */
const PROMPT =
  process.env['EV16_PROMPT'] ??
  'Do not run any commands or use any tools. Just answer from what you already know about this ' +
  'project: what entry types does it have? List their names exactly.';

function asc(args, cwd, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

function define(dir, name, description, recordWhen) {
  const doc = {
    name,
    description,
    record_when: recordWhen,
    properties: [{ name: 'note', type: 'text', description: 'Unused.' }],
  };
  const res = asc(['types', 'define', '-'], dir, JSON.stringify(doc));
  if (res.status !== 0) throw new Error(`types define ${name} failed: ${res.stderr}`);
}

function project(size) {
  const dir = mkdtempSync(join(tmpdir(), `ev16-canary-${size}-`));
  mkdirSync(join(dir, '.ascend'), { recursive: true });
  const init = asc(['init'], dir);
  if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);
  if (size === 'large') {
    for (let i = 0; i < 400; i += 1) {
      define(
        dir,
        `filler_type_${String(i).padStart(3, '0')}`,
        'A filler type registered to extend the brief to a measured size.',
        'Never by hand. This type exists to extend the brief to a measured size for EV-16 arm D, ' +
          'and carries prose of the same shape and length as a real starter type so the brief it ' +
          'produces costs what a real registry of this size would cost.' +
          ' Padded to EV-16 Q1 measured 301.19 bytes/type.',
      );
    }
  }
  // Registered LAST so that, if an oversized brief is truncated rather than dropped, the canary is
  // in the part most likely to be cut -- a false "not delivered" is the safe direction to fail in.
  define(
    dir,
    CANARY,
    'A canary type whose name is a nonce, used to detect whether the brief reaches the model.',
    'Never. This type exists only so that a session which can name it must have read the brief.',
  );
  const hook = asc(['install-hook', '--yes', '--json'], dir);
  if (hook.status !== 0) throw new Error(`install-hook failed: ${hook.stderr}`);
  const brief = asc(['types', 'brief'], dir);
  return { dir, briefBytes: brief.stdout.length, canaryInBrief: brief.stdout.includes(CANARY) };
}

async function run(size) {
  const { dir, briefBytes, canaryInBrief } = project(size);
  if (!canaryInBrief) throw new Error(`canary missing from the ${size} brief -- instrument broken`);

  const argv = [
    '-p',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    'Read',
  ];
  const child = spawn('claude', argv, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', () => {});
  child.stdin.end(PROMPT);
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const stream = Buffer.concat(chunks).toString('utf8');
  writeFileSync(join(out, `ev16-canary-${size}.jsonl`), stream);

  let result = null;
  // ONLY assistant text. The `hook_response` event carries the canary in every case, so a raw
  // stream match would be true whatever the answer -- see the header.
  let canaryInAssistantText = false;
  let assistantText = '';
  let cacheCreation = 0;
  for (const line of stream.split('\n')) {
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'result') result = obj;
    const usage = obj.message?.usage;
    if (usage !== undefined) cacheCreation += usage.cache_creation_input_tokens ?? 0;
    if (obj.type !== 'assistant') continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'text') continue;
      assistantText += block.text;
      if (block.text.includes(CANARY)) canaryInAssistantText = true;
    }
  }

  return {
    size,
    briefBytes,
    exitCode,
    spentUsd: result?.total_cost_usd ?? 0,
    cacheCreationTokens: cacheCreation,
    briefReachedContext: canaryInAssistantText,
    // Kept so the verdict can be read against what the model actually said rather than instead
    // of it -- a refusal and a blank both look like "not delivered" without this.
    said: assistantText.slice(0, 600),
  };
}

const sizes = (process.env['EV16_SIZES'] ?? 'small,large').split(',').map((s) => s.trim());
const rows = [];
let spent = 0;
for (const size of sizes) {
  if (spent >= maxUsd) {
    console.error(`CEILING REACHED at ${spent.toFixed(4)} USD, stopping before ${size}.`);
    break;
  }
  const row = await run(size);
  spent += row.spentUsd;
  rows.push(row);
}
console.log(JSON.stringify({ model, canary: CANARY, spentUsd: spent, rows }, null, 2));
