/**
 * `asc install-skill` -- copy the analysis skill and its slash command into this project's
 * `.claude/`, so a Claude Code session standing in this project can use them.
 *
 * `ARCHITECTURE.md` ("Skill + slash command") ships a skill teaching the analysis method --
 * profile, sample, cluster, propose rule, back-test, annotate -- plus a thin `/ascend-analyze
 * <type...>` command. Writing the method down does nothing for a session that never sees it:
 * `.claude/skills/` and `.claude/commands/` are per-PROJECT directories, and the method lives
 * inside the `@ascend/cli` package. This command is the bridge between the two.
 *
 * **The sources are resolved from `import.meta.url`, not from a path relative to the repo
 * root, and that is a packaging decision rather than a style preference.** `ARCHITECTURE.md`
 * records why: the skill lives inside `packages/cli/`, not at the repository root, because
 * `packages/cli/package.json`'s `files` array is `["dist", "oclif.manifest.json", "skill"]` --
 * only paths inside the package are published. A repo-root `skill/` directory would exist in
 * this checkout and be absent from every install, and this command would refuse on the one
 * machine where it matters: someone's actual `asc install-skill` after `npm install -g`.
 * Resolving from `import.meta.url` means the answer is always "next to the file that is
 * running", which is true in this monorepo (`packages/cli/dist/commands/install-skill.js`,
 * two directories below `packages/cli/`) and true of a published tarball alike.
 *
 * **Consent is explicit, per the same architecture note `install-hook.ts` cites: ascend never
 * silently edits a user's files.** `--dry-run` reports exactly which files would be written,
 * with their destination paths and sizes, and writes nothing; `--yes` writes; with neither, a
 * terminal is asked and a non-terminal is refused naming the flag it needed -- `cli-best-
 * practices` rule 3, and the reason is concrete: a command that prompts into a pipe does not
 * fail, it hangs, and a CI job that hangs is worse than one that exits 2.
 *
 * **Never clobber a user's edits.** Unlike `install-hook.ts`'s settings.json, there is no
 * shared array to append to here -- these are whole files, and a destination that already
 * exists is either the same file (nothing to do) or a different one (someone's own version, or
 * an older release's). Byte-for-byte identity is the test, not a version number or a hash
 * ascend would have to keep somewhere: it needs no state of its own and it is exact. A
 * differing destination is refused, naming the file and the fix (`--force`), rather than
 * silently replaced -- exactly the guarantee `install-hook.ts` gives its settings file, applied
 * to a whole file instead of one array element.
 *
 * **Idempotent**, for the same reason: running this command twice with nothing changed in
 * between compares each destination's bytes to the source, finds them equal, and reports
 * "already installed" without touching the filesystem.
 *
 * **Atomic writes**, per `cli-best-practices` rule 7 and identical in shape to
 * `install-hook.ts`'s: write to a temp file beside the destination, then `renameSync` into
 * place. A crash mid-write leaves either the old file or nothing at that path, never a
 * half-written one -- and `mkdirSync(..., { recursive: true })` first, since a fresh project
 * has neither `.claude/skills/` nor `.claude/commands/` yet.
 *
 * **A missing source is a refusal, not a crash.** `planFile` (below) is exported specifically
 * so this can be measured directly: given a spec whose `source` does not exist, it throws the
 * same `refusal` every other guard in this file throws, naming the path and stating that the
 * installed package is incomplete -- never a raw `ENOENT` propagating out of `readFileSync`.
 * `ARCHITECTURE.md` names the scenario this defends: a build that dropped `skill/` from
 * `files` would make every source path resolve to nothing, and the failure has to be legible
 * rather than a stack trace pointing at this module's own internals.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Flags } from '@oclif/core';
import { STORE_DIR } from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import { findProjectRoot } from '../project.js';

/**
 * Where the skill and the command markdown ship inside this package.
 *
 * `'../../skill/...'` from `dist/commands/install-skill.js`: one `..` cancels `commands`, the
 * second cancels `dist`, landing on the package root, exactly as the module comment above
 * explains. Computed once, at module load, like `install-hook.ts`'s `SETTINGS_PATH` -- these
 * never change for the lifetime of a process, and there is nothing to gain by re-deriving them
 * per invocation.
 */
const SKILL_SOURCE = fileURLToPath(
  new URL('../../skill/ascend-analysis/SKILL.md', import.meta.url),
);
const COMMAND_SOURCE = fileURLToPath(
  new URL('../../skill/commands/ascend-analyze.md', import.meta.url),
);

