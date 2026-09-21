/**
 * EV-16 Q2/Q3: does the `SessionStart` brief change what a session RECORDS, and at what size does
 * it stop working? (`asc-4so.2`)
 *
 * EV-16 measured the brief's COST and left this half unmeasured, twice: the first harness was
 * correctly refused for using `--dangerously-skip-permissions`, and the re-scoped one met a
 * classifier outage. The design is PRE-REGISTERED and sealed -- four arms, five predictions,
 * hashed before any measurement -- so this file's job is to run the arms AS WRITTEN, not to
 * redesign them. Where a choice was left open, it is named below rather than made silently.
 *
 * WHAT THE GRANT ACTUALLY BOUNDS, MEASURED RATHER THAN ASSUMED. This header claimed until
 * 2026-09-20 that "anything outside the list is REFUSED, not prompted for". That was wrong, and so
 * was the first correction to it ("the grant bounds nothing"). Five sessions in
 * `spike/ev16-grant-probe.mjs` settled it by holding the grant fixed and varying the COMMAND:
 *
 *   grant `Bash(echo:*)`   find . -name X     read     RAN      denials []
 *   grant `Bash(echo:*)`   touch X            write    DENIED   denials [Bash]
 *   grant `Read`           echo X             read     RAN      denials []
 *   grant `Read`           touch X            write    DENIED   denials [Bash]
 *   grant `Bash(echo:*)`   asc record ...     write    DENIED   (EV-18's negative control)
 *
 * THE COMMAND'S CLASS IS THE AXIS, NOT THE GRANT'S SHAPE. Read-only shell commands are approved
 * whether or not the allowlist covers them; a command that WRITES is denied unless the allowlist
 * covers it. Each verdict above is read off the filesystem (did the file appear?) or off a marker
 * in a `tool_result`, never off the model's account of what happened.
 *
 * This is what EV-16 arm A's unexplained `Bash(find ...)` was: out of grant, read-only, approved.
 * It was never evidence that the gate was open, and the gate is not open -- a session here cannot
 * write through a shell command the allowlist does not name.
 *
 * WHAT REMAINS UNBOUNDED, AND IS ACCEPTED. Two things, both real:
 *
 *   - Read-only shell access is effectively unrestricted. A session can read anything the user can
 *     read, including outside the scratch project. It cannot destroy anything that way, but it is
 *     an information-disclosure surface, and `HOME` is the real one.
 *   - `Edit` and `Write` are granted as BARE tool names with no path restriction, so the file tools
 *     themselves can write outside the scratch directory. That exposure comes from this grant, not
 *     from a gate failure, and narrowing it by path has not been tested.
 *
 * Accepted deliberately by the repository owner on 2026-09-20, before the two probes above
 * narrowed the risk to what is described here. `--permission-mode dontAsk` is kept for determinism
 * in a session with no TTY -- it makes an ungranted write a denial instead of a hang -- and the
 * probes measured no difference in what it permits.
 *
 * `permission_denials` IS STILL NOT PROOF THAT A BOUND HELD. It is `[]` whenever nothing was
 * stopped, which includes every out-of-grant read that sailed through. It records what the model
 * tried and was refused; it never certifies where the session stayed.
 *
 * WHY THE MODEL IS PINNED. The probe on 2026-09-21 found `claude -p` here routes to whatever
 * `model:` says in `~/.claude/settings.json` -- a mutable key that overrode a stale
 * `default_model`. An arm that inherits it cannot attribute its rate to a named model, so
 * `EV16_MODEL` is required rather than defaulted, and every run records the `modelUsage` envelope
 * it actually got. A rate with no model beside it is not a finding.
 *
 * WHAT COSTS MONEY. Each session is a real billed API call. `EV16_DRY_RUN=1` exercises everything
 * up to the spawn -- fixtures, store, hook install, prompt bytes, the grant -- and spends nothing.
 * Run that first, every time. `EV16_MAX_USD` is a hard ceiling: the harness reads `total_cost_usd`
 * off each session's envelope, accumulates, and REFUSES to start a session that would cross it.
 * The ceiling has no default, for the same reason the model does not.
 *
 * ONE SESSION PER INVOCATION IS NOT THE DESIGN -- P3 is stated as "0 of 3" against ">=2 of 3", so
 * an arm is three sessions. `EV16_ARMS` and `EV16_REPS` select a subset so a run can be stopped
 * and resumed without re-spending what already ran; every session's raw stream is written under
 * `spike/tmp/` before anything is analysed, so a bug in the analysis never costs a re-run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const bin = join(root, 'packages/cli/dist/bin.js');
const out = join(root, 'spike', 'tmp');
mkdirSync(out, { recursive: true });

/**
 * Required, not defaulted. See the header: an unpinned model makes the measurement unattributable,
 * and a default would be a silent decision about what Q6 is asking.
 */
