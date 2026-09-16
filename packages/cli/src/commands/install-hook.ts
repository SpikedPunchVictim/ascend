/**
 * `asc install-hook` -- wire recall into this project's Claude Code settings.
 *
 * The problem this solves is the product's primary failure mode: an empty database. `asc init`
 * creates the store and the starter types, but nothing makes a *session* know they exist, so the
 * model records nothing because it never learned what to record. `ARCHITECTURE.md` calls the
 * resulting `SessionStart` hook "the primary recall mechanism" -- the digest lands in context every
 * session "with no dependence on the model remembering, and no `CLAUDE.md` instruction to decay".
 *
 * **The write is append-only, and that is the whole difficulty.** Measured, not assumed: this
 * repository's own `.claude/settings.json` already carries `bd prime --hook-json` on `SessionStart`,
 * because `bd init` registered it there. Hook entries merge across settings levels and every
 * matching hook runs, so ascend coexisting with beads is fine -- but ascend *rewriting the array*
 * would silently delete another tool's hook, and rewriting the *file* would delete the user's own
 * edits. So the existing array is read, a new matcher element is appended, and nothing that was
 * already there is touched.
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
 * **Two guards, and the second was not in the design until it was measured.** `ARCHITECTURE.md`
 * specifies the `[ ! -f ... ] ||` no-op pattern "so a missing binary is inert". That guard is
 * correct and incomplete: driven for real, `asc types brief` with a binary present and **no store**
 * exits 1 and writes `No .ascend/ store found...` to stderr. Since `.ascend/` is gitignored, that
 * is not a corner case -- it is what **every teammate sees on every session**, because they inherit
 * this tracked settings file and cannot inherit the store. So the command guards on the store as
 * well. Both clauses exit 0 and print nothing, which is what "inert" has to mean.
 *
 * **Consent is explicit, per the architecture's "never silently edits a user's settings file".**
 * `--dry-run` shows the exact command and writes nothing; `--yes` writes it; with neither, a
 * terminal is asked and a non-terminal is refused with the flag it is missing. That last branch is
 * `cli-best-practices` rule 3: a command that prompts into a pipe hangs CI rather than failing.
 *
 * **Idempotent**, and by a marker rather than by comparing generated text: any existing
 * `SessionStart` hook whose command mentions `types brief` counts as already installed, and the
 * report prints the command it found so a reader can see *which* one rather than being told "done".
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
 * How an already-installed hook is recognised.
 *
 * A substring of the command rather than the whole generated string, because the generated string
 * contains absolute paths that change when a checkout moves or ascend is reinstalled -- and a
 * detector that said "not installed" after either would append a SECOND copy, which is the failure
 * this check exists to prevent. Matching on the subcommand is stable across all of those.
 */
const INSTALLED_MARKER = 'types brief';

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
 * The command to install, guarded so that a missing binary or a missing store is a silent no-op.
 *
 * Three clauses, and the shape is the `[ ! -f ... ] ||` pattern the architecture names. `||` rather
 * than `&&` because of what each leaves behind when the guard fails: `[ ! -f X ]` succeeding
 * short-circuits the whole command to **exit 0 with no output**, which is a hook that did nothing.
 * A `&&` chain would exit 1 and log a failure every session in every project that has not run
 * `asc init`.
 *
 * The interpreter is `process.execPath` -- the node running this command -- rather than a bare
 * `node`. That is a measurement, not a preference: `@ascend/store` imports `node:sqlite`, which
 * needs Node 22.5+, so a bare `node` resolving to an older shell default would fail at runtime,
 * while the running interpreter is known to satisfy it. The cost, stated plainly: switching Node
 * versions after installing leaves the hook pinned to the old one, and it fails inert rather than
 * loudly. Re-running this command rewrites it.
 */
function installCommand(binary: string, interpreter: string, storeDir: string): string {
  return (
    `[ ! -f ${shellQuote(binary)} ] || ` +
    `[ ! -d ${shellQuote(storeDir)} ] || ` +
    `${shellQuote(interpreter)} ${shellQuote(binary)} types brief`
  );
}

