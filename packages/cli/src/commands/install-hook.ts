/**
 * `asc install-hook` -- wire recall into this project's Claude Code settings.
 *
 * The problem this solves is the product's primary failure mode: an empty database. `asc init`
 * creates the store and the starter types, but nothing makes a *session* know they exist, so the
 * model records nothing because it never learned what to record. `ARCHITECTURE.md` calls the
 * resulting `SessionStart` hook "the primary recall mechanism" -- the digest lands in context every
 * session "with no dependence on the model remembering, and no `CLAUDE.md` instruction to decay".
 *
 * **The settings write is append-only, and that is the whole difficulty.** Measured, not assumed:
 * this repository's own `.claude/settings.json` already carries `bd prime --hook-json` on
 * `SessionStart`, because `bd init` registered it there. Hook entries merge across settings levels
 * and every matching hook runs, so ascend coexisting with beads is fine -- but ascend *rewriting the
 * array* would silently delete another tool's hook, and rewriting the *file* would delete the
 * user's own edits. So the existing array is read, a new matcher element is appended, and nothing
 * that was already there is touched.
 *
 * **The settings command is now a single portable constant, and everything machine-specific moved
 * into a generated script** (asc-cjm, dogfood/0009). Before this change, the written command baked
 * in three absolute paths -- the running binary, the interpreter and the store directory -- which
 * is correct for the checkout that ran `install-hook` and wrong the moment it reaches a git remote:
 * dogfood/0009 measured 6 such paths across 2 machine-specific roots in this repository's OWN
 * attempted self-install, contradicting this command's own long-standing design note that project
 * settings are "the file a team shares... not... of one checkout" (see `SETTINGS_PATH` below).
 * `SETTINGS_COMMAND` now names nothing but `.claude/ascend-hook.sh`, a file `hookScript` writes and
 * regenerates, which resolves the project root and the ascend binary at the time the hook actually
 * RUNS rather than at install time. That file is committed too (`.gitignore`:49-51 marks `.claude/`
 * "deliberately TRACKED"), so a clone gets a working hook with no configuration.
 *
 * **stdout, not a JSON envelope.** Measured against the hooks reference: for `SessionStart`,
 * "Claude Code adds stdout it treats as plain text to Claude's context", and the reference's own
 * example is a bare `echo`. The `hookSpecificOutput.additionalContext` envelope beads uses is an
 * *alternative*, not a requirement -- and it carries a measured hazard: a `SessionStart` hook's
 * output is silently dropped when the JSON shape coexists with a raw-text hook on the same event
 * (anthropics/claude-code#53682). Plain stdout is the smaller surface, and it is what the
 * architecture specified by name (`asc types brief`). No new flag on `types brief`, and no second
 * output format to keep in sync.
 *
 * **`asc ingest claude-code` runs first, ahead of `types brief`, inside the generated script rather
 * than as a second hook entry** (asc-4dm.2, decision entry 79696d45; moved into the script by
 * asc-cjm without changing the guarantee). The hazard that decision addressed -- silently dropped
 * output when a second raw-text `SessionStart` hook coexists -- means there must remain exactly ONE
 * ascend hook, and that is still true: the settings command names one script, and the script itself
 * decides what runs. Ingest's output is discarded on both streams (`>/dev/null 2>&1`) -- `types
 * brief` stdout must stay the only payload `SessionStart` ever sees, and ingest also writes an
 * identity-vocabulary disclosure line to stderr (`ingest/claude-code.ts`'s
 * `reportIdentityVocabulary`) that must not leak into the session either. Ingest runs before the
 * brief, not after, so the brief reflects a corpus that is current as of this session start.
 *
 * **Two guards, both now inside the script rather than inline in the settings command.**
 * `ARCHITECTURE.md` specifies the `[ ! -f ... ] || ...` no-op pattern "so a missing binary is
 * inert" -- `hookScript` keeps that shape for its binary-resolution fallbacks, ending in a silent
 * `exit 0` when none resolves. The second guard is the one that was NOT in the design until it was
 * measured: driven for real, `asc types brief` with a binary present and **no store** exits 1 and
 * writes `No .ascend/ store found...` to stderr. Since `.ascend/` is gitignored, that is not a
 * corner case -- it is what **every teammate sees on every session**, because they inherit this
 * tracked settings file and the tracked script, and cannot inherit the store. So the script guards
 * on the store too, before it does anything else. Both guards exit 0 and print nothing, which is
 * what "inert" has to mean.
 *
 * **Consent is explicit, per the architecture's "never silently edits a user's settings file".**
 * `--dry-run` shows the exact command and the fact that a script would be written, then writes
 * nothing; `--yes` writes both; with neither, a terminal is asked and a non-terminal is refused
 * with the flag it is missing. That last branch is `cli-best-practices` rule 3: a command that
 * prompts into a pipe hangs CI rather than failing.
 *
 * **Idempotent, and now by THREE generations of command shape rather than two.** A command
 * mentioning `types brief` (generation 1, pre-asc-4dm.2), `ingest claude-code` alongside it
 * (generation 2), or naming `ascend-hook.sh` (generation 3, this change) is recognised as ascend's
 * own by `locateAscendHook`. Generation 3 is special: `SETTINGS_COMMAND` is now a fixed constant
 * with no per-project variation, so once a project is on generation 3 the settings TEXT can never
 * again distinguish a current script from a stale one -- the string stops changing between script
 * versions. So "already installed" requires BOTH that the command names the script AND that the
 * on-disk script content equals what `hookScript` would write today; when only the script has
 * drifted, this command rewrites the script and leaves the settings command untouched, reported
 * `upgraded` the same as a generation-1-or-2 replacement would be. The report prints the command it
 * found (or wrote) so a reader can see *which* one rather than being told "done".
 *
 * **Consent also discloses a file being CREATED, not merely a settings edit** (asc-cjm). Writing
 * `.claude/ascend-hook.sh` is a different act than editing `settings.json`: it puts a new, tracked
 * file into the repository that gets committed and shared the moment someone runs `git add`.
 * `consent()` says so before the y/N prompt, distinctly from the ingest disclosure beside it, which
 * is about what the hook DOES rather than what this command WRITES.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Flags } from '@oclif/core';
import { STORE_DIR } from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import { findProjectRoot } from '../project.js';
import { shellQuote, symlinkTarget } from '../symlink.js';

/** The hook event recall rides on. The only event whose stdout is injected on a session boundary. */
const HOOK_EVENT = 'SessionStart';

