/**
 * The base every `asc` command extends.
 *
 * Three things live here, and they live here rather than in each command because they
 * are the parts that must not vary between commands:
 *
 *   1. **The output flags and the format decision.** `--json` / `--table` / `--csv` and
 *      the rule that they are mutually exclusive. A command that resolved these itself
 *      could resolve them differently, and then `asc query --csv` and `asc types list
 *      --csv` would be two formats with one name.
 *   2. **The error boundary.** `catch` maps anything thrown to a message on stderr and
 *      an exit code (`errors.ts`). Command bodies therefore throw instead of exiting,
 *      which is what keeps them callable from a test.
 *   3. **The store's lifetime.** `withProject` opens the store for the project
 *      containing the working directory and closes it in a `finally`. A command cannot
 *      leak a handle by forgetting, because the leak is not reachable from where the
 *      command is written.
 */

import { Command, Flags } from '@oclif/core';
import { describeFailure, usageError } from './errors.js';
import { render, type Output, type OutputFormat } from './output.js';
import {
  openProject,
  openQueryProject,
  type Project,
  type ProjectOptions,
  type QueryProject,
} from './project.js';

/**
 * What `Command.catch` is handed.
 *
 * Spelled out rather than imported: oclif declares this as `CommandError` in
 * `interfaces/errors`, but does not re-export it from the package root, and reaching into
 * `@oclif/core/lib/interfaces/...` would couple this file to oclif's internal layout.
 */
type CommandError = Error & { exitCode?: number };

/**
 * The flags on every command.
 *
 * `--json` deliberately does NOT use oclif's `enableJsonFlag`: that would install a
 * `--json` whose meaning is oclif's own, and the contract here (`output.ts`) is the
 * product's, versioned by `ascend_output`.
 */
export const OUTPUT_FLAGS = {
  json: Flags.boolean({
    description: 'Print a versioned JSON envelope on stdout. The stable contract for scripts.',
  }),
  table: Flags.boolean({ description: 'Print an aligned table (the default).' }),
  csv: Flags.boolean({ description: 'Print RFC 4180 CSV.' }),
  debug: Flags.boolean({
    description: 'Include stack traces and internal detail when something fails.',
  }),
};

export interface FormatFlags {
  readonly json: boolean;
  readonly table: boolean;
  readonly csv: boolean;
}

export abstract class BaseCommand extends Command {
  static override baseFlags = OUTPUT_FLAGS;

  /**
   * Which format was asked for, or the default.
   *
   * Refusing on two flags rather than silently preferring one: `--json --table` is a
   * caller who believes something that is not true, and quietly honouring one of them
   * teaches them the wrong rule. A usage error names both flags and exits 2.
   */
  protected resolveFormat(flags: FormatFlags): OutputFormat {
    const requested: OutputFormat[] = [];
    if (flags.json) requested.push('json');
    if (flags.table) requested.push('table');
    if (flags.csv) requested.push('csv');

    if (requested.length > 1) {
      throw usageError(
        `${requested.map((format) => `--${format}`).join(' and ')} cannot be combined. ` +
          `Pick one output format.`,
      );
    }

    return requested[0] ?? 'table';
  }

  /** Write a result to stdout in the requested format. */
  protected emit(format: OutputFormat, output: Output): void {
    const text = render(format, output);
    // An empty rendering is not a blank line: stdout carries data, and a stray newline
    // is data a consumer has to learn to ignore.
    if (text !== '') this.log(text);
  }

  /**
   * A boolean flag's value as it actually arrives.
   *
   * **Measured against this oclif, not assumed.** The parsed `flags` object carries a key only
   * when that flag was passed -- probed directly, `Object.keys(flags)` is `[]` for a command
   * given no `--dry-run` and `['dry-run']` when given one -- so an absent boolean flag is
   * `undefined`, while oclif's declared type for the parsed flags says `boolean`. That type is
   * why the widening below is not a redundant narrowing, and the difference is not academic:
   * `JSON.stringify` omits `undefined` properties, so a `--json` row built as
   * `{ dry_run: flags['dry-run'] }` drops the field outright and a consumer cannot tell "not a
   * dry run" from "this command does not report dry runs".
   *
   * Coerced at the boundary rather than at each read, so no command has to remember to, and no
   * reader has to work out which of the two `boolean`s in play is the true one.
   */
  protected flagValue(value: boolean | undefined): boolean {
    return value ?? false;
  }

