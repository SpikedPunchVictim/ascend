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
import { join, relative, sep } from 'node:path';

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
 * The sentence both generated scripts print when the binary they resolved is a `.js` and there is no
 * `node` on `PATH` to run it.
 *
 * One spelling, because both scripts make the same claim about the same condition and are
 * regenerated independently of each other: a reader who meets it from the shim -- a command they
 * typed, so it exits 127 and says "command not found" -- and a reader who meets it from the hook --
 * a lifecycle hook, which exits 1 and is reported as a hook error -- are being told the same thing.
 * Two copies of the sentence is how the next edit teaches one of them something else (asc-nopa).
 *
 * `$bin` is a shell variable and is left as one: this string is rendered INTO a generated script,
 * where the shell expands it, never expanded here.
 */
export const NEEDS_NODE_REFUSAL = 'asc: $bin needs node, and node is not on PATH';

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
 * The candidates the INSTALL owns, in the order they are tried -- and the only place that order is
 * written down.
 *
 * **A table rather than a chain per artifact, because one resolution written twice is what this
 * closes.** `dogfood/0082` is a hook whose shell text resolved a binary one way and whose installer
 * assumed another, and the way two spellings of one chain fail is by agreeing today and diverging
 * after one of them is edited. `hookScript` renders this list as the `elif` chain a hook runs;
 * `resolveHookBinary` walks the same list to answer "does this project's hook reach a binary at all",
 * which `asc doctor` reports as the branch an installed hook takes; `shimScript` renders the same
 * list minus `shim`, which is itself.
 *
 * **`resolveHookBinary` is deliberately called by nothing at install time**, and this paragraph used
 * to say otherwise. It is a walk over a list the install has just finished satisfying: every path
 * that reaches an install-time probe after a successful write leaves the shim written and mode 755,
 * so `none` is unreachable there, and on the *pre-fix* tree the same walk resolved another checkout's
 * shim and was green while every hook was inert. It never modelled the failure it was proposed for.
 * The chain's own reachability is proved where it can fail -- by running the generated bytes in
 * `install-hook.test.ts` and comparing them to this walk. See `resolveHookBinary`.
 *
 * Two shell predicates, and the TypeScript walk mirrors whichever one applies. `-f` for a candidate
 * this script hands to an interpreter or runs through its own shebang; `-x` for a program it executes
 * directly. The shim is the latter, and the same `-x` is what the generated `PATH` entry below and
 * `isShimCurrent` both gate on -- so all three agree on what "the shim is usable here" means.
 *
 * **`$ASCEND_BIN` and `command -v asc` are deliberately absent.** Each is a fallback this list can
 * neither guarantee nor check. The first is a run-time-only override that need not be set in the
 * session's environment at all, so probing it here would report success for a session that has it
 * unset -- which is exactly how the n8n pilot's own workaround would have masked this. The second is
 * the user's `PATH`, which the install does not control and which is the one that shadowed this
 * project's own shim in `dogfood/0082`. Both stay in the generated text, on either side of this
 * chain; `resolveHookBinary` declines to model them, so its answer is about the branches the install
 * is responsible for, and `none` from it is a stricter answer than the shell's own.
 */
const HOOK_BINARY_ORDER = ['node-modules', 'relative', 'shim'] as const;

export type HookBinaryKind = (typeof HOOK_BINARY_ORDER)[number];

/** Which of the two shell predicates each candidate is tested with. */
const CANDIDATE_TEST: Readonly<Record<HookBinaryKind, 'f' | 'x'>> = {
  'node-modules': 'f',
  relative: 'f',
  shim: 'x',
};

/**
 * Candidate `kind` as a single shell WORD, with `$root` left unexpanded for the session's own shell
 * to resolve -- or `undefined` when the candidate is omitted entirely rather than merely skipped.
 *
 * `undefined` is the honest answer for the relative branch when the running binary lies outside the
 * root: there is no portable way to spell a path that escapes the root it is relative to, and a
 * `..`-prefixed one would be exactly as unportable as the absolute path `ownBinaryRelativePath`
 * exists to avoid writing.
 *
 * `shellQuote` on that branch, and a bare template interpolation on the other two: the relative path
 * is computed from real directory names, which on macOS routinely contain spaces, and the total
 * escaping `shellQuote` documents is what lets it sit safely right after the unquoted `"$root"` it is
 * concatenated onto -- two adjacent quoted tokens with no space between them are ONE shell word. The
 * other two are module constants with no spaces in them.
 */
function candidateWord(
  kind: HookBinaryKind,
  binaryRelativeToRoot: string | undefined,
): string | undefined {
  if (kind === 'node-modules') return '"$root/node_modules/.bin/asc"';
  if (kind === 'shim') return `"$root/${SHIM_RELATIVE_PATH}"`;
  if (binaryRelativeToRoot === undefined) return undefined;
  return `"$root"${shellQuote(`/${binaryRelativeToRoot}`)}`;
}

/**
 * Candidate `kind` as an absolute path, for a caller that has to test the file itself -- or
 * `undefined` when it cannot exist for this root, the same omission `candidateWord` makes.
 */