/**
 * The settings file this command edits.
 *
 * Project-level, NOT `settings.local.json` -- which is the architecture's explicit instruction, for
 * a reason that is about a different tool rather than about ascend: `settings.local.json` is
 * rewritten by an editor's own hook manager, so a hook installed there does not reliably survive.
 * Project settings are also the file a team shares, which is the point: recall is a property of the
 * project, not of one checkout.
 */
const SETTINGS_PATH = join('.claude', 'settings.json');

/**
 * Where the generated hook script lives, relative to the project root.
 *
 * Always `/`-separated, unlike `SETTINGS_PATH` above: this string is embedded in shell text -- both
 * in `SETTINGS_COMMAND` and inside the script `hookScript` writes -- and `/bin/sh` reads that text
 * on whatever OS is running the hook, regardless of which OS `install-hook` itself ran on.
 * `path.join`'s platform separator would be correct for a filesystem call and wrong here.
 */
const SCRIPT_RELATIVE_PATH = '.claude/ascend-hook.sh';

/**
 * The command written into `.claude/settings.json`.
 *
 * A CONSTANT now, not a function of the checkout (asc-cjm, dogfood/0009). The command this
 * replaced took the binary, the interpreter and the store directory and baked all three in as
 * absolute paths -- correct for the checkout that ran `install-hook`, and wrong the moment that
 * command reached a git remote: dogfood/0009 measured 6 such paths across 2 machine-specific roots
 * in this repository's own attempted install. Resolution now happens inside
 * `.claude/ascend-hook.sh` (see `hookScript`) at the time the hook actually RUNS, so the text that
 * lands in the shared, tracked settings file never depends on who installed it or where.
 *
 * `$CLAUDE_PROJECT_DIR` is Claude Code's own variable, not a shell expansion this command performs
 * -- it is set by the `SessionStart` runner itself (measured directly in dogfood/0009's portable-
 * form run) to the project root, which is exactly the piece of information that used to be
 * hard-coded here.
 *
 * `[ ! -f ... ] || sh "..."`, not `-x` and a direct exec: the executable bit does not reliably
 * survive every checkout (a fresh clone, a zip download, a `git archive`), and `sh` does not need
 * it -- it only needs the file to be present and readable, which `-f` already checked.
 */
