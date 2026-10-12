/**
 * `asc handlers power <file.yaml...> --effect <fraction>` -- how long each handler's experiment has
 * to run before its answer means anything, and whether the units on hand can get there (asc-6ola.3).
 *
 * **`compare` is post-hoc; this is the check that has to run first.** A before/after comparison can
 * only ever tell you what happened over a window you already chose. Whether that window COULD have
 * answered the question is a property of the base rate and the unit rate, and it is computable from
 * the replay before the first unit is assigned. `spike/power/FINDINGS.md` measured what happens when
 * it is skipped: in all eight of its cells, both arms cleared `MIN_N` within 0.1–1.7 active days while
 * the same comparisons needed 13.5–265.6 days. Reading "each arm has 20 units" as readiness was 57x
 * to 204x too early, every time.
 *
 * **The unit is the compaction segment and the cluster is the session** (`asc-6ola.4`, `asc-0hys`).
 * The segment is what the hook randomizes; sessions are where correlation actually lives, because a
 * segment inherits the context its session built up. There is deliberately no `--unit` flag: the
 * replay produces segment-keyed units and nothing else, and a flag that could only ever take one
 * value is a lie. Naming a FINER unit when the segment will not work is likewise not done here — a
 * suggestion nobody computed is the class of claim this repo treats as severity-zero.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { Args, Flags } from '@oclif/core';
import {
  clusterDesign,
  MIN_N,
  powerPlan,
  powerVerdict,
  wilson,
  type PowerPlan,
  type PowerVerdict,
} from '@ascend/analysis';
import { BaseCommand } from '../../base.js';
import { usageError } from '../../errors.js';
import { parseHoldoutFraction } from '../../holdout.js';
import { replayHandlers, type HandlerReplay, type UnitSpan } from '../../handler-replay.js';
import {
  checkReplayScope,
  describeProportion,
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

/** The unit the hook randomizes. Named on every run, because a rate is a rate per SOMETHING. */
const UNIT = 'compaction segment';

/** What a unit's outcome is, in the same words `compare` uses, so the two cannot be read apart. */
const OUTCOME = 'a trigger in the segment produced a row';

/**
 * The default horizon, in active days.
 *
 * Ninety is the planning figure `spike/power/FINDINGS.md` states its third verdict against ("the
 * smallest detectable effect in 90 days is X"), so the default and the published example agree.
 */
const HORIZON_DAYS = 90;

