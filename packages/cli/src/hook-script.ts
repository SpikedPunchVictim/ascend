/**
 * What `.claude/ascend-hook.sh` IS: where it lives, how it is recognised, the binary resolution
 * that goes into it, the text itself, and the byte-equality test that decides whether an installed
 * copy is still current.
 *
 * **A leaf module, and only because two callers need the same identity** (`asc-mu20`).
 * `asc install-hook` writes the script; `asc doctor` reports whether an installed one is still the
 * generation this ascend would write. Byte equality is the only test that can answer the second --
 * `hookScript`'s output changes whenever the resolution logic changes -- so doctor has to compute
 * exactly the bytes install-hook would write. Two spellings of "current" would be two answers to
 * one question, and the point of the check is that the answer is not knowable by looking at the
 * script's date.
 *
 * **The two markers moved here with the script**, which is one more than the four symbols the bead
 * named, for a reason the bead's own case list forces: "settings.json names the hook but the script
 * is missing" cannot be told from "the hook was never installed" without asking what a settings file
 * that names ascend's hook contains. That test lives beside the strings it tests, not in the doctor
 * check, so the marker is still spelled once.
 *
 * Nothing here touches the store or the command layer: `hookScript` is a pure string function and
 * `isScriptCurrent` is the one filesystem read. `doctor.ts` stays pure by taking the resulting facts
 * as plain data; the reading happens in `commands/doctor.ts`.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { STORE_DIR } from '@ascend/store';

import { RECORD_COMMAND, RECORD_COMMAND_INPUT } from './brief-text.js';
import { shellQuote } from './symlink.js';

/**
 * Where the generated hook script lives, relative to the project root.
 *
 * Always `/`-separated, unlike the settings path in `install-hook.ts`: this string is embedded in
 * shell text -- both in `SETTINGS_COMMAND` and inside the script `hookScript` writes -- and `/bin/sh`
 * reads that text on whatever OS is running the hook, regardless of which OS `install-hook` itself
 * ran on. `path.join`'s platform separator would be correct for a filesystem call and wrong here.
 */
export const SCRIPT_RELATIVE_PATH = '.claude/ascend-hook.sh';

/**
 * How a pre-asc-cjm ascend hook (generation 1 or 2) is recognised: a substring of the OLD inline
 * command, naming the subcommand it ran rather than a path -- the one part of those two generations
 * that stayed stable while the absolute paths around it changed with every checkout.
 */
export const INSTALLED_MARKER = 'types brief';

/**
 * How a generation-3 (asc-cjm's) ascend hook is recognised: `SETTINGS_COMMAND` names the script by
 * this substring, and it is the ONLY marker a generation-3 command carries -- it mentions neither
 * `types brief` nor `ingest claude-code`, both of which moved into the script itself. Checked in
 * ADDITION to `INSTALLED_MARKER` in `locateAscendHook`, never instead of it: a settings file can
 * still hold a generation-1 or generation-2 command, and that must keep being recognised too, or a
 * second copy gets appended beside it -- the exact failure these markers exist to prevent.
 */
export const SCRIPT_MARKER = 'ascend-hook.sh';

/**
 * The `asc` shim `install-hook` writes, and the directory it sits in -- which is the directory the
 * SessionStart hook appends to the session's `PATH` (asc-zser).
 *
 * Inside `${STORE_DIR}/` rather than `.claude/`, and under `bin/` rather than loose, for two
 * reasons that point the same way. `.claude/` is tracked configuration, and this file resolves
 * `$root` at run time and is regenerated in full by every install -- committing it would put two
 * checkouts of one project in conflict over a file neither reads. And `${STORE_DIR}/` is already
 * the directory the generated hook script refuses to work without, so "a project with no store has
 * no shim" needs no second guard: the hook exits before the shim is ever consulted.
 */
export const SHIM_DIR_RELATIVE_PATH = `${STORE_DIR}/bin`;
export const SHIM_RELATIVE_PATH = `${SHIM_DIR_RELATIVE_PATH}/asc`;

