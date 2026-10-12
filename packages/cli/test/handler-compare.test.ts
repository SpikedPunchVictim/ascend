import { describe, expect, it } from 'vitest';
import { armAssignments, compareArms } from '../src/handler-compare.js';
import type { DecidedRecord } from '../src/exposure-log.js';
import type { Arm as HoldoutArm, Intervention } from '../src/holdout-arm.js';
import { unitKey, type UnitCount, type UnitSpan } from '../src/handler-replay.js';

/**
 * `compareArms` places each triggered unit before or after a change and estimates, per arm, the
 * share of units whose triggers produced a row (asc-jwm7).
 *
 * The second half is the holdout (asc-xn4g): when the hook's own decisions name the units of the
 * after arm, that arm is split into the units it delivered to and the units it held back, and the
 * contrast the whole thing exists for becomes available.
 */

const AT = '2026-09-20T00:00:00.000Z';

function units(
  specs: readonly { first?: string; last?: string; triggers: number; rows: number }[],
): { spans: Map<string, UnitSpan>; counts: Map<string, UnitCount> } {
  const spans = new Map<string, UnitSpan>();
  const counts = new Map<string, UnitCount>();
  specs.forEach((spec, index) => {
    const key = unitKey(`s${String(index)}`, '', 0);
    spans.set(key, {
      ...(spec.first === undefined ? {} : { first_ts: spec.first }),
      ...(spec.last === undefined ? {} : { last_ts: spec.last }),
    });
    if (spec.triggers > 0) counts.set(key, { triggers: spec.triggers, rows: spec.rows });
  });
  return { spans, counts };
}

const BEFORE = { first: '2026-09-10T00:00:00.000Z', last: '2026-09-11T00:00:00.000Z' };
const AFTER = { first: '2026-09-21T00:00:00.000Z', last: '2026-09-22T00:00:00.000Z' };
const ACROSS = { first: '2026-09-19T00:00:00.000Z', last: '2026-09-21T00:00:00.000Z' };

describe('compareArms', () => {
  it('counts a unit that ended before the change in the before arm', () => {
    const { spans, counts } = units([{ ...BEFORE, triggers: 2, rows: 1 }]);
    expect(compareArms(counts, spans, AT).before.units).toBe(1);
  });

  it('counts a unit that started at or after the change in the after arm', () => {
    const { spans, counts } = units([{ ...AFTER, triggers: 1, rows: 0 }]);
    expect(compareArms(counts, spans, AT).after.units).toBe(1);
  });

  it('puts a unit that started exactly at the change after it', () => {
    const { spans, counts } = units([{ first: AT, last: AFTER.last, triggers: 1, rows: 0 }]);
    expect(compareArms(counts, spans, AT).after.units).toBe(1);
  });

  it('counts a unit that spans the change as straddling, in neither arm', () => {
    const { spans, counts } = units([{ ...ACROSS, triggers: 1, rows: 1 }]);
    const result = compareArms(counts, spans, AT);
    expect([result.straddling, result.before.units, result.after.units]).toEqual([1, 0, 0]);
  });

  it('counts a unit with no timestamp as undated, in neither arm', () => {
    const { spans, counts } = units([{ triggers: 1, rows: 1 }]);
    expect(compareArms(counts, spans, AT).undated).toBe(1);
  });

  it('counts a unit as a success when any of its triggers produced a row', () => {
    const { spans, counts } = units([
      { ...BEFORE, triggers: 3, rows: 1 },
      { ...BEFORE, triggers: 2, rows: 0 },
    ]);
    expect(compareArms(counts, spans, AT).before.withRow).toBe(1);
  });

  it('ignores units the handler never triggered in', () => {
    const { spans, counts } = units([
      { ...BEFORE, triggers: 0, rows: 0 },
      { ...BEFORE, triggers: 1, rows: 1 },
    ]);
    expect(compareArms(counts, spans, AT).before.units).toBe(1);
  });

  it('gives no proportion for an empty arm, rather than a zero', () => {
    const { spans, counts } = units([{ ...BEFORE, triggers: 1, rows: 1 }]);
    expect(compareArms(counts, spans, AT).after.proportion).toBeNull();
  });

  it('marks an arm under MIN_N as a small group', () => {
    const { spans, counts } = units([{ ...BEFORE, triggers: 1, rows: 1 }]);
    expect(compareArms(counts, spans, AT).before.proportion?.smallGroup).toBe(true);
  });

  it('withholds the difference while either arm is a small group', () => {
    const many = Array.from({ length: 20 }, () => ({ ...BEFORE, triggers: 1, rows: 1 }));
    const { spans, counts } = units([...many, { ...AFTER, triggers: 1, rows: 0 }]);
    expect(compareArms(counts, spans, AT).difference).toBeUndefined();
  });

  it('reports the difference, after minus before, once both arms reach MIN_N', () => {
    const before = Array.from({ length: 20 }, (_, i) => ({
      ...BEFORE,
      triggers: 1,
      rows: i < 5 ? 1 : 0,
    }));
    const after = Array.from({ length: 20 }, (_, i) => ({
      ...AFTER,
      triggers: 1,
      rows: i < 15 ? 1 : 0,
    }));
    const { spans, counts } = units([...before, ...after]);
    expect(compareArms(counts, spans, AT).difference).toBeCloseTo(0.5, 10);
  });
});

