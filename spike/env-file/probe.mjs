// asc-zser (throwaway). Does CLAUDE_ENV_FILE exist, and is a PATH export written into it by a
// SessionStart hook honoured in the SAME session? Design and predictions: PREREG.md.
//
//   node spike/env-file/probe.mjs <scratch-dir> <arm write|control> <model> <reps>
//
// Each rep gets its own ephemeral project. A SessionStart hook logs whether CLAUDE_ENV_FILE is
// set (and, if set, whether it lives inside the project -- never the value itself) and, in the
// `write` arm, appends a PATH export naming the project's own bin/ directory. `bin/asc` prints a
// marker when run. Then two sessions in that project each run one Bash command and report whether
// `asc` resolves on PATH.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// ABSOLUTE, because the hook command written into settings.json is run by a session whose cwd is
// the project dir -- a relative `sh "spike/tmp/..."` resolves to nothing and the hook fails silently.
const [scratchArg, arm, model, reps] = process.argv.slice(2);
const scratch = resolve(scratchArg);

/**
 * One headless session. Returns the Bash commands the assistant emitted, the tool_result text
 * they produced, and the turn's cost.
 *
 * Both are kept: the COMMAND text is not evidence (it contains the literal `FOUND=NONE` it would
 * print), so the verdict is read off the RESULT text, which is the shell's own output.
 */
function run(dir, args, prompt) {
  const r = spawnSync(
    'claude',
    ['-p', '--model', model, '--output-format', 'stream-json', '--verbose',
      // Bare `Bash`, not `Bash(echo:*)`: a prefix rule does not match a command containing a `$`
      // expansion, so the narrower allowlist denied both the registered `$(command -v asc ...)` and
      // its replacement `echo "$PATH"`. Measured, not assumed -- `Bash(echo:*)` allows a plain
      // `echo hi` and denies `echo "$PATH"` in the same headless configuration. The prompt still
      // asks for one command, and `cmds` records EVERY Bash command the session emitted, so a
      // session that went off-script is visible in the row rather than invisible in a summary.
      '--allowedTools', 'Bash', '--permission-mode', 'dontAsk', ...args],
    // Bounded, so a session that hangs on a prompt cannot run away with the experiment.
    { cwd: dir, input: prompt, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120_000 },
  );
  // The raw stream is kept beside the rep: the result-text extraction below is the part of this
  // harness most likely to be wrong, and guessing its shape from memory is how the first draft
  // produced `unreadable` for every run.
  writeFileSync(join(dir, `events-${args.at(-1)}.jsonl`), r.stdout);
  writeFileSync(join(dir, `stderr-${args.at(-1)}.txt`), r.stderr ?? '');
  const events = r.stdout
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const content = events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content);
  const cmds = content
    .filter((c) => c.type === 'tool_use' && c.name === 'Bash')
    .map((c) => c.input.command);
  const results = events
    .filter((e) => e.type === 'user')
    .flatMap((e) => e.message.content)
    .filter((c) => c.type === 'tool_result')
    .map((c) => (typeof c.content === 'string' ? c.content : (c.content ?? []).map((p) => p.text ?? '').join('')))
    .join('\n');
  return { cmds, results, cost: events.find((e) => e.type === 'result')?.total_cost_usd ?? 0 };
}

// A single allowed tool, so a negative cannot be a permission denial read as "not found".
//
// The command is a BARE `echo "$PATH"`, and not the `command -v asc` this probe first registered.
// That one was denied: Claude Code splits a compound command at `||` and `$( )` before matching it
// against the allowlist, so `echo "FOUND=$(command -v asc || echo NONE)"` decomposes into
// `echo`, `command -v asc` and `echo NONE`, and the middle one matches no allowed rule. The
// measured question is unchanged -- *is the project's own bin/ on the session shell's PATH* -- and
// the answer is now read directly off the PATH the shell prints instead of off a lookup it runs.
const PROMPT = 'Run this exact Bash command and report exactly what it prints: echo "$PATH"';

/**
 * The shell's own answer, off the result text.
 *
 * `denied` is deliberately its own verdict, not a `no`: the whole reason the prompt is a single
 * `echo` is to keep the command inside the allowlist, and a silent denial would otherwise be
 * indistinguishable from a marker that is genuinely absent.
 */
function verdict(session, markerDir) {
  if (session.cmds.length === 0) return 'no-command';
  if (/has been denied|Permission to use/.test(session.results)) return 'denied';
  if (session.results.includes(markerDir)) return 'yes';
  if (session.results.trim() === '') return 'unreadable';
  return 'no';
}

const rows = [];
for (let i = 0; i < Number(reps); i += 1) {
  const dir = join(scratch, `envfile-${arm}-${i}-${Date.now()}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });

  // The marker: a command named `asc` that exists only on the project's own bin/.
  writeFileSync(join(dir, 'bin', 'asc'), '#!/bin/sh\necho MARKER-OK\n');
  chmodSync(join(dir, 'bin', 'asc'), 0o755);

  // The hook. Logs the one fact that answers question 1 (set/unset, and where -- never the value),
  // and in the `write` arm does what asc-zser would have install-hook do.
  const write =
    arm === 'write'
      ? 'if [ -n "$CLAUDE_ENV_FILE" ]; then printf \'export PATH="%s:$PATH"\\n\' "$root/bin" >> "$CLAUDE_ENV_FILE"; fi\n'
      : '';
  writeFileSync(
    join(dir, 'hook.sh'),
    `#!/bin/sh
cat >/dev/null
root=\${CLAUDE_PROJECT_DIR:-$PWD}
if [ -n "$CLAUDE_ENV_FILE" ]; then
  case "$CLAUDE_ENV_FILE" in
    "$root"/*) where=inside-project ;;
    *) where=outside-project ;;
  esac
  echo "set where=$where base=$(basename "$CLAUDE_ENV_FILE")" >> "$root/hook.log"
else
  echo "unset" >> "$root/hook.log"
fi
${write}`,
  );
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: `sh "${join(dir, 'hook.sh')}"` }] },
        ],
      },
    }),
  );

  const s1 = run(dir, ['--session-id', randomUUID()], PROMPT);
  const s2 = run(dir, ['--session-id', randomUUID()], PROMPT);
  const logPath = join(dir, 'hook.log');
  const envFile = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '(no log)';

  const markerDir = join(dir, 'bin');
  const row = { arm, i, envFile, session1: verdict(s1, markerDir), session2: verdict(s2, markerDir), cmds: [...s1.cmds, ...s2.cmds], cost: +(s1.cost + s2.cost).toFixed(4) };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const n = (key, value) => rows.filter((r) => r[key] === value).length;
console.log(
  `SUMMARY ${arm} ${model}: session1 sees asc ${n('session1', 'yes')}/${rows.length}  ` +
    `session2 sees asc ${n('session2', 'yes')}/${rows.length}  cost $${rows.reduce((s, r) => s + r.cost, 0).toFixed(3)}`,
);
console.log(`HOOK LOGS ${JSON.stringify([...new Set(rows.map((r) => r.envFile))])}`);
