/**
 * Before/after a change, over the replayed log (asc-jwm7).
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
 * **Every result is observational.** The change was made when someone chose to make it, and the
 * sessions after it differ from the ones before in ways the log does not record. A difference here
 * is a correlation; only a controlled arm -- units held out at random from the rule -- can credit
 * the rule with it, and nothing assigns one yet. The caller prints that with the numbers.
 */

import { wilson, type Proportion } from '@ascend/analysis';
import type { UnitCount, UnitSpan } from './handler-replay.js';

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

export interface Comparison {
  readonly before: Arm;
  readonly after: Arm;
  /** Triggered units whose span contains the change. In neither arm. */
  readonly straddling: number;
  /** Triggered units with no timestamp at all. In neither arm. */
  readonly undated: number;
  /**
   * `after.p - before.p`, present only when neither arm is a small group. Absent otherwise --
   * a difference between two anecdotes is not a smaller estimate, it is no estimate.
   */
  readonly difference?: number;
}

/** Place every triggered unit relative to `at` (an ISO timestamp) and estimate each arm. */
export function compareArms(
  counts: ReadonlyMap<string, UnitCount>,
  spans: ReadonlyMap<string, UnitSpan>,
  at: string,
): Comparison {
  const before: UnitCount[] = [];
  const after: UnitCount[] = [];
  let straddling = 0;
  let undated = 0;
  for (const [unit, count] of counts) {
    if (count.triggers === 0) continue;
    const span = spans.get(unit);
    if (span?.first_ts === undefined || span.last_ts === undefined) undated += 1;
    else if (span.last_ts < at) before.push(count);
    else if (span.first_ts >= at) after.push(count);
    else straddling += 1;
  }
  const beforeArm = arm(before);
  const afterArm = arm(after);
  const b = beforeArm.proportion;
  const a = afterArm.proportion;
  return {
    before: beforeArm,
    after: afterArm,
    straddling,
    undated,
    ...(b !== null && a !== null && !b.smallGroup && !a.smallGroup
      ? { difference: a.p - b.p }
      : {}),
  };
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