/**
 * Whether `settingsText` -- the raw contents of `.claude/settings.json`, or `undefined` when there
 * is no such file -- already registers an ascend hook of any generation.
 *
 * **Deliberately a raw-text test, and the loose one is the right one HERE.** `install-hook.ts`'s
 * `locateAscendHook` walks the parsed JSON and returns where the command sits, because upgrading one
 * means writing back into the exact matcher and entry it came from. A report has no such need: the
 * doctor's question is only whether anyone ever opted in, and a file that mentions either marker has
 * plainly done so. Asking the structural question here would mean parsing untyped user JSON for
 * information the answer does not depend on.
 *
 * Both markers, for the reason `SCRIPT_MARKER` states above: an install from before asc-cjm names
 * `types brief` and a script that was never written, and calling that "never installed" would send
 * its owner looking for a hook they already have.
 */
export function namesAscendHook(settingsText: string | undefined): boolean {
  if (settingsText === undefined) return false;
  return settingsText.includes(INSTALLED_MARKER) || settingsText.includes(SCRIPT_MARKER);
}

/**
 * `binary`'s path relative to `root`, or `undefined` when it lies outside `root` entirely.
 *
 * This is branch 3 of `hookScript`'s resolution order: the running `asc`, named relative to the
 * project rather than by an absolute path, so the string stays correct for every OTHER checkout of
 * the same repository -- which is exactly what makes ascend's own monorepo installable with no
 * configuration (this project's own `.claude/settings.json`, hand-applied before this command could
 * write it, already names `packages/cli/dist/bin.js` this way).
 *
 * `undefined` when `relative` returns a path starting with `..`: that means `binary` is OUTSIDE
 * `root` (a global install, a sibling checkout, another project's `node_modules`), and there is no
 * portable way to spell a path that escapes the root it is relative to. Omitting the branch
 * entirely is the honest answer -- a `..`-prefixed path would be exactly as unportable as the
 * absolute path this function exists to avoid ever writing.
 *
 * `.split(sep).join('/')` normalises to the forward slashes `SCRIPT_RELATIVE_PATH` already commits
 * to: `relative` returns the host's own separator, and the string it produces here is embedded in
 * shell text that `/bin/sh` reads regardless of which OS generated it.
 */
export function ownBinaryRelativePath(root: string, binary: string): string | undefined {
  const path = relative(root, binary).split(sep).join('/');
  return path.startsWith('..') ? undefined : path;
}

/**
 * The two lines that make this checkout's own binary one of the candidates, or nothing at all when
 * that binary lives outside the root -- there is no relative path to write in that case, and a
 * `.claude/`-relative spelling of an absolute path elsewhere would name a file that is not there.
 *
 * Shared by `hookScript` and `shimScript`, which is why it is a function rather than a repeated
 * five-line expression: the two generated files must agree, forever, on which binary they are
 * talking about, and the way two spellings of one resolution go wrong is by drifting apart slowly
 * enough that nobody notices until a hook runs the wrong ascend.
 */
function ownBinaryLines(binaryRelativeToRoot: string | undefined): readonly string[] {
  if (binaryRelativeToRoot === undefined) return [];
  // `shellQuote` rather than a bare template interpolation: this path is computed from real
  // directory names, which on macOS routinely contain spaces, and the total escaping `shellQuote`
  // documents is what lets it sit safely right after the unquoted `"$root"` it is concatenated
  // onto -- two adjacent quoted tokens with no space between them are ONE shell word.
  const quoted = shellQuote(`/${binaryRelativeToRoot}`);
  return [`elif [ -f "$root"${quoted} ]; then`, `  bin="$root"${quoted}`];
}

