/**
 * What an experiment on a handler needs before its answer means anything, as rows (asc-6ola.3).
 *
 * **`asc handlers power` is post-hoc; this is the arithmetic that has to run first.** A before/after
 * comparison can only ever tell you what happened over a window you already chose. Whether that
 * window COULD have answered the question is a property of the base rate and the unit rate, and it
 * is computable from the replay before the first unit is assigned. `spike/power/FINDINGS.md` measured
 * what happens when it is skipped: in all eight of its cells, both arms cleared `MIN_N` within
 * 0.1-1.7 active days while the same comparisons needed 13.5-265.6 days. Reading "each arm has 20
 * units" as readiness was 57x to 204x too early, every time.
 *
 * **Two callers, and that is why this is a module rather than a function inside the command.**
 * `handlers/power.ts` plans a handler you name; `handlers/grade.ts` plans the handler an intervention
 * row's `metric` names, so that the row's grading point and the log's actual units are read by the
 * same code. A second implementation of the arithmetic would be a second answer to "how long does
 * this need", and the grader's whole job is to be the one place that cannot disagree with itself.
 *
 * **The unit is the compaction segment and the cluster is the session** (`asc-6ola.4`, `asc-0hys`).
 * The segment is what the hook randomizes; sessions are where correlation actually lives, because a
 * segment inherits the context its session built up. There is deliberately no unit choice: the replay
 * produces segment-keyed units and nothing else, and an option that could only ever take one value is
 * a lie. Naming a FINER unit when the segment will not work is likewise not done here -- a suggestion
 * nobody computed is the class of claim this repo treats as severity-zero.
 *
 * Read-only: nothing here writes to the store or to the transcripts.
 */

import {
  clusterDesign,
  MIN_N,
  powerPlan,
  powerVerdict,
  wilson,
  type PowerPlan,
  type PowerVerdict,
} from '@ascend/analysis';
import type { HandlerReplay, UnitSpan } from './handler-replay.js';
import { describeProportion, round } from './handler-scope.js';

/** The unit the hook randomizes. Named on every run, because a rate is a rate per SOMETHING. */
export const UNIT = 'compaction segment';

/** What a unit's outcome is, in the same words `compare` uses, so the two cannot be read apart. */
export const OUTCOME = 'a trigger in the segment produced a row';

/**
 * The default horizon, in active days.
 *
 * Ninety is the planning figure `spike/power/FINDINGS.md` states its third verdict against ("the
 * smallest detectable effect in 90 days is X"), so the default and the published example agree.
 */
export const HORIZON_DAYS = 90;

/** What the caller is planning for. Both flags are fractions between 0 and 1. */
export interface Asked {
  readonly reduction: number;
  readonly holdout: number;
  readonly horizon: number;
}

/**
 * One handler's plan, as rows. Split from the command so the arithmetic and the rendering are not
 * one function, and so each refusal below can return before the arithmetic that would not survive
 * it. `add` is the caller's row sink, and it carries the handler's name, because how a row is
 * labelled is the caller's business.
 *
 * **It returns the plan it printed, or `undefined` when there was none.** `handlers/power.ts`
 * ignores the value -- the rows are the whole of its answer. `handlers/grade.ts` does not: its last
 * row compares the wait an intervention row pre-registered against this plan's `days`, and reading
 * that number off the rows it just emitted, or recomputing it, would be a second answer to "how long
 * does this need". The rounding is the caller's: the returned plan is the unrounded arithmetic, and
 * the row carries `round(built.days)`.
 */
export function plan(
  replay: HandlerReplay,
  spans: ReadonlyMap<string, UnitSpan>,
  asked: Asked,
  add: (field: string, value: unknown) => void,
): PowerPlan | undefined {
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
    return undefined;
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
  return built;
}

/**
 * Why this handler cannot be planned at all, or `undefined` when it can.
 *
 * Each of these is a 0/0 the planning arithmetic refuses, and each is reachable from a real log:
 * a handler that triggered nowhere, one that succeeded everywhere or nowhere (no variance to detect
 * a change in), and one whose units carry no timestamps at all (no day rate to divide by). They are
 * named here rather than left to a thrown `PowerError`, because a stack trace is not a report.
 */
export function whyNot(
  units: number,
  successes: number,
  dated: number,
  activeDays: number,
): string | undefined {
  if (units === 0)
    return 'nothing to plan -- this handler triggered in no unit of the replayed log';
  if (successes === 0 || successes === units) {
    // EVERY UNIT SUCCEEDING IS THE IDENTITY A `say:` HANDLER HAS BY CONSTRUCTION, and that is a
    // decision rather than a gap (`asc-xg62`): `packages/core` compiles a `say:` handler to one
    // emit per trigger, so "a trigger produced a row" is true in every unit and this instrument
    // cannot size a nudge. What a nudge is meant to move -- EV-63's rework, a later commit
    // rewriting the lines -- is a git fact and is not in the event stream at all. The owner's
    // decision is that nudges are sized GIT-SIDE, with the rework join the design-effect measurement
    // already uses (EV-71/EV-72, `spike/rework-design-effect/units.mjs`), rather than by growing a
    // second outcome definition in here.
    const guidance =
      successes === units
        ? ` A \`say:\` handler has exactly this shape (one row per trigger), and a nudge's outcome is ` +
          `not a row: size it git-side with the rework join (EV-71/EV-72, ` +
          `spike/rework-design-effect/units.mjs), not here.`
        : '';
    return (
      `nothing to plan -- the outcome was the same in all ${String(units)} units, so there is no ` +
      `variance for any effect size to move.${guidance}`
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
