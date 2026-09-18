/**
 * `asc stats <type> --<mode>` -- the analysis layer, reachable.
 *
 * `asc-5k0`. Seven primitives shipped into `@ascend/analysis` across E7 and none of them had a way
 * to be run. This is that way, and it is one command with seven exclusive modes rather than seven
 * commands, because they all answer the same shape of question about one type's entries and share
 * one definition of what an entry's text and values ARE (`stats-text.ts`).
 *
 * ```bash
 * asc stats tool_denial --assoc                        # rank property pairs by association
 * asc stats tool_denial --correlate a --correlate b    # one pair, with the table under it
 * asc stats tool_denial --rules                        # association rules (FP-growth)
 * asc stats tool_denial --changepoints                 # breaks in the entry rate over time
 * asc stats decision --distinctive --by reversibility  # terms that mark one group out
 * asc stats decision --cluster --threshold 0.9         # lexical clusters over prose
 * asc stats decision --duplicates                      # near-duplicate collapse
 * ```
 *
 * **SEVEN MODES, WHERE THE BEAD NAMED FIVE.** `asc-5k0` asks for
 * `--cluster|--assoc|--correlate|--changepoints|--distinctive`, and lists `rules.ts` (asc-p4g) and
 * `neardup.ts` (asc-yce) among its dependencies. Both are finished modules with tests and neither
 * appears in that flag list, so shipping the five would have left two of this epic's primitives
 * with no way to run them -- which is the exact condition this bead exists to end. `--rules` and
 * `--duplicates` are therefore additions, stated here rather than quietly included.
 *
 * **THE MODES ARE NOT COMPOSABLE AND THE COMMAND REFUSES COMBINATIONS RATHER THAN RESOLVING THEM**,
 * exactly as `explore.ts` refuses its own. Two modes produce two different tables with two different
 * column sets over two different populations, and a caller handed one of them after asking for both
 * is reading an answer to a question they did not ask, with nothing in the output saying so.
 *
 * **A TEXT MODE ON A TYPE WITH NO PROSE IS A REFUSAL THAT NAMES THE COVERAGE, not an empty table.**
 * `docs/evidence/EV-20.md` measured that 1,698 of 1,785 entries in this store (94.6%) carry no prose
 * at all, by design -- the derived types have no text property. An empty table there reads as "no
 * duplicates found", which is a claim about the corpus; what is true is that the instrument could
 * not see it. The refusal says which properties were read and how many entries had anything in them.
 *
 * **NOTHING HERE PRINTS AN ENTRY'S PROSE.** `--cluster` and `--duplicates` report ids, counts,
 * scores and cluster LABELS built from term weights, and `explore.ts`'s reasoning applies unchanged:
 * a profile of a corpus full of prose must not put that prose into a caller's context. A caller who
 * wants to read the representative reads it with `asc query`.
 *
 * **THE TWO EMPIRICAL DEFAULTS COME FROM MEASUREMENTS, AND THE MEASUREMENTS ARE CITED IN THE HELP
 * TEXT.** `--duplicates`' threshold defaults to 0.9 from EV-20 (0.8 measured a false-merge rate of
 * 0.000930, 0.9 measured 0.000000); `--linkage` defaults to `average` from EV-21 (judged coherence
 * 9 of 10 clusters with 89.7% of entries covered, against complete linkage's 9 of 10 at 70.1%).
 * `--cluster` ships NO default threshold, for the reason EV-21 gives: the silhouette curve is flat
 * across 0.82-0.92 (0.081972, 0.084086, 0.079134, 0.078669, 0.084922), so a constant would be a
 * number picked off a flat curve and printed as a finding. The flag is required, and the usage error
 * says why.
 *
 * **EVERY MODE REPORTS WHETHER ITS N IS ENOUGH RATHER THAN DECIDING FOR THE CALLER.** `MIN_N` is 20
 * (`packages/analysis/src/proportion.ts`) and each primitive already carries an `underpowered` flag;
 * this command surfaces it as a `small_group` column. A refusal would hide the one thing a small
 * corpus can still say -- what it looks like -- and a silent report would let it be quoted as an
 * estimate.
 *
 * **`--changepoints` SCANS ONE SERIES BY DEFAULT -- the entry rate -- and one per value of a
 * property when `--by` is given.** Both go through `rankChangepoints`, so the p-values are
 * Benjamini-Hochberg corrected across whatever family the caller asked for. Scanning ten series and
 * reporting the best p without correcting is how a corpus with no break in it produces one.
 *
 * **`--at` NAMES THE CLOCK, AND THE DEFAULT IS WRONG FOR MOST OF THIS STORE.** `recorded_at` is
 * when `asc` wrote the row, which for a derived type is when `asc ingest claude-code` ran: measured
 * here, 1,702 of 1,797 entries (94.7%) share the single instant `2026-09-17T22:37:40.736Z`, and
 * every one of those five types carries its real clock in an `occurred_at` property
 * (`dogfood/0006`). The default is still `recorded_at`, because the alternative -- picking the
 * type's lone `timestamp` property automatically -- would make the time axis a function of the
 * schema, so two types would be scanned on two different clocks with nothing in the output saying
 * which. Instead the axis is always named in the output, and a scan that collapses to too few
 * periods names the `timestamp` properties the type does declare.
 */

