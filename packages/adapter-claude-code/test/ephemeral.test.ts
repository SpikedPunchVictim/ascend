import { describe, expect, it } from 'vitest';
import { EPHEMERAL_ROOTS, isEphemeralProject } from '../src/index.js';

/**
 * `asc-80m`: an anchored prefix match against Claude Code's encoded project label, never a
 * substring match. The label is a dash-encoded absolute path, so a temp root is a prefix of it
 * by construction; the risk this file guards against is a rule that is too LOOSE (catching a
 * real project that merely mentions "temp") rather than too narrow.
 */

describe('EPHEMERAL_ROOTS', () => {
  it('matches every root both as an exact label and as a prefix', () => {
    for (const root of EPHEMERAL_ROOTS) {
      expect(isEphemeralProject(root)).toBe(true);
      expect(isEphemeralProject(`${root}-something`)).toBe(true);
    }
  });
});

describe('isEphemeralProject: the anchor, not a substring match', () => {
  it('does NOT match a real project whose label merely starts with the same letters as -tmp', () => {
    // `-tmpfoo` is the label for a real project at `/tmpfoo`. It shares a prefix of characters
    // with `-tmp` but is not `-tmp` followed by a `-`, so it must not match. This is the exact
    // case the `${root}-` anchor (rather than `${root}`) exists to separate.
    expect(isEphemeralProject('-tmpfoo')).toBe(false);
  });

  it('matches the observed ephemeral label shape from the live corpus', () => {
    // Measured 2026-09-18: 5 directories under ~/.claude/projects share this shape -- the
    // realpath'd form of macOS's `os.tmpdir()`, `/private/var/folders/<n>/<id>/T/<run>`. The
    // `<id>` segment is a per-user, per-boot identifier and is REDACTED here rather than
    // reproduced: this repository is public, and the rule under test reads only the prefix, so
    // the real id would be an identifying detail the assertion does not need.
    expect(isEphemeralProject('-private-var-folders-41-REDACTED-T-ev18-arm-b-Nc9Y44')).toBe(true);
  });

  // THE SINGLE MOST IMPORTANT TEST IN THIS FILE. The DECISION comment on asc-80m (2026-09-18) is
  // explicit that "contains temp" is the WRONG rule, and this is the counter-example that proves
  // it: a REAL project (1 entry in the store) that happens to live under a temp-ish path. If this
  // ever matches, the rule has regressed to a substring match and would silently discard real
  // data on the next ingest.
  it('does NOT match a real project that merely lives under a path containing "temp"', () => {
    expect(isEphemeralProject('-Users-me-temp-some-project')).toBe(false);
  });

  it('does not match an ordinary project label', () => {
    expect(isEphemeralProject('-Users-me-projects-ascend')).toBe(false);
  });

  it('does not match the empty string', () => {
    expect(isEphemeralProject('')).toBe(false);
  });
});
