import { describe, expect, it } from 'vitest';
import { armFor, armKey, type Intervention } from '../src/holdout-arm.js';

/** The live control arm (asc-xn4g): which unit is deliberately not shown the guidance. */

/** A unit, as `unitKey` composes it: one compaction segment of one stream. */
const unit = (index: number): string => `session-1\u0000main\u0000${String(index)}`;

const intervention: Intervention = { id: 'review-finding-nudge', version: 'a1b2c3d4' };

/** The units one intervention holds out, for the assertions about re-keying. */
const heldOut = (one: Intervention, fraction: number): Set<string> =>
  new Set(
    Array.from({ length: 2000 }, (_, index) => unit(index)).filter(
      (composed) => armFor(composed, one, fraction) === 'held_out',
    ),
  );

describe('armKey', () => {
  it('separates the parts, so a hyphen inside one cannot be read as the separator', () => {
    // Session ids and handler names both carry hyphens. Joined on a printable separator these two
    // pairs render identically; NUL is the separator because no part may contain it.
    const left = armKey('sess-1', { id: 'nudge', version: 'v' });
    const right = armKey('sess', { id: '1-nudge', version: 'v' });
    expect(left).not.toBe(right);
  });

  it('is stable for one unit under one intervention', () => {
    expect(armKey(unit(3), intervention)).toBe(armKey(unit(3), intervention));
  });

  it('changes when only the intervention version changes', () => {
    const other: Intervention = { ...intervention, version: 'ffffffff' };
    expect(armKey(unit(3), other)).not.toBe(armKey(unit(3), intervention));
  });

  it('changes when only the intervention id changes', () => {
    const other: Intervention = { ...intervention, id: 'other-handler' };
    expect(armKey(unit(3), other)).not.toBe(armKey(unit(3), intervention));
  });
});

describe('armFor', () => {
  it('gives one unit one arm, however often it is asked', () => {
    // The property the whole design rests on: replay must be able to reproduce what the live hook
    // decided, and it can only do that if the decision is a pure function of the key.
    for (let index = 0; index < 50; index += 1) {
      expect(armFor(unit(index), intervention, 0.3)).toBe(armFor(unit(index), intervention, 0.3));
    }
  });

  it('holds out close to the fraction asked for', () => {
    // 2,000 draws at p = 0.3 have a standard deviation of ~20, so +/- 100 is five of them.
    const out = heldOut(intervention, 0.3);
    expect(Math.abs(out.size - 600)).toBeLessThan(100);
  });

  it('only ever grows the withheld set as the fraction grows', () => {
    // A threshold on a fixed hash. Raising the rate must never move a unit the model has already
    // seen into the control arm -- that would retroactively relabel data as unseen.
    const small = heldOut(intervention, 0.2);
    const large = heldOut(intervention, 0.4);
    expect([...small].every((one) => large.has(one))).toBe(true);
  });

  it('re-keys when the intervention version changes', () => {
    // A new sentence is a new intervention, and its units must not inherit the old arm: pooling
    // the two versions into one arm would compare deliveries of one against holdouts of another.
    const next: Intervention = { ...intervention, version: 'ffffffff' };
    expect(
      [...heldOut(intervention, 0.3)].some((one) => armFor(one, next, 0.3) === 'delivered'),
    ).toBe(true);
  });
});