const model = process.env['EV16_MODEL'];
if (model === undefined || model === '') {
  console.error('EV16_MODEL is required (e.g. claude-haiku-4-5-20251001). Refusing to guess.');
  process.exit(2);
}

/** Hard spend ceiling in USD, also required. The harness refuses to cross it mid-run. */
const maxUsd = Number(process.env['EV16_MAX_USD'] ?? 'NaN');
if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
  console.error('EV16_MAX_USD is required and must be a positive number of dollars.');
  process.exit(2);
}

const dryRun = process.env['EV16_DRY_RUN'] === '1';
const arms = (process.env['EV16_ARMS'] ?? 'A,B,C,D').split(',').map((a) => a.trim());
const reps = Number(process.env['EV16_REPS'] ?? '3');

/**
 * The size arm D runs at. EV-16 measured 301.19 bytes/type with r2 = 0.999999 up to N = 400, and
 * P2 predicts the model still records at 400. 400 is therefore the pre-registered top of the
 * range, not a round number chosen here.
 */
const OVERSIZED_TYPES = Number(process.env['EV16_OVERSIZED_N'] ?? '400');

/**
 * The neutral task, VERBATIM from the pre-registered method: "Read `calc.js`, find and fix the bug
 * in `median()`, run the tests".
 *
 * It must never mention recording. It contains real work that plausibly WARRANTS a record -- a
 * decision about how to handle the even-length case, a fix, possibly a stuck moment -- and says
 * nothing about making one. A task that said "record an entry" would measure instruction
 * following, which is not the question.
 */
const TASK = 'Read calc.js, find and fix the bug in median(), then run the tests.';

/**
 * The bug: `median` never sorts, and takes the lower element on an even-length input instead of
 * averaging the middle two. Two distinct defects in four lines, so "fix the bug" has a real
 * judgement call in it (does the caller expect a sorted copy, or is sorting in place acceptable?)
 * rather than being a one-token edit.
 */
const CALC_JS = `export function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
  if (xs.length === 0) return 0;
  return xs[Math.floor(xs.length / 2)];
}
`;

/**
 * Hand-written expectations, never the module's own output: [3,1,2] sorts to [1,2,3] so the median
 * is 2, and [4,1,3,2] sorts to [1,2,3,4] so it is (2+3)/2 = 2.5. The unsorted input is what makes
 * the missing sort visible; the even-length case is what makes the missing average visible.
 */
const TEST_JS = `import { median, mean } from './calc.js';

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures += 1;
    console.log(\`FAIL \${name}: expected \${expected}, got \${actual}\`);
  } else {
    console.log(\`ok \${name}\`);
  }
}

check('median of an odd, unsorted list', median([3, 1, 2]), 2);
check('median of an even, unsorted list', median([4, 1, 3, 2]), 2.5);
check('median of one element', median([7]), 7);
check('mean still works', mean([1, 2, 3]), 2);

if (failures > 0) {
  console.log(\`\${failures} failing\`);
  process.exit(1);
}
console.log('all passing');
`;

/** `asc` on PATH, execing the BUILT binary, so the session runs the code under test. */
function shim(dir) {
  const shimDir = join(dir, '.shim');
  mkdirSync(shimDir, { recursive: true });
  const path = join(shimDir, 'asc');
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
  chmodSync(path, 0o755);
  return shimDir;
}

