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
 * asc stats tool_denial --assoc --temporal weekday --blocks day   # + the block control
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
 * **EVERY P-VALUE HERE IS UNCORRECTED FOR CLUSTERING, AND THE HELP SAYS SO.** `--assoc`,
 * `--correlate` and `--distinctive` print a chi-square or permutation p; `--changepoints` prints a
 * Benjamini-Hochberg-corrected one. All of them are computed at the RAW entry count, and the
 * observations behind them are not independent -- one session contributes many entries. Correcting
 * a p needs a Rao-Scott correction, which adjusts the TEST STATISTIC and its degrees of freedom
 * rather than scaling N, and that is genuinely different mathematics from the design effect
 * `asc explore <type> --cluster` applies to a Wilson interval (`asc-0hys`). Shipping it here is
 * scope that bead took narrowly and declined, so the honest move is to name which numbers carry a
 * correction and which do not, rather than to leave a reader assuming the flag on one surface
 * reaches the other.
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
 *
 * **`--assoc` CARRIES TWO CONTROLS THE Q-VALUES CANNOT STAND IN FOR, AND BOTH ARE WHY THE RANKING IS
 * SHORTER THAN THE PAIR COUNT** (`asc-fwpe`; `docs/evidence/EV-patterns.md:126-138` named both as
 * required additions and neither existed). A pair whose two properties are the same fact twice --
 * `project x repo`, at determinism 0.828 on the real corpus -- survives every other control, because
 * shuffling destroys the identity and the result still looks significant. Such pairs are suppressed
 * BEFORE the FDR family is computed (a definitional pair cannot be a false discovery, so leaving it
 * in would tax every real pair for a test nobody should have run) and DISCLOSED on stderr with their
 * coefficient, because a suppression nobody can see is indistinguishable from a pair the corpus
 * never had. `--temporal` + `--blocks` add the second: a null that permutes whole blocks' temporal
 * labels, answering "is this pairing real over time, or is it the day structure?" -- a question the
 * ordinary shuffled control is STRUCTURALLY blind to, since the marginal concentration it would
 * destroy is real and it is the pairing that is spurious. Both flags are declared by the caller
 * rather than sniffed, because a weekday and a project name are both just strings.
 *
 * **BOTH FLAGS ACCEPT `<clock>:<bucket>` AS WELL AS A NAME, AND THAT FORM EXISTS BECAUSE THE
 * DECLARATION ALONE WAS UNRUNNABLE** (`asc-h7nq`). A declaration needs a property whose values came
 * from a timestamp, and the type the controls were built for -- `tool_denial` -- declares no such
 * property: its clock is `occurred_at`, and `recorded_at` is one instant for all 774 entries because
 * `asc ingest claude-code` derived them in a single run. So the store could not form the pair the
 * control was designed to test. A derivation from a clock the type actually records is the missing
 * half, and it changes nothing about who decides: the caller names the clock and the bucket, the CLI
 * materialises the strings, and the layer receives a fully built column declared `temporal`
 * (`association.ts:183-222`).
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
  DEFINITIONAL_AT,
  distinctiveTerms,
  functionalDependence,
  MIN_N,
  mutualInformation,
  permutationNull,
  PSEUDOREPLICATION_AT,
  rankAssociations,
  rankChangepoints,
  runStructure,
  type AssociationOptions,
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
  isLocalityColumn,
  LOCALITY_COLUMNS,
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

/**
 * How many times the block control permutes the temporal labels among the blocks.
 *
 * Hard-coded rather than exposed as a flag, and 500 rather than the 5,000 the measurement used:
 * this is a control that runs while the user waits, and its answer is a p-value compared against a
 * threshold. At 500 the standard error of a p near 0.05 is about 0.01, which is enough to decide
 * whether a pairing is inside the block structure's own noise -- and a reader who wants the
 * measured 5,000-iteration numbers can run `spike/spike-controls.mjs`, which is where those were
 * produced.
 *
 * IT IS THE ONLY CONTROL WITH A FIXED COUNT, and that is the difference `--permutations` makes
 * (`asc-jpka`): the block control runs whenever `--blocks` is given, so its count is the tool's to
 * choose and its cost is a cost it imposes; the shuffled control exists only because the caller
 * asked for it, so its count is the caller's and it defaults to OFF. Two controls, two questions,
 * two reasons for their counts -- sharing one constant between them would have made that
 * unreadable.
 */
const BLOCK_ITERATIONS = 500;

/** A day, as `YYYY-MM-DD`, from an ISO timestamp. */
function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * The property that partitions a derived corpus into sessions, for the pseudoreplication check
 * (asc-qt6r).
 *
 * A NAME THE LAYER BELOW IS NOT ALLOWED TO KNOW. `packages/analysis` is pure and harness-neutral --
 * `runStructure` takes an opaque partition label and nothing else -- so the convention lives here,
 * in the layer that already knows it is reading entries derived from Claude Code transcripts. It is
 * the same property `--blocks` is documented to accept as "the day (or session) each entry belongs
 * to", and it is `required` on every type the adapter derives (`PROVENANCE`,
 * `packages/adapter-claude-code/src/derived-types.ts`).
 */
