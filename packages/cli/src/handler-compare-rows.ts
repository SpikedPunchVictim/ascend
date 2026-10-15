/**
 * How a comparison is printed: the `design` a set of numbers is, each arm as five rows, and the one
 * contrast `difference` names (asc-jwm7, asc-xn4g).
 *
 * **`handler-compare.ts` computes a comparison; this renders one.** The two live apart for the
 * reason `handler-power.ts` gives for its own split: `handlers/compare.ts` prints a comparison for a
 * handler you name on the command line, and `handlers/grade.ts` prints one for the handler an
 * intervention row's `metric` names -- and a second copy of these sentences would be a second answer
 * to "what does this number mean". That is the one thing a row whose ruler is re-read at grade time
 * cannot afford to disagree with itself about.
 *
 * **`UNIT` and `OUTCOME` come from `handler-power.ts`.** That module already exported them so that
 * "the two cannot be read apart", while `compare` was still spelling both out by hand.
 *
 * **`isoInstant` is here because both callers split a comparison at an instant.** `compare` takes
 * the instant from `--at`; `grade` defaults it to the row's own `applied_at` and takes a flag only
 * when the row does not say. Two parsers would be two answers to what `2026-10-13` means, and the
 * row's whole claim is that its date is the date the change was made.
 *
 * Read-only: nothing here writes to the store or to the transcripts.
 */

import { MIN_N } from '@ascend/analysis';
import { usageError } from './errors.js';
import type { Arm, Comparison } from './handler-compare.js';
import { OUTCOME, UNIT } from './handler-power.js';
import { describeProportion, round } from './handler-scope.js';

/** A caller's row sink. It carries the handler's name, because labelling a row is the caller's job. */
export type Add = (field: string, value: unknown) => void;

/**
 * The design every comparison has with nothing held out. Printed as a row, not left to the docs, so
 * a number copied out of this output carries it.
 */
const OBSERVATIONAL =
  'observational -- the change was not assigned at random, so a difference is a correlation, ' +
  'not the change’s effect';

/**
 * The design a comparison has once the hook's decisions name the arms of the after arm.
 *
 * It says what makes the number mean something rather than who computed it: the assignment is a
 * hash of the unit, so it cannot depend on what the unit went on to do, and that is the whole of
 * the argument. It does not claim the arms are otherwise alike -- a segment inheriting a summary
 * that already mentions the guidance is exposed, whatever its arm says -- and it does not claim the
 * live arm is correct, which is a measurement nobody has taken.
 */
const CONTROLLED =
  'controlled -- the after arm is split by the arm the hook assigned, which is a hash of the unit ' +
  'and so cannot follow what the unit did: delivered against held out estimates the guidance’s ' +
  'effect, where before against after could only ever be a correlation';

/**
 * One comparison, as rows.
 *
 * `at` is passed rather than read off `comparison`, because the split instant is what the caller
 * asked for and not a fact the arithmetic kept: `compareArms` places units against it and reports
 * only the arms that follow. The row is printed first, so a number copied out of the output carries
 * the moment it was split at.
 */
export function compareRows(comparison: Comparison, at: string, add: Add): void {
  const split = comparison.controlled;
  add('at', at);
  add('unit', UNIT);
  add('outcome', OUTCOME);
  add('design', split === undefined ? OBSERVATIONAL : CONTROLLED);
  armRows('before', comparison.before, add);
  armRows('after', comparison.after, add);
  if (split !== undefined) {
    armRows('after.delivered', split.delivered, add);
    armRows('after.held_out', split.heldOut, add);
    add('after.unassigned', split.unassigned);
  }
  add('straddling', comparison.straddling);
  add('undated', comparison.undated);
  add('difference', difference(comparison));
}

/** The single contrast `design` names, or the sentence saying why there is none. */
function difference(comparison: Comparison): number | string {
  if (comparison.difference !== undefined) return round(comparison.difference);
  return comparison.controlled === undefined
    ? `not estimated -- an arm has fewer than ${String(MIN_N)} units, and a difference between ` +
        'anecdotes is no estimate'
    : `not estimated -- the delivered or held-out arm has fewer than ${String(MIN_N)} units, and a ` +
        'difference between anecdotes is no estimate';
}

/** One cell per arm, so the interval and the small-group flag cannot be separated from `p`. */
function armRows(name: string, arm: Arm, add: Add): void {
  add(`${name}.units`, arm.units);
  add(`${name}.with_row`, arm.withRow);
  add(`${name}.triggers`, arm.triggers);
  add(`${name}.rows`, arm.rows);
  add(`${name}.proportion`, describeProportion(arm.proportion));
}

/**
 * `value` as the ISO instant event timestamps are compared with. A date alone means its midnight
 * UTC, as `Date` reads it. Refused rather than guessed when it does not parse.
 */
export function isoInstant(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw usageError(`--at ${value} is not an ISO 8601 date or time.`);
  }
  return new Date(time).toISOString();
}
