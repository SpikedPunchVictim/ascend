import { describe, expect, it } from 'vitest';
import { MIN_N } from '../src/index.js';

describe('MIN_N', () => {
  it('is 20, the threshold flagged in EV-patterns.md', () => {
    expect(MIN_N).toBe(20);
  });
});
