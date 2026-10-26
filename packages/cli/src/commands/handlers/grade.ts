/**
 * `asc handlers grade <entry-id>` -- read an `intervention` row's own metric, prove the ruler has not
 * moved since it was written, and print the comparison and the power figure the row exists for
 * (asc-09wx.8.3).
 *
 * **Why the row's metric is the input and not a handler path.** `compare` and `power` both take a
 * handler file on the command line, which makes the ruler a thing a person chose at the moment of
 * reading. A ledger row chose its ruler BEFORE the change was applied -- `metric` on the
 * `intervention` type names the handler, its `sha256` and the `derive_version` the baseline was read
 * at, and all three are written down before anything moves. Reading the comparison back off the row
 * is the whole difference between a pre-registered test and a number somebody went looking for.
 *
 * **The triple is verified, and a mismatch refuses rather than comparing anyway.** `intervention`'s
 * own words: *"a handler whose own `where` clause was improved is a DIFFERENT RULER: a number that
 * moved because the ruler moved is not evidence about the change."* So both halves are checked
 * before a single row is printed, and the refusal names both values. This command is the only reader
 * that can make that check, because it is the only one holding the row and the log at once.
 *
 * **What `sha256` is, since the name is a trap.** It is the compiled handler's identity --
 * `CompiledHandler.hash`, the same value `asc handlers check` and `asc handlers power` print as
 * `hash` -- and NOT the sha256 of the file's bytes. `shasum -a 256 handlers/beads-delivery.yaml` gives
 * a different number, and a reader who checks that way and finds they disagree has found the naming
 * rather than a moved ruler. The check below reads the hash off the loaded handler, which is what
 * the row was written from and what the replay runs.
 *
 * **The last row is the one the acceptance criterion names**: *"The grading point says how many
 * sessions per arm are needed, and the row says whether the units on hand can reach it."* The row's
 * `grading_point` and the plan's `days` are both in ACTIVE days, so they are commensurable; the
 * `due_at` printed above them is not, which is why `due_at_basis` is printed beside it and why the
 * comparison is made between the two counts rather than between the two dates.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import type { PowerPlan } from '@ascend/analysis';
import { findEntry, type SqlDatabase } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { refusal, usageError } from '../../errors.js';
import { readDecided } from '../../exposure-log.js';
import { armAssignments, compareArms, exposedUnits } from '../../handler-compare.js';
import { compareRows, isoInstant, type Add } from '../../handler-compare-rows.js';
import { HORIZON_DAYS, plan, type Asked } from '../../handler-power.js';
import { replayHandlers } from '../../handler-replay.js';
import { parseHoldoutFraction } from '../../holdout.js';
import {
  gradingPoint,
  ledgerEntries,
  ledgerRows,
  statedMetric,
  type GradingPoint,
  type LedgerRow,
} from '../../intervention.js';
import { storePaths } from '../../project.js';
import {
  checkReplayScope,
  FIELD,
  HANDLER,
  load,
  logRows,
  REPLAY_FLAGS,
  replayScope,
  round,
  VALUE,
  type Row,
} from '../../handler-scope.js';

const TYPE_NAME = 'intervention';

/**
 * What `premature` reads on a chain whose head claims no grade.
 *
 * A sentence rather than `false`, for the reason `compare`'s `difference` is a sentence when there
 * is no estimate: `LedgerRow.premature` is absent in three different situations -- no grade taken,
 * a grade taken whose chain states no date for it, and a grade taken on time -- and a boolean that
 * collapsed them would say "on time" about a grade nobody took.
 */
const NO_GRADE = 'not applicable -- this row claims no grade yet';

