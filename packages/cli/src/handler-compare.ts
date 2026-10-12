/**
 * Before/after a change, over the replayed log (asc-jwm7), and the controlled arm within it
 * (asc-xn4g).
 *
 * **The unit is the compaction segment** (asc-6ola.4): per session there are too few to compare,
 * and within one segment the context -- and so whatever a rule put in it -- is continuous. A unit
 * belongs to the BEFORE arm when its last event precedes the change and to the AFTER arm when its
 * first event is at or after it. A unit that spans the change, or carries no timestamp, is in
 * neither: it is counted, because a comparison that dropped it silently would look whole.
 *
 * **The outcome is "did any trigger in the unit produce a row"**, so a unit with forty triggers is
 * one observation, not forty. Triggers within a segment share their context and are not
 * independent, and counting them as if they were would narrow every interval by a factor nobody
 * could see. For a handler with a window this is the natural question (a row is the window's
 * verdict); for one without, every triggered unit has a row and both arms read 1.
 *
 * **Every result is observational UNTIL THE AFTER ARM CARRIES AN ASSIGNMENT.** The change was made
 * when someone chose to make it, and the sessions after it differ from the ones before in ways the
 * log does not record. A difference there is a correlation. When `assignments` names the arm the
 * hook put each after unit in, that arm WAS assigned at random -- it is a hash of the unit key, and
 * `holdout-arm.ts` is why -- so the delivered side against the held-out side estimates the
 * guidance's effect instead of a correlation. Then the after arm is split and `difference` becomes
 * that contrast, because the `design` row the caller prints beside it names which contrast
 * `difference` is, and the two must not disagree. The after-minus-before number is not lost with
 * it: both arms are still reported whole, so every number it is made of is still on the page.
 *
 * **A unit the assignments do not name is `unassigned`, counted and in neither side.** A unit the
 * hook never decided and a unit whose decisions contradict each other land in the same place,
 * deliberately: both are units no arm can claim, and counting either in one would be inventing an
 * experiment.
 */

import { wilson, type Proportion } from '@ascend/analysis';
import type { DecidedRecord } from './exposure-log.js';
import type { Arm as HoldoutArm, Intervention } from './holdout-arm.js';
import { unitKey, type UnitCount, type UnitSpan } from './handler-replay.js';

export interface Arm {
  /** Units in this arm with at least one trigger. */
  readonly units: number;
  /** Of those, the units where at least one trigger produced a row. */
  readonly withRow: number;
  readonly triggers: number;
  readonly rows: number;
  /** `null` for an arm with no units: there is no estimate, and never a zero standing for one. */
  readonly proportion: Proportion | null;
}

/** The after arm divided by the arm the hook assigned each of its units. */
export interface Controlled {
  readonly delivered: Arm;
  readonly heldOut: Arm;
  /** After units no assignment named. `delivered.units + heldOut.units + unassigned = after.units`. */
  readonly unassigned: number;
}

export interface Comparison {
  readonly before: Arm;
  readonly after: Arm;
  /** Triggered units whose span contains the change. In neither arm. */
  readonly straddling: number;
  /** Triggered units with no timestamp at all. In neither arm. */
  readonly undated: number;
  /**
   * The contrast the design names: `after.p - before.p` while nothing is assigned, and
   * `delivered.p - heldOut.p` once the after arm is split. Present only when neither arm it is
   * computed from is a small group. Absent otherwise -- a difference between two anecdotes is not a
   * smaller estimate, it is no estimate.
   */
  readonly difference?: number;
  /** Present only when at least one after unit carries an assignment. */
  readonly controlled?: Controlled;
}

/**
 * Place every triggered unit relative to `at` (an ISO timestamp) and estimate each arm.
 *
 * `assignments` maps a unit key to the arm the hook put it in. Omitted, or naming no after unit,
 * the result is exactly what it was before the holdout existed -- which is what every caller with
 * no decisions to pass gets, unchanged down to the bytes it prints.
 */