export default class HandlersPower extends BaseCommand {
  static override description =
    'Replay handlers over Claude Code transcripts and report, per handler, the base rate, the units ' +
    'per active day and the design effect, then how many days an experiment needs to detect a given ' +
    'relative reduction -- and whether the units on hand can reach it. Writes nothing.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> handlers/edit-unverified.yaml --effect 0.5',
    '<%= config.bin %> <%= command.id %> a.yaml --effect 0.3 --holdout 0.2 --horizon 30 --json',
  ];

  static override strict = false;

  static override args = {
    file: Args.string({
      description: 'A handler file. Pass several to plan them over the log together.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    effect: Flags.string({
      description:
        'The RELATIVE reduction to plan for, as a fraction between 0 and 1. 0.5 asks how long it ' +
        'takes to detect a halving of the outcome rate.',
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
    ...REPLAY_FLAGS,
  };

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(HandlersPower);
    const format = this.resolveFormat(flags);
    const asked = {
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
    const handlers = (argv as string[]).map(load);
    checkReplayScope(scope);

    const result = await replayHandlers(handlers, scope);
    const rows: Row[] = logRows(scope.projects, result);
    for (const replay of result.handlers) {
      const add = (field: string, value: unknown): void => {
        rows.push({ [HANDLER]: replay.name, [FIELD]: field, [VALUE]: value });
      };
      plan(replay, result.units, asked, add);
    }
    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}

/** A `--effect`/`--holdout` value as a fraction, or a usage error naming the flag it came from. */
function fraction(raw: string, flag: string): number {
  const parsed = parseHoldoutFraction(raw, flag);
  if (typeof parsed === 'string') throw usageError(parsed);
  return parsed;
}

interface Asked {
  readonly reduction: number;
  readonly holdout: number;
  readonly horizon: number;
}

/**
 * One handler's plan, as rows. Split from `run` so the arithmetic and the rendering are not one
 * function, and so each refusal below can return before the arithmetic that would not survive it.
 */
function plan(
  replay: HandlerReplay,
  spans: ReadonlyMap<string, UnitSpan>,
  asked: Asked,
  add: (field: string, value: unknown) => void,
): void {
  const triggered = [...replay.units].filter(([, count]) => count.triggers > 0);
  const successes = triggered.filter(([, count]) => count.rows > 0).length;
  // The day rate is per DATED unit, so the numerator has to be the dated units too. Counting an
  // undated unit in the rate but not in the day set would put a numerator over a denominator
  // measured on a different population, which is the shape of a number that looks right.
  const dates = triggered
    .map(([unit]) => spans.get(unit)?.first_ts)
    .filter((ts): ts is string => typeof ts === 'string')
    .map((ts) => ts.slice(0, 10));
  const activeDays = new Set(dates).size;

  add('hash', replay.handler.hash);
  add('unit', UNIT);
  add('outcome', OUTCOME);
  add('units', triggered.length);
  add('successes', successes);
  add('undated', triggered.length - dates.length);
  add('active_days', activeDays);
  add('holdout', asked.holdout);
  add('effect', asked.reduction);
  add('horizon_days', asked.horizon);

  const refusal = whyNot(triggered.length, successes, dates.length, activeDays);
  if (refusal !== undefined) {
    add('proportion', 'no estimate');
    add('verdict', refusal);
    return;
  }

  const design = clusterDesign(
    triggered.map(([, count]) => (count.rows > 0 ? 1 : 0)),
    triggered.map(([unit]) => sessionOf(unit)),
  );
  add('proportion', describeProportion(wilson(successes, triggered.length, 0.95, design)));
  add('clusters', design.clusters);
  add('rho', round(design.rho));
  add('rho_source', design.rhoSource);
  add('design_effect', round(design.designEffect));
  add('effective_n', round(design.effectiveN));

  const perDay = dates.length / activeDays;
  add('units_per_day', round(perDay));

  const input = {
    baseline: successes / triggered.length,
    reduction: asked.reduction,
    holdout: asked.holdout,
    perDay,
    designEffect: design.designEffect,
  };
  const built = powerPlan(input);
  add('units_needed', built.units);
  add('units_per_arm', built.perArm);
  add('days_to_power', round(built.days));
  add('min_n_days', round(built.minNDays));
  add('multiple', round(built.multiple));
  add('verdict', sentence(built, powerVerdict(input, asked.horizon)));
}

/**
 * Why this handler cannot be planned at all, or `undefined` when it can.
 *
 * Each of these is a 0/0 the planning arithmetic refuses, and each is reachable from a real log:
 * a handler that triggered nowhere, one that succeeded everywhere or nowhere (no variance to detect
 * a change in), and one whose units carry no timestamps at all (no day rate to divide by). They are
 * named here rather than left to a thrown `PowerError`, because a stack trace is not a report.
 */
function whyNot(
  units: number,
  successes: number,
  dated: number,
  activeDays: number,
): string | undefined {
  if (units === 0)
    return 'nothing to plan -- this handler triggered in no unit of the replayed log';
  if (successes === 0 || successes === units) {
    return (
      `nothing to plan -- the outcome was the same in all ${String(units)} units, so there is no ` +
      `variance for any effect size to move`
    );
  }
  if (dated === 0 || activeDays === 0) {
    return 'nothing to plan -- no unit in this replay carried a timestamp, so there is no day rate';
  }
  return undefined;
}

/** The session a unit key belongs to -- the clustering level, taken back off the key it is in. */
function sessionOf(unit: string): string {
  return unit.split('\u0000')[0] ?? unit;
}

/** The one sentence the whole check exists to produce, and the numbers it was made of. */
function sentence(built: PowerPlan, verdict: PowerVerdict): string {
  if (verdict.kind === 'too-few-units') {
    return (
      `refused -- at ${String(round(built.perDay))} units per active day, ${String(verdict.horizon)} ` +
      `active days leave ${String(Math.floor(verdict.arm))} units in the smaller arm, under the ` +
      `minimum of ${String(MIN_N)}. A finer unit is the remedy, and this command cannot measure one.`
    );
  }
  if (verdict.kind === 'answerable') {
    return `answerable here in ${String(Math.ceil(verdict.days))} active days`;
  }
  const smallest =
    verdict.smallest === null
      ? 'no reduction at all is detectable at this many units'
      : `the smallest reduction these units detect is ${String(round(verdict.smallest * 100))}%`;
  return `not answerable in ${String(verdict.horizon)} active days -- ${smallest}`;
}