function candidatePath(
  kind: HookBinaryKind,
  root: string,
  binaryRelativeToRoot: string | undefined,
): string | undefined {
  if (kind === 'node-modules') return join(root, 'node_modules', '.bin', 'asc');
  if (kind === 'shim') return join(root, ...SHIM_RELATIVE_PATH.split('/'));
  if (binaryRelativeToRoot === undefined) return undefined;
  return join(root, ...binaryRelativeToRoot.split('/'));
}

/**
 * The `elif` chain for `kinds`, in `HOOK_BINARY_ORDER` -- the two lines each candidate contributes to
 * a generated script. Candidates omitted for this root contribute nothing at all.
 */
function candidateLines(
  kinds: readonly HookBinaryKind[],
  binaryRelativeToRoot: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  for (const kind of HOOK_BINARY_ORDER) {
    if (!kinds.includes(kind)) continue;
    const word = candidateWord(kind, binaryRelativeToRoot);
    if (word === undefined) continue;
    lines.push(`elif [ -${CANDIDATE_TEST[kind]} ${word} ]; then`, `  bin=${word}`);
  }
  return lines;
}

/** Whether `path` is a file a shell could RUN -- the test the generated `-x` branches perform. */
function isExecutableFile(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** What {@link resolveHookBinary} found: which branch of the install's own chain resolves, if any. */
export type HookBinary =
  { readonly kind: HookBinaryKind; readonly path: string } | { readonly kind: 'none' };

/**
 * Which of the install's own candidates a hook run in `root` would actually reach, or `none`.
 *
 * **The question `dogfood/0082` was never asked.** `install-hook` wrote both generated files, reported
 * `installed`, and every hook invocation in a whole session was silently inert, because nothing had
 * ever checked that the chain the script runs ends at a file. Currency checks could not answer it --
 * both files were byte-identical to what that ascend would have written.
 *
 * **A walk over the same list the shell is generated from**, not a second description of it, so the
 * two cannot disagree about which candidate wins (`HOOK_BINARY_ORDER`). It tests each candidate's
 * file itself, with the predicate the shell applies to that candidate.
 *
 * `$ASCEND_BIN` and `command -v asc` are deliberately not modelled, for the reasons on
 * `HOOK_BINARY_ORDER`: one is an override this process cannot know the session will have, and the
 * other is the user's `PATH`. `none` therefore means "none of the branches the install is responsible
 * for resolves here", which is a *narrower* statement than "no shell anywhere could find an `asc`",
 * and a caller printing it owes the reader that distinction.
 *
 * **A result rather than a throw**, like `resolveOwnBinary` beside it and for the same reason: the
 * callers want opposite things from one failure, and a throw would pick for them. Today there is one
 * caller. `asc doctor` asks this to NAME the branch an installed hook takes, reports it, and exits 0
 * whatever it finds.
 *
 * **`install-hook` does NOT call this, and that is a decision rather than an omission.** An
 * assertion there was planned and then measured out as a check that cannot fail: every path that
 * reaches it after a successful install leaves the shim written and mode 755, so `none` is
 * unreachable, and on the *pre-fix* tree a call here resolved `another checkout's shim` and was
 * green while the hook was inert -- it never modelled the failure it was proposed for. The hook
 * script's chain is verified where it can be verified, by running the generated bytes in
 * `install-hook.test.ts` and comparing them against this function. Do not add a refusal here without
 * a reachable `none` to justify it.
 */
export function resolveHookBinary(
  root: string,
  binaryRelativeToRoot: string | undefined,
): HookBinary {
  for (const kind of HOOK_BINARY_ORDER) {
    const path = candidatePath(kind, root, binaryRelativeToRoot);
    if (path === undefined) continue;
    const present = CANDIDATE_TEST[kind] === 'x' ? isExecutableFile(path) : existsSync(path);
    if (present) return { kind, path };
  }
  return { kind: 'none' };
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
 * Five fallbacks for the binary, tried in order, and the first one that resolves wins:
 *
 *   1. `$ASCEND_BIN` -- an explicit override, for a machine or CI job that wants to pin one.
 *   2. `node_modules/.bin/asc` -- ascend installed as an ordinary dependency of this project.
 *   3. `binaryRelativeToRoot`, when given -- see `ownBinaryRelativePath`. Omitted entirely, not
 *      merely skipped, when the currently-running `asc` lives outside the project: there is no
 *      relative path to write in that case.
 *   4. `${STORE_DIR}/bin/asc` -- the shim `install-hook` itself wrote, the one candidate that carries
 *      the installing checkout's absolute path, precisely so a project that is NOT that checkout can
 *      still reach it. It sits LAST of the branches the install owns, because each of the three above
 *      it is a more specific answer and this is the catch-all the install guarantees; and it sits
 *      ahead of `command -v` for the reason `dogfood/0082` measured -- a project with no
 *      `node_modules` reached step 5, got whatever `asc` the USER'S shell had on `PATH`, and that was
 *      a different checkout's shim, which then refused to run for a project it had not installed into.
 *   5. `command -v asc` -- whatever a shell finds on `PATH`.
 *
 * Falling through all five is `exit 0`, silently -- the same inert contract every guard in
 * `install-hook.ts` already kept, extended to "no usable binary" as one more reason a session can
 * find nothing to run. Steps 2-4 are rendered from `HOOK_BINARY_ORDER` and are exactly the branches
 * `resolveHookBinary` walks, so `asc doctor` can NAME the branch an installed hook takes and say
 * `none` when none of the install's owns resolves. What is deliberately NOT done with that function
 * is refusing an install on it: `resolveHookBinary` says why, and the short version is that this
 * chain's own reachability is proved by running its generated bytes in `install-hook.test.ts`, which
 * is a check that can fail, rather than by a probe whose answer the install had just written.
 *
 * **What each exit code means here, and why the stage path maps one onto another (asc-nopa).** The
 * exit codes now draw one line: *nothing to run stays silent; something found that would not run
 * reports.* Falling through all five candidates above is the first case -- there is no binary, so
 * there is nothing to say -- and the store guard is the same case for a teammate who cloned this
 * repository. Past those, the project has a store and `install-hook` guarantees a shim inside it, so a
 * binary that RESOLVES and cannot run is a breakage, and it reports. Before asc-nopa the stage path
 * discarded the resolved binary's status with an unconditional `exit 0`, which was measured to be no
 * signal at all rather than a weak one: exit-0 stderr is not shown in the transcript and never reaches
 * the model (the Claude Code hooks reference is explicit, and `dogfood/0082` is three sessions of that
 * silence).
 *
 * **The status is MAPPED to 1, not passed through, and that is the whole safety argument.** The
 * shim's own refusal is 127 and oclif answers an unresolvable subcommand or flag with 2 -- and on
 * `UserPromptSubmit` and `PreToolUse` a 2 BLOCKS, so a stale ascend handed `hook <stage> --holdout`
 * (a flag `asc install-hook --holdout` bakes into the stage entry) would turn a routine upgrade into a
 * prompt that never reaches the model. Any non-zero is mapped to 1, which is non-blocking on all
 * three stages and always produces the notice carrying the first line of stderr.
 *
 * **And the stage path still ENDS with an `exit 0`, which is not the old mask and must not be
 * deleted as one.** The two things an `exit 0` here can mean are different: the pre-fix script
 * exited 0 with the binary's status thrown away, and this one exits 0 only after that status was
 * tested. Deleting the line instead of the discard is a live hazard, not a tidy-up -- the script's
 * last two statements are the SessionStart tail, `ingest claude-code` and `types brief`, so a stage
 * call that stops exiting early FALLS THROUGH into them. Measured while writing this: the generated
 * script without it printed the hook's JSON and then `types brief`'s output on the same stream, so a
 * PostToolUse hook answered with two documents and Claude Code could parse neither. The distinction
 * is the whole reason the line is commented rather than merely present, and the asc-tuur.4 test that
 * drives a stage call and parses its stdout as one JSON object is what holds it.
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
    ...candidateLines(HOOK_BINARY_ORDER, binaryRelativeToRoot),
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
  // **`-x` on the shim, not `-n` on the directory**, is what ties the two halves together: no `PATH`
  // entry is written unless that file is there AND runnable, so a project whose shim was deleted, or
  // lost its executable bit, gets no entry either -- and no entry is ever written for a directory that
  // has since been deleted. The two generated files therefore cannot disagree about whether a bare
  // `asc` is supposed to resolve here. The shim's own candidate in `hookScript`'s resolution gates on
  // the same `-x`, for the same reason: "the shim is usable in this project" is one test, not two.
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
    command -v node >/dev/null 2>&1 || {
      echo "${NEEDS_NODE_REFUSAL}" >&2
      exit 1
    }
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
  status=$?
  [ "$status" -eq 0 ] || exit 1
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
 * **The failure is loud, and the code it carries is the shell's rather than the hook's.** 127 is
 * "command not found", which is what a user typing a command expects to see; a lifecycle hook says
 * the same thing through a non-zero exit that is reported rather than shown, and asc-nopa is what
 * made the two agree -- it used to be that the hook script's stage path discarded this shim's refusal
 * entirely, so the SAME condition was loud when typed and silent when fired. What still belongs only
 * to a command someone typed is the exit code's meaning: a hook cannot use 127, and must not use 2,
 * which blocks. The message carries context, problem and fix rather than the raw path alone, and it
 * is one string for both scripts -- `NEEDS_NODE_REFUSAL` above says why.
 */
export function shimScript(
  binaryAbsolute: string,
  binaryRelativeToRoot: string | undefined,
): string {
  // The shim's own candidates, from the same table `hookScript` renders -- minus `shim`, which is this
  // file. Its extra absolute fallback below is the one candidate the two do not share: the hook script
  // has no reason to name an absolute path on another machine, and this file exists to be reachable
  // from a project that is not this checkout.
  const candidates = [...candidateLines(['node-modules', 'relative'], binaryRelativeToRoot)];
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
      echo "${NEEDS_NODE_REFUSAL}" >&2
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
  return isScriptCurrent(path, expected) && isExecutableFile(path);
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