/** One file this command can install: where it ships from, and where it lands. */
export interface FileSpec {
  /** What this file is, for the report's `action` column and for messages naming it. */
  readonly label: string;
  /** Absolute path to the file as it ships inside this package. */
  readonly source: string;
  /** Where it lands, relative to the project root. */
  readonly destRel: string;
}

/** The two files `asc install-skill` installs, in the order they are reported. */
const FILES: readonly FileSpec[] = [
  {
    label: 'skill',
    source: SKILL_SOURCE,
    destRel: join('.claude', 'skills', 'ascend-analysis', 'SKILL.md'),
  },
  {
    label: 'command',
    source: COMMAND_SOURCE,
    destRel: join('.claude', 'commands', 'ascend-analyze.md'),
  },
];

/** What happened, or would happen, to one file. */
type FileOutcome =
  'installed' | 'already installed' | 'replaced' | 'would install' | 'would replace';

/** The decision for one file: what is there, what ascend would write, and whether it will. */
export interface FilePlan {
  readonly spec: FileSpec;
  /** The absolute destination path: `root` joined with `spec.destRel`. */
  readonly destination: string;
  /** The bytes ascend would write -- read once here so `run` and `--dry-run` see the same file. */
  readonly sourceBytes: Buffer;
  readonly outcome: FileOutcome;
  /** Whether this file needs a write. `false` only for 'already installed'. */
  readonly willWrite: boolean;
}

/**
 * Decide what to do about one file, without writing anything.
 *
 * Exported so the refusal paths can be measured directly, in particular the one a subprocess
 * test cannot reach without either mutating this repository's own `packages/cli/skill/` (which
 * a concurrently-running writer of that same content makes unsafe) or standing up a second,
 * disposable copy of the whole compiled package just to make one file disappear from it. A
 * fabricated `FileSpec` pointed at a path under a throwaway temp directory reaches the same
 * code with neither cost.
 *
 * Refuses -- never overwrites -- when the destination exists with DIFFERENT bytes and `force`
 * is not set. Byte equality is the whole test: there is no version stamp or hash kept anywhere
 * ascend would have to trust instead, and reading both files once each is cheap enough that
 * there is no reason to.
 */
export function planFile(spec: FileSpec, root: string, force: boolean, dryRun: boolean): FilePlan {
  if (!existsSync(spec.source)) {
    throw refusal(
      `${spec.source} does not exist, so ascend cannot install the ${spec.label} -- this ` +
        `installation of ascend is incomplete. Reinstall ascend, or run it from a build that ` +
        `includes packages/cli/skill/.`,
    );
  }

  let sourceBytes: Buffer;
  try {
    sourceBytes = readFileSync(spec.source);
  } catch (error) {
    throw refusal(
      `${spec.source} exists but could not be read (${
        error instanceof Error ? error.message : String(error)
      }), so ascend cannot install the ${spec.label}. Make it readable and run this again.`,
    );
  }

  const destination = join(root, spec.destRel);
  if (!existsSync(destination)) {
    return {
      spec,
      destination,
      sourceBytes,
      outcome: dryRun ? 'would install' : 'installed',
      willWrite: true,
    };
  }

  let existingBytes: Buffer;
  try {
    existingBytes = readFileSync(destination);
  } catch (error) {
    throw refusal(
      `${destination} exists but could not be read (${
        error instanceof Error ? error.message : String(error)
      }), so ascend cannot tell whether it already matches the ${spec.label} ascend would ` +
        `install. Make it readable and run this again.`,
    );
  }

  if (existingBytes.equals(sourceBytes)) {
    return { spec, destination, sourceBytes, outcome: 'already installed', willWrite: false };
  }

  if (!force) {
    throw refusal(
      `${destination} already exists and its bytes differ from the ${spec.label} ascend would ` +
        `install, so ascend will not overwrite it and risk losing your edits. Pass --force to ` +
        `replace it, or remove the file yourself and run this again.`,
    );
  }

  return {
    spec,
    destination,
    sourceBytes,
    outcome: dryRun ? 'would replace' : 'replaced',
    willWrite: true,
  };
}

/** One row of the report: what was touched, and what happened to it. */
interface SkillRow extends Record<string, unknown> {
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly bytes: number;
  readonly dry_run: boolean;
}