/**
 * The content of `.claude/ascend-hook.sh`, regenerated in full on every `install-hook` run.
 *
 * Resolution happens HERE, at the time the hook actually runs, rather than at install time -- the
 * fix asc-cjm exists for (dogfood/0009): nothing in this function's OUTPUT is a path measured on
 * the machine that generated it; `root` and `bin` are both worked out fresh by the shell, every
 * session.
 *
 * `root`: `$CLAUDE_PROJECT_DIR` when the caller is Claude Code (it always is, when this script runs
 * as a hook), falling back to the script's OWN location otherwise -- it lives at
 * `<root>/.claude/ascend-hook.sh`, so the parent of `dirname "$0"` is `root`. That fallback is what
 * lets a person run `sh .claude/ascend-hook.sh` by hand, from anywhere, and get the same answer
 * the hook would.
 *
 * Four fallbacks for the binary, tried in order, and the first one that resolves wins:
 *
 *   1. `$ASCEND_BIN` -- an explicit override, for a machine or CI job that wants to pin one.
 *   2. `node_modules/.bin/asc` -- ascend installed as an ordinary dependency of this project.
 *   3. `binaryRelativeToRoot`, when given -- see `ownBinaryRelativePath`. Omitted entirely, not
 *      merely skipped, when the currently-running `asc` lives outside the project: there is no
 *      relative path to write in that case.
 *   4. `command -v asc` -- whatever a shell finds on `PATH`.
 *
 * Falling through all four is `exit 0`, silently -- the same inert contract every guard in
 * `install-hook.ts` already kept, extended to "no usable binary" as one more reason a session can
 * find nothing to run.
 *
 * The interpreter is bare `node`, not `process.execPath` the way the old inline command pinned it.
 * That WAS a measurement (Node's `node:sqlite` needs 22.5+, so a stale `node` on `PATH` used to
 * fail with a bare module-resolution error) but pinning is no longer the safer choice: `046cd04`
 * added `nodeVersionRefusal`, called from `bin.ts` before any command loads, so a `node` too old
 * for `node:sqlite` now fails with a sentence naming the requirement instead of that confusing
 * error. Pinning the interpreter is part of what made the settings command unportable in the first
 * place, so dropping it here is the other half of the same fix, not a regression. `dist/bin.js` is
 * mode 644 despite its `#!/usr/bin/env node` shebang (measured on this checkout), so a `.js` target
 * MUST run through `node` -- a `node_modules/.bin` shim, by contrast, already has its own
 * interpreter line and its own executable bit set by whichever package manager created it, so it is
 * run directly.
 *
 * The store guard and the ingest-then-brief pair carry the same guarantees as the inline command
 * this replaced: `${STORE_DIR}/` is gitignored, so a teammate who clones this repository has the
 * hook and no store, and must see nothing rather than an error; `ingest claude-code` runs first
 * with both streams discarded, then `types brief` runs regardless of ingest's exit status, because
 * a broken ingest must never be able to suppress the one thing this hook has always reliably done.
 * Two ordinary statements on two lines carry that guarantee here, in place of the `;` the old
 * inline command needed to state explicitly: a script does not need `&&` to make one statement run
 * after another.
 *
 * **The text names this module, not `install-hook.ts`, and that is load-bearing.** The line is what
 * a reader of the script is told to go read, and `asc-mu20` moved `hookScript` out of the command
 * file -- so the string changed, which is exactly the event `isScriptCurrent` exists to catch: every
 * script installed before this module existed is now an older generation, and says so, rather than
 * pointing at a file that no longer holds the function.
 */
