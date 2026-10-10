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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  const ownBinaryLines = ((): readonly string[] => {
    if (binaryRelativeToRoot === undefined) return [];
    // `shellQuote` rather than a bare template interpolation: this path is computed from real
    // directory names, which on macOS routinely contain spaces, and the total escaping `shellQuote`
    // documents is what lets it sit safely right after the unquoted `"$root"` it is concatenated
    // onto -- two adjacent quoted tokens with no space between them are ONE shell word.
    const quoted = shellQuote(`/${binaryRelativeToRoot}`);
    return [`elif [ -f "$root"${quoted} ]; then`, `  bin="$root"${quoted}`];
  })();

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
    ...ownBinaryLines,
    'elif command -v asc >/dev/null 2>&1; then',
    '  bin="$(command -v asc)"',
    'else',
    '  exit 0',
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
if [ -n "$1" ]; then
  run hook "$1"
  exit 0
fi

run ingest claude-code >/dev/null 2>&1
run types brief
`;
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