/**
 * The holdout split (asc-xn4g).
 *
 * `compareArms` is handed unit-to-arm assignments already keyed the way the replay keys its units,
 * so these tests build them with `arms` and `controlled` rather than through a decided log -- the
 * log's own reading is `armAssignments`'s half, tested below.
 */

/** The key `units` above gives the spec at `index`. */
const key = (index: number): string => unitKey(`s${String(index)}`, '', 0);

/**
 * `count` after units, the first `withRow` producing a row, each assigned by `heldOut`. Returns the
 * comparison and the assignment it was given, so a test can assert the split and the whole arm.
 */
function controlled(spec: { count: number; withRow: number; heldOut: (index: number) => boolean }) {
  const specs = Array.from({ length: spec.count }, (_, index) => ({
    ...AFTER,
    triggers: 1,
    rows: index < spec.withRow ? 1 : 0,
  }));
  const { spans, counts } = units(specs);
  const assignments = new Map<string, HoldoutArm>(
    Array.from({ length: spec.count }, (_, index) => [
      key(index),
      spec.heldOut(index) ? 'held_out' : 'delivered',
    ]),
  );
  return compareArms(counts, spans, AT, assignments);
}

describe('compareArms: the controlled arm', () => {
  it('splits the after arm by the arm each unit was assigned', () => {
    const { controlled: split } = controlled({ count: 20, withRow: 10, heldOut: (i) => i < 8 });
    expect([split?.delivered.units, split?.heldOut.units, split?.unassigned]).toEqual([12, 8, 0]);
  });

  it('counts the rows of each side separately', () => {
    // The first 10 units produce a row and are all held out, so the held-out side is 8 of 8 and the
    // delivered side is 2 of 12 -- the whole-arm count of 10 of 20 describes neither.
    const { controlled: split } = controlled({ count: 20, withRow: 10, heldOut: (i) => i < 8 });
    expect([split?.heldOut.withRow, split?.delivered.withRow]).toEqual([8, 2]);
  });

  it('counts an after unit the hook never decided as unassigned', () => {
    const specs = Array.from({ length: 4 }, () => ({ ...AFTER, triggers: 1, rows: 1 }));
    const { spans, counts } = units(specs);
    const assignments = new Map<string, HoldoutArm>([[key(0), 'delivered']]);
    const { controlled: split } = compareArms(counts, spans, AT, assignments);
    expect([split?.delivered.units, split?.unassigned]).toEqual([1, 3]);
  });

  it('has no split at all when no after unit carries an assignment', () => {
    // The ordinary case, and the one the command's bytes depend on: no decision was ever written,
    // or every decision names a unit this replay did not see. Either way there is no arm here, and
    // an empty split printed as a split would claim an experiment that did not run.
    const specs = Array.from({ length: 4 }, () => ({ ...AFTER, triggers: 1, rows: 1 }));
    const { spans, counts } = units(specs);
    const elsewhere = new Map<string, HoldoutArm>([[unitKey('other', '', 0), 'delivered']]);
    expect(compareArms(counts, spans, AT, elsewhere).controlled).toBeUndefined();
  });

  it('ignores an assignment to a unit in the before arm', () => {
    // The hook did not exist before the change, so a decision there records nothing; what the split
    // divides is the after arm, and only it.
    const { spans, counts } = units([{ ...BEFORE, triggers: 1, rows: 1 }]);
    const assignments = new Map<string, HoldoutArm>([[key(0), 'held_out']]);
    const result = compareArms(counts, spans, AT, assignments);
    expect([result.controlled, result.after.units]).toEqual([undefined, 0]);
  });

  it('reports the controlled contrast as `difference`, not the after-minus-before one', () => {
    // 20 before units, every one with a row (p = 1); 40 after units split at index 20. After minus
    // before is 0.5 - 1 = -0.5 and delivered minus held out is 1. The `design` row names which
    // contrast `difference` is, so the one printed has to be the one the design names -- and the
    // after-minus-before number is still recoverable from the two arms printed beside it.
    const before = Array.from({ length: 20 }, () => ({ ...BEFORE, triggers: 1, rows: 1 }));
    const after = Array.from({ length: 40 }, (_, index) => ({
      ...AFTER,
      triggers: 1,
      rows: index < 20 ? 1 : 0,
    }));
    const { spans, counts } = units([...before, ...after]);
    const assignments = new Map<string, HoldoutArm>(
      Array.from({ length: 40 }, (_, index) => [
        key(20 + index),
        index < 20 ? 'held_out' : 'delivered',
      ]),
    );
    const result = compareArms(counts, spans, AT, assignments);
    expect([result.before.proportion?.p, result.after.proportion?.p]).toEqual([1, 0.5]);
    expect(result.difference).toBeCloseTo(-1, 10);
  });

  it('withholds the controlled difference while either side is a small group', () => {
    const { controlled: split, difference } = controlled({
      count: 40,
      withRow: 20,
      heldOut: (i) => i < 2,
    });
    expect([difference, split?.heldOut.units]).toEqual([undefined, 2]);
  });
});