  /**
   * An optional flag's value as it actually arrives.
   *
   * The same measured fact, in the other direction. oclif's parsed type says `--version` is a
   * `number`; at runtime it is `undefined` when the flag was not passed. Without this, the
   * branch that handles "no version given" is a comparison against `undefined` on a value the
   * compiler believes cannot be `undefined` -- a condition lint reports as dead while it is in
   * fact the whole branch, and which a later reader would be right to delete.
   */
  protected optionalFlag<T>(value: T | undefined): T | undefined {
    return value;
  }

  /**
   * Open the store for the project containing the working directory, run `body`, close it.
   *
   * Working directory rather than a flag: the store is per-project, and the project is
   * the one you are standing in. `project.ts` walks up from here.
   */
  protected async withProject<T>(
    body: (project: Project) => Promise<T> | T,
    options: ProjectOptions = {},
  ): Promise<T> {
    const project = openProject(process.cwd(), this.ascendVersion(), options);
    try {
      return await body(project);
    } finally {
      // `finally` rather than a happy-path close: a command that threw must not leave a
      // write lock behind for the next one, and the store is opened in WAL mode
      // precisely so concurrent callers serialise rather than fail.
      project.store.close();
    }
  }

  /**
   * The store for a read-only command, where there may be no project at all.
   *
   * Separate from `withProject` rather than an option on it, so that the commands which need a
   * project root keep receiving a plain `string`: a flag would make the "there is no project" case
   * reachable in every command, and reachable-but-impossible is how a `?? process.cwd()` gets
   * written somewhere it does not belong. Here the case is the point, and only `asc query` has it.
   *
   * The store's lifetime is still owned here, for the reason stated at the top of this file: a
   * command cannot leak a handle by forgetting, because the leak is not reachable from where the
   * command is written.
   */
  protected async withQueryProject<T>(body: (project: QueryProject) => Promise<T> | T): Promise<T> {
    const project = openQueryProject(process.cwd(), this.ascendVersion());
    try {
      return await body(project);
    } finally {
      project.store.close();
    }
  }

  /**
   * The version to stamp on everything this command writes.
   *
   * Throws rather than substituting a placeholder. `entries.ascend_version` records which
   * build produced a row, and `TASKS.md` #7 is explicit that an unavailable value is
   * omitted rather than filled in -- writing `'unknown'` there would be a
   * plausible-looking wrong answer in the one column a later analysis uses to tell one
   * ascend's rows from another's. An unset version is a broken package, and saying so is
   * the only honest option.
   *
   * `protected` rather than `private`: `init` is the first command other than the base class to
   * need it -- it opens a store WITHOUT a project, because creating the project is its job -- and
   * it had grown its own copy of this refusal. Two copies of a rule with one owner is how the
   * owner stops being one, so the copy is gone and every caller calls this.
   */
  protected ascendVersion(): string {
    const version = this.config.version;
    // Only the empty string can happen: oclif types `config.version` as `string`, so a
    // check for `undefined` would be unreachable, and an unreachable guard reads like a
    // handled case while handling nothing.
    if (version === '') {
      throw new Error(
        'ascend cannot determine its own version, so it cannot label what it writes. ' +
          'This is a problem with the asc installation rather than with your input.',
      );
    }
    return version;
  }

  /**
   * The current time, as the store wants it.
   *
   * This is where the clock is read, and the only place. Core and store are pure -- time is
   * injected (`TASKS.md` #6) -- so the boundary package is what turns "now" into a value
   * they can be handed. Kept as a method rather than a free function so a future command can
   * be driven in a test with a fixed clock instead of whatever day it runs on.
   */
  protected now(): string {
    return new Date().toISOString();
  }

  /**
   * Turn anything thrown into stderr plus an exit code.
   *
   * `--debug` is read from argv rather than from parsed flags on purpose: this runs when
   * parsing may itself have failed, which is exactly when a stack is most useful.
   *
   * Not `async`, because it never awaits: the body ends in `this.error`, which oclif types
   * as `never` (it throws a `CLIError` carrying the exit code for oclif's own top-level
   * handler to print and exit with). An `async` keyword here would exist only to satisfy
   * the declared return type, and a method that pretends to be asynchronous is a method a
   * caller might wrongly assume can be awaited for a result.
   */
  protected override catch(error: CommandError): Promise<void> {
    const failure = describeFailure(error, this.argv.includes('--debug'));
    this.error(failure.message, { exit: failure.exitCode });
  }
}
