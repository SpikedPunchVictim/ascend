import { describe, expect, it } from 'vitest';
import {
  detectableReduction,
  MIN_N,
  powerPlan,
  powerVerdict,
  PowerError,
  requiredUnits,
  type PowerInput,
} from '../src/index.js';

/**
 * The planning-time power check (asc-6ola.3).
 *
 * The anchors are `spike/power/FINDINGS.md`'s own printed numbers, which are the strongest kind
 * available here: they were produced by an independent throwaway implementation over the frozen
 * corpus, published before this port existed, and the closed form they came from was separately
 * validated against a 10,000-replication simulation (z-test 81.0%, Newcombe 80.8% at the analytic n).
 * The four `requiredUnits` cases below are its four search-miss cells, where the spike's design
 * effect is 1 because it CLAMPED an unestimable intraclass correlation to zero. Those are the only
 * cells the two implementations should agree on, and they agree to the unit.
 */

/** M1 / pooled, from the spike's summary line: `units 9886 successes 206 p 2.08% ... perDay 274.6`. */
const POOLED = 206 / 9886;

const base = {
  baseline: POOLED,
  reduction: 0.5,
  holdout: 0.5,
  perDay: 274.6,
  designEffect: 1,
} as const;

describe('requiredUnits', () => {
  it('reproduces the spike’s pooled search-miss cell, at 50% holdout', () => {
    expect(Math.ceil(requiredUnits(base))).toBe(4448);
  });

  it('reproduces it at 20% holdout', () => {
    expect(Math.ceil(requiredUnits({ ...base, holdout: 0.2 }))).toBe(6343);
  });

  it('reproduces the spike’s this-project search-miss cell, whose base rate is 18 of 1236', () => {
    const here = { ...base, baseline: 18 / 1236, perDay: 103 };
    expect(Math.ceil(requiredUnits(here))).toBe(6395);
  });

  it('reproduces that cell at 20% holdout', () => {
    const here = { ...base, baseline: 18 / 1236, perDay: 103, holdout: 0.2 };
    expect(Math.ceil(requiredUnits(here))).toBe(9117);
  });

  it('multiplies by the design effect, because clustering is a cost and never a discount', () => {
    const clustered = requiredUnits({ ...base, designEffect: 4.53 });
    expect(clustered / requiredUnits(base)).toBeCloseTo(4.53, 10);
  });

  it('needs the fewest units at an even split, which is the only reason 50/50 is the default', () => {
    // The holdout share is tied to the CONTROL arm, so this is not symmetric: 30% held out costs
    // 4,996 units and 70% costs 5,551, arranging the same two rates differently over the same total.
    const at = (holdout: number): number => requiredUnits({ ...base, holdout });
    expect(at(0.5)).toBeLessThan(at(0.3));
    expect(at(0.3)).toBeLessThan(at(0.2));
    expect(at(0.5)).toBeLessThan(at(0.7));
  });
});

/**
 * The plan, against the two numbers of the spike's that matter most: what it printed as "powered"
 * and what it printed as the ratio against `MIN_N`. The ratio is the finding — 57x to 204x across its
 * eight cells — so a port that got `days` right and `multiple` wrong would have inverted the point.
 */

describe('powerPlan', () => {
  it('turns units into active days at the unit rate', () => {
    expect(powerPlan(base).days).toBeCloseTo(16.198106336489438, 10);
  });

  it('reproduces the spike’s 111.2x ratio of days-to-power against days-to-MIN_N', () => {
    expect(powerPlan(base).multiple).toBeCloseTo(111.2, 6);
  });

  it('reproduces the spike’s this-project cell: 62.1 days and a 159.9x ratio', () => {
    const plan = powerPlan({ ...base, baseline: 18 / 1236, perDay: 103 });
    expect([plan.days, plan.multiple]).toEqual([62.0873786407767, 159.875]);
  });

  it('reports the days to clear MIN_N per arm, which is the floor and not the answer', () => {
    // The spike printed `0.4 d` here against a powered `62.1 d`. Both are on the plan, and the ratio
    // between them is the whole reason this module exists.
    const plan = powerPlan({ ...base, baseline: 18 / 1236, perDay: 103 });
    expect(plan.minNDays).toBeCloseTo(20 / (103 * 0.5), 10);
  });

  it('splits the total into the smaller arm by the holdout share', () => {
    const plan = powerPlan({ ...base, holdout: 0.2 });
    expect(plan.perArm).toBe(Math.ceil(6343 * 0.2));
  });

  it('carries the treated proportion the reduction implies', () => {
    expect(powerPlan(base).treated).toBeCloseTo(POOLED / 2, 12);
  });
});