export function hookScript(binaryRelativeToRoot: string | undefined): string {
  const ownLines = ownBinaryLines(binaryRelativeToRoot);

  // The one sentence that stops a reader copying the resolution below (`asc-l38f`, dogfood/0028).
  // The asymmetry it names is structural, not a bug to be fixed: an allow rule matches the LITERAL
  // TEXT of the command a session emits, so a form spelled differently is a different command --
  // "it doesn't match the same program invoked in a different form". This script's own path form
  // therefore runs and is not granted, while the bare form is granted and resolves nowhere when the
  // binary is off PATH. No artifact can be both, so the script stops RECOMMENDING its own form.
  // The command is interpolated from `RECORD_COMMAND` rather than spelled again: `dogfood/0028`
  // measured `asc record` at 0 occurrences in the brief and this script naming a form four sessions
  // tried and were denied, and two artifacts disagreeing on one spelling is the class this closes.
  // `RECORD_COMMAND_INPUT` travels with it for the same reason (`asc-k0l9`): the command reads the
  // entry from standard input, so a reader told to run it without that clause runs something that
  // exits 1 -- and a note on one artifact and not the other is the same asymmetry again.
  const byHand = [
    `# To record an entry by hand, run: ${RECORD_COMMAND}  (${RECORD_COMMAND_INPUT})`,
    "# The resolution below is THIS script's own job -- how a hook finds a binary that is not on",
    '# PATH -- and is not a form to copy: an allow rule matches the literal text of a command, so a',
    '# path form is a different command to the one an allow-list entry names, and is refused.',
    '',
  ].join('\n');

  const resolution = [
    'if [ -n "$ASCEND_BIN" ] && [ -f "$ASCEND_BIN" ]; then',
    '  bin="$ASCEND_BIN"',
    'elif [ -f "$root/node_modules/.bin/asc" ]; then',
    '  bin="$root/node_modules/.bin/asc"',
    ...ownLines,
    'elif command -v asc >/dev/null 2>&1; then',
    '  bin="$(command -v asc)"',
    'else',
    '  exit 0',
    'fi',
  ].join('\n');

  // The PATH half (asc-zser). Everything above finds a binary that is NOT on PATH; this puts one
  // that IS, so that a bare `asc` in the session's own shell resolves -- which is what README
  // §Install could not promise and dogfood/0050 paid for.
  //
  // **`$CLAUDE_ENV_FILE` is run, not read.** Claude Code executes it as a shell script before each
  // Bash command, in the same shell process, so an export written here governs a command run later
  // in the SAME session. Measured, not assumed: 4/4 sessions against a 0/4 control with the write
  // removed and nothing else changed (`docs/evidence/EV-47.md`). That is also why the export is a
  // real `export PATH` and not a `settings.json` `env` entry, whose values are literal -- a `PATH`
  // there would REPLACE the inherited one with the literal string `$PATH:...`.
  //
  // **The guard is required, not defensive.** The variable is set for SessionStart, Setup,
  // CwdChanged and FileChanged hooks and unset for every other event, and an unguarded append to an
  // unset path fails with `sh: : No such file or directory` and exit 1 (measured, EV-47) -- which
  // would turn every session of every project into a reported hook failure.
  //
  // **`printf`, not a heredoc, because the two stages expand different things.** The format is
  // single-quoted, so `$PATH` survives into the file as literal text for the session's shell to
  // expand; `%s` is filled with `$root` expanded HERE, so the file names an absolute directory and
  // nothing about this machine's `PATH` is baked into it. An unquoted heredoc would expand both and
  // a quoted one neither.
  //
  // **The `case` is what makes the write idempotent**, and it is evaluated when the FILE is run, in
  // the session's own shell, not here. A session that fires SessionStart twice -- `/clear` does --
  // would otherwise stack a second copy of the same directory onto `PATH` on every fire.
  //
  // **`-x` on the shim, not `-n` on the directory**, is what ties the two halves together: a project
  // where `install-hook` wrote no shim (its binary lives outside the root, so the shim could only
  // ever find itself) gets no `PATH` entry either, and no entry is written for a directory that has
  // since been deleted. The two generated files therefore cannot disagree about whether a bare `asc`
  // is supposed to resolve here.
  const pathExport = [
    `ascend_bin_dir="$root/${SHIM_DIR_RELATIVE_PATH}"`,
    'if [ -n "$CLAUDE_ENV_FILE" ] && [ -x "$ascend_bin_dir/asc" ]; then',
    `  printf 'case ":$PATH:" in\\n  *":%s:"*) ;;\\n  *) export PATH="%s:$PATH" ;;\\nesac\\n' \\`,
    '    "$ascend_bin_dir" "$ascend_bin_dir" >> "$CLAUDE_ENV_FILE"',
    'fi',
  ].join('\n');

  return `#!/bin/sh
# Written by \`asc install-hook\`. Regenerated in full every time that command runs, so a hand
# edit here does not survive the next install or upgrade -- see hook-script.ts's \`hookScript\`.
#
# Resolves the project root and the ascend binary at RUN time, in THIS file, rather than in
# .claude/settings.json: that file is shared, tracked, team configuration, and a path measured on
# one checkout was only ever correct for that one checkout (asc-cjm, dogfood/0009).

root=\${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)}

# ${STORE_DIR}/ is gitignored, so a teammate who clones this repository has the hook and no
# store -- exit 0 and print nothing, the same contract every guard in this file keeps.
[ -d "$root/${STORE_DIR}" ] || exit 0

# Both commands below find their store by walking UP FROM THE WORKING DIRECTORY, never from
# \`$root\` -- so without this the guard above and the commands it guards are talking about two
# different projects. Measured: run from \`/\` with a valid \`$root\`, the guard passed and
# \`types brief\` still exited 1 with "No ${STORE_DIR}/ store found in /". That is the benign half.
# \`ingest\` WRITES, so the same mismatch in a directory that does have a store above it would
# file one project's transcripts into another project's database, silently and irreversibly.
cd "$root" || exit 0

# Put a bare \`asc\` on this session's PATH, for the shell Claude Code hands to the tools in it.
#
# ABOVE the resolution below, and the order is load-bearing rather than tidy: the resolution ends in
# \`exit 0\` when it finds no binary, and the ordinary outside-the-project install -- where the shim
# is the ONLY thing that will ever put \`asc\` on PATH -- is precisely the case that reaches that
# exit. With this block below it, the hook would exit before writing the entry that makes the shim
# reachable, and \`install-hook\` would report success while no session ever saw a bare \`asc\`.
# Measured: the export produced nothing until this block moved (the scratch project's own hook run
# exited 0 at the resolution and never reached the write).
${pathExport}

${byHand}${resolution}

case "$bin" in
  *.js)
    command -v node >/dev/null 2>&1 || exit 0
    run() { node "$bin" "$@"; }
    ;;
  *)
    run() { "$bin" "$@"; }
    ;;
esac

# With a stage (\`sh ascend-hook.sh post-tool-use\`), this is a lifecycle hook for the project's
# say: handlers: the hook's JSON input is on stdin, and \`asc hook\` reads it from there.
#
# EVERY argument is forwarded, not just the stage, because a stage's entry may carry flags -- the
# holdout rate \`asc install-hook --holdout\` bakes in (asc-xn4g). Forwarding \`"$1"\` alone dropped
# them silently: the entry would read \`... post-tool-use --holdout 0.3\`, the flag would never
# reach \`asc hook\`, and the project would run no experiment while its settings.json said it did.
if [ -n "$1" ]; then
  run hook "$@"
  exit 0
fi

run ingest claude-code >/dev/null 2>&1
run types brief
`;
}

