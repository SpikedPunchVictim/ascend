import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DECIDED_FILE,
  EXPOSURE_DIR,
  exposureIdOf,
  readDecided,
  writeDecided,
  type DecidedRecord,
} from '../src/exposure-log.js';

/**
 * `guidance.decided`: the live half of the exposure pair (asc-xn4g).
 *
 * The arm alone is not evidence of anything -- "this unit was held out" is a claim by the thing
 * being measured. The record is what a later reader, who was not there, can check.
 */

let tree: string;

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), 'asc-exposure-'));
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

const base: DecidedRecord = {
  exposure_id: 'nudge@a1b2c3d4e5f6:sess-1:main:0',
  intervention_id: 'nudge',
  intervention_version: 'a1b2c3d4e5f6',
  arm: 'delivered',
  rate: 0.3,
  session: 'sess-1',
  agent: 'main',
  segment: 0,
  hook_event: 'PostToolUse',
  tool_use_id: 'toolu_1',
  channel: 'additional_context',
  payload_sha256: 'deadbeef',
  payload_bytes: 42,
};

describe('exposureIdOf', () => {
  it('identifies one exposure, and separates two triggers in one unit', () => {
    const one = exposureIdOf({
      intervention: 'nudge',
      version: 'abcdef012345',
      unit: 's\u0000main\u00000',
      trigger: 'toolu_1',
    });
    const two = exposureIdOf({
      intervention: 'nudge',
      version: 'abcdef012345',
      unit: 's\u0000main\u00000',
      trigger: 'toolu_2',
    });
    expect(one).not.toBe(two);
  });

  it('is stable, so replay can rebuild it rather than trust it', () => {
    const parts = {
      intervention: 'nudge',
      version: 'abcdef012345',
      unit: 's\u0000main\u00000',
      trigger: 'toolu_1',
    };
    expect(exposureIdOf(parts)).toBe(exposureIdOf(parts));
  });
});

describe('writeDecided / readDecided', () => {
  it('returns what was written, with the rate it ran at', () => {
    writeDecided(tree, base);
    expect(readDecided(tree)).toStrictEqual([base]);
  });

  it('is append-only, keeping earlier decisions', () => {
    writeDecided(tree, base);
    writeDecided(tree, { ...base, exposure_id: 'later', arm: 'held_out' });
    expect(readDecided(tree).map((one) => one.exposure_id)).toEqual([base.exposure_id, 'later']);
  });

  it('is an empty list when nothing has been decided, not an error', () => {
    // The ordinary case: no handler declares a stage, so no decision has ever been written.
    expect(readDecided(tree)).toEqual([]);
  });

  it('omits the payload fields for a held-out arm rather than writing a fabricated zero', () => {
    // Nothing was sent, so there is no digest and no size. `0` would be a measured-looking zero
    // for a value that does not exist.
    writeDecided(tree, {
      exposure_id: 'x',
      intervention_id: 'nudge',
      intervention_version: 'a1b2c3d4e5f6',
      arm: 'held_out',
      rate: 0.3,
      session: 'sess-1',
      agent: 'main',
      segment: 0,
      hook_event: 'PostToolUse',
    });
    const [record] = readDecided(tree);
    expect(record).not.toHaveProperty('payload_sha256');
    expect(record).not.toHaveProperty('payload_bytes');
    expect(record).not.toHaveProperty('channel');
  });

  it('reads only whole lines, so a torn tail does not lose the records before it', () => {
    writeDecided(tree, base);
    const path = join(tree, EXPOSURE_DIR, DECIDED_FILE);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"exposure_id":"tor`, 'utf8');
    expect(readDecided(tree).map((one) => one.exposure_id)).toEqual([base.exposure_id]);
  });

  it('writes under the exposure tree, beside entries/ and events/', () => {
    mkdirSync(join(tree, 'entries'), { recursive: true });
    writeDecided(tree, base);
    expect(
      readFileSync(join(tree, 'exposure', DECIDED_FILE), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });
});
