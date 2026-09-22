import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE, nodeVersionRefusal } from '../src/node-version.js';

/**
 * `nodeVersionRefusal` runs before anything else in `bin.ts` -- before `execute`, before argv
 * is even read -- because on a Node too old to have `node:sqlite`, importing anything that
 * pulls in `@ascend/store` throws a bare module-resolution error instead of a sentence. This
 * file covers the predicate as logic, with no process involved: `bin.ts` is where it is wired
 * to `process.versions.node` and stderr, and has no test of its own by the same convention
 * `streams.ts` documents -- the entry point does only wiring, so the wiring is what is left
 * untested and the decisions are tested here.
 */

describe('a Node below the floor is refused', () => {
  it('refuses a version whose minor is below 22.5', () => {
    const message = nodeVersionRefusal('22.4.0');
    expect(message).toBeDefined();
    expect(message).toContain(MINIMUM_NODE);
    expect(message).toContain('22.4.0');
  });

  it('names the package, the module and the fix', () => {
    const message = nodeVersionRefusal('22.0.0');
    // Context: what ascend needs and why.
    expect(message).toMatch(/@ascend\/store/);
    expect(message).toMatch(/node:sqlite/);
    // Fix: what to do about it.
    expect(message).toMatch(/Install Node/);
  });

  it('refuses an older major outright', () => {
    expect(nodeVersionRefusal('20.11.0')).toBeDefined();
  });
});

describe('a Node at or above the floor is not refused', () => {
  it('passes exactly at the floor', () => {
    expect(nodeVersionRefusal('22.5.0')).toBeUndefined();
  });

  it('passes a later patch on the floor minor', () => {
    expect(nodeVersionRefusal('22.5.1')).toBeUndefined();
  });

  it('passes 22.10.0 -- the case a STRING comparison gets wrong', () => {
    // '22.10.0' < '22.5.0' is true lexicographically ('1' < '5') and false in fact: 22.10 is
    // ten minor releases past the floor. An implementation that compared the raw strings would
    // refuse this version, and this is the test that catches it.
    expect(nodeVersionRefusal('22.10.0')).toBeUndefined();
  });

  it('passes a much newer major', () => {
    expect(nodeVersionRefusal('24.0.0')).toBeUndefined();
  });
});

describe('unparseable input is let through rather than refused', () => {
  it('does not refuse a pre-release build tag Node could plausibly report', () => {
    // process.versions.node does not carry a `v` prefix or a pre-release suffix in practice,
    // but this module is defensive about it: an older major with a suffix still refuses on the
    // major/minor alone, so this checks a shape that has no leading digits at all.
    expect(nodeVersionRefusal('not-a-version')).toBeUndefined();
  });

  it('does not refuse an empty string', () => {
    expect(nodeVersionRefusal('')).toBeUndefined();
  });

  it('does not refuse a bare major with no minor', () => {
    expect(nodeVersionRefusal('22')).toBeUndefined();
  });
});