export default class HandlersGrade extends BaseCommand {
  static override description =
    'Read an intervention row’s own metric, check that the handler it names and the event ' +
    'derivation have not moved since it was written, and print that row’s state, its before/after ' +
    'comparison and the power figure its grading point is judged against. Refuses when the ruler ' +
    'has moved rather than comparing anyway. Writes nothing.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> 8f2c1d7a-1e6b-4c2f-9a30-5d7e6b8c9a01 --effect 0.5',
    '<%= config.bin %> <%= command.id %> 8f2c1d7a-1e6b-4c2f-9a30-5d7e6b8c9a01 --effect 0.3 --json',
  ];

  static override strict = false;

  static override args = {
    id: Args.string({
      description: 'The entry id of an `intervention` row, as `asc query` prints it.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    effect: Flags.string({
      description:
        'The RELATIVE reduction to plan for, as a fraction between 0 and 1, for the row’s last ' +
        'row to compare its grading point against. Required, and deliberately not defaulted: a ' +
        'figure this row did not choose would be this command inventing an effect size for it.',
      required: true,
    }),
    holdout: Flags.string({
      description:
        'The share of units held back, between 0 and 1. Defaults to 0.5, the cheapest split.',
      default: '0.5',
    }),
    horizon: Flags.integer({
      description: `The horizon to judge against, in active days. Defaults to ${String(HORIZON_DAYS)}.`,
      default: HORIZON_DAYS,
    }),
    at: Flags.string({
      description:
        'When the change was made, as an ISO 8601 date or time. Defaults to the row’s own ' +
        '`applied_at`, which is the date the capture mechanism observed the change and the date ' +
        'the row means.',
    }),
    ...REPLAY_FLAGS,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(HandlersGrade);
    const format = this.resolveFormat(flags);
    const asked: Asked = {
      reduction: fraction(flags.effect, '--effect'),
      holdout: fraction(flags.holdout, '--holdout'),
      horizon: flags.horizon,
    };
    if (asked.horizon <= 0) {
      throw usageError(
        `--horizon takes a positive number of active days; got ${String(asked.horizon)}.`,
      );
    }
    const scope = replayScope({
      root: this.optionalFlag(flags.root),
      project: this.optionalFlag(flags.project),
      'all-projects': flags['all-projects'],
      'include-ephemeral': flags['include-ephemeral'],
    });
    checkReplayScope(scope);
    // The clock is read once, here, and handed to `ledgerRows` as a value -- `base.ts` says why the
    // boundary package owns that read and nothing below it does.
    const now = new Date(this.now());
    const askedAt = this.optionalFlag(flags.at);

    const rows = await this.withProject(async ({ root, store }) => {
      const row = ledgerRowFor(store.db, args.id, now);
      const reading = readingOf(row, args.id);
      const point = gradingPoint(row.chain);

      // Before the replay, because the answer is in the loaded handler and a refusal that costs a
      // sweep of the corpus is a refusal a caller learns nothing more from.
      const path = resolve(root, reading.handler);
      const named = load(path);
      if (named.handler.hash !== reading.sha256) {
        throw refusal(
          `The ruler has moved since intervention row ${row.root} was written. Its metric names ` +
            `${reading.sha256} for ${reading.handler}; ${path} hashes to ${named.handler.hash} ` +
            `today. A handler whose own 'where' clause was changed is a different ruler, and a ` +
            `number that moved because the ruler moved is not evidence about the change. Nothing ` +
            `was compared; nothing was written.`,
        );
      }

      const result = await replayHandlers([named], scope);
      if (result.derive_version !== reading.deriveVersion) {
        throw refusal(
          `The log has moved since intervention row ${row.root}'s baseline was read. Its metric ` +
            `names derive version ${String(reading.deriveVersion)}; this replay is at ` +
            `${String(result.derive_version)}. A different derivation is a different set of ` +
            `events, so the units the baseline counted are not the units on hand. Nothing was ` +
            `compared; nothing was written.`,
        );
      }

      const replay = result.handlers[0];
      // Unreachable: one handler was passed and `replayHandlers` returns one entry per handler.
      if (replay === undefined) {
        throw new Error(`replaying ${path} returned no handler to report on.`);
      }

      // The row's own moment unless the caller overrode it, which is what makes `asc handlers grade
      // <id>` reproduce the split the row was filed expecting rather than a split someone picked.
      const at = askedAt === undefined ? point?.appliedAt : isoInstant(askedAt);
      if (at === undefined) {
        throw refusal(
          `Intervention row ${row.root} states no 'applied_at' -- the wait it means has no start ` +
            `-- and no --at was given, so there is no moment to split the comparison at. Pass ` +
            `--at with the date the change was made.`,
        );
      }

      const out: Row[] = logRows(scope.projects, result);
      const add: Add = (field, value) => {
        out.push({ [HANDLER]: replay.name, [FIELD]: field, [VALUE]: value });
      };
      ledgerFacts(row, args.id, point, reading, named.handler.hash, add);
      const assignments = armAssignments(readDecided(storePaths(root).tree), {
        id: replay.name,
        version: replay.handler.hash,
      });
      // Same rule as `handlers compare`, and computed here for the reason `handler-compare-rows.ts`
      // gives for sharing its sentences: a grade that read contamination differently from the
      // command that printed the comparison would be a second answer to one question.
      const sentences = replay.rows.flatMap((one) => {
        const said = one.fields['say'];
        return typeof said === 'string' ? [said] : [];
      });
      compareRows(
        compareArms(
          replay.units,
          result.units,
          at,
          assignments,
          exposedUnits(assignments, result.opening, sentences),
        ),
        at,
        add,
      );
      add('reaches_grading_point', reaches(point, plan(replay, result.units, asked, add)));
      return out;
    });

    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}