/**
 * The `asc` shim itself: the command a session's shell finds on `PATH`, which forwards to whichever
 * ascend binary this project's checkout actually holds.
 *
 * **Why a shim, and not simply the directory the binary already lives in.** That would be the whole
 * feature in one line, and it is what the Claude Code docs' own example does -- and it does nothing
 * here, or in any source checkout. `dist/bin.js` is named `bin.js` and is mode 644 (measured on this
 * checkout), so there is no directory to put on `PATH` that yields a command called `asc`. The
 * binary is reachable only as `node <path>`, and the only way a shell can spell that as one word is
 * a file that does it -- which is this one.
 *
 * **The resolution is the hook script's, minus its last fallback -- and the omission is the whole
 * reason this can exist.** `command -v asc` would return THIS file: the shim's own directory is on
 * `PATH` precisely because the shim is what put it there, so the lookup would find the thing doing
 * the looking and `exec` itself forever. Removing that one fallback is what makes a shim possible at
 * all, and it is why the last candidate here is an absolute path rather than a `PATH` search.
 *
 * **That absolute path is baked in, and it is NOT the mistake `dogfood/0009` records.** asc-cjm
 * moved the binary's location out of `.claude/settings.json` because that file is *tracked*: a path
 * measured on one checkout is wrong for every teammate, and wrong for the same person the moment the
 * checkout moves. Neither holds here. This file is gitignored, written per machine, and rewritten in
 * full by every run of `install-hook` -- so it names the binary of *this* machine's install, which is
 * the only thing it was ever asked to name. The relative form is preferred when the binary is inside
 * the root, because it survives the checkout being moved; the absolute form is the fallback for the
 * ordinary case of a checkout used to install into somebody else's project, where there is no
 * relative path to write and without this there would be no shim at all.
 *
 * **The failure is loud, unlike the hook script's silent `exit 0`.** That contract belongs to a
 * background hook, which must never turn a session start into a wall of output; this is a command
 * the user typed, and a command that exits silently is indistinguishable from one that did nothing.
 * 127 is the shell's own "command not found". The message carries context, problem and fix rather
 * than the raw path alone.
 */