const SETTINGS_COMMAND =
  `[ ! -f "$CLAUDE_PROJECT_DIR/${SCRIPT_RELATIVE_PATH}" ] || ` +
  `sh "$CLAUDE_PROJECT_DIR/${SCRIPT_RELATIVE_PATH}"`;

/**
 * How a pre-asc-cjm ascend hook (generation 1 or 2) is recognised: a substring of the OLD inline
 * command, naming the subcommand it ran rather than a path -- the one part of those two
 * generations that stayed stable while the absolute paths around it changed with every checkout.
 */
const INSTALLED_MARKER = 'types brief';

/**
 * How a generation-3 (this change's) ascend hook is recognised: `SETTINGS_COMMAND` names the
 * script by this substring, and it is the ONLY marker a generation-3 command carries -- it
 * mentions neither `types brief` nor `ingest claude-code`, both of which moved into the script
 * itself. Checked in ADDITION to `INSTALLED_MARKER` in `locateAscendHook`, never instead of it: a
 * settings file can still hold a generation-1 or generation-2 command, and that must keep being
 * recognised too, or a second copy gets appended beside it -- the exact failure these markers exist
 * to prevent.
 */
const SCRIPT_MARKER = 'ascend-hook.sh';

/** One row of the report: what was touched, and what happened to it. */
interface HookRow extends Record<string, unknown> {
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly command: string;
  readonly dry_run: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !isArray(value);

/**
 * `Array.isArray`, narrowed to `readonly unknown[]`.
 *
 * The built-in narrows `unknown` to `any[]`, so spreading its result is an unsafe spread that lint
 * rejects -- and rightly: the elements would be untyped, and this one is spread into a value written
 * to the user's settings file.
 */
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

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
function ownBinaryRelativePath(root: string, binary: string): string | undefined {
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
 * Falling through all four is `exit 0`, silently -- the same inert contract every guard in this
 * file already kept, extended to "no usable binary" as one more reason a session can find nothing
 * to run.
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
 */
function hookScript(binaryRelativeToRoot: string | undefined): string {
  const ownBinaryLines = ((): readonly string[] => {
    if (binaryRelativeToRoot === undefined) return [];
    // `shellQuote` rather than a bare template interpolation: this path is computed from real
    // directory names, which on macOS routinely contain spaces, and the total escaping `shellQuote`
    // documents is what lets it sit safely right after the unquoted `"$root"` it is concatenated
    // onto -- two adjacent quoted tokens with no space between them are ONE shell word.
    const quoted = shellQuote(`/${binaryRelativeToRoot}`);
    return [`elif [ -f "$root"${quoted} ]; then`, `  bin="$root"${quoted}`];
  })();

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
# edit here does not survive the next install or upgrade -- see install-hook.ts's \`hookScript\`.
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

${resolution}

case "$bin" in
  *.js)
    command -v node >/dev/null 2>&1 || exit 0
    node "$bin" ingest claude-code >/dev/null 2>&1
    node "$bin" types brief
    ;;
  *)
    "$bin" ingest claude-code >/dev/null 2>&1
    "$bin" types brief
    ;;
esac
`;
}

/**
 * Whether `path` already holds exactly `expected`.
 *
 * Byte equality, not mere existence -- `hookScript`'s output changes whenever the resolution logic
 * in this file changes, and a script an older ascend wrote must be recognised as stale even though
 * a file is sitting right there. That is the reason generation 3's currency check can no longer
 * live in the settings command alone; see the comment above `alreadyInstalled` in `run`.
 */
function isScriptCurrent(path: string, expected: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8') === expected;
  } catch {
    return false;
  }
}

/** Where, positionally, an existing command was found -- the matcher and the entry within it. */
interface LocatedHook {
  readonly matcherIndex: number;
  readonly entryIndex: number;
  readonly command: string;
}

/**
 * Ascend's own previously-written command within an existing `SessionStart` array, if there is
 * one -- found by `INSTALLED_MARKER` or `SCRIPT_MARKER`, either of which has always meant "this is
 * ascend's own".
 *
 * Positional, unlike the flat list this replaced, because upgrading a stale command means writing
 * back into the exact matcher and entry it came from rather than merely knowing its text existed.
 *
 * Deliberately permissive: this walks untyped JSON a user may have hand-written, so anything that
 * is not the shape it expects is skipped rather than thrown on. A malformed entry is the user's, and
 * it is not this command's to reject while it is only *reading*.
 */
function locateAscendHook(sessionStart: readonly unknown[]): LocatedHook | undefined {
  for (let matcherIndex = 0; matcherIndex < sessionStart.length; matcherIndex += 1) {
    const matcher = sessionStart[matcherIndex];
    if (!isRecord(matcher)) continue;
    const entries = matcher['hooks'];
    if (!isArray(entries)) continue;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      if (!isRecord(entry)) continue;
      const command = entry['command'];
      if (
        typeof command === 'string' &&
        (command.includes(INSTALLED_MARKER) || command.includes(SCRIPT_MARKER))
      ) {
        return { matcherIndex, entryIndex, command };
      }
    }
  }
  return undefined;
}

interface Merge {
  /** The settings object to write. Identical to the input when nothing changed. */
  readonly next: Record<string, unknown>;
  /** The command now registered by this command -- the one found, or the one written. */
  readonly command: string;
  /** Whether `command` was already exactly `SETTINGS_COMMAND`, in which case nothing is written. */
  readonly alreadyInstalled: boolean;
  /** Whether an existing ascend command was rewritten in place, rather than appended or found current. */
  readonly upgraded: boolean;
}

/**
 * `settings` with the hook appended, upgraded in place, or unchanged, per which of those three a
 * prior `SessionStart` array already reflects.
 *
 * **Appending** a new matcher element is what makes "never overwrite" checkable at the level of the
 * file: whatever was in the array is still in the array, in the same order. That guarantee is about
 * a DIFFERENT tool's hook -- ascend cannot know what such a command is for, so it never touches one.
 *
 * **Upgrading** is a different case wearing a similar shape, and deliberately handled differently:
 * a command found by `locateAscendHook` carries `INSTALLED_MARKER` or `SCRIPT_MARKER`, which have
 * only ever meant "ascend wrote this". Rewriting ascend's OWN prior output in place -- reported
 * `upgraded` -- is not the overwrite the guarantee above forbids; it is this command noticing its
 * own earlier work is stale and bringing it current, the same way a second `asc init` updates a
 * `.gitignore` block it wrote before. A command that carries NEITHER marker is never a candidate for
 * this branch at all, by construction of `locateAscendHook`, so someone else's hook can never be
 * mistaken for ascend's own.
 *
 * **Currency, since generation 3, is exact string equality against `command`** rather than a
 * marker check: `SETTINGS_COMMAND` no longer varies per project, so a located command that already
 * equals it IS current, full stop, and a located command that does not (every generation-1 and
 * generation-2 shape, by construction, since neither ever matched this literal string) is replaced.
 * This is strictly a claim about the SETTINGS TEXT -- whether the *script* generation-3 points at is
 * also current is a separate question `run` answers by reading the script off disk, because that
 * answer cannot be recovered from the settings string at all once it stops changing.
 *
 * `matcher: ''` matches every session source, which is what recall needs -- in particular `compact`,
 * because the model most in need of being reminded what to record is the one that just lost the
 * context explaining it.
 *
 * Refuses to guess when the key exists with the wrong JSON type. Appending to a `SessionStart` that
 * is an object, or replacing a `hooks` that is a string, would be this command deciding what the
 * user meant; the refusal names the key and the type actually found.
 */
function withHook(settings: Record<string, unknown>, command: string, target: string): Merge {
  const hooks = settings['hooks'];
  if (hooks !== undefined && !isRecord(hooks)) {
    throw refusal(
      `${target} has a "hooks" key that is ${isArray(hooks) ? 'an array' : typeof hooks} ` +
        `rather than an object, so ascend cannot tell where a hook entry belongs. ` +
        `Fix that key by hand, or install the hook somewhere else.`,
    );
  }

  const sessionStart = isRecord(hooks) ? hooks[HOOK_EVENT] : undefined;
  if (sessionStart !== undefined && !isArray(sessionStart)) {
    throw refusal(
      `${target} has "hooks.${HOOK_EVENT}" as ${typeof sessionStart} rather than an array. ` +
        `Claude Code expects an array of matchers there, and ascend will not replace it. ` +
        `Make it an array, or remove the key, and run this again.`,
    );
  }

  const located = isArray(sessionStart) ? locateAscendHook(sessionStart) : undefined;

  if (located !== undefined && isArray(sessionStart)) {
    if (located.command === command) {
      return { next: settings, command: located.command, alreadyInstalled: true, upgraded: false };
    }

    const nextSessionStart = sessionStart.map((matcher, matcherIndex) => {
      if (matcherIndex !== located.matcherIndex) return matcher;
      const record = matcher as Record<string, unknown>;
      const entries = record['hooks'] as readonly unknown[];
      const nextEntries = entries.map((entry, entryIndex) =>
        entryIndex === located.entryIndex
          ? { ...(entry as Record<string, unknown>), command }
          : entry,
      );
      return { ...record, hooks: nextEntries };
    });

    const nextHooks = { ...(hooks as Record<string, unknown>), [HOOK_EVENT]: nextSessionStart };
    return {
      next: { ...settings, hooks: nextHooks },
      command,
      alreadyInstalled: false,
      upgraded: true,
    };
  }

  const entry = { matcher: '', hooks: [{ type: 'command', command }] };
  const nextHooks = isRecord(hooks) ? { ...hooks } : {};
  nextHooks[HOOK_EVENT] = isArray(sessionStart) ? [...sessionStart, entry] : [entry];

  return {
    next: { ...settings, hooks: nextHooks },
    command,
    alreadyInstalled: false,
    upgraded: false,
  };
}

export default class InstallHook extends BaseCommand {
  static override description =
    'Add a SessionStart hook to this project’s .claude/settings.json, so every session ' +
    'starts knowing which entry types exist.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --yes',
    '<%= config.bin %> <%= command.id %> --yes --json',
  ];

  static override flags = {
    // Quoted and hyphenated, matching `init`: measured against this oclif, a camelCase key renders
    // verbatim as `--dryRun` and is not converted (`types/define.ts`).
    'dry-run': Flags.boolean({
      description: 'Print the exact hook that would be installed, then write nothing.',
    }),
    // Required in a non-interactive shell. Named rather than assumed so a script says what it means,
    // and so a misconfigured CI job is a usage error rather than a hang.
    yes: Flags.boolean({
      description: 'Install without asking. Required when stdout is not a terminal.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InstallHook);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const yes = this.flagValue(flags.yes);

    const startDir = resolve(process.cwd());
    const root = findProjectRoot(startDir);
    if (root === undefined) {
      throw refusal(
        `No ${STORE_DIR}/ store found in ${startDir} or any parent directory, so there is no ` +
          `project to install a hook for. Run 'asc init' first -- it creates the store and then ` +
          `tells you about this command.`,
      );
    }

    const binary = this.ownBinary();
    const requested = join(root, SETTINGS_PATH);
    const target = this.writablePath(requested);
    const merged = withHook(this.readSettings(target), SETTINGS_COMMAND, requested);

    const scriptPath = join(root, ...SCRIPT_RELATIVE_PATH.split('/'));
    const scriptContent = hookScript(ownBinaryRelativePath(root, binary));
    const scriptCurrent = isScriptCurrent(scriptPath, scriptContent);

    // "Already installed" needs BOTH facts, not just the settings command: `SETTINGS_COMMAND` is a
    // fixed constant with no per-project variation (`withHook`'s doc comment), so once a project is
    // on generation 3 that string can never again distinguish a current script from a stale one --
    // reading the script itself is the only way left to answer "is this current".
    const alreadyInstalled = merged.alreadyInstalled && scriptCurrent;
    const settingsNeedsWrite = !merged.alreadyInstalled;
    const scriptNeedsWrite = !scriptCurrent;
    // "Fresh" means `locateAscendHook` found nothing at all -- neither a stale command nor a current
    // one. Whenever that is NOT the case and the combined result is still not current, this is an
    // upgrade rather than a first install, whether it is the settings command, the script, or both
    // that changed.
    const freshInstall = !merged.alreadyInstalled && !merged.upgraded;
    const upgraded = !alreadyInstalled && !freshInstall;

    const outcome = alreadyInstalled
      ? 'already installed'
      : upgraded
        ? dryRun
          ? 'would upgrade'
          : 'upgraded'
        : dryRun
          ? 'would install'
          : 'installed';

    // Nothing is written unless it is both asked for and consented to. The order matters: a dry run
    // and an already-installed hook are both *reports*, and prompting for either would ask the user
    // to approve something that is not about to happen.
    if (!alreadyInstalled && !dryRun) {
      await this.consent(yes, requested, scriptPath, merged.command, settingsNeedsWrite, upgraded);
      if (settingsNeedsWrite) {
        this.writeAtomically(target, `${JSON.stringify(merged.next, null, 2)}\n`);
      }
      if (scriptNeedsWrite) {
        this.writeAtomically(scriptPath, scriptContent);
      }
    }

    // The command is a row field, so `--json` carries it -- but a table shows only
    // action/target/outcome, and a dry run whose whole purpose is "show me what you would write"
    // that answers only "would install" is a preview of nothing. Stated on stderr, where advice
    // belongs, rather than widening the table with a string three times its width.
    if (dryRun) {
      this.warn('dry run: nothing was written.');
      if (!alreadyInstalled) {
        if (settingsNeedsWrite) {
          this.warn(
            upgraded
              ? `the hook that would replace ascend's existing one in ${requested} is:`
              : `the hook that would be appended to ${requested} is:`,
          );
          this.warn(`  ${merged.command}`);
        } else {
          this.warn(`${requested} already names ${scriptPath}; only that script would change.`);
        }
        this.warn(
          `the script at ${scriptPath} would be (re)written -- it resolves the ascend binary ` +
            `when it runs, so nothing in it depends on this machine.`,
        );
      }
    }

    const rows: HookRow[] = [
      { action: 'hook', target: requested, outcome, command: merged.command, dry_run: dryRun },
    ];
    this.emit(format, { columns: ['action', 'target', 'outcome'], rows });

    if (!alreadyInstalled) {
      this.warn(
        `the hook is inert until ${STORE_DIR}/ exists in ${root}, and ${STORE_DIR}/ is gitignored ` +
          `-- so a teammate who clones this repository gets the hook and no store, and sees ` +
          `nothing rather than an error. That is intended, not a bug.`,
      );
    }
  }

  /**
   * The absolute path of the `asc` that is running right now.
   *
   * `process.argv[1]` is the script Node was handed, which for every supported invocation is the
   * compiled `dist/bin.js` -- the bin field, a global install's symlink, or an explicit
   * `node .../bin.js` alike. `realpathSync` resolves the symlinked cases, because a global install
   * puts a link in the bin directory and writing *that* path would leave the hook pointing at a link
   * whose target can move. Resolving once, here, means the string this command has to work with
   * names the file itself.
   *
   * No longer written into `settings.json` directly (asc-cjm): the only remaining use of this value
   * is `ownBinaryRelativePath`, which turns it into a path relative to the project root for
   * `hookScript`'s branch 3 -- and only when it resolves to somewhere INSIDE that root.
   *
   * Refuses rather than falling back to the bare name `asc`: the README is explicit that nothing
   * links `asc` onto a PATH, so a hook written as `asc types brief` would be inert in exactly the
   * way that looks like it works.
   */
  private ownBinary(): string {
    const script = process.argv[1];
    if (script === undefined || script === '') {
      throw refusal(
        'ascend cannot tell where its own executable is (no script path in argv), so a hook ' +
          `written now would point at nothing. Run the installed 'asc' binary rather than ` +
          `importing the CLI into another program.`,
      );
    }
    const resolved = realpathSync(script);
    if (!existsSync(resolved)) {
      throw refusal(
        `ascend resolved its own executable to ${resolved}, which does not exist, so a hook ` +
          `written now would be inert. Reinstall ascend, or run it from a built checkout.`,
      );
    }
    return resolved;
  }

  /**
   * The path a write must actually land on.
   *
   * A `settings.json` that is a symlink is followed rather than replaced, and a link to nothing is
   * refused -- both for the reason `symlink.ts` states. A dangling link is the case that needs the
   * refusal: `existsSync` follows links, so it reports "no file here" and the create branch would
   * replace the link with a regular file, silently breaking whatever else pointed at it. Refusing
   * costs the user one manual step, and the message names it.
   */
  private writablePath(requested: string): string {
    const link = symlinkTarget(requested);
    if (link === null) {
      throw refusal(
        `${requested} is a symlink to a file that does not exist, so writing through it is not ` +
          `possible and replacing it would break whatever points at it. Point it at a file, or ` +
          `remove it, and run this again.`,
      );
    }
    return link ?? requested;
  }

  /**
   * The settings file as an object, or an empty one when there is none.
   *
   * Invalid JSON is refused rather than repaired or overwritten. A settings file that does not parse
   * is one this command cannot merge into without discarding whatever the user meant -- and silently
   * replacing it would destroy, in one command, the file the architecture says ascend must never
   * edit without consent, when the consent it obtained was for a *merge*.
   *
   * `JSON.parse` is isolated in its own `try` rather than sharing one with the shape checks below:
   * `refusal` returns a plain `Error`, so a shared block would catch this command's own refusals and
   * re-report them as parse failures, naming the wrong problem.
   */
  private readSettings(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw refusal(
        `${path} exists but could not be read (${
          error instanceof Error ? error.message : String(error)
        }), so ascend cannot merge into it without risking the rest of it. ` +
          `Make it readable, or install the hook by hand.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw refusal(
        `${path} is not valid JSON (${
          error instanceof Error ? error.message : String(error)
        }), so ascend cannot merge into it without discarding whatever it holds. ` +
          `Fix the file by hand, then run this again.`,
      );
    }

    if (!isRecord(parsed)) {
      throw refusal(
        `${path} holds ${isArray(parsed) ? 'an array' : typeof parsed} rather than a JSON ` +
          `object, so there is no place to add a hook without discarding what is there. ` +
          `Fix the file by hand, then run this again.`,
      );
    }
    return parsed;
  }

  /**
   * Ask before writing, and refuse rather than hang when there is nobody to ask.
   *
   * The prompt goes to stderr, because stdout carries the report and a prompt interleaved into it
   * would corrupt the one stream a script reads. The interactive branch requires BOTH stdin and
   * stdout to be terminals -- `cli-best-practices` rule 3, and the reason is a real one: a command
   * that prompts into a pipe does not fail, it waits, and a CI job that hangs is worse than one that
   * exits 2 naming the flag it wanted.
   *
   * **Discloses the behaviour, not just the file edit** (asc-4dm.2). The script this hook runs reads
   * `~/.claude/projects` and writes what it derives into this project's store on every session start
   * -- it does not merely print a digest. That is said plainly, before the command text and before
   * the y/N prompt, rather than left for the reader to notice inside the command itself.
   *
   * **Also discloses a file being CREATED inside the repository** (asc-cjm), as distinct from the
   * `settings.json` EDIT above it: `.claude/ascend-hook.sh` is new, tracked configuration, not a
   * change to a file that already existed. `settingsNeedsWrite` decides whether the settings-command
   * text also needs a line of its own -- it does not, when only the script is stale.
   */
  private async consent(
    yes: boolean,
    target: string,
    scriptPath: string,
    command: string,
    settingsNeedsWrite: boolean,
    upgraded: boolean,
  ): Promise<void> {
    if (yes) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw usageError(
        `stdout is not a terminal, so ascend will not prompt for consent to edit ${target}. ` +
          `Pass --yes to install the hook, or --dry-run to see what would be written without ` +
          `writing it.`,
      );
    }

    this.warn(
      `this hook reads this machine's Claude Code transcripts (~/.claude/projects) and writes ` +
        `what it derives from them into this project's ${STORE_DIR}/ store on every session ` +
        `start, before printing the entry-type brief it already printed.`,
    );
    this.warn(
      `ascend will also ${existsSync(scriptPath) ? 'rewrite' : 'create'} ${scriptPath} -- unlike ` +
        `${target}, which this command only edits, this file does not exist yet the first time ` +
        `this runs. It is tracked, not local state (per .gitignore's own comment on .claude/), so ` +
        `it is committed and shared with whoever else has this checkout, same as settings.json.`,
    );
    if (settingsNeedsWrite) {
      this.warn(
        upgraded
          ? `ascend will replace its existing hook in ${target} with:`
          : `ascend will append this hook to ${target}:`,
      );
      this.warn(`  ${command}`);
    } else {
      this.warn(`${target} already names ${scriptPath}; that script is the only thing changing.`);
    }
    if (!(await this.ask('Install it? [y/N] '))) {
      throw refusal(
        `Not installed: consent was not given, so neither ${target} nor ${scriptPath} was ` +
          `changed. Run 'asc install-hook --dry-run' to review the command on its own.`,
      );
    }
  }

  /** One yes/no question, on stderr. Anything that is not `y`/`yes` is not consent. */
  private async ask(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(question)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  }

  /**
   * Write through a temp file and a rename, per `cli-best-practices` rule 7.
   *
   * The stakes are higher here than for `.gitignore`: a crash mid-write leaves a truncated
   * `settings.json`, and Claude Code reading invalid JSON at startup loses every hook the user had,
   * including ones ascend never touched. Rename is atomic within a filesystem, so a reader sees
   * either the old file or the new one. The same call also writes `.claude/ascend-hook.sh`: the
   * guarantee is identical either way, and a script left half-written by a crash would be exactly as
   * bad as a truncated settings file, just quieter about it.
   *
   * The parent directory is created first, because `.claude/` need not exist -- and only on the
   * write path, so a dry run creates nothing at all.
   */
  private writeAtomically(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.ascend-tmp`;
    writeFileSync(temporary, contents, 'utf8');
    renameSync(temporary, path);
  }
}