function asc(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

/**
 * One scratch project per session: its own directory, its own store, its own
 * `.claude/settings.json`. Arms must not share a store, or arm B's entries would be counted as
 * arm C's.
 */
function scratch(arm, rep) {
  const dir = mkdtempSync(join(tmpdir(), `ev16-${arm}${String(rep)}-`));
  mkdirSync(join(dir, '.ascend'), { recursive: true });
  writeFileSync(join(dir, 'calc.js'), CALC_JS);
  writeFileSync(join(dir, 'test.js'), TEST_JS);
  const init = asc(['init'], dir);
  if (init.status !== 0) throw new Error(`asc init failed in ${dir}: ${init.stderr}`);
  return dir;
}

/**
 * Arm D's registry, inflated the way EV-16's Q1 curve was built: the real starter prose extended
 * by duplication under distinct names. Stated as a limitation there and repeated here -- this buys
 * a brief of realistic SIZE and shape, not a realistic VOCABULARY, so D tests the size axis and
 * nothing about whether a model can choose among 400 genuinely different types.
 */
function inflate(dir, n) {
  const defined = [];
  for (let i = 0; i < n; i += 1) {
    const doc = {
      name: `filler_type_${String(i).padStart(3, '0')}`,
      description: 'A filler type registered to extend the brief to a measured size.',
      // The prose length is not arbitrary: EV-16 Q1 measured the real starter registry at
      // 301.19 bytes/type, and arm D is only comparable to that curve if its brief sits on it.
      // A first pass at 254.0 bytes/type put N=400 at 102,953 bytes against Q1's 120,484, so
      // this is padded to close the gap. The padding is measured, not guessed -- see the
      // bytes/type check in the dry run.
      record_when:
        'Never by hand. This type exists to extend the brief to a measured size for EV-16 arm D, ' +
        'and carries prose of the same shape and length as a real starter type so the brief it ' +
        'produces costs what a real registry of this size would cost.' +
        ' Padded to EV-16 Q1 measured 301.19 bytes/type.',
      properties: [
        { name: 'note', type: 'text', description: 'Filler prose, never recorded against.' },
      ],
    };
    const res = spawnSync(process.execPath, [bin, 'types', 'define', '-'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify(doc),
    });
    if (res.status !== 0) throw new Error(`types define failed at ${i}: ${res.stderr}`);
    defined.push(doc.name);
  }
  return defined;
}

/** The brief as this project's store would deliver it, measured rather than assumed. */
function briefBytes(dir) {
  const res = asc(['types', 'brief'], dir);
  return res.status === 0 ? res.stdout.length : null;
}

/**
 * The four arms, exactly as pre-registered. `hook` and `mentionsBrief` are the only two things that
 * vary; the task is byte-identical across all four, which is what makes A vs C and B vs C readable.
 */
const ARMS = {
  A: { hook: false, mentionsBrief: false, oversized: false, isolates: 'the floor' },
  B: { hook: false, mentionsBrief: true, oversized: false, isolates: 'availability without injection' },
  C: { hook: true, mentionsBrief: false, oversized: false, isolates: 'the product claim' },
  D: { hook: true, mentionsBrief: false, oversized: true, isolates: "Q2's size axis" },
  /**
   * NOT PRE-REGISTERED. A post-hoc extension, marked as one so it can never be read as part of the
   * sealed design: arms A-D and predictions P1-P5 were hashed before any measurement and arm E was
   * proposed afterwards, by the repository owner, as a fix for `asc-3q7`.
   *
   * It keeps the hook's output tiny and spends it on an INSTRUCTION naming a file that holds the
   * full brief, so nothing large passes through the channel that truncates near 10 KB. The canary
   * measured that a session follows that pointer unprompted -- given only "fix the bug in
   * median()", it read `.ascend/brief.txt` FIRST, before the file the task named.
   *
   * What it cannot inherit is P3's answer. Arm C delivered 1,353 bytes of brief into context, below
   * any ceiling, and recorded in 0 of 3. Arm E does not make the brief more available than that; it
   * makes the session READ it rather than merely have it, and whether that distinction moves the
   * rate is the only thing this arm measures.
   */
  E: { hook: true, mentionsBrief: false, oversized: false, pointer: true, isolates: 'reading the brief vs having it' },
};

function promptFor(arm) {
  if (ARMS[arm].mentionsBrief) {
    return `${TASK}\n\nThis project uses a tool called \`asc\`. \`asc types brief\` lists the entry types it knows about.`;
  }
  return TASK;
}

/**
 * The grant, identical across arms so the arms differ only in the brief. It restricts WRITES and
 * not reads -- see the header -- so a session may and does run read-only commands absent from it.
 *
 * `Bash(node test.js)` is an exact command, not a prefix -- the task says run the tests, and
 * nothing else needs a shell. `Bash(asc:*)` is a prefix because the whole question is whether the
 * session reaches for `asc` unprompted, and constraining WHICH asc subcommand it may reach for
 * would decide the outcome the arm exists to measure.
 *
 * `Bash(asc:*)` is load-bearing in a way the probes make precise: `asc record` WRITES, so without
 * this entry the arms would measure a session that reached for `asc` and was refused, and record a
 * rate of zero that meant "forbidden" rather than "did not try". That is the measurement destroyed.
 */
const ALLOWED = process.env['EV16_ALLOWED'] ?? 'Read,Edit,Write,Bash(node test.js),Bash(asc:*)';

function argvFor() {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    ALLOWED,
    '--permission-mode',
    'dontAsk',
  ];
}

