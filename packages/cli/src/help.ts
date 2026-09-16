/**
 * The root help, with the two sections oclif does not give the root.
 *
 * `asc --help` printed VERSION, USAGE, TOPICS and COMMANDS and nothing else -- measured, `grep -c
 * '^FLAGS'` and `grep -c '^EXAMPLES'` were both 0 -- while every subcommand's help carries USAGE,
 * FLAGS, DESCRIPTION and EXAMPLES. So the one screen a new caller sees first was the screen that
 * did not say `--version` exists, did not say what a bare `asc` does, and did not show a single
 * runnable command. `cli-best-practices` rule 4 asks for usage, options and 2-3 runnable examples;
 * every subcommand met it and the root did not.
 *
 * **Only `formatRoot` is overridden.** It is oclif's own extension point: `formatRoot` is public on
 * `Help`, and `oclif.helpClass` (set in `package.json`) is the documented way to install a
 * replacement. This therefore APPENDS to oclif's root screen rather than reproducing it. The
 * alternative, overriding `showRootHelp`, would have meant copying that method's state handling and
 * its topic/command filtering into this repo, where an oclif upgrade could drift the copy out of
 * date with nothing left to notice -- the failure mode `base.ts`'s docblock already refuses for
 * `CommandError`, for the same reason.
 *
 * **The flag descriptions are read from `OUTPUT_FLAGS`, not written again here.** A second copy of
 * the same four sentences is a copy that can disagree with the flags it describes, and a help
 * screen that describes a flag differently from how the flag behaves is the defect `asc-3u2` item
 * (d) is about. Reading them means the help cannot drift.
 *
 * **Why `asc --csv` is documented here when `types brief` refuses it.** The FLAGS section is only
 * TRUE because of the routing in `bin.ts`: `asc` has no root command, so a bare invocation -- and a
 * bare invocation plus output flags -- is sent to `types brief`. `types brief` accepts `--json`,
 * `--table` and `--debug` and refuses `--csv`, because a brief has no columns to project. That is
 * said under the table rather than left for the caller to discover by hitting it.
 */

import { Help } from '@oclif/core';
import { OUTPUT_FLAGS } from './base.js';

/** The examples shown at the root, in the order a caller would try them. */
export const ROOT_EXAMPLES: readonly string[] = [
  '$ asc',
  '$ asc --json',
  '$ asc types brief --json',
  '$ asc --version',
];

export default class AscendHelp extends Help {
  /**
   * oclif's root screen, with FLAGS and EXAMPLES appended.
   *
   * Appended rather than inserted near the top: the root screen's job is to say what `asc` is and
   * what it can do, and putting the four output flags between USAGE and TOPICS would push the
   * command list -- the part a caller is actually looking for -- below a table of how to print.
   */
  public override formatRoot(): string {
    return [super.formatRoot(), this.outputFlags(), this.rootExamples()]
      .filter((section) => section !== '')
      .join('\n\n');
  }

  /**
   * The four output flags, described exactly as the flags describe themselves.
   *
   * `--${name}` rather than `flag.char`: none of the four declares a short form, and a short form
   * appearing in the table without one existing is the kind of false help this section exists to
   * remove. The set is asserted against `OUTPUT_FLAGS` in `help.test.ts`, so a fifth output flag
   * cannot be added without appearing here.
   */
  protected outputFlags(): string {
    const rows: [string, string | undefined][] = Object.entries(OUTPUT_FLAGS).map(
      ([name, flag]) => [`--${name}`, flag.description ?? ''],
    );

    const note =
      'A bare `asc` runs `types brief`, so these reach that command. `--csv` is refused there ' +
      'because a brief has no columns: use `asc types list --csv` for the registry as columns.';

    return `${this.section('FLAGS', rows)}\n\n${this.indent(this.wrap(note))}`;
  }

  protected rootExamples(): string {
    const rows = ROOT_EXAMPLES.map((line): [string, string | undefined] => [line, undefined]);
    return this.section('EXAMPLES', this.renderList(rows, { indentation: 2 }));
  }
}