export default class InstallSkill extends BaseCommand {
  static override description =
    'Copy the ascend-analysis skill and its /ascend-analyze command into this project’s ' +
    '.claude/, so a Claude Code session here can use them.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --yes',
    '<%= config.bin %> <%= command.id %> --yes --force',
  ];

  static override flags = {
    // Quoted and hyphenated, matching `install-hook`: measured against this oclif, a camelCase
    // key renders verbatim as `--dryRun` and is not converted (`types/define.ts`).
    'dry-run': Flags.boolean({
      description: 'Report exactly which files would be written, with sizes, then write nothing.',
    }),
    // Required in a non-interactive shell. Named rather than assumed so a script says what it
    // means, and so a misconfigured CI job is a usage error rather than a hang.
    yes: Flags.boolean({
      description: 'Install without asking. Required when stdout is not a terminal.',
    }),
    force: Flags.boolean({
      description:
        'Replace a destination file whose bytes differ from the one ascend would install.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InstallSkill);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const yes = this.flagValue(flags.yes);
    const force = this.flagValue(flags.force);

    const startDir = resolve(process.cwd());
    const root = findProjectRoot(startDir);
    if (root === undefined) {
      throw refusal(
        `No ${STORE_DIR}/ store found in ${startDir} or any parent directory, so there is no ` +
          `project to install the skill into. Run 'asc init' first.`,
      );
    }

    // Computed for every file before anything is written, and before consent is asked: a
    // conflict on the SECOND file must not leave the first one written. Refusing here, rather
    // than after writing some of them, keeps "refuses without --force" an all-or-nothing
    // guarantee across the whole command, not just within one file.
    const plans = FILES.map((spec) => planFile(spec, root, force, dryRun));
    const toWrite = plans.filter((plan) => plan.willWrite);

    // Nothing is written unless it is both asked for and consented to, matching
    // `install-hook.ts`: a dry run and an all-already-installed run are both reports, and
    // prompting for either would ask approval for something that is not about to happen.
    if (toWrite.length > 0 && !dryRun) {
      await this.consent(yes, toWrite);
      for (const plan of toWrite) this.writeAtomically(plan.destination, plan.sourceBytes);
    }

    if (dryRun) {
      this.warn('dry run: nothing was written.');
      for (const plan of toWrite) {
        this.warn(`would write ${plan.destination} (${String(plan.sourceBytes.length)} bytes)`);
      }
    }

    const rows: SkillRow[] = plans.map((plan) => ({
      action: plan.spec.label,
      target: plan.destination,
      outcome: plan.outcome,
      bytes: plan.sourceBytes.length,
      dry_run: dryRun,
    }));
    this.emit(format, { columns: ['action', 'target', 'outcome'], rows });
  }

  /**
   * Ask before writing, and refuse rather than hang when there is nobody to ask.
   *
   * The prompt goes to stderr, because stdout carries the report and a prompt interleaved into
   * it would corrupt the one stream a script reads. The interactive branch requires BOTH stdin
   * and stdout to be terminals -- `cli-best-practices` rule 3, matching `install-hook.ts`'s
   * `consent` exactly, for the same reason: a command that prompts into a pipe does not fail,
   * it waits, and a CI job that hangs is worse than one that exits 2 naming the flag it wanted.
   */
  private async consent(yes: boolean, plans: readonly FilePlan[]): Promise<void> {
    if (yes) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw usageError(
        `stdout is not a terminal, so ascend will not prompt for consent to write ` +
          `${plans.map((plan) => plan.destination).join(', ')}. Pass --yes to install, or ` +
          `--dry-run to see what would be written without writing it.`,
      );
    }

    this.warn('ascend will write:');
    for (const plan of plans) {
      this.warn(`  ${plan.destination} (${String(plan.sourceBytes.length)} bytes)`);
    }
    if (!(await this.ask('Install? [y/N] '))) {
      throw refusal(
        `Not installed: consent was not given, so nothing was written. Run ` +
          `'asc install-skill --dry-run' to review what would be written.`,
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
   * Write through a temp file and a rename, per `cli-best-practices` rule 7, identical in shape
   * to `install-hook.ts`'s `writeAtomically`. A crash between the write and the rename leaves
   * either the old destination or nothing at that path, never a half-written skill file that
   * Claude Code would read as truncated markdown.
   *
   * The parent directory is created first, because a fresh project has neither
   * `.claude/skills/ascend-analysis/` nor `.claude/commands/` yet -- and only on the write
   * path, so a dry run creates nothing at all.
   */
  private writeAtomically(path: string, contents: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.ascend-tmp`;
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  }
}