import { Args, Flags } from '@oclif/core';
import type { TypeSpec } from '@ascend/core';
import {
  associationRules,
  cell,
  chiSquare,
  cluster,
  collapseNearDuplicates,
  crosstab,
  distinctiveTerms,
  MIN_N,
  mutualInformation,
  rankAssociations,
  rankChangepoints,
  type Linkage,
  type NamedSeries,
  type SeriesPoint,
} from '@ascend/analysis';
import { entryIds, findEntry, findType, type RecordedEntry } from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import type { OutputFormat } from '../output.js';
import {
  categoricalItems,
  categoricalProperties,
  RECORDED_AT,
  textCorpus,
  timeColumn,
  timestampProperties,
  valueColumn,
  type TextCoverage,
} from '../stats-text.js';

/** The modes, in the order the help lists them. One per run. */
const MODES = [
  'assoc',
  'correlate',
  'rules',
  'changepoints',
  'distinctive',
  'cluster',
  'duplicates',
] as const;

type Mode = (typeof MODES)[number];

/** A day, as `YYYY-MM-DD`, from an ISO timestamp. */
function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** The Monday of a timestamp's week, as `YYYY-MM-DD`. */
function weekOf(timestamp: string): string {
  const date = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
  // `getUTCDay` is 0 for Sunday; the shift makes Monday 0, so a week runs Monday to Sunday rather
  // than splitting the working week that produced most of these entries across two buckets.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/**
 * Counts per period, as a DENSE series: a period with no entries is a measured 0, not a gap.
 *
 * The filling is the load-bearing part. A quiet fortnight is exactly the kind of break this mode
 * exists to find, and left as absent labels it would be invisible -- the series would read as
 * consecutive busy periods and Pettitt would scan a timeline that never happened. A zero here is a
 * count that was taken and came out zero, which is not `TASKS.md` #7's forbidden fill-in for an
 * unknown: the store was read, and nothing was recorded in that period.
 */
function rateSeries(labels: readonly string[], stepDays: number): SeriesPoint[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);

  const ordered = [...counts.keys()].sort();
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return [];

  const points: SeriesPoint[] = [];
  const cursor = new Date(`${first}T00:00:00.000Z`);
  const end = Date.parse(`${last}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const label = cursor.toISOString().slice(0, 10);
    points.push({ label, value: counts.get(label) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
  }
  return points;
}

export default class Stats extends BaseCommand {
  static override description =
    'Run one analysis over a type: association, rules, changepoints, distinctive terms, ' +
    'lexical clustering, or near-duplicate collapse.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> tool_denial --assoc',
    '<%= config.bin %> <%= command.id %> tool_denial --correlate tool_name --correlate denial_kind',
    '<%= config.bin %> <%= command.id %> tool_denial --rules',
    '<%= config.bin %> <%= command.id %> tool_denial --changepoints --period week',
    '<%= config.bin %> <%= command.id %> decision --distinctive --by reversibility',
    '<%= config.bin %> <%= command.id %> decision --cluster --threshold 0.9',
    '<%= config.bin %> <%= command.id %> decision --duplicates',
  ];

  static override args = {
    // `ignoreStdin`: the arg names a type, and oclif fills a MISSING positional from stdin unless
    // the arg refuses it -- so `cat entries.json | asc stats --assoc` would be read as a request to
    // analyse a type called `[{"properties"...`. `args.test.ts` is the check that every arg in this
    // CLI declares it; `record.ts` carries the long form.
    type: Args.string({
      description: 'The entry type to analyse.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    assoc: Flags.boolean({
      description: 'Rank every pair of categorical properties by association strength.',
    }),
    correlate: Flags.string({
      multiple: true,
      description: 'Two property names: report that one pair in full, with its table.',
    }),
    rules: Flags.boolean({
      description: 'Mine association rules over categorical property values (FP-growth).',
    }),
    changepoints: Flags.boolean({
      description: 'Scan the entry rate over time for a break. With --by, one series per value.',
    }),
    distinctive: Flags.boolean({
      description: 'Terms that mark one group of entries out from the rest. Needs --by.',
    }),
    cluster: Flags.boolean({
      description: 'Cluster entries lexically over their prose. Needs --threshold.',
    }),
    duplicates: Flags.boolean({
      description: 'Collapse near-duplicate entries into one representative and a count.',
    }),

    by: Flags.string({
      description:
        'The property to group by (--distinctive) or to split into one series per value ' +
        '(--changepoints).',
    }),
    threshold: Flags.string({
      description:
        'Similarity cut. --duplicates: exact Jaccard, default 0.9 (EV-20 measured a false-merge ' +
        'rate of 0.000930 at 0.8 and 0.000000 at 0.9). --cluster: cosine DISTANCE, required, ' +
        'because EV-21 measured the silhouette curve flat across 0.82-0.92 and a default would be ' +
        'a number picked off a flat curve.',
    }),
    linkage: Flags.string({
      options: ['average', 'complete', 'single'],
      description:
        'How --cluster joins clusters. Default average: EV-21 judged 9 of its 10 largest clusters ' +
        'coherent with 89.7% of entries covered, against complete linkage at 70.1%.',
    }),
    method: Flags.string({
      options: ['pettitt', 'cusum'],
      description:
        'Which changepoint test. Default pettitt (rank-based). cusum is magnitude-based with a ' +
        'seeded bootstrap; they fail differently, and two agreeing is a stronger claim than either.',
    }),
    at: Flags.string({
      description:
        'Which clock --changepoints reads. Default recorded_at, which for an INGESTED type is ' +
        'when the ingest ran, not when anything happened -- those types declare occurred_at.',
    }),
    period: Flags.string({
      options: ['day', 'week'],
      description: 'Period for --changepoints. Default day.',
    }),
    'min-support': Flags.string({
      description: `Minimum itemset support for --rules. Default MIN_N (${String(MIN_N)}).`,
    }),
    limit: Flags.string({ description: 'Rows to print. Default 20.' }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Stats);
    const format = this.resolveFormat(flags);

    const chosen = MODES.filter((mode) =>
      // `flagValue` rather than a bare read: oclif types an absent boolean flag as `boolean` and
      // hands back `undefined` for it (`base.ts`), so the coercion is the one that happens
      // everywhere else in this CLI rather than a narrowing this command invented.
      mode === 'correlate' ? (flags.correlate ?? []).length > 0 : this.flagValue(flags[mode]),
    );

    if (chosen.length === 0) {
      throw usageError(
        `no mode given, and \`asc stats\` runs exactly one. Pass one of ` +
          `${MODES.map((mode) => `--${mode}`).join(', ')}.`,
      );
    }
    if (chosen.length > 1) {
      // Refused rather than resolved, for `explore.ts`'s reason: two modes are two tables over two
      // populations, and a caller handed one of them is reading an answer to a question they did
      // not ask, with nothing in the output saying which of the two it answered.
      throw usageError(
        `${chosen.map((mode) => `--${mode}`).join(' and ')} were given together, and they are not ` +
          `composable: each produces a different table over a different population. Run them ` +
          `separately.`,
      );
    }

    const mode = chosen[0] as Mode;
    const limit = this.positiveInteger(flags.limit, 'limit') ?? 20;

    await this.withProject(({ store }) => {
      const version = findType(store.db, args.type);
      if (version === undefined) {
        throw refusal(
          `there is no entry type named '${args.type}'. List what is registered with ` +
            `\`asc types list\`.`,
        );
      }

      const entries = entryIds(store.db, args.type)
        .map((id) => findEntry(store.db, id))
        .filter((entry): entry is RecordedEntry => entry !== undefined);

      if (entries.length === 0) {
        throw refusal(
          `'${version.name}' has no entries, so there is nothing to analyse. Record one with ` +
            `\`asc record ${version.name}\`.`,
        );
      }

      switch (mode) {
        case 'assoc':
          this.runAssoc(format, version.spec, entries, limit);
          return;
        case 'correlate':
          this.runCorrelate(format, version.spec, entries, flags.correlate ?? []);
          return;
        case 'rules':
          this.runRules(format, version.spec, entries, flags['min-support'], limit);
          return;
        case 'changepoints':
          this.runChangepoints(format, version.spec, entries, flags, limit);
          return;
        case 'distinctive':
          this.runDistinctive(format, version.spec, entries, flags.by, limit);
          return;
        case 'cluster':
          this.runCluster(format, version.spec, entries, flags, limit);
          return;
        case 'duplicates':
          this.runDuplicates(format, version.spec, entries, flags.threshold, limit);
          return;
      }
    });
  }

  /** A positive integer flag, or a usage error naming what arrived instead. */
  private positiveInteger(raw: string | undefined, name: string): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1)
      throw usageError(`--${name} must be a positive integer, and '${raw}' is not.`);
    return value;
  }

  /** A similarity or distance flag in [0,1], or a usage error. */
  private unitNumber(raw: string | undefined, name: string): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw usageError(`--${name} must be a number between 0 and 1, and '${raw}' is not.`);
    return value;
  }

  /**
   * The type's categorical properties, or a refusal naming why there are not enough of them.
   *
   * Numbers, timestamps, durations, refs and JSON are not comparable this way and their exclusion
   * is not a convenience: a crosstab of a timestamp against anything has one row per entry and a
   * Cramer's V of 1, which is a definition restated as a finding.
   */
  private categoricalOrRefuse(spec: TypeSpec, needed: number): readonly string[] {
    const names = categoricalProperties(spec);
    if (names.length < needed) {
      throw refusal(
        `'${spec.name}' declares ${String(names.length)} categorical ` +
          `propert${names.length === 1 ? 'y' : 'ies'} (${names.join(', ') || 'none'}), and this ` +
          `needs ${String(needed)}. Only \`string\` and \`enum\` properties are compared: a ` +
          `crosstab of a timestamp against anything has one row per entry and reports a ` +
          `definition as a finding.`,
      );
    }
    return names;
  }

  /** One named property, checked to be categorical, or a refusal listing what is. */
  private categoricalName(spec: TypeSpec, name: string, flag: string): string {
    const known = categoricalProperties(spec);
    if (!known.includes(name)) {
      throw refusal(
        `'${name}' is not a \`string\` or \`enum\` property of '${spec.name}', so ${flag} cannot ` +
          `group by it. Groupable properties: ${known.join(', ') || '(none)'}.`,
      );
    }
    return name;
  }

  private runAssoc(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    limit: number,
  ): void {
    const names = this.categoricalOrRefuse(spec, 2);
    const report = rankAssociations(
      names.map((name) => ({ name, values: valueColumn(entries, name) })),
    );

    this.warn(
      `${String(report.pairs.length)} pair(s) of ${String(names.length)} properties over ` +
        `${String(report.items)} entries. q-values are corrected across a family of ` +
        `${String(report.family)}, which is every pair in THIS run -- asking about ten properties ` +
        `and asking twice about five are different questions with different q-values.`,
    );

    this.emit(format, {
      columns: [
        'a',
        'b',
        'n',
        'excluded',
        'cramers_v',
        'chi2',
        'df',
        'p',
        'p_adjusted',
        'mutual_information_bits',
        'uncertainty',
        'asymptotic_valid',
        'small_group',
      ],
      rows: report.pairs.slice(0, limit).map((pair) => ({
        a: pair.a,
        b: pair.b,
        n: pair.n,
        excluded: pair.excluded,
        cramers_v: pair.cramersVCorrected,
        chi2: pair.chi2,
        df: pair.df,
        p: pair.p,
        p_adjusted: pair.pAdjusted,
        mutual_information_bits: pair.mutualInformation,
        uncertainty: pair.uncertainty,
        // Carried because `p` is only trustworthy where this is true, and a reader who sorts on
        // `p_adjusted` without it is ranking approximations that did not apply.
        asymptotic_valid: pair.asymptoticValid,
        small_group: pair.underpowered,
      })),
    });
  }

  private runCorrelate(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    pair: readonly string[],
  ): void {
    if (pair.length !== 2) {
      throw usageError(
        `--correlate names ONE pair and was given ${String(pair.length)} value(s). Pass it twice: ` +
          `\`--correlate <a> --correlate <b>\`. To rank every pair at once, use --assoc.`,
      );
    }
    const a = this.categoricalName(spec, pair[0] as string, '--correlate');
    const b = this.categoricalName(spec, pair[1] as string, '--correlate');
    if (a === b) {
      throw usageError(
        `--correlate was given '${a}' twice. A property crosstabbed against itself is diagonal by ` +
          `construction and reports a Cramer's V of 1 that measured nothing.`,
      );
    }

    // Rows missing either value are dropped, matching `rankAssociations`' default. The two modes
    // must agree about the population or `--correlate` would be a different measurement of the pair
    // `--assoc` just ranked, under the same two names.
    const left = valueColumn(entries, a);
    const right = valueColumn(entries, b);
    const x: string[] = [];
    const y: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const first = left[index] ?? null;
      const second = right[index] ?? null;
      if (first === null || second === null) continue;
      x.push(first);
      y.push(second);
    }

    if (x.length === 0) {
      throw refusal(
        `no entry of '${spec.name}' has a value for both '${a}' and '${b}', so there is nothing ` +
          `to tabulate. That is not independence -- it is an empty comparison, and a chi-square ` +
          `of 0 over it would claim the two were unrelated.`,
      );
    }

    const table = crosstab(x, y);
    const test = chiSquare(table);
    const information = mutualInformation(table);

    this.warn(
      `${a} x ${b}: n=${String(test.n)} of ${String(entries.length)} entries ` +
        `(${String(entries.length - test.n)} dropped for missing one of the two values), ` +
        `chi2=${String(test.chi2)} at df=${String(test.df)}, p=${String(test.p)}, ` +
        `Cramer's V=${String(test.cramersVCorrected)} (Bergsma-corrected), mutual information ` +
        `${String(information.bits)} bits, symmetric uncertainty ` +
        `${String(information.uncertainty)}.`,
    );
    if (!test.asymptoticValid) {
      this.warn(
        `the chi-square approximation does NOT hold here: the smallest expected count is ` +
          `${String(test.minExpected)} and ${String(test.cellsBelowFive)} of ` +
          `${String(test.cells)} cells expect fewer than 5. Read the table and the effect size; ` +
          `the p-value above is not an estimate of anything.`,
      );
    }

    this.emit(format, {
      columns: ['a_value', 'b_value', 'count', 'a_total', 'b_total'],
      rows: table.rowKeys.flatMap((rowKey) =>
        table.colKeys
          .map((colKey) => ({
            a_value: rowKey,
            b_value: colKey,
            count: cell(table, rowKey, colKey),
            a_total: table.rowTotals.get(rowKey) ?? 0,
            b_total: table.colTotals.get(colKey) ?? 0,
          }))
          // Only the combinations that occurred. A pair of properties with fifty levels each has
          // 2,500 cells and at most `n` of them non-zero, so printing the full grid would bury the
          // table in rows that are all the same fact. The marginals carried on every row are how a
          // level that appears in no printed cell is still visible.
          .filter((row) => row.count > 0),
      ),
    });
  }

  private runRules(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    rawSupport: string | undefined,
    limit: number,
  ): void {
    const names = this.categoricalOrRefuse(spec, 2);
    const minSupport = this.positiveInteger(rawSupport, 'min-support');
    const report = associationRules(
      entries.map((entry) => categoricalItems(entry, names)),
      minSupport === undefined ? {} : { minSupport },
    );

    this.warn(
      `${String(report.rules.length)} rule(s) from ${String(report.itemsets.length)} frequent ` +
        `itemset(s) over ${String(report.transactions)} entries at minimum support ` +
        `${String(report.minSupport)}; ${String(report.unproductive)} dropped for adding nothing ` +
        `to a shorter rule with the same consequent.`,
    );
    this.warn(
      `'informative' is true only where the confidence interval's LOWER bound clears the ` +
        `consequent's base rate. A rule with a lift above 1 and informative false is a rule whose ` +
        `evidence does not reach its own claim.`,
    );

    this.emit(format, {
      columns: [
        'antecedent',
        'consequent',
        'support',
        'antecedent_support',
        'confidence',
        'ci_lower',
        'ci_upper',
        'base_rate',
        'lift',
        'informative',
        'small_group',
      ],
      rows: report.rules.slice(0, limit).map((rule) => ({
        antecedent: rule.antecedent.join(' AND '),
        consequent: rule.consequent,
        support: rule.support,
        antecedent_support: rule.antecedentSupport,
        // Omitted, never zero, where there is no interval: `TASKS.md` #7, and the difference
        // matters most here -- a confidence of 0 would say the rule never held.
        ...(rule.confidence === null
          ? {}
          : {
              confidence: rule.confidence.p,
              ci_lower: rule.confidence.lower,
              ci_upper: rule.confidence.upper,
            }),
        base_rate: rule.baseRate,
        lift: rule.lift,
        informative: rule.informative,
        small_group: rule.underpowered,
      })),
    });
  }

  /**
   * Which clock `--changepoints` reads, checked against the type.
   *
   * `recorded_at` stays the default even though it is the wrong axis for most of this store,
   * because the alternative -- silently preferring the type's lone `timestamp` property -- would
   * make the axis a function of the schema. Two types would then be scanned on two different
   * clocks from one command line, and the only thing that could tell them apart is the column this
   * command now always prints.
   */
  private timeAxis(spec: TypeSpec, requested: string | undefined): string {
    if (requested === undefined) return RECORDED_AT;
    if (requested === RECORDED_AT) return RECORDED_AT;
    const known = timestampProperties(spec);
    if (!known.includes(requested)) {
      throw refusal(
        `'${requested}' is not a \`timestamp\` property of '${spec.name}', so --at cannot read a ` +
          `clock from it. Available: ${[RECORDED_AT, ...known].join(', ')}.`,
      );
    }
    return requested;
  }

  /** What to try instead, when a scan on `recorded_at` collapsed and the type declares a clock. */
  private axisHint(spec: TypeSpec, axis: string): string {
    if (axis !== RECORDED_AT) return '';
    const declared = timestampProperties(spec);
    const first = declared[0];
    if (first === undefined) return '';
    return (
      ` '${RECORDED_AT}' is when \`asc\` wrote the row, which for an ingested type is when the ` +
      `ingest ran rather than when anything happened. '${spec.name}' declares ` +
      `${declared.map((name) => `\`${name}\``).join(', ')}: try \`--at ${first}\`.`
    );
  }

  private runChangepoints(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    // Spelled `string | undefined` rather than optional keys: `exactOptionalPropertyTypes` is on,
    // and oclif's parsed flags carry every declared key with `undefined` where the flag was absent
    // (`base.ts`, `optionalFlag`). An optional key would not accept that object.
    flags: {
      readonly at: string | undefined;
      readonly by: string | undefined;
      readonly period: string | undefined;
      readonly method: string | undefined;
    },
    limit: number,
  ): void {
    const weekly = flags.period === 'week';
    const bucket = weekly ? weekOf : dayOf;
    const step = weekly ? 7 : 1;

    const axis = this.timeAxis(spec, flags.at);
    const times = timeColumn(entries, axis);
    const undated = times.filter((time) => time === null).length;
    if (undated > 0) {
      this.warn(
        `${String(undated)} of ${String(entries.length)} entries have no '${axis}' and are not on ` +
          `this timeline. An entry with no time is left out rather than dated to now, which would ` +
          `put every unmeasured entry in today's period and manufacture the break this mode looks ` +
          `for.`,
      );
    }

    const series: NamedSeries[] = [];
    if (flags.by === undefined) {
      const labels: string[] = [];
      for (const time of times) if (time !== null) labels.push(bucket(time));
      series.push({ name: `entry rate by ${axis}`, points: rateSeries(labels, step) });
    } else {
      const by = this.categoricalName(spec, flags.by, '--changepoints');
      const groups = new Map<string, string[]>();
      for (let index = 0; index < entries.length; index += 1) {
        const time = times[index] ?? null;
        if (time === null) continue;
        const value = (entries[index] as RecordedEntry).properties[by];
        if (typeof value !== 'string' || value.length === 0) continue;
        const bucketed = groups.get(value);
        if (bucketed === undefined) groups.set(value, [bucket(time)]);
        else bucketed.push(bucket(time));
      }
      if (groups.size === 0) {
        throw refusal(
          `no entry of '${spec.name}' has both a value for '${by}' and a time in '${axis}', so ` +
            `there are no series to scan. \`asc explore ${spec.name}\` lists the properties and ` +
            `how many entries measured each.`,
        );
      }
      for (const [value, labels] of [...groups.entries()].sort())
        series.push({ name: `${by}=${value}`, points: rateSeries(labels, step) });
    }

    // Three periods is `pettitt`'s and `cusum`'s own floor -- a break needs a before and an after --
    // and a series below it is held out rather than passed in, because the module would throw and
    // one short series would take every other series' answer with it.
    const scannable = series.filter((one) => one.points.length >= 3);
    if (scannable.length === 0) {
      throw refusal(
        `every series spans fewer than 3 ${weekly ? 'weeks' : 'days'} on the '${axis}' clock, and ` +
          `a break needs a before and an after.${this.axisHint(spec, axis)}` +
          (weekly ? ' Or try `--period day`.' : ''),
      );
    }
    if (scannable.length < series.length) {
      this.warn(
        `${String(series.length - scannable.length)} series span fewer than 3 periods and were ` +
          `not scanned. They are omitted rather than reported as having no break: too short to ` +
          `test is not the same as tested and flat.`,
      );
    }

    const method = flags.method === 'cusum' ? 'cusum' : 'pettitt';
    const report = rankChangepoints(scannable, { method });

    this.warn(
      `${String(report.family)} series scanned with ${method} over '${axis}' by ` +
        `${weekly ? 'week' : 'day'}; q-values corrected across that family. EVERY series gets an ` +
        `index, including one with no break in it -- so the p is the finding and the index never ` +
        `is. Read 'break_after' only where 'p_adjusted' is small.`,
    );

    this.emit(format, {
      columns: [
        'series',
        'axis',
        'method',
        'periods',
        'break_after',
        'first_after',
        'before_mean',
        'before_median',
        'after_mean',
        'after_median',
        'statistic',
        'p',
        'p_adjusted',
        'small_group',
      ],
      rows: report.series.slice(0, limit).map((one) => ({
        series: one.series,
        // The clock, on every row. A changepoint's date means nothing without it, and a caller
        // comparing two runs of this command has no other way to see they used different ones.
        axis,
        method: one.method,
        periods: one.periods,
        break_after: one.label,
        first_after: one.nextLabel,
        before_mean: one.before.mean,
        before_median: one.before.median,
        after_mean: one.after.mean,
        after_median: one.after.median,
        statistic: one.statistic,
        p: one.p,
        p_adjusted: one.pAdjusted,
        small_group: one.underpowered,
      })),
    });
  }

  private runDistinctive(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    rawBy: string | undefined,
    limit: number,
  ): void {
    if (rawBy === undefined) {
      throw usageError(
        `--distinctive compares groups and needs to be told which groups: pass --by <property>. ` +
          `A distinctive term is one that marks a group out FROM THE OTHERS, so there is no ` +
          `one-group form of this question.`,
      );
    }
    const by = this.categoricalName(spec, rawBy, '--distinctive');

    const { documents, coverage } = textCorpus(entries, spec);
    this.requireText(coverage, spec, '--distinctive');

    const tokensById = new Map(documents.map((document) => [document.id, document.tokens]));
    const groups = new Map<string, (readonly string[])[]>();
    for (const entry of entries) {
      const tokens = tokensById.get(entry.id);
      if (tokens === undefined) continue;
      const value = entry.properties[by];
      if (typeof value !== 'string' || value.length === 0) continue;
      const bucket = groups.get(value);
      if (bucket === undefined) groups.set(value, [tokens]);
      else bucket.push(tokens);
    }

    if (groups.size < 2) {
      throw refusal(
        `'${by}' takes ${String(groups.size)} value(s) among the ${String(coverage.withText)} ` +
          `entries that carry prose, and distinctive terms need two groups to compare. A group ` +
          `compared with nothing has no terms that distinguish it.`,
      );
    }

    const report = distinctiveTerms(
      [...groups.entries()].sort().map(([name, texts]) => ({ name, documents: texts })),
    );

    this.warn(
      `${String(report.groups.length)} group(s) of '${by}', vocabulary ` +
        `${String(report.vocabulary)} over ${String(report.tokens)} tokens; q-values corrected ` +
        `across a family of ${String(report.family)} (term, group) tests. Terms are ranked by z ` +
        `rather than by the raw ratio: at these sizes a term seen twice out-ranks a term seen ` +
        `eighty times on ratio alone, and the ordering would be an accident.`,
    );

    this.emit(format, {
      columns: [
        'group',
        'term',
        'in_group',
        'elsewhere',
        'documents',
        'log_odds',
        'z',
        'p',
        'p_adjusted',
        'small_group',
      ],
      rows: report.groups.flatMap((group) =>
        group.terms.slice(0, limit).map((term) => ({
          group: group.group,
          term: term.term,
          in_group: term.countInGroup,
          elsewhere: term.countElsewhere,
          documents: term.documentsInGroup,
          log_odds: term.logOddsRatio,
          z: term.z,
          p: term.p,
          p_adjusted: term.pAdjusted,
          small_group: group.underpowered,
        })),
      ),
    });
  }

  private runCluster(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    flags: { readonly threshold: string | undefined; readonly linkage: string | undefined },
    limit: number,
  ): void {
    const threshold = this.unitNumber(flags.threshold, 'threshold');
    if (threshold === undefined) {
      throw usageError(
        `--cluster needs --threshold, and ships no default on purpose. EV-21 measured the ` +
          `silhouette curve flat across 0.82-0.92 on this store's corpus (0.081972, 0.084086, ` +
          `0.079134, 0.078669, 0.084922), so any constant here would be a number picked off a ` +
          `flat curve and printed as a finding. 0.90 is where that record cut; run it and read ` +
          `the silhouette rather than trusting the cut.`,
      );
    }

    const { documents, coverage } = textCorpus(entries, spec);
    this.requireText(coverage, spec, '--cluster');

    const linkage = (flags.linkage ?? 'average') as Linkage;
    const report = cluster(documents, { threshold, linkage });

    this.warn(
      `${String(report.documents)} entries with prose of ${String(coverage.entries)} in ` +
        `'${spec.name}'; ${String(report.clusters.length - report.singletons)} cluster(s) of two ` +
        `or more and ${String(report.singletons)} singleton(s) over a vocabulary of ` +
        `${String(report.vocabulary)}. Mean silhouette ${String(report.silhouette)} over every ` +
        `entry, ${linkage} linkage at ${String(threshold)}.` +
        (report.underpowered
          ? ` Fewer than MIN_N (${String(MIN_N)}) documents: an anecdote, whatever it scores.`
          : ''),
    );
    this.warn(
      `the silhouette measures SEPARATION, not meaning. EV-21 measured this corpus's tightest ` +
        `cluster -- silhouette 0.2445, the highest of the ten judged -- to be its only worthless ` +
        `one: ten unrelated entries sharing a 43-word tool preamble (asc-m4u). Read the clusters.`,
    );

    this.emit(format, {
      columns: ['representative', 'size', 'silhouette', 'cohesion', 'terms'],
      rows: report.clusters
        .filter((one) => one.size > 1)
        .slice(0, limit)
        .map((one) => ({
          representative: one.representative,
          size: one.size,
          silhouette: one.silhouette,
          cohesion: one.cohesion,
          terms: one.terms.map((term) => term.term).join(' '),
          // Carried out of `columns` the way `entryRow` carries `properties`: a caller scripting
          // against `--json` wants the ids, and a terminal table cannot hold fifty of them.
          members: one.members,
        })),
    });
  }

  private runDuplicates(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    rawThreshold: string | undefined,
    limit: number,
  ): void {
    const threshold = this.unitNumber(rawThreshold, 'threshold');
    const { documents, coverage } = textCorpus(entries, spec);
    this.requireText(coverage, spec, '--duplicates');

    const report = collapseNearDuplicates(
      documents.map((document) => ({ id: document.id, tokens: document.tokens })),
      threshold === undefined ? {} : { threshold },
    );

    this.warn(
      `${String(report.documents)} entries with prose of ${String(coverage.entries)} in ` +
        `'${spec.name}'; ${String(report.groups.length)} group(s) collapsing ` +
        `${String(report.documents - report.singletons.length)} entries to ` +
        `${String(report.collapsed)} row(s) at threshold ${String(report.threshold)}. The index ` +
        `proposed ${String(report.candidatePairs)} pair(s) and exact Jaccard merged ` +
        `${String(report.mergedPairs)}.`,
    );
    if (report.chainedGroups > 0) {
      this.warn(
        `${String(report.chainedGroups)} group(s) are CHAINED: their weakest pair sits below the ` +
          `threshold and was joined through an intermediate. 'min_similarity' is computed over ` +
          `every pair in the group, including pairs the index never proposed, so a chain cannot ` +
          `hide inside it.`,
      );
    }

    this.emit(format, {
      columns: ['representative', 'count', 'min_similarity', 'max_similarity', 'chained'],
      rows: report.groups.slice(0, limit).map((group) => ({
        representative: group.representative,
        count: group.count,
        min_similarity: group.minSimilarity,
        max_similarity: group.maxSimilarity,
        chained: group.minSimilarity < report.threshold,
        members: group.members,
      })),
    });
  }

  /**
   * A text mode on a type with no prose says so, and says what it looked at.
   *
   * The refusal is the point. An empty table reads as "nothing found", which is a claim about the
   * corpus; what is true is that the instrument could not see it.
   */
  private requireText(coverage: TextCoverage, spec: TypeSpec, mode: string): void {
    if (coverage.withText > 0) {
      if (coverage.withText < coverage.entries) {
        this.warn(
          `${String(coverage.withText)} of ${String(coverage.entries)} entries carry prose; the ` +
            `rest are not in this answer. An entry with no text is left out rather than compared ` +
            `as an empty one, which would make every empty entry identical to every other and ` +
            `report that silence as the largest finding in the data.`,
        );
      }
      return;
    }

    const looked =
      coverage.properties.length === 0
        ? `'${spec.name}' declares no property of type \`text\`, and no entry carries evidence_text`
        : `'${spec.name}' declares \`text\` propert` +
          `${coverage.properties.length === 1 ? 'y' : 'ies'} ${coverage.properties.join(', ')}, ` +
          `and no entry has a value in any of them or in evidence_text`;

    throw refusal(
      `${mode} reads prose and there is none: ${looked}. Only \`text\` properties are read, never ` +
        `every property that happens to hold a string -- EV-20 measured what feeding a text ` +
        `instrument the categorical \`string\` values of a type does: 562 of 564 entries collapsed ` +
        `into one group, 72% of its pairs wrong. This is a refusal rather than an empty table ` +
        `because an empty table would read as 'nothing found', which is a claim about the corpus ` +
        `this command cannot make.`,
    );
  }
}