describe('powerPlan refusals', () => {
  const refuses = (patch: Partial<PowerInput>, field: string): void => {
    expect(() => powerPlan({ ...base, ...patch })).toThrow(new RegExp(field));
  };

  it('refuses a baseline of 0 or 1, where there is no variance to detect a change in', () => {
    refuses({ baseline: 0 }, 'baseline');
    refuses({ baseline: 1 }, 'baseline');
  });

  it('refuses a reduction of 0 or 1, which ask for infinite units and for an empty arm', () => {
    refuses({ reduction: 0 }, 'reduction');
    refuses({ reduction: 1 }, 'reduction');
  });

  it('refuses a holdout share of 0 or 1, each of which leaves an arm empty', () => {
    refuses({ holdout: 0 }, 'holdout');
    refuses({ holdout: 1 }, 'holdout');
  });

  it('refuses a unit rate of 0, at which no horizon reaches any sample size', () => {
    refuses({ perDay: 0 }, 'perDay');
  });

  it('refuses a design effect below 1, which would be clustering making the interval tighter', () => {
    refuses({ designEffect: 0.9 }, 'designEffect');
  });

  it('names the field it refused, so the message is actionable without the source', () => {
    expect(() => powerPlan({ ...base, perDay: -1 })).toThrow(PowerError);
    expect(() => powerPlan({ ...base, perDay: -1 })).toThrow(/perDay is -1/);
  });
});

/**
 * The inversion, which is what the "not answerable" verdict is made of: not "you need more data" but
 * "here is the effect this much data would have found".
 */

/** The same inputs with the effect size left out, which is what an inversion takes as given. */
const available = {
  baseline: base.baseline,
  holdout: base.holdout,
  perDay: base.perDay,
  designEffect: base.designEffect,
};

describe('detectableReduction', () => {
  it('returns the reduction whose requirement is the units in hand', () => {
    const units = 274.6 * 90;
    const found = detectableReduction(available, units);
    expect(found).toBeCloseTo(0.23010967234066043, 8);
  });

  it('detects a smaller effect as the units grow, which is the direction it has to be monotone in', () => {
    const small = detectableReduction(available, 20000);
    const large = detectableReduction(available, 60000);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large as number).toBeLessThan(small as number);
  });

  it('returns null rather than a number when no reduction at all is detectable', () => {
    // Not "a large effect size": at this many units the arithmetic has no answer, which is the same
    // refusal `wilson(0, 0)` makes by returning null instead of a zero-width interval.
    expect(detectableReduction(available, 3)).toBeNull();
    expect(detectableReduction(available, 0)).toBeNull();
  });
});

/**
 * The refusal the bead asks for, and the order it is checked in.
 */

describe('powerVerdict', () => {
  it('is answerable when the days to power fit inside the horizon', () => {
    expect(powerVerdict(base, 30)).toEqual({ kind: 'answerable', days: 16.198106336489438 });
  });

  it('says what the units in the horizon would detect when they do not fit', () => {
    const verdict = powerVerdict(base, 10);
    expect(verdict.kind).toBe('not-answerable');
    expect(verdict.kind === 'not-answerable' && verdict.smallest).toBeCloseTo(
      0.6122766841383716,
      8,
    );
  });

  it('refuses the UNIT, before it says anything about effect sizes', () => {
    // A rate so low that even a long horizon cannot put MIN_N units in each arm. The order is the
    // point: a `smallest detectable` computed here would be a number at a sample size no horizon
    // reaches, so the unit is named as the problem instead.
    const verdict = powerVerdict({ ...base, perDay: 0.1 }, 90);
    expect(verdict.kind).toBe('too-few-units');
    expect(verdict.kind === 'too-few-units' && verdict.arm).toBeLessThan(MIN_N);
  });

  it('refuses the unit even when the horizon is long enough to power a sample that size', () => {
    // The overlap the ORDER exists for, and the reason the two checks cannot be swapped: at a 90%
    // reduction, 29 units is a powered sample (29 days against a 30-day horizon) AND 15 units in the
    // smaller arm. Either check alone takes this one, so only the order decides, and the wrong order
    // reports `answerable` for a comparison the gate would refuse to estimate -- a green verdict
    // earned by the size of the effect rather than by the number of units.
    const steep = { baseline: 0.5, reduction: 0.9, holdout: 0.5, perDay: 1, designEffect: 1 };
    expect(powerVerdict(steep, 30)).toEqual({ kind: 'too-few-units', arm: 15, horizon: 30 });
  });

  it('names the horizon it judged against, so a refusal carries its own condition', () => {
    expect(powerVerdict(base, 10)).toMatchObject({ horizon: 10 });
  });
});