export function compareArms(
  counts: ReadonlyMap<string, UnitCount>,
  spans: ReadonlyMap<string, UnitSpan>,
  at: string,
  assignments?: ReadonlyMap<string, HoldoutArm>,
): Comparison {
  const before: UnitCount[] = [];
  const after: UnitCount[] = [];
  const delivered: UnitCount[] = [];
  const heldOut: UnitCount[] = [];
  let straddling = 0;
  let undated = 0;
  let unassigned = 0;
  for (const [unit, count] of counts) {
    if (count.triggers === 0) continue;
    const span = spans.get(unit);
    if (span?.first_ts === undefined || span.last_ts === undefined) undated += 1;
    else if (span.last_ts < at) before.push(count);
    else if (span.first_ts >= at) {
      after.push(count);
      const arm = assignments?.get(unit);
      if (arm === 'delivered') delivered.push(count);
      else if (arm === 'held_out') heldOut.push(count);
      else unassigned += 1;
    } else straddling += 1;
  }
  const beforeArm = arm(before);
  const afterArm = arm(after);
  // `after.length > unassigned` is "at least one after unit was assigned". An assignments map that
  // names only before units, or only units this replay never saw, is no assignment at all.
  const controlled: Controlled | undefined =
    after.length > unassigned
      ? { delivered: arm(delivered), heldOut: arm(heldOut), unassigned }
      : undefined;
  const difference =
    controlled === undefined
      ? contrast(afterArm, beforeArm)
      : contrast(controlled.delivered, controlled.heldOut);
  return {
    before: beforeArm,
    after: afterArm,
    straddling,
    undated,
    ...(difference === undefined ? {} : { difference }),
    ...(controlled === undefined ? {} : { controlled }),
  };
}

/**
 * `first.p - second.p`, or absent when either arm is a small group.
 *
 * The arms are named, not numbered: `contrast(after, before)` is after minus before and
 * `contrast(delivered, heldOut)` is delivered minus held out, so the call site reads as the
 * subtraction it is. Which way round the difference would go is the one thing in this module a
 * reader cannot check from the numbers beside it.
 *
 * `null` for an arm with no units is the same refusal as `smallGroup`, and it is checked here
 * rather than left to the caller for the reason `isSmallGroup` exists: with nothing to estimate
 * from there is no estimate, and a difference computed against a zero standing in for one would be
 * a number with no denominator behind it.
 */
function contrast(first: Arm, second: Arm): number | undefined {
  const f = first.proportion;
  const s = second.proportion;
  if (f === null || s === null || f.smallGroup || s.smallGroup) return undefined;
  return f.p - s.p;
}

function arm(units: readonly UnitCount[]): Arm {
  const withRow = units.filter((unit) => unit.rows > 0).length;
  return {
    units: units.length,
    withRow,
    triggers: units.reduce((sum, unit) => sum + unit.triggers, 0),
    rows: units.reduce((sum, unit) => sum + unit.rows, 0),
    proportion: wilson(withRow, units.length),
  };
}

/**
 * Which arm the hook put each unit in, read from the decisions it wrote (asc-xn4g).
 *
 * **Read, not recomputed, and the two ways of getting this wrong are why.** Recomputing needs the
 * rate, which lives in the installed command line and in no file this can read -- so it would need
 * a `--holdout` flag, and a rate typed one digit wrong relabels every unit silently. It also needs
 * the handler version the decision was made under, and `armFor` on the version the handler file
 * carries TODAY re-keys every unit the moment the handler is edited -- the arm would follow the
 * edit, which is precisely the re-keying `holdout-arm.ts` exists to prevent. The decision record
 * carries both the version and the arm, so the join is exact and neither failure is reachable.
 *
 * **A decision counts only for the intervention version it was made under.** Units decided under a
 * sentence the handler no longer carries are not evidence about the sentence it carries now, so a
 * handler edited since the experiment began yields no assignments -- and the caller goes on saying
 * `observational`, which is true of it.
 *
 * **A unit whose own decisions disagree is left out entirely.** `armFor` is a pure function of the
 * key, so one unit cannot be in two arms under one intervention version, and a disagreement is a
 * log written under two rates. Either arm picked from that is a coin toss printed as a measurement.
 */
export function armAssignments(
  decided: readonly DecidedRecord[],
  intervention: Intervention,
): ReadonlyMap<string, HoldoutArm> {
  const arms = new Map<string, HoldoutArm>();
  const conflicted = new Set<string>();
  for (const record of decided) {
    if (record.intervention_id !== intervention.id) continue;
    if (record.intervention_version !== intervention.version) continue;
    const unit = unitKey(record.session, record.agent, record.segment);
    const seen = arms.get(unit);
    if (seen === undefined) arms.set(unit, record.arm);
    else if (seen !== record.arm) conflicted.add(unit);
  }
  for (const unit of conflicted) arms.delete(unit);
  return arms;
}