/**
 * The decided log's half of the split (asc-xn4g): which unit the hook put in which arm.
 *
 * Read from what the hook wrote rather than recomputed with `armFor`, and that is the load-bearing
 * choice. Recomputing needs the rate -- which lives nowhere compare can read -- and this run's
 * handler hash, which is the wrong version for every unit decided before the handler was last
 * edited, so it would silently relabel those units onto an arm they were never in.
 */

const NUDGE: Intervention = { id: 'nudge', version: 'a1b2c3d4' };

const decision = (
  session: string,
  segment: number,
  arm: HoldoutArm,
  version: string = NUDGE.version,
): DecidedRecord => ({
  exposure_id: `${session}:${String(segment)}`,
  intervention_id: NUDGE.id,
  intervention_version: version,
  arm,
  rate: 0.3,
  session,
  agent: '',
  segment,
  hook_event: 'PostToolUse',
});

describe('armAssignments', () => {
  it('keys each decision by the unit the replay counts in', () => {
    const arms = armAssignments([decision('s1', 3, 'held_out')], NUDGE);
    expect(arms.get(unitKey('s1', '', 3))).toBe('held_out');
  });

  it('separates two segments of one session', () => {
    const arms = armAssignments(
      [decision('s1', 0, 'held_out'), decision('s1', 1, 'delivered')],
      NUDGE,
    );
    expect([arms.get(unitKey('s1', '', 0)), arms.get(unitKey('s1', '', 1))]).toEqual([
      'held_out',
      'delivered',
    ]);
  });

  it('reads one unit from every decision about it', () => {
    // One unit carries a decision per hook event that matched, and they agree -- `armFor` is a pure
    // function of the key. Several decisions must not read as a conflict.
    const arms = armAssignments(
      [decision('s1', 0, 'held_out'), decision('s1', 0, 'held_out'), decision('s1', 0, 'held_out')],
      NUDGE,
    );
    expect(arms.get(unitKey('s1', '', 0))).toBe('held_out');
  });

  it('leaves a unit out when its own decisions disagree about the arm', () => {
    // Only reachable from a rate changed mid-experiment. A unit that is both shown the lesson and
    // not shown it is in neither arm, and picking one would be a coin toss printed as a measurement.
    const arms = armAssignments(
      [decision('s1', 0, 'delivered'), decision('s1', 0, 'held_out')],
      NUDGE,
    );
    expect(arms.has(unitKey('s1', '', 0))).toBe(false);
  });

  it('ignores another intervention, and another version of this one', () => {
    const arms = armAssignments(
      [
        decision('s1', 0, 'held_out', 'ffffffff'),
        { ...decision('s2', 0, 'held_out'), intervention_id: 'other-handler' },
      ],
      NUDGE,
    );
    expect(arms.size).toBe(0);
  });
});