export function shimScript(
  binaryAbsolute: string,
  binaryRelativeToRoot: string | undefined,
): string {
  const candidates = [
    'elif [ -f "$root/node_modules/.bin/asc" ]; then',
    '  bin="$root/node_modules/.bin/asc"',
    ...ownBinaryLines(binaryRelativeToRoot),
  ];
  if (binaryRelativeToRoot === undefined) {
    const quoted = shellQuote(binaryAbsolute);
    candidates.push(`elif [ -f ${quoted} ]; then`, `  bin=${quoted}`);
  }

  return `#!/bin/sh
# Written by \`asc install-hook\`. Puts a bare \`asc\` on the PATH of this project's sessions, so a
# reader who is told to run \`asc ...\` does not have to define an alias first. Regenerated in full
# every time that command runs, so a hand edit here does not survive the next install or upgrade --
# see hook-script.ts's \`shimScript\`.
#
# This is the other half of \`.claude/ascend-hook.sh\`: that script finds a binary that is NOT on
# PATH, and this is what the session's shell finds ON it. Nothing is written into a global bin
# directory, so removing this project's ascend is \`rm -r ${STORE_DIR}/\`.

root=\${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." 2>/dev/null && pwd)}

if [ -n "$ASCEND_BIN" ] && [ -f "$ASCEND_BIN" ]; then
  bin="$ASCEND_BIN"
${candidates.join('\n')}
else
  echo "asc: no ascend binary for $root -- re-run 'asc install-hook' from the checkout that should run it" >&2
  exit 127
fi

case "$bin" in
  *.js)
    command -v node >/dev/null 2>&1 || {
      echo "asc: $bin needs node, and node is not on PATH" >&2
      exit 127
    }
    exec node "$bin" "$@"
    ;;
  *)
    exec "$bin" "$@"
    ;;
esac
`;
}

/**
 * Whether `path` already holds exactly `expected` **and** a shell could run it.
 *
 * Byte equality alone is not enough for the shim, and this is not a hypothetical: the shim is a
 * command, and a copy that is byte-identical but has lost its executable bit -- restored from an
 * archive, copied without `-p`, rewritten by an editor that replaced rather than modified the file
 * -- is a file the doctor would call current and the shell calls `permission denied`. That is
 * exactly the false green `isScriptCurrent` exists to prevent, one layer down, and the mode is part
 * of the artifact rather than a property of the filesystem that nobody has to think about.
 */
export function isShimCurrent(path: string, expected: string): boolean {
  if (!isScriptCurrent(path, expected)) return false;
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Where the ascend binary that is RUNNING lives, resolved to an absolute path -- or why it could
 * not be worked out.
 *
 * `process.argv[1]` is the script Node was handed, which for every supported invocation is the
 * binary itself: `node .../bin.js` and a `node_modules/.bin` shim alike. `realpathSync` resolves the
 * symlinked cases, because a global install and a workspace link both reach the real file through
 * links, and a hook that named the link would break when the link moved.
 *
 * **A result rather than a throw, because the two callers want opposite things from one failure.**
 * `install-hook` refuses loudly -- it is about to WRITE a hook, and a hook pointing at nothing is
 * worse than not installing. `asc doctor` reports: it exits 0 whatever it finds, and its job is to
 * say that currency is unknown rather than to stop the command. Returning the outcome rather than
 * throwing is what lets both be written against the same resolution instead of two of them.
 */
export type OwnBinary =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'no-argv' }
  | { readonly kind: 'unresolvable'; readonly path: string };

export function resolveOwnBinary(): OwnBinary {
  const script = process.argv[1];
  if (script === undefined || script === '') return { kind: 'no-argv' };
  let resolved: string;
  try {
    resolved = realpathSync(script);
  } catch {
    return { kind: 'unresolvable', path: script };
  }
  if (!existsSync(resolved)) return { kind: 'unresolvable', path: resolved };
  return { kind: 'resolved', path: resolved };
}

/**
 * Whether `path` already holds exactly `expected`.
 *
 * Byte equality, not mere existence -- `hookScript`'s output changes whenever the resolution logic
 * changes, and a script an older ascend wrote must be recognised as stale even though a file is
 * sitting right there. That is the reason generation 3's currency check can no longer live in the
 * settings command alone; see the comment above `alreadyInstalled` in `install-hook.ts`'s `run`.
 *
 * **A missing file is `false`, which is why the doctor check asks existence separately.** "Not
 * current" is the honest answer here, and it is also the answer for a file that is there and old --
 * so a caller that must tell those apart (the doctor does, and names the fix for each) has to ask
 * `existsSync` itself rather than reading a second meaning into `false`.
 */
export function isScriptCurrent(path: string, expected: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8') === expected;
  } catch {
    return false;
  }
}
