/**
 * `asc kappa --scheme <a> --scheme <b>` -- how reproducible a classification is.
 *
 * `ARCHITECTURE.md`: kappa measures agreement "between two schemes, or two runs of one scheme. A
 * direct measurement of whether a classification is reproducible or the model is guessing." Both
 * spellings are one question -- two raters over the same entries -- so both are this command:
 *
 * ```bash
 * asc kappa --scheme first --scheme second               # two schemes, latest pass of each
 * asc kappa --scheme review --pass <t1> --pass <t2>      # two runs of one scheme
 * ```
 *
 * **One pass per rater, and the default is the latest.** A scheme accumulates a pass per run, and
 * `recordAnnotations` refuses two labels for one entry *within* a pass -- but two passes over one
 * entry are ordinary, so reading every annotation a scheme has would hand `cohenKappa` a rater who
 * labelled the same entry twice and it would refuse. The pass is therefore chosen, not summed: the
 * latest by default, which is the run in force, and `--pass` to name one.
 *
 * **Two raters are always named; there is no shorthand for one.** `--scheme review` alone is a
 * single rater, and comparing it with itself would report a kappa of 1 for every scheme that
 * classified anything -- a perfect number that measured nothing. So the flag combinations are
 * enumerated and the one-rater form is a usage error rather than a fallback: two schemes, or one
 * scheme with two `--pass`.
 *
 * **An absent pass is named as absent rather than reported as agreement.** When the two raters share
 * no labelled entry there is no kappa -- not a kappa of zero, which would say they never agreed. The
 * measure keys are omitted from the row and the reason is on stderr; `null` is kept for the one case
 * that is genuinely a computed null (both raters used the same single label, so observed and
 * expected are both 1 and kappa is 0/0). Those are the two absences `agreement.ts` distinguishes,
 * and this command does not merge them.
 *
 * **No interval is reported**, following `agreement.ts`: kappa is a ratio of ratios, so Wilson's
 * variance does not apply to it, and an interval from the wrong variance is a wrong answer shaped
 * like a right one.
 *
 * **There is no `--across`.** Annotations live in the store of the project you are standing in;
 * `asc query --across` reads other projects' CORPUS files, and a scheme in one project is not a
 * rater for another's entries.
 */

