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
import { describeFailure, renderForStderr, usageError, type StderrLabel } from './errors.js';
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
    this.emitText(render(format, output));
  }

  /**
   * Write text that has already been rendered.
   *
   * Split out for `--max-tokens`, and the reason is not code reuse. A fitted output is MEASURED as
   * text and then written; re-rendering it here would mean the bytes on stdout are produced by a
   * second call, so the budget claim would rest on the render being a pure function of its arguments
   * rather than on the measurement itself. `budget.ts` hands back the exact string it measured, and
   * this is the door it goes out through.
   */
  protected emitText(text: string): void {
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
   * Write a message to stderr.
   *
   * The counterpart of `emitText`, and it follows the same rule: a renderer produces the text and
   * this supplies the terminator. `process.stderr.write` rather than `console.error` because the
   * stream is what `streams.ts` made synchronous (`makeWritesSynchronous`), so the bytes are
   * complete before the `process.exit` that always ends an error reaches for them -- the same
   * property `8pp-truncation.test.ts` pins on stdout. `console.error` would route through
   * `format()` and `ux/write`, a second answer to "how is this text written" that ascend does not
   * control the lifetime of.
   *
   * There is no empty-rendering guard here, and that is a fact about the renderer rather than an
   * omission: `renderForStderr` always produces the label, so its output is never the empty string
   * and the guard would be a branch no input reaches.
   */
  protected emitStderr(label: StderrLabel, message: string): void {
    process.stderr.write(`${renderForStderr(label, message)}\n`);
  }

  /**
   * Turn anything thrown into stderr plus an exit code.
   *
   * `--debug` is read from argv rather than from parsed flags on purpose: this runs when
   * parsing may itself have failed, which is exactly when a stack is most useful.
   *
   * **ascend renders its own failures, and this replaced `this.error` (asc-98c).** `this.error`
   * hands the message to oclif, which wraps it with `wrapAnsi(..., { hard: true })` and marks each
   * continuation line with a `›` -- breaking mid-token, and in practice mid-path. The measurement,
   * the breaking rule that replaced it and the width are in `renderForStderr`, which is where the
   * decision belongs. What is stated here is why the exit still goes through oclif:
   *
   * `this.exit(code)` throws an `Errors.ExitError`, and oclif's top-level handler treats that class
   * as "already reported": it prints nothing for it and exits with the code it carries
   * (`errors/handle.js`: `shouldPrint` is false for an `ExitError`). So the text above is the only
   * thing on stderr, the exit code is unchanged, and the unwind is the ordinary one -- the command's
   * `finally`, oclif's `finally` hook and `Performance.collect` all still run. Exiting from here
   * with `process.exit` would have been one line shorter and would have skipped all three.
   *
   * Not `async`, because it never awaits: the body ends in `this.exit`, which oclif types as
   * `never`. An `async` keyword here would exist only to satisfy the declared return type, and a
   * method that pretends to be asynchronous is a method a caller might wrongly assume can be
   * awaited for a result.
   *
   * **One failure is still rendered by oclif, and it is stated rather than hidden:** a command
   * name that does not exist. `asc frobnicate` is answered by oclif's `main.js` before any command
   * is instantiated -- `config.findCommand` returns nothing and `runCommand` raises the error
   * itself -- so there is no `BaseCommand` on the stack to catch it, and it keeps the `›` and the
   * terminal-width wrap. Its message is a command name and never a path, so it cannot hit the
   * defect this method fixes; `install-hook.test.ts` and `help-cli.test.ts` cover the shapes it
   * can take. Catching it would mean replacing `execute()` with `run()` in `bin.ts` and
   * re-implementing what `handle` does with exit codes -- including the `ExitError` thrown three
   * lines below -- which is a larger change than this defect earns.
   */
  protected override catch(error: CommandError): Promise<void> {
    const failure = describeFailure(error, this.argv.includes('--debug'));
    this.emitStderr('Error', failure.message);
    this.exit(failure.exitCode);
  }

  /**
   * Write a warning to stderr.
   *
   * Overridden for the reason `catch` is: oclif's `warn` renders through the same `prettyPrint`,
   * so a warning was wrapped and gutter-marked exactly as an error was. Warnings are how the
   * `--dry-run` commands say that nothing was written, and how `asc query` says a plan was changed
   * -- sentences a reader is meant to read whole, not in `›`-marked fragments.
   *
   * Returns the input, matching oclif's declared signature. Nothing in ascend reads the return
   * value; it is returned because a caller written against oclif's type may chain on it, and
   * narrowing the signature would be this class making a promise about a method it did not define.
   */
  public override warn(input: Error | string): Error | string {
    this.emitStderr('Warning', input instanceof Error ? input.message : input);
    return input;
  }
}