const SESSION_PROPERTY = 'session_id';

/**
 * The property carrying when the EVENT happened, which is not when ascend ingested the entry.
 *
 * `recorded_at` is the ingest clock, and during a backfill of two years of transcripts it is
 * unrelated to the event's own time (`derived-types.ts:76-82`) -- so ordering runs by it would
 * invent adjacency between entries that were never adjacent. Measured on the live store 2026-10-07:
 * `skill` in `skill_activation` reads a runs/marginals ratio of 0.722 ordered by this column and
 * 0.980 ordered by the stored row, and `agent` reads 0.649 against 0.991. The stored order
 * manufactures structure that the event order does not have.
 */
const EVENT_TIME_PROPERTY = 'occurred_at';

/**
 * Row indices in the order the EVENTS happened, ties broken by the stored order.
 *
 * ISO timestamps sort lexicographically, and a corpus with no `EVENT_TIME_PROPERTY` at all keeps the
 * order it arrived in -- every key is then equal and the sort is a no-op rather than a shuffle.
 */
function eventOrder(entries: readonly RecordedEntry[]): readonly number[] {
  const times = valueColumn(entries, EVENT_TIME_PROPERTY);
  return entries
    .map((_, index) => index)
    .sort((left, right) => {
      const a = times[left] ?? '';
      const b = times[right] ?? '';
      return a === b ? left - right : a < b ? -1 : 1;
    });
}

/**
 * The smallest empirical p a control of `iterations` shuffles can report, as text.
 *
 * ARITHMETIC RATHER THAN A CONSTANT, because the floor moves with the count and the reader compares
 * it against the p printed beside it. `nullFrom`'s `+1` correction makes the minimum `1/(n+1)`, and
 * the reason it is not 0 is the reason the floor is worth stating at all: the observed arrangement
 * is one of the arrangements it is being compared against.
 *
 * The published evidence record states "a 5,000-iteration floor of p=0.0025", and 0.0025 is 1/401 --
 * the count `spike/spike-patterns.mjs` actually ran was 400. That is `dogfood/0066`, and it is the
 * whole argument for computing this rather than quoting it.
 */
function floorOf(iterations: number): string {
  return (1 / (iterations + 1)).toFixed(6);
}

