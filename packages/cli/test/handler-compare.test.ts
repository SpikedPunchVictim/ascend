import { describe, expect, it } from 'vitest';
import { compareArms } from '../src/handler-compare.js';
import { unitKey, type UnitCount, type UnitSpan } from '../src/handler-replay.js';

/**
 * `compareArms` places each triggered unit before or after a change and estimates, per arm, the
 * share of units whose triggers produced a row (asc-jwm7).
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