/**
 * Every command string already registered on `SessionStart`, in file order.
 *
 * Deliberately permissive: this walks untyped JSON a user may have hand-written, so anything that
 * is not the shape it expects is skipped rather than thrown on. A malformed entry is the user's, and
 * it is not this command's to reject while it is only *reading*.
 */
function sessionStartCommands(settings: Record<string, unknown>): readonly string[] {
  const hooks = settings['hooks'];
  if (!isRecord(hooks)) return [];
  const sessionStart = hooks[HOOK_EVENT];
  if (!isArray(sessionStart)) return [];

  const commands: string[] = [];
  for (const matcher of sessionStart) {
    if (!isRecord(matcher)) continue;
    const entries = matcher['hooks'];
    if (!isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const command = entry['command'];
      if (typeof command === 'string') commands.push(command);
    }
  }
  return commands;
}

interface Merge {
  /** The settings object to write. Identical to the input when nothing was added. */
  readonly next: Record<string, unknown>;
  /** The command now registered by this command -- the one found, or the one generated. */
  readonly command: string;
  /** Whether `command` was already there, in which case nothing is written. */
  readonly alreadyInstalled: boolean;
}

/**
 * `settings` with the hook appended, or unchanged when it is already there.
 *
 * The appended element is a *new* matcher object rather than an extra command inside the existing
 * one. That is what makes "never overwrite" checkable at the level of the file: whatever was in the
 * array is still in the array, in the same order. Merging into an existing element would be equally
 * correct to the hook runner and would make the guarantee harder to see.
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
  const already = sessionStartCommands(settings).find((candidate) =>
    candidate.includes(INSTALLED_MARKER),
  );
  if (already !== undefined) return { next: settings, command: already, alreadyInstalled: true };

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

  const entry = { matcher: '', hooks: [{ type: 'command', command }] };
  const nextHooks = isRecord(hooks) ? { ...hooks } : {};
  nextHooks[HOOK_EVENT] = isArray(sessionStart) ? [...sessionStart, entry] : [entry];

  return { next: { ...settings, hooks: nextHooks }, command, alreadyInstalled: false };
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
    const merged = withHook(
      this.readSettings(target),
      installCommand(binary, process.execPath, join(root, STORE_DIR)),
      requested,
    );

    const outcome = merged.alreadyInstalled
      ? 'already installed'
      : dryRun
        ? 'would install'
        : 'installed';

    // Nothing is written unless it is both asked for and consented to. The order matters: a dry run
    // and an already-installed hook are both *reports*, and prompting for either would ask the user
    // to approve something that is not about to happen.
    if (!merged.alreadyInstalled && !dryRun) {
      await this.consent(yes, requested, merged.command);
      this.writeAtomically(target, `${JSON.stringify(merged.next, null, 2)}\n`);
    }

    // The command is a row field, so `--json` carries it -- but a table shows only
    // action/target/outcome, and a dry run whose whole purpose is "show me what you would write"
    // that answers only "would install" is a preview of nothing. Stated on stderr, where advice
    // belongs, rather than widening the table with a string three times its width.
    if (dryRun) {
      this.warn('dry run: nothing was written.');
      if (!merged.alreadyInstalled) {
        this.warn(`the hook that would be appended to ${requested} is:`);
        this.warn(`  ${merged.command}`);
      }
    }

    const rows: HookRow[] = [
      { action: 'hook', target: requested, outcome, command: merged.command, dry_run: dryRun },
    ];
    this.emit(format, { columns: ['action', 'target', 'outcome'], rows });

    if (!merged.alreadyInstalled) {
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
   * whose target can move. Resolving once, here, means the string in settings names the file itself.
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
   */
  private async consent(yes: boolean, target: string, command: string): Promise<void> {
    if (yes) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw usageError(
        `stdout is not a terminal, so ascend will not prompt for consent to edit ${target}. ` +
          `Pass --yes to install the hook, or --dry-run to see what would be written without ` +
          `writing it.`,
      );
    }

    this.warn(`ascend will append this hook to ${target}:`);
    this.warn(`  ${command}`);
    if (!(await this.ask('Install it? [y/N] '))) {
      throw refusal(
        `Not installed: consent was not given, so ${target} is unchanged. ` +
          `Run 'asc install-hook --dry-run' to review the command on its own.`,
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
   * either the old file or the new one.
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