import { Flags } from '@oclif/core';
import { cohenKappa, type Agreement, type Labelled } from '@ascend/analysis';
import {
  annotationPasses,
  annotationRows,
  listSchemes,
  type AnnotationRow,
  type SchemeSummary,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';

/** One rater: which scheme, which pass, and the labels it produced. */
interface Rater {
  readonly scheme: string;
  /** The pass timestamp, or `null` when the scheme has no annotations at all. */
  readonly pass: string | null;
  readonly labels: readonly Labelled[];
}

/** The registered schemes, for the message that names what exists. */
function registeredNames(schemes: readonly SchemeSummary[]): string {
  return schemes.map((scheme) => `'${scheme.name}'`).join(', ') || '(none)';
}

/** A pass's rows as one rater's labels. `entryId`, not `id`: an annotation's own id pairs nothing. */
function labelsOf(rows: readonly AnnotationRow[]): readonly Labelled[] {
  return rows.map((row) => ({ id: row.entryId, label: row.label }));
}

export default class Kappa extends BaseCommand {
  static override description =
    "Measure agreement between two schemes, or two passes of one scheme, with Cohen's kappa.";

  static override examples = [
    '<%= config.bin %> <%= command.id %> --scheme first --scheme second',
    '<%= config.bin %> <%= command.id %> --scheme review --pass 2026-09-17T10:00:00.000Z --pass 2026-09-17T11:00:00.000Z',
  ];

  static override flags = {
    scheme: Flags.string({
      multiple: true,
      description: 'A scheme to read. Two of them, or one with two --pass.',
    }),
    pass: Flags.string({
      multiple: true,
      description:
        "A pass timestamp to read. Two of them, with a single --scheme. Default is each scheme's " +
        'latest pass.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Kappa);
    const format = this.resolveFormat(flags);

    // Measured: an absent `multiple` flag arrives as `undefined`, not `[]`. See `annotate.ts`.
    // `--scheme` is therefore NOT `required: true` -- oclif checking for it would report a missing
    // flag, and what a caller who omitted it needs told is the shape of the command, which the
    // checks below say in full.
    const schemes = flags.scheme ?? [];
    const passes = flags.pass ?? [];

    const [firstScheme, secondScheme] = schemes;

    if (firstScheme === undefined) {
      throw usageError(
        'no --scheme given, and kappa is between two raters: pass two schemes ' +
          '(`--scheme a --scheme b`), or one scheme with two --pass ' +
          '(`--scheme a --pass <t1> --pass <t2>`).',
      );
    }
    if (schemes.length > 2) {
      throw usageError(
        `--scheme was given ${String(schemes.length)} times, and kappa is between two raters. ` +
          `Pass exactly two schemes, or one scheme with two --pass.`,
      );
    }
    if (passes.length > 0 && passes.length !== 2) {
      throw usageError(
        `--pass was given ${String(passes.length)} time(s), and comparing one pass with nothing is ` +
          `not a measurement. Pass exactly two, or none to use each rater's latest pass.`,
      );
    }
    if (passes.length === 2 && schemes.length !== 1) {
      throw usageError(
        `--pass names two passes of ONE scheme, and this run gave ${String(schemes.length)} ` +
          `schemes. To compare two schemes, drop --pass; they are read at their latest pass.`,
      );
    }
    if (passes.length === 0 && schemes.length === 1) {
      throw usageError(
        `--scheme was given once and --pass not at all, which names one rater. A scheme compared ` +
          `with itself agrees perfectly and measures nothing. Pass a second --scheme, or two ` +
          `--pass to compare two runs of '${firstScheme}'.`,
      );
    }

    await this.withProject(({ store }) => {
      const registered = listSchemes(store.db);

      /** One rater, resolved by name and optionally by pass, or a refusal naming what does exist. */
      const resolve = (name: string, pass: string | undefined, which: string): Rater => {
        if (!registered.some((entry) => entry.name === name)) {
          throw refusal(
            `there is no annotation scheme named '${name}', which is ${which}. Registered schemes: ` +
              `${registeredNames(registered)}. Create one with \`asc annotate --scheme ${name}\`.`,
          );
        }

        if (pass === undefined) {
          const list = annotationPasses(store.db, name);
          const latest = list[list.length - 1];
          if (latest === undefined) {
            this.warn(
              `scheme '${name}' has no annotations, so it contributed no labels and nothing could ` +
                `be paired with it. Annotate it with \`asc annotate --scheme ${name}\`.`,
            );
            return { scheme: name, pass: null, labels: [] };
          }
          return {
            scheme: name,
            pass: latest.createdAt,
            labels: labelsOf(annotationRows(store.db, { scheme: name, pass: latest.createdAt })),
          };
        }

        // `annotationRows` resolves the VERSION from the pass, so a pass written under an older
        // version -- the ordinary result of editing a rule and running again -- is readable without
        // the caller knowing which version wrote it. An empty result therefore means the timestamp
        // matches nothing anywhere, which is a caller mistake and is named as one.
        const rows = annotationRows(store.db, { scheme: name, pass });
        if (rows.length === 0) {
          const known = annotationPasses(store.db, name)
            .map((entry) => entry.createdAt)
            .join(', ');
          throw refusal(
            `scheme '${name}' has no pass at ${pass}, so there is nothing to read for ${which}. ` +
              `Its passes: ${known || '(none)'}. A pass is identified by its timestamp, which is ` +
              `the 'pass' field \`asc annotate\` reports.`,
          );
        }
        return { scheme: name, pass, labels: labelsOf(rows) };
      };

      // Both raters are named by the checks above: two schemes, or one scheme with two passes. The
      // fallback is not a shorthand for one rater -- that combination is refused -- but the
      // two-pass form, where both raters read the same scheme at different timestamps.
      const first = resolve(firstScheme, passes[0], 'the first rater');
      const second = resolve(secondScheme ?? firstScheme, passes[1], 'the second rater');

      const agreement = cohenKappa(first.labels, second.labels);
      this.warnOnAbsence(agreement, first, second);

      this.emit(format, {
        columns: [
          'scheme_a',
          'pass_a',
          'scheme_b',
          'pass_b',
          'compared',
          'only_a',
          'only_b',
          'observed',
          'expected',
          'kappa',
          'small_group',
        ],
        rows: [
          {
            scheme_a: first.scheme,
            pass_a: first.pass,
            scheme_b: second.scheme,
            pass_b: second.pass,
            compared: agreement.compared,
            only_a: agreement.onlyA,
            only_b: agreement.onlyB,
            // Omitted, not zero, when nothing could be compared: `TASKS.md` #7, and the difference is
            // the whole point -- an `observed` of 0 would say the two raters disagreed about
            // everything. `marginals` is carried but kept out of `columns`, the way `properties` is
            // in `entryRow`: it is the evidence behind the numbers, not a terminal column.
            ...(agreement.measure === null
              ? {}
              : {
                  observed: agreement.measure.observed,
                  expected: agreement.measure.expected,
                  kappa: agreement.measure.kappa,
                  small_group: agreement.measure.smallGroup,
                }),
            marginals: agreement.marginals,
          },
        ],
      });
    });
  }

  /**
   * Why there is no measure, on stderr, when there is none.
   *
   * The row carries the counts either way, so a caller parsing `--json` can always see what was
   * paired; what only a sentence can say is which of the two absences this is, and that neither is a
   * zero. A measurement that silently disappears from an output is one a reader fills in.
   */
  private warnOnAbsence(agreement: Agreement, first: Rater, second: Rater): void {
    if (agreement.measure === null) {
      this.warn(
        `nothing to measure: ${String(agreement.compared)} entries were labelled by both raters ` +
          `(${String(agreement.onlyA)} only by '${first.scheme}', ${String(agreement.onlyB)} only ` +
          `by '${second.scheme}'). That is not zero agreement -- agreement cannot be computed over ` +
          `an empty comparison, and reporting 0 would claim the two disagreed about everything.`,
      );
      return;
    }

    if (agreement.measure.kappa === null) {
      // Denominator 0 is the only way kappa comes back null, and it means the marginals are
      // degenerate in the strongest way: both raters used one label and it is the same one, so
      // observed is 1 too and kappa is 0/0. Ordinary for a rule that matches everything, scored
      // against a scheme that labelled everything the same way.
      this.warn(
        `kappa is undefined here, not perfect: over the ${String(agreement.compared)} compared ` +
          `entries the two raters used a single label between them, so observed and expected ` +
          `agreement are both 1 and kappa is 0/0. The classification is reproducible because ` +
          `nothing in the compared entries varied, which is not the same as agreeing about them.`,
      );
    }
  }
}