/** Read the outcome off the STORE, never off the agent's report. EV-9's discipline. */
function storeOutcome(dir) {
  const rows = asc(
    ['query', '--json', 'SELECT type_name, COUNT(*) AS n FROM entries GROUP BY type_name'],
    dir,
  );
  // `entry_types`, NOT `types` -- the first arm A run asked for `types`, got "no such table",
  // and reported registeredTypes as null. Nothing was lost (that arm registered none), but P5
  // asks whether a model INVENTS a type name, and a null here would have read as "no invented
  // type" when it actually meant "not measured". That distinction is the whole discipline.
  const types = asc(['query', '--json', 'SELECT name FROM entry_types'], dir);
  return {
    entries: rows.status === 0 ? JSON.parse(rows.stdout).rows : null,
    registeredTypes: types.status === 0 ? JSON.parse(types.stdout).rows.map((r) => r.name) : null,
  };
}

async function runSession(arm, rep, spent) {
  const dir = scratch(arm, rep);
  const spec = ARMS[arm];
  const inflated = spec.oversized ? inflate(dir, OVERSIZED_TYPES) : [];

  let hookInstall = null;
  if (spec.hook) {
    // The REAL command, per the pre-registration: nothing about the hook is simulated.
    const res = asc(['install-hook', '--yes', '--json'], dir);
    hookInstall = { status: res.status, stdout: res.stdout.slice(0, 2000), stderr: res.stderr };
    if (res.status !== 0) throw new Error(`install-hook failed in ${dir}: ${res.stderr}`);
  }

  // Arm E rewrites the installed hook to emit a pointer instead of the brief. The hook STRUCTURE
  // stays exactly what `asc install-hook` wrote -- only the command changes -- so the arm differs
  // from C in what the hook says and in nothing else.
  if (spec.pointer === true) {
    writeFileSync(join(dir, '.ascend', 'brief.txt'), asc(['types', 'brief'], dir).stdout);
    const wrapper = join(dir, '.brief-hook.mjs');
    // The pointer text is built as data and embedded with JSON.stringify rather than written as
    // source inside a template literal. The first attempt nested backticks three deep to quote
    // `asc` in the message and produced a SyntaxError; the quoting is not worth a second try.
    const POINTER =
      'This project records evidence with the `asc` tool. The entry types it knows about, and ' +
      'when each should be recorded, are listed in ./.ascend/brief.txt -- read that file before ' +
      'deciding whether anything in this session is worth recording.';
    writeFileSync(wrapper, `process.stdout.write(${JSON.stringify(POINTER)});\n`);
    const settingsPath = join(dir, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    let patched = 0;
    for (const matcher of settings.hooks?.SessionStart ?? []) {
      for (const h of matcher.hooks ?? []) {
        h.command = `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}`;
        patched += 1;
      }
    }
    if (patched !== 1) throw new Error(`expected one SessionStart hook, patched ${String(patched)}`);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  const prompt = promptFor(arm);
  const argv = argvFor();
  const shimDir = shim(dir);
  const before = storeOutcome(dir);
  const brief = briefBytes(dir);

  const meta = {
    arm,
    rep,
    isolates: spec.isolates,
    scratch: dir,
    model,
    grant: {
      allowedTools: ALLOWED,
      permissionMode: 'dontAsk',
      bypass: false,
      // Measured 2026-09-20 by spike/ev16-grant-probe.mjs across five sessions, not assumed:
      // ungranted WRITES are denied, ungranted READ-ONLY commands run. See the header.
      boundsWrites: true,
      boundsReads: false,
    },
    invocation: ['claude', ...argv],
    prompt,
    promptBytes: prompt.length,
    briefBytes: brief,
    inflatedTypes: inflated.length,
    hookInstall,
    storeBefore: before,
  };

  if (dryRun) return { ...meta, dryRun: true, spentUsd: 0 };

  const started = Date.now();
  const child = spawn('claude', argv, {
    cwd: dir,
    // HOME is deliberately NOT overridden: this is a real session and needs the real credentials.
    // Nothing in ascend writes to $HOME -- the hook it installed is project-level.
    env: { ...process.env, PATH: `${shimDir}:${process.env['PATH'] ?? ''}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  const errs = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', (c) => errs.push(c));
  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const wallMs = Date.now() - started;

  const stream = Buffer.concat(chunks).toString('utf8');
  // Written BEFORE analysis: the stream is the expensive half, the analysis is the half that gets
  // edited, and a bug in the latter must never cost another session.
  writeFileSync(join(out, `ev16-${arm}${String(rep)}-stream.jsonl`), stream);
  writeFileSync(join(out, `ev16-${arm}${String(rep)}-stderr.txt`), Buffer.concat(errs));

  let result = null;
  for (const line of stream.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'result') result = obj;
    } catch {
      /* a partial line at the tail is not a finding */
    }
  }

  return {
    ...meta,
    exitCode,
    wallMs,
    spentUsd: result?.total_cost_usd ?? 0,
    modelUsage: result?.modelUsage ?? null,
    numTurns: result?.num_turns ?? null,
    // Reported because it names what the model TRIED and was stopped from doing. It is not
    // evidence of where the session stayed: an out-of-grant READ leaves this empty, measured.
    permissionDenials: result?.permission_denials ?? null,
    isError: result?.is_error ?? null,
    storeAfter: storeOutcome(dir),
  };
}

const sessions = [];
let spent = 0;
for (const arm of arms) {
  if (ARMS[arm] === undefined) throw new Error(`unknown arm ${arm}`);
  for (let rep = 1; rep <= reps; rep += 1) {
    if (!dryRun && spent >= maxUsd) {
      console.error(
        `CEILING REACHED: spent ${spent.toFixed(4)} of ${String(maxUsd)} USD. ` +
          `Stopping before arm ${arm} rep ${String(rep)}. Completed sessions are written to spike/tmp/.`,
      );
      break;
    }
    const session = await runSession(arm, rep, spent);
    spent += session.spentUsd ?? 0;
    sessions.push(session);
    writeFileSync(join(out, 'ev16-arms.json'), JSON.stringify({ sessions, spent }, null, 2));
  }
}

console.log(
  JSON.stringify(
    {
      dryRun,
      model,
      maxUsd,
      spentUsd: spent,
      grant: {
        allowedTools: ALLOWED,
        permissionMode: 'dontAsk',
        bypass: false,
        boundsWrites: true,
        boundsReads: false,
      },
      sessions: sessions.map((s) => ({
        arm: s.arm,
        rep: s.rep,
        briefBytes: s.briefBytes,
        inflatedTypes: s.inflatedTypes,
        spentUsd: s.spentUsd,
        numTurns: s.numTurns ?? null,
        entries: s.storeAfter?.entries ?? null,
        permissionDenials: s.permissionDenials ?? null,
      })),
    },
    null,
    2,
  ),
);