/** The Monday of a timestamp's week, as `YYYY-MM-DD`. */
function weekOf(timestamp: string): string {
  const date = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
  // `getUTCDay` is 0 for Sunday; the shift makes Monday 0, so a week runs Monday to Sunday rather
  // than splitting the working week that produced most of these entries across two buckets.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** The day of the week a timestamp falls on, as `Mon`..`Sun`. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * A timestamp's weekday, three letters, `Mon`..`Sun`.
 *
 * **THREE LETTERS AND AN ENGLISH NAME, because `docs/evidence/EV-patterns.md` already reported these
 * numbers and the labels have to be the same labels.** That document's block-control table was
 * produced by `spike/spike-controls.mjs`, whose `strftime('%w')` yields `0` for Sunday; the labels
 * here are that same 0-is-Sunday indexing spelled out, so `Thu` in the record and `Thu` from the CLI
 * are the same bucket and the two can be compared. A second spelling would make the re-run in the
 * Amendment incomparable with the original, which is the one thing a control re-run must not be.
 */
function weekdayOf(timestamp: string): string {
  return WEEKDAYS[new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`).getUTCDay()] as string;
}

/** The buckets `--temporal`/`--blocks` can derive from a clock. */
const BUCKETS = ['day', 'week', 'weekday'] as const;

type Bucket = (typeof BUCKETS)[number];

const BUCKET_OF: Readonly<Record<Bucket, (timestamp: string) => string>> = {
  day: dayOf,
  week: weekOf,
  weekday: weekdayOf,
};

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
    'lexical clustering, or near-duplicate collapse. Every p-value it prints is computed at the ' +
    'raw entry count and is NOT corrected for clustering; a corrected N is reported by ' +
    '`asc explore <type> --cluster` instead.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> tool_denial --assoc',
    '<%= config.bin %> <%= command.id %> tool_denial --assoc --permutations 400',
    '<%= config.bin %> <%= command.id %> tool_denial --assoc --temporal weekday --blocks day',
    '<%= config.bin %> <%= command.id %> tool_denial --assoc --temporal occurred_at:weekday --blocks occurred_at:day',
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
    temporal: Flags.string({
      multiple: true,
      description:
        'A column whose values came from a TIMESTAMP -- a weekday, a date, a month. Name a property ' +
        'that already holds one, or derive it with `<clock>:<bucket>` (`at:weekday`, ' +
        '`occurred_at:day`; buckets are day, week, weekday). Needs --blocks. Only the caller knows ' +
        'a value was derived from time (a weekday and a project name are both just strings), so ' +
        'this is declared rather than guessed, and it is what makes a pair eligible for the block ' +
        'control.',
    }),
    blocks: Flags.string({
      description:
        "Test every temporal pairing against this column's block structure -- the day each entry " +
        'belongs to. Takes the same two forms as --temporal. Answers a DIFFERENT question from the ' +
        'q-values: "is this pairing real over time, or is it the block structure?". Needs ' +
        '--temporal.',
    }),
    permutations: Flags.string({
      description:
        'Permutation iterations for the shuffled-label control: shuffle ONE column freely, so both ' +
        'marginals stay fixed and only the pairing between them is destroyed, then report the ' +
        'empirical p for every pair. Answers a THIRD question -- "could these marginals alone ' +
        'manufacture this chi-square?" -- and it does NOT catch a definitional pair, because a ' +
        "tautology's statistic is genuinely extreme rather than marginal-driven: read it beside " +
        '`determinism`, never instead of it. THE SECOND COLUMN OF EACH PAIR IS THE ONE SHUFFLED -- ' +
        '`b` in the table, and the second `--correlate` -- so naming the same two columns the other ' +
        'way round is a different null and a different p. Off by default, because it costs roughly a ' +
        'second per pair per thousand iterations (measured, `spike/jpka-permutation-cost.mjs`). The ' +
        'published verdicts in docs/evidence/EV-patterns.md used 400.',
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

    // `--temporal`/`--blocks` configure the block control, which only `--assoc` runs. Refused
    // rather than ignored, for the same reason two modes are: a caller handed a table that quietly
    // dropped their control would read it as a control that ran and found nothing.
    if (mode !== 'assoc' && ((flags.temporal ?? []).length > 0 || flags.blocks !== undefined)) {
      throw usageError(
        `--temporal and --blocks configure the block control, which only \`--assoc\` runs, and ` +
          `--${mode} was given. They were checked against a block structure in --assoc's own ` +
          `report; nowhere else has one.`,
      );
    }

    // `--permutations` is the other control, and it reaches one mode further than the block control
    // does: `--correlate` names a single pair and can shuffle it in place, where `--rules`,
    // `--cluster` and the rest produce tables the control has nothing to attach to. Refused rather
    // than ignored -- a requested control that silently did not run is the same false negative one
    // level up.
    if (mode !== 'assoc' && mode !== 'correlate' && flags.permutations !== undefined) {
      throw usageError(
        `--permutations configures the shuffled-label control, which only \`--assoc\` and ` +
          `\`--correlate\` run -- they are the two modes that measure a pair, and \`--${mode}\` was ` +
          `given. Run one of those, or drop the flag rather than reading a table that never ` +
          `shuffled anything.`,
      );
    }

    const permutations = this.positiveInteger(flags.permutations, 'permutations');

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
          this.runAssoc(
            format,
            version.spec,
            entries,
            limit,
            flags.temporal ?? [],
            flags.blocks,
            permutations,
          );
          return;
        case 'correlate':
          this.runCorrelate(format, version.spec, entries, flags.correlate ?? [], permutations);
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
   * Every name a categorical flag can group by, in the order the instruments receive them: the
   * declared categorical properties, then the envelope locality columns that ACTUALLY VARY here.
   *
   * **THE VARIANCE GATE IS WHY THIS TAKES `entries`.** `RecordedEntry` carries `cwd`, `repo` and
   * `branch` on every row whether or not anything wrote them, and measured 2026-10-05 on the live
   * store that is the entire difference between the three: `branch` is populated on all 774
   * `tool_denial` entries, `cwd` on all 774, and `repo` on NONE. A family built from the envelope
   * unconditionally would hand every instrument two constant columns, and `chiSquare` already
   * documents what that measures (`association.ts:442-449`): no uncertainty about a variable that
   * does not vary. Two distinct levels is that same judgement, made once, where the data is rather
   * than as a list of names hardcoded to today's corpus -- so `cwd` and `branch` join on the real
   * store while `repo` stays out until something fills it.
   *
   * The gate decides what is added BY DEFAULT. A name passed on the command line is a request and is
   * honoured whether or not it varies; see `categoricalName`.
   *
   * These names cannot collide with a declared property, which is structural rather than lucky:
   * `ENVELOPE_PROPERTY_NAMES` (`packages/core/src/spec.ts:148-165`) reserves every one of them, so
   * a spec cannot declare `branch` in the first place. Without that, this function would need a
   * precedence rule and `rankAssociations`' duplicate-name refusal would be reachable.
   */
  private groupableNames(spec: TypeSpec, entries: readonly RecordedEntry[]): readonly string[] {
    const varying = LOCALITY_COLUMNS.filter(
      (name) => new Set(valueColumn(entries, name).filter((value) => value !== null)).size >= 2,
    );
    return [...categoricalProperties(spec), ...varying];
  }

  /**
   * The names a categorical flag can group by, or a refusal naming why there are not enough.
   *
   * Numbers, timestamps, durations, refs and JSON are not comparable this way and their exclusion
   * is not a convenience: a crosstab of a timestamp against anything has one row per entry and a
   * Cramer's V of 1, which is a definition restated as a finding. The count in the message is of
   * DECLARED properties while the test is against `groupableNames`, because the reader who needs
   * telling is the one whose spec has too few properties -- and the envelope clause says whether any
   * locality column was available to make up the difference.
   */
  private categoricalOrRefuse(
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    needed: number,
  ): readonly string[] {
    const declared = categoricalProperties(spec);
    const names = this.groupableNames(spec, entries);
    if (names.length < needed) {
      throw refusal(
        `'${spec.name}' declares ${String(declared.length)} categorical ` +
          `propert${declared.length === 1 ? 'y' : 'ies'} (${declared.join(', ') || 'none'}), and ` +
          `this needs ${String(needed)}. Only \`string\` and \`enum\` properties are compared, plus ` +
          `the entry envelope's locality columns (${LOCALITY_COLUMNS.join(', ')}) where they vary -- ` +
          `and none of them varies in this corpus. A crosstab of a timestamp against anything has ` +
          `one row per entry and reports a definition as a finding.`,
      );
    }
    return names;
  }

  /**
   * One named column, checked against the vocabulary a flag can group by, or a refusal listing it.
   *
   * **NO VARIANCE GATE HERE, and that asymmetry with `groupableNames` is the decision.** The gate
   * decides what the family adds BY ITSELF; a name on the command line is a request. A crosstab of a
   * constant column is degenerate -- `chiSquare` returns `p: 1, asymptoticValid: false` rather than
   * throwing (`association.ts:442-469`) -- and that is a RESULT, worth printing. Refusing it would be
   * this command deciding the question was not worth asking, after the reader had asked it, and the
   * reader would have no way to see that the column is constant rather than absent.
   *
   * The vocabulary is therefore the declared properties plus EVERY locality column, whether or not
   * the corpus varies by it. A refusal that omitted an acceptable name would send a reader looking
   * for a different spelling of a column they had already named correctly.
   */
  private categoricalName(spec: TypeSpec, name: string, flag: string): string {
    if (categoricalProperties(spec).includes(name) || isLocalityColumn(name)) return name;
    const vocabulary = [...categoricalProperties(spec), ...LOCALITY_COLUMNS];
    throw refusal(
      `'${name}' is not a \`string\` or \`enum\` property of '${spec.name}', nor a locality column of ` +
        `the entry envelope, so ${flag} cannot group by it. Groupable: ` +
        `${vocabulary.join(', ') || '(none)'}. (\`--temporal\`/\`--blocks\` additionally accept a ` +
        `\`<clock>:<bucket>\` derivation such as \`at:weekday\`; no other flag groups by a derived ` +
        `column yet, so this is where the boundary is rather than a spelling you are missing.)`,
    );
  }

  /** A clock a `--temporal`/`--blocks` derivation can be read from: a `timestamp` property, or the entry's own. */
  private clockName(spec: TypeSpec, clock: string, flag: string): string {
    if (clock === RECORDED_AT || timestampProperties(spec).includes(clock)) return clock;
    throw refusal(
      `'${clock}' is not a clock '${spec.name}' records, so ${flag} cannot derive a column from ` +
        `it. Clocks: ${[RECORDED_AT, ...timestampProperties(spec)].join(', ')}.`,
    );
  }

  /**
   * Resolve one `--temporal`/`--blocks` value into a named column of values.
   *
   * **ONE FLAG, TWO FORMS, AND THE SECOND EXISTS BECAUSE THE FIRST WAS UNUSABLE.** A value is either
   * a NAME -- a declared categorical property or a locality column, which is all this flag used to
   * accept -- or a `<clock>:<bucket>` spec that derives the column from a clock the type actually
   * records. The name form is why the controls shipped unrunnable: `--temporal weekday` needs a
   * property whose values came from a timestamp, the derived `tool_denial` type has none, and the
   * store's real clock is `occurred_at`. So a control that could be measured and could not be run
   * gets the derivation it was missing rather than a paragraph explaining the absence.
   *
   * The derived column is named EXACTLY the spec the caller typed (`occurred_at:weekday`), so the
   * suppression and block disclosures quote something the reader recognises. A colon cannot appear in
   * a property name, so a derived name cannot collide with a declared one -- and it is the reason the
   * two forms can share one flag without a precedence rule.
   *
   * The derivation itself lives here rather than in `packages/analysis` deliberately: `Date` is a
   * restricted global in that package (`eslint.config.js`), and the layer's contract is that the
   * temporal decision is DECLARED BY THE CALLER and never sniffed (`association.ts:183-222`). The
   * layer still receives a fully materialised column and a `temporal: true` declaration; nothing
   * about who computed the strings changes what the layer does with them.
   */
  private temporalColumn(
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    raw: string,
    flag: string,
  ): { readonly name: string; readonly values: readonly (string | null)[] } {
    const colon = raw.indexOf(':');
    const clocks = [RECORDED_AT, ...timestampProperties(spec)];

    if (colon === -1) {
      // A CLOCK IS NOT A COLUMN, and this is the refusal the acceptance could not reach before: the
      // caller asked a real question ("group by the time") and the answer they need is the spelling
      // of the derivation, not the news that a timestamp is not a string.
      if (clocks.includes(raw)) {
        throw refusal(
          `'${raw}' is a clock, not a column: a crosstab of the timestamp itself has one row per ` +
            `entry and reports a definition as a finding. Name the bucket to derive, e.g. ` +
            `\`${flag} ${raw}:weekday\`. Buckets: ${BUCKETS.join(', ')}.`,
        );
      }
      if (isLocalityColumn(raw) || categoricalProperties(spec).includes(raw)) {
        return { name: raw, values: valueColumn(entries, raw) };
      }
      // BOTH vocabularies, because "you named the wrong property" and "this corpus cannot answer
      // that" are different problems with different fixes, and a message naming only the first
      // leaves a reader who meant a derivation no way to see that one exists.
      const example = timestampProperties(spec)[0] ?? RECORDED_AT;
      throw refusal(
        `'${raw}' is not a column of '${spec.name}', and not a derivation from one of its clocks. ` +
          `Columns: ${[...categoricalProperties(spec), ...LOCALITY_COLUMNS].join(', ') || '(none)'}. ` +
          `Derivations: any clock in ${clocks.join(', ')} followed by a colon and one of ` +
          `${BUCKETS.join(', ')} -- e.g. \`${flag} ${example}:weekday\`.`,
      );
    }

    const clock = raw.slice(0, colon);
    const bucket = raw.slice(colon + 1);
    if (!(BUCKETS as readonly string[]).includes(bucket)) {
      throw refusal(
        `'${bucket}' is not a bucket ${flag} can derive from '${clock}'. Buckets: ` +
          `${BUCKETS.join(', ')} -- each is a function of a clock, so ` +
          `\`${flag} ${clock}:day\` is the day each entry falls in.`,
      );
    }
    const times = timeColumn(entries, this.clockName(spec, clock, flag));
    const derive = BUCKET_OF[bucket as Bucket];
    // A null timestamp stays null rather than becoming a bucket of its own: `--blocks` refuses on it
    // below (a row with no day cannot be given another day's label) and `--assoc` counts it as an
    // exclusion, both of which are the honest readings of "this entry has no clock".
    return {
      name: raw,
      values: times.map((time) => (time === null ? null : derive(time))),
    };
  }

  /**
   * The pseudoreplication check `docs/evidence/EV-patterns.md` names as E7's third control
   * (asc-qt6r), reported on the command surface rather than left in the library.
   *
   * WHY IT IS NOT ONE OF THE OTHER TWO CONTROLS. The shuffled control holds each column's marginal
   * distribution fixed and destroys only the pairing; dwell weighting IS the marginal -- the long
   * run is what made one value's count large -- so that control re-draws a null carrying the same
   * defect and cannot object to it. Detection therefore has to be a property of the ORDER, and
   * `runStructure` measures two: how many independent runs the rows collapse into, and whether the
   * run structure is more than the marginals already predict.
   *
   * IT RUNS UNASKED, which is the whole point of the acceptance's word "silently": a control that
   * only ran when asked for would leave the unasked run -- the common one -- reporting a row count
   * as a sample size with nothing said. It costs one pass over the columns and prints nothing when
   * there is nothing to report.
   *
   * WHAT IT DOES NOT DO: collapse the column and re-rank. That is a change to what was measured
   * rather than a note about it, and the two honest remedies -- collapse to one row per run, or
   * compute at the run count with a clustered method -- are the caller's to choose.
   */
  private warnOnStateLikeColumns(
    entries: readonly RecordedEntry[],
    columns: readonly string[],
  ): void {
    const sessions = valueColumn(entries, SESSION_PROPERTY);
    if (sessions.every((value) => value === null)) {
      // NOT a warning and not a silent pass. A corpus with no `SESSION_PROPERTY` was not derived from
      // a session, so nothing in it is an echo of one and the check genuinely does not apply -- which
      // is a different fact from the check running and finding nothing, and the difference is the
      // reason this says so rather than staying quiet.
      this.warn(
        `the pseudoreplication check does not apply to this corpus: no entry carries a ` +
          `'${SESSION_PROPERTY}', so nothing here was derived from a session and no row is an echo ` +
          `of one.`,
      );
      return;
    }

    const order = eventOrder(entries);
    const stateLike: { readonly text: string; readonly rowsPerRun: number }[] = [];
    for (const name of columns) {
      const values = valueColumn(entries, name);
      // Re-ordered to the event's own time and re-partitioned by session in ONE step, so the values
      // and the partitions cannot drift apart: both are read through the same index list.
      const structure = runStructure(
        order.map((index) => values[index] ?? null),
        order.map((index) => sessions[index] ?? null),
      );
      if (!structure.stateLike) continue;
      stateLike.push({
        text:
          `${name} (${String(structure.rows)} rows carry ${String(structure.runs)} runs, ` +
          `${structure.rowsPerRun.toFixed(1)} rows per run, longest run ${String(structure.longestRun)})`,
        rowsPerRun: structure.rowsPerRun,
      });
    }
    if (stateLike.length === 0) return;

    // WORST FIRST, because on a corpus derived per-session nearly every column is clustered -- one
    // session has one project, one cwd, one branch -- so the column ORDER carries no information and
    // the magnitudes are the whole of what distinguishes a mild case from a column that is barely
    // more than a session label. Measured on the live store 2026-10-07: `project` in `tool_denial` is
    // 19.0 rows per run and `skill` in `skill_activation` is 2.4, and a reader scrolling past the
    // second should still have seen the first.
    stateLike.sort((left, right) => right.rowsPerRun - left.rowsPerRun);

    this.warn(
      `${String(stateLike.length)} of ${String(columns.length)} column(s) are STATE-LIKE: their ` +
        `values repeat in consecutive runs WITHIN a session, so an average of ` +
        `${String(PSEUDOREPLICATION_AT)} or more rows carries one observation's worth of ` +
        `information and their rows are echoes of a session state rather than independent events: ` +
        `${stateLike.map((column) => column.text).join(', ')}. Any p-value below computed over ` +
        `such a column is computed at a row count that is not a sample size, and the shuffled ` +
        `control will not flag it -- that control holds the marginals fixed, and the dwell ` +
        `weighting is what made the marginals what they are. Either collapse the column to one row ` +
        `per run, or compute the claim at its run count with a clustered method: ` +
        `\`--blocks <session property>\` reaches the block control, and the effective sample size ` +
        `is \`clusterDesign\` in packages/analysis/src/design-effect.ts.`,
    );
  }

  private runAssoc(
    format: OutputFormat,
    spec: TypeSpec,
    entries: readonly RecordedEntry[],
    limit: number,
    temporalNames: readonly string[],
    rawBlocks: string | undefined,
    permutations: number | undefined,
  ): void {
    const names = this.categoricalOrRefuse(spec, entries, 2);

    // Refused rather than defaulted, in both directions, because each flag alone is a request the
    // tool cannot answer and silently ignoring one would look like a control that ran and found
    // nothing. `--blocks` without `--temporal` has nothing to permute; `--temporal` without
    // `--blocks` has no structure to permute against.
    if (rawBlocks !== undefined && temporalNames.length === 0) {
      throw usageError(
        `--blocks was given without --temporal, so nothing declares which columns came from a ` +
          `timestamp and the block control would have nothing to permute. Name them: ` +
          `\`--temporal <property> --blocks <property>\`.`,
      );
    }
    if (rawBlocks === undefined && temporalNames.length > 0) {
      throw usageError(
        `--temporal was given without --blocks, so the declared columns have no block structure to ` +
          `be tested against. Name the day (or session) each entry belongs to: ` +
          `\`--blocks <property>\`.`,
      );
    }

    // A `--temporal` value is either an existing column or a derivation that ADDS one, so the set of
    // columns to rank is only known once every value has been resolved -- which is why this comes
    // before the ranking rather than being folded into it.
    const temporalColumns = temporalNames.map((raw) =>
      this.temporalColumn(spec, entries, raw, '--temporal'),
    );

    // Declared columns first, in canonical order, then whatever the caller's derivations added: the
    // ranking's pair names follow this order, and a column that exists only because it was asked for
    // should not be able to displace a declared one.
    const valuesByName = new Map<string, readonly (string | null)[]>(
      names.map((name) => [name, valueColumn(entries, name)] as const),
    );
    for (const column of temporalColumns) {
      if (!valuesByName.has(column.name)) valuesByName.set(column.name, column.values);
    }
    const columns = [...valuesByName.keys()];
    // The DECLARATION, not the column's shape: it is what makes a pair eligible for the block
    // control, and a derived column is not less declared for having been computed here.
    const temporal = new Set(temporalColumns.map((column) => column.name));

    let blocks: string[] | undefined;
    let blockName: string | undefined;
    if (rawBlocks !== undefined) {
      const column = this.temporalColumn(spec, entries, rawBlocks, '--blocks');
      blockName = column.name;
      const missing = column.values.filter((value) => value === null).length;
      // Checked here as well as in the analysis layer, because the layer can only report that some
      // ITEM has no block while the CLI knows which PROPERTY and how many entries -- and the fix
      // belongs to the caller. A derived block quotes the DERIVED name, so the reader sees the spec
      // they have to change rather than the clock behind it.
      if (missing > 0) {
        throw refusal(
          `${String(missing)} of ${String(entries.length)} entries have no '${blockName}', so the ` +
            `block control cannot place them in time. A block has to cover every entry: a row with ` +
            `no block cannot be given another block's label, and dropping it would change the ` +
            `corpus being tested.`,
        );
      }
      blocks = column.values.map((value) => value as string);
    }

    // The two controls are asked for independently and neither implies the other: `permutations`
    // reaches the shuffled null over every pair, `blocks` reaches the block null over the declared
    // temporal ones. Both are absent (not zero) when not asked for, so "no control ran" stays
    // distinguishable from "a control ran and found nothing".
    const options: AssociationOptions = {
      ...(blocks === undefined ? {} : { blocks, blockPermutations: BLOCK_ITERATIONS }),
      ...(permutations === undefined ? {} : { permutations }),
    };
    const report = rankAssociations(
      columns.map((name) => ({
        name,
        values: valuesByName.get(name) as readonly (string | null)[],
        // `exactOptionalPropertyTypes`: an undeclared column omits the key rather than carrying
        // `false`, so "not declared temporal" and "declared not-temporal" cannot be told apart --
        // which is right, because the module only ever asks whether it was declared.
        ...(temporal.has(name) ? { temporal: true } : {}),
      })),
      options,
    );

    // WHAT WENT INTO THE FAMILY, not only how big it is. The locality columns are added by the
    // command rather than named by the caller, so a reader who never typed `cwd` has no other way to
    // learn that a pair in this ranking was formed by it -- and the family size alone cannot say so,
    // because the same size is reachable with a different membership.
    const envelopeColumns = columns.filter((name) => isLocalityColumn(name));
    this.warn(
      `${String(report.pairs.length)} pair(s) of ${String(columns.length)} properties over ` +
        `${String(report.items)} entries. q-values are corrected across a family of ` +
        `${String(report.family)}, which is every pair in THIS run -- asking about ten properties ` +
        `and asking twice about five are different questions with different q-values.` +
        (envelopeColumns.length === 0
          ? ''
          : ` ${String(envelopeColumns.length)} of those columns are read from the entry ENVELOPE ` +
            `rather than a declared property (${envelopeColumns.join(', ')}): they vary in this ` +
            `corpus, and no spec can declare a name the envelope already owns.`),
    );

    // Before the disclosures below, because it undermines what they are disclosures ABOUT: a pair
    // can be suppressed as definitional and still have every surviving p-value in this table
    // computed at a row count that is not a sample size.
    this.warnOnStateLikeColumns(entries, columns);

    // The disclosure, not a note. A suppressed pair is usually the STRONGEST thing in the request --
    // it is the same fact twice, so it scores highest -- and a ranking that dropped it in silence
    // would be indistinguishable from one over a corpus that never had it.
    if (report.suppressed.length > 0) {
      this.warn(
        `${String(report.suppressed.length)} pair(s) SUPPRESSED as DEFINITIONAL, at or above a ` +
          `determinism of ${String(DEFINITIONAL_AT)} in either direction -- one property restating ` +
          `the other, so the pair is the same fact twice rather than two findings: ` +
          report.suppressed
            .map(
              (pair) =>
                `${pair.a} x ${pair.b} at ${pair.determinism.toFixed(3)} (n=${String(pair.n)})`,
            )
            .join(', ') +
          `. Determinism is reported for every pair below, so a near-miss can be argued with.`,
      );
    }

    if (blockName !== undefined) {
      this.warn(
        `the block control ran on every pair containing ${[...temporal].join(' or ')}: those labels ` +
          `were permuted among the ${String(new Set(blocks ?? []).size)} distinct blocks of ` +
          `'${blockName}' over ${String(BLOCK_ITERATIONS)} iterations. A HIGH p_blocked means the ` +
          `observed association is inside what the block structure alone manufactures. It is absent ` +
          `(--json) or blank (table) where the pair has no temporal column, because that pair ` +
          `cannot be asked the question.`,
      );
    }

    if (permutations !== undefined) {
      this.warn(
        `the shuffled-label control ran on every pair at ${String(permutations)} iterations, so ` +
          `the smallest empirical p it can report is ${floorOf(permutations)} = 1/(` +
          `${String(permutations)}+1). A pair reading exactly that is AT THE FLOOR rather than at ` +
          `a measured value -- the permutation was never extreme enough to be counted. It is ` +
          `PER PAIR and carries no family correction; p_adjusted is the column corrected across ` +
          `the family of ${String(report.family)}. It answers a different question from both the ` +
          `q-values and the block control -- "could these marginals alone manufacture this ` +
          `chi-square?" -- and it does NOT catch a definitional pair, so read it beside ` +
          `\`determinism\`.`,
      );
    }

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
        'determinism',
        'p_blocked',
        'p_permuted',
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
        // The coefficient, not just the verdict. `definitional` alone would be enough to suppress
        // with and not enough to argue with: 0.49 and 0.05 are both "not definitional".
        determinism: pair.dependence.determinism,
        // Omitted, never zeroed, where the control did not run -- `TASKS.md` #7, and the difference
        // is the whole point: a p_blocked of 0 would say the block structure explains nothing.
        ...(pair.pBlocked === undefined ? {} : { p_blocked: pair.pBlocked }),
        // The same discipline for the other control. Both live in one row because they are answers
        // to three different questions about the same pair, and a reader comparing them is the
        // reader this table is for.
        ...(pair.pPermuted === undefined ? {} : { p_permuted: pair.pPermuted }),
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
    permutations: number | undefined,
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
    // `--correlate` never reaches `rankAssociations`, so it never reaches the suppression either:
    // without this it would report a defining pair as a strong association and say nothing about it.
    // `asc-fwpe` met that shape in the library and here it is one level down -- the capability met
    // and the surface that has to disclose it unmet. The coefficient is printed for every pair and
    // the verdict only for the ones above the threshold, which is the same discipline --assoc keeps:
    // 0.49 and 0.05 are both "not definitional", and only the number can tell them apart.
    const dependence = functionalDependence(table);

    // The OTHER control, reached directly because this mode never enters `rankAssociations`. Same
    // arithmetic from the same function rather than a second implementation of it, so the two modes
    // cannot come to disagree about what a shuffle means for the same pair.
    //
    // `y` AND NOT `x`, WHICH IS ALSO WHAT `--assoc` SHUFFLES FOR THIS PAIR, and the coincidence is
    // the point rather than an accident: the shuffle is asymmetric -- shuffling `project` is a
    // different null from shuffling `tool_name` -- so `--correlate A B` and `--correlate B A` are
    // two different controls. `--assoc` shuffles `b`, the second column of the pair as it prints;
    // this shuffles the second column as it was NAMED. Measured on the live pair, 400 iterations:
    // `project`-then-`tool_name` gives 0.184539, matching the `--assoc` table, and
    // `tool_name`-then-`project` gives 0.189526. A reader comparing the two surfaces has to line
    // the pair up in the same order, so the line below names which column moved.
    let shuffled = '';
    if (permutations !== undefined && table.n > 0) {
      const pValue = permutationNull(x, y, { iterations: permutations }).pValue(test.chi2);
      shuffled =
        `, shuffled p ${pValue.toFixed(6)} over ${String(permutations)} iterations by permuting ` +
        `'${b}' alone (floor ${floorOf(permutations)})`;
    }

    this.warn(
      `${a} x ${b}: n=${String(test.n)} of ${String(entries.length)} entries ` +
        `(${String(entries.length - test.n)} dropped for missing one of the two values), ` +
        `chi2=${String(test.chi2)} at df=${String(test.df)}, p=${String(test.p)}, ` +
        `Cramer's V=${String(test.cramersVCorrected)} (Bergsma-corrected), mutual information ` +
        `${String(information.bits)} bits, symmetric uncertainty ` +
        `${String(information.uncertainty)}, determinism ${dependence.determinism.toFixed(3)}` +
        `${shuffled}.`,
    );
    if (dependence.definitional) {
      this.warn(
        `${a} x ${b} is DEFINITIONAL at a determinism of ${dependence.determinism.toFixed(3)}, at ` +
          `or above ${String(DEFINITIONAL_AT)}: one column restates the other, so the effect size ` +
          `above is close to the arithmetic of one fact told twice rather than an association ` +
          `between two. \`--assoc\` suppresses a pair like this from its ranking; --correlate was ` +
          `asked about these two columns BY NAME and answers the question asked rather than ` +
          `dropping it.`,
      );
    }
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
    const names = this.categoricalOrRefuse(spec, entries, 2);
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
      // Read through `valueColumn` rather than off `entry.properties`, because `--by` accepts an
      // envelope locality column: reading the properties map directly would accept `cwd` and then
      // find no group for it, which is an empty answer to a question the tool just agreed to answer.
      const byValues = valueColumn(entries, by);
      const groups = new Map<string, string[]>();
      for (let index = 0; index < entries.length; index += 1) {
        const time = times[index] ?? null;
        if (time === null) continue;
        const value = byValues[index] ?? null;
        if (value === null) continue;
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
    // Through `valueColumn`, for `--changepoints --by`'s reason: `--by` accepts an envelope locality
    // column, and a direct read of `entry.properties` would answer "no groups" to a name it had just
    // accepted.
    const byValues = valueColumn(entries, by);
    const groups = new Map<string, (readonly string[])[]>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as RecordedEntry;
      const tokens = tokensById.get(entry.id);
      if (tokens === undefined) continue;
      const value = byValues[index] ?? null;
      if (value === null) continue;
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
