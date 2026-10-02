/**
 * `asc types brief` -- the digest a model is handed before it records anything.
 *
 * This is the command `asc-9y1` measures on a token budget, so its default output is the smallest
 * true thing: the recording command, then one line per active type, `name -- record_when`, and
 * nothing else. No rule, no counts. The types are what the reader needs; the rest is tokens.
 *
 * **The recording command is the one exception, and it is a reversal of this command's original
 * "no header" rule** (`asc-uftd`, `dogfood/0028`). That rule was argued on the same budget the
 * paragraph above states, and EV-16 measured the budget as real -- but measured against the text
 * the rule produced, the digest named every type and never the verb that writes one: `asc record`
 * occurred **0 times in the 3,382 bytes a session received** (3,381 as `asc doctor` counts it --
 * the same text without the trailing newline; one measurement, two objects, and F3 of
 * `.agents/research/2026-10-01-bug-hunt-e12-13.md` is what found them being quoted interchangeably),
 * while `asc ingest` occurred 6 and `asc query` 1, both as
 * prose inside derived types' descriptions. A session asked to record therefore had to go looking,
 * and the artifact it found, `.claude/ascend-hook.sh`, teaches a form an allow rule cannot match
 * (`ARCHITECTURE.md`'s allow-list note; measured in `spike/ev16-arms.mjs` arm F, four denials).
 * The header is one line, and it buys the removal of a discovery step; the budget still governs,
 * and this is the only line in the payload that is not a type. The comment on `RECORD_COMMAND_LINE` in
 * `brief-text.ts` carries the full argument.
 *
 * **Deprecated types are absent, and that is the point of asking for a brief.** A deprecated
 * type still holds entries and is still queryable (`asc types list` and `asc types show` report
 * it), but telling a recorder about one would invite new entries under a definition the project
 * has retired. A registry with no active type at all prints nothing rather than a bare command
 * line, and the doctor's size reads 0 for it (`briefText` owns that rule).
 *
 * **`--csv` is refused rather than rendered.** A digest has no columns to project: the two
 * columns it would have are the two fields of a sentence, and every row would repeat the
 * separator. Refusing says so; emitting a degenerate two-column CSV would be a shape a script
 * could parse and nothing else.
 *
 * **`--table` is accepted as the default's name.** The line format *is* this command's table --
 * it is not `output.ts`'s aligned grid, and `--json` is where the rows become a contract.
 *
 * **`--json` is deliberately asymmetric: the rows are types and the command line is not one of
 * them.** The default output is prose addressed to a model, and the header is part of it; the
 * envelope is a `rows` contract addressed to a script, and a synthetic row naming a command would
 * be a row that corresponds to no type. The precedent is `output.ts`'s "there is deliberately no
 * `command` field naming which command produced this ... a consumer knows which command it ran",
 * and the same holds here: a script that ran `asc types brief --json` to get the type list does not
 * need to be told how to record, because it is not a recorder. `columns` stays `['name',
 * 'record_when']` and `row_count` still counts types, so nothing about the envelope moves.
 *
 * **Above a measured ceiling the payload is capped, and the whole brief is written beside the
 * store.** A `SessionStart` hook's stdout is truncated to a ~2 KiB preview somewhere between 8,990
 * and 10,495 bytes (`asc-3q7`, located one session per point by `spike/ev16-brief-canary.mjs`), and
 * **nothing reports the loss**: the hook exits 0, this command prints everything, and the
 * transcript's own `hook_response` carries the full text even when the model received almost none
 * of it. When the brief does not fit under `BRIEF_CAP_BYTES`, the whole text -- header included --
 * is written to `.ascend/brief.txt` and stdout carries as many whole lines as fit plus a note saying
 * how many were dropped and where they went. That pointer is the arm `9bf45ed` measured delivering
 * a canary whole at 121,865 bytes, where stdout and the JSON envelope both truncated.
 *
 * **No flag turns this on, and that is a constraint rather than an oversight.** `install-hook.ts`
 * records that the hook's payload is this command's plain stdout and that there is to be **no new
 * flag on `types brief`**, so the cap is a property of the command rather than a mode a caller
 * selects. `--json` is exempt: a script asked for a contract, not for a payload that has to fit in
 * a session, and a truncated envelope would be a broken envelope.
 */

import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { listTypes } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import {
  BRIEF_CAP_BYTES,
  RECORD_COMMAND_LINE,
  briefLines,
  briefText,
  reviewAfterReached,
} from '../../brief-text.js';
import { usageError } from '../../errors.js';

/** The whole brief's path under the project root. Written only when the payload has to be capped. */
const BRIEF_FILE = '.ascend/brief.txt';

/**
 * The most whole lines that fit under `cap`, and the note that accounts for the rest.
 *
 * **Whole lines, never a byte slice.** Cutting mid-line would leave a `record_when` sentence that
 * reads complete, which is a claim about the registry the project did not make; and cutting
 * mid-character is `asc-bcv.23`'s defect, where `--table` severed a grapheme cluster and showed a
 * plausible-looking different character. Dropping from the end is also the only truncation whose
 * loss is one number, and it follows the order the registry already has.
 *
 * The note is regenerated per candidate because it names how many were dropped, so the fit is over
 * the text that will actually be emitted rather than over the lines alone -- the same reason
 * `budget.ts` measures its report as part of the output it reports on.
 *
 * `cap` is a **budget, not necessarily `BRIEF_CAP_BYTES`**: the caller may pass the constant less a
 * header this function never sees, so that what lands on stdout fits the cap as a whole. Whatever it
 * is given bounds the lines and the note; the caller owns everything else on the wire.
 */
