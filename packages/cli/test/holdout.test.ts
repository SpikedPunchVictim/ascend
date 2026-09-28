import { describe, expect, it } from 'vitest';
import { parseHoldoutFraction, splitHoldout } from '../src/holdout.js';

/** The backtest's train/holdout split (asc-z41.2). */

const ids = Array.from({ length: 2000 }, (_, index) => ({ id: `entry-${String(index)}` }));

describe('splitHoldout', () => {
  it('puts every item on exactly one side, in order', () => {
    const { train, holdout } = splitHoldout(ids, 'hand', 0.3);
    expect(train.length + holdout.length).toBe(ids.length);
    expect(new Set([...train, ...holdout]).size).toBe(ids.length);
  });

  it('holds out close to the fraction asked for', () => {
    // 2,000 draws at p = 0.3 have a standard deviation of ~20, so +/- 100 is five of them.
    const { holdout } = splitHoldout(ids, 'hand', 0.3);
    expect(Math.abs(holdout.length - 600)).toBeLessThan(100);
  });

  it('gives the same answer for the same seed, and a different one for another seed', () => {
    const first = splitHoldout(ids, 'hand', 0.3).holdout;
    expect(splitHoldout(ids, 'hand', 0.3).holdout).toStrictEqual(first);
    expect(splitHoldout(ids, 'other', 0.3).holdout).not.toStrictEqual(first);
  });

  it('only grows the holdout as the fraction grows', () => {
    // A threshold on a fixed hash, so an entry held out at 0.2 is still held out at 0.4: raising
    // the fraction never moves an entry the author has already seen into the holdout.
    const at = (fraction: number): Set<string> =>
      new Set(splitHoldout(ids, 'hand', fraction).holdout.map((item) => item.id));
    const small = at(0.2);
    const large = at(0.4);
    expect([...small].every((id) => large.has(id))).toBe(true);
  });
});

describe('parseHoldoutFraction', () => {
  it('accepts a fraction strictly between 0 and 1', () => {
    expect(parseHoldoutFraction('0.3')).toBe(0.3);
  });

  it.each(['0', '1', '-0.1', '1.5', 'NaN', '', 'a third'])('refuses %j', (raw) => {
    expect(typeof parseHoldoutFraction(raw)).toBe('string');
  });
});