/** The ruler a row names, read off the metric its chain states most recently. */
interface Reading {
  readonly handler: string;
  /** The compiled handler's identity, NOT the sha256 of the file's bytes. See the docblock above. */
  readonly sha256: string;
  readonly deriveVersion: number;
  /** The criterion `intervention` requires beside a metric: what will count as `helped`. */
  readonly rule: string;
  readonly unit: unknown;
  readonly scope: unknown;
}

/** The ledger row `id` belongs to, or a refusal naming what to pass instead. */
function ledgerRowFor(db: SqlDatabase, id: string, now: Date): LedgerRow {
  const entry = findEntry(db, id);
  if (entry === undefined) {
    throw refusal(
      `No entry '${id}' in this project's store, so there is no row to grade. Pass the id of an ` +
        `intervention entry, as 'asc query' prints it.`,
    );
  }
  if (entry.typeName !== TYPE_NAME) {
    throw refusal(
      `Entry '${id}' is a '${entry.typeName}' entry, and this command grades an intervention row: ` +
        `only that type carries the metric a grade is read off.`,
    );
  }
  const row = ledgerRows(ledgerEntries(db), now).find((candidate) =>
    candidate.chain.some((member) => member.id === id),
  );
  // Unreachable: `id` was found in the store and every intervention entry is in exactly one chain.
  if (row === undefined) {
    throw new Error(`intervention entry '${id}' is not in any chain the ledger rows report.`);
  }
  return row;
}

/**
 * The ruler `chain` states, or a refusal naming which of the three facts is missing.
 *
 * **The newest entry carrying a metric wins, and that is the rule `gradingPoint` above uses for the
 * other two facts.** It matters here for the same reason it matters there: a row that is applied by
 * `.8.2`'s capture mechanism lands as a SECOND entry whose `metric` is absent, and a reading that
 * took the head's metric would find none at all.
 *
 * **A `metric` with no sibling `rule` is refused rather than read.** The `intervention` type says
 * *"a row with one and no rule is refused at write time rather than graded loosely"*, and
 * `asc record` does refuse it (`starters.ts`, `metricWithoutRuleIssue`). `asc import` does not run
 * that check, so a row written around it can exist, and this is the other end of the same rule: with
 * no criterion there is nothing for the numbers below to be a reading OF.
 */
function readingOf(row: LedgerRow, id: string): Reading {
  const stated = statedMetric(row.chain);
  if (stated === undefined) {
    throw refusal(
      `Intervention row ${row.root} (entry '${id}') states no metric anywhere in its chain, so ` +
        `there is nothing to grade it against: a row with no metric is a capture, not a proposal.`,
    );
  }
  const metric = stated.metric;

  const handler = nonEmpty(metric['handler']);
  if (handler === undefined) {
    throw refusal(missing(row, "'handler'", 'so there is no file to replay the baseline with'));
  }
  const sha256 = nonEmpty(metric['sha256']);
  if (sha256 === undefined) {
    throw refusal(
      missing(row, "'sha256'", 'so the handler on disk cannot be shown to be the one it names'),
    );
  }
  const deriveVersion = metric['derive_version'];
  if (typeof deriveVersion !== 'number' || !Number.isFinite(deriveVersion)) {
    throw refusal(
      missing(
        row,
        "'derive_version'",
        'so the events the baseline counted cannot be told from the events the log holds now',
      ),
    );
  }
  const rule = nonEmpty(stated.entry.properties['rule']);
  if (rule === undefined) {
    throw refusal(
      `Intervention row ${row.root} names a metric with no 'rule' beside it, so nothing says what ` +
        `would count as helped and the numbers below would not be a grade. 'asc record' refuses ` +
        `that row at write time; this command refuses to read one written around it.`,
    );
  }
  return {
    handler,
    sha256,
    deriveVersion,
    rule,
    unit: metric['unit'],
    scope: metric['scope'],
  };
}