function fitBrief(
  lines: readonly string[],
  note: (kept: number, total: number) => string,
  cap: number,
): { readonly text: string; readonly kept: number } {
  for (let kept = lines.length; kept >= 0; kept -= 1) {
    const text =
      kept === lines.length
        ? lines.join('\n')
        : [...lines.slice(0, kept), note(kept, lines.length)].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= cap) return { text, kept };
  }
  // Unreachable for any cap that fits the note on its own. Returning the note alone keeps the
  // failure bounded and named rather than unbounded and silent, which is the whole point.
  return { text: note(0, lines.length), kept: 0 };
}

export default class TypesBrief extends BaseCommand {
  static override description = 'List the active entry types, with when to record each one.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(TypesBrief);
    const format = this.resolveFormat(flags);

    if (format === 'csv') {
      throw usageError(
        '`asc types brief --csv` is not a format: a brief is one sentence per type, so a CSV ' +
          'of it would repeat the separator in every row. Use `--json` for a machine-readable ' +
          'brief, or `asc types list --csv` for the registry as columns.',
      );
    }

    await this.withProject(({ store, root }) => {
      const summaries = listTypes(store.db).filter((summary) => summary.status === 'active');

      if (format === 'json') {
        this.emit(format, {
          columns: ['name', 'record_when'],
          rows: summaries.map((summary) => ({
            name: summary.name,
            // Omitted, not `""`: `TASKS.md` #7. A consumer must be able to tell "this type
            // does not say when to record" from "this type says to record it on an empty
            // occasion".
            ...(summary.recordWhen === null ? {} : { record_when: summary.recordWhen }),
            version: summary.latestVersion,
            major: summary.major,
            property_count: summary.propertyCount,
            type_hash: summary.typeHash,
            // Omitted together when undeclared, for the same `TASKS.md` #7 reason as record_when.
            ...(summary.reviewAfter === null
              ? {}
              : {
                  review_after: summary.reviewAfter,
                  review_after_reached: reviewAfterReached(summary),
                }),
          })),
        });
        return;
      }

      if (summaries.length === 0) return;

      const lines = briefLines(summaries);
      const whole = briefText(summaries);

      // The pointer is named relative to the caller's working directory rather than to the project
      // root, because a store is found by walking UP from the cwd: run from a subdirectory, the
      // root is an ancestor and a root-relative name would point at nothing.
      const pointer = relative(process.cwd(), join(root, BRIEF_FILE));
      const note = (kept: number, total: number): string =>
        `[${String(kept)} of ${String(total)} types shown; the other ${String(total - kept)} are ` +
        `in ${pointer} -- read it before recording anything.]`;

      // The recording command is **not one of the lines `fitBrief` counts, and its bytes are still
      // charged to the cap**: the budget handed to the fitter is the cap less the header, so
      // `header + fit.text` is what has to fit. Keeping it out of the counted set is what makes the
      // note's `N of M types` mean types -- put the header in the list and a capped brief would
      // account for it as a dropped type, and the count a reader checks against `asc types list`
      // would be off by one. Taking the bytes off the top is what keeps `BRIEF_CAP_BYTES` a bound on
      // the payload rather than on part of it.
      const budget = BRIEF_CAP_BYTES - Buffer.byteLength(`${RECORD_COMMAND_LINE}\n`, 'utf8');

      const fit = fitBrief(lines, note, budget);
      if (fit.kept === lines.length) {
        // One write rather than one per line, so a brief read through a pipe arrives whole.
        this.log(whole);
        return;
      }

      // Over the cap, so the whole brief has to be somewhere the model can reach. Written BEFORE
      // the line that names it: a pointer emitted first and written second is a claim about a file
      // that a crash can leave missing, and the model would spend a turn discovering that. The file
      // gets the header too -- `whole`, not `fit.text` -- because it is the brief, and a reader
      // handed the capped stdout is told to go and read this one.
      try {
        writeFileSync(join(root, BRIEF_FILE), whole, 'utf8');
        this.log(`${RECORD_COMMAND_LINE}\n${fit.text}`);
      } catch (cause) {
        // Not swallowed. The payload still has to fit under the ceiling, so the fallback is the
        // same fit with a note that claims no file -- never a pointer to one that is not there.
        this.log(
          `${RECORD_COMMAND_LINE}\n${
            fitBrief(
              lines,
              (kept, total) =>
                `[${String(kept)} of ${String(total)} types shown; the other ` +
                `${String(total - kept)} are in this project's store -- \`asc types list\` names ` +
                `them.]`,
              budget,
            ).text
          }`,
        );
        this.warn(
          `could not write ${pointer} (${String(cause)}) -- the brief was capped and the ` +
            `omitted types were not written anywhere.`,
        );
      }
    });
  }
}