/** Everything the ledger block prints: what the row is, where its wait stands, and its ruler. */
function ledgerFacts(
  row: LedgerRow,
  id: string,
  point: GradingPoint | undefined,
  reading: Reading,
  hash: string,
  add: Add,
): void {
  add('entry', id);
  add('root', row.root);
  add('status', row.head.properties['status']);
  add('chain_entries', row.chain.length);
  add('recorded_at', row.head.recorded_at);
  if (point !== undefined) {
    add('applied_at', point.appliedAt);
    add('grading_point', point.days);
    add('due_at', point.dueAt);
    // **An earlier bound, and the row says so** (`asc-09wx.8.5`, decision `c38bf1a2`). The instant is
    // `applied_at` plus CALENDAR days while `grading_point` is stated in ACTIVE days, so it is the
    // earliest moment the row's wait could be up and never the moment it is; the divergence is a
    // property of the log and was measured at 14.98 calendar days early on the sparsest real corpus
    // (`dogfood/0106`). Printed beside the instant because a reader given only `due_at` reads a date
    // as a verdict, and this is the one command that prints the two properties together.
    add(
      'due_at_basis',
      'an EARLIER bound -- calendar days, not the active days grading_point states',
    );
  }
  add('premature', premature(row, point));
  if (row.premature !== undefined) add('days_short', row.premature.daysShort);
  add('rule', reading.rule);
  add('metric.handler', reading.handler);
  add('metric.sha256', reading.sha256);
  add('metric.derive_version', reading.deriveVersion);
  // What the metric itself says the unit and the scope are, in the row's own words. Printed rather
  // than checked: the replay above has already named the unit it used, and a reader comparing the
  // two rows can see a disagreement that this command did not think to look for.
  if (reading.unit !== undefined) add('metric.unit', reading.unit);
  if (reading.scope !== undefined) add('metric.scope', reading.scope);
  add(
    'ruler',
    `matched the metric -- ${reading.handler} hashes to ${hash}, the sha256 the row names, at ` +
      `derive version ${String(reading.deriveVersion)}`,
  );
}

/** Three readings, because `LedgerRow.premature` is absent in three different situations. */
function premature(row: LedgerRow, point: GradingPoint | undefined): unknown {
  if (row.head.properties['status'] !== 'graded') return NO_GRADE;
  if (row.premature !== undefined) return true;
  if (point === undefined) {
    return (
      'unknown -- this row claims a grade and no entry in its chain states both the date the wait ' +
      'started and how long it is, so there is no point to have been early for'
    );
  }
  return false;
}

/**
 * The one sentence the acceptance criterion asks for.
 *
 * **Both numbers are in ACTIVE days, and comparing these two rather than the two dates is the
 * point.** `grading_point` is stated in active days (`intervention`'s own description, and the unit
 * `asc handlers power` reports in) and `powerPlan`'s `days` is the same unit, so the two sides are
 * commensurable. `due_at` above is not -- it is calendar days -- and that is why the comparison is
 * made here and not there.
 */
function reaches(point: GradingPoint | undefined, built: PowerPlan | undefined): string {
  if (built === undefined) {
    return (
      'not checked -- the plan above could not be computed, so there is no figure for this row’s ' +
      'grading point to reach'
    );
  }
  const needed = round(built.days);
  if (point === undefined) {
    return (
      `not checked -- this row states no grading point, so it does not say how long it means to ` +
      `wait; the effect asked for needs ${String(needed)} active days`
    );
  }
  if (point.days >= needed) {
    return (
      `the row waits ${String(point.days)} active days and this effect needs ${String(needed)}, ` +
      `so a grade at the row’s own grading point is planned for rather than hoped for`
    );
  }
  return (
    `the row waits ${String(point.days)} active days and this effect needs ${String(needed)}: ` +
    `${String(round(needed - point.days))} active days short, so a grade taken at the row’s own ` +
    `grading point would be an anecdote rather than a comparison`
  );
}

/** The refusal for a metric missing one of its three facts, naming the row, the fact and the loss. */
function missing(row: LedgerRow, field: string, why: string): string {
  return (
    `The metric on intervention row ${row.root} names no ${field}, ${why}. A metric that cannot ` +
    `be named this precisely is not yet a metric, and comparing anyway is the number that looks ` +
    `right and is not.`
  );
}

/** A `--effect`/`--holdout` value as a fraction, or a usage error naming the flag it came from. */
function fraction(raw: string, flag: string): number {
  const parsed = parseHoldoutFraction(raw, flag);
  if (typeof parsed === 'string') throw usageError(parsed);
  return parsed;
}

/** A non-empty string, or `undefined`. Whitespace is a value wearing a value's clothes. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
