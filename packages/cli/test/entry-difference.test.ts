import { describe, expect, it } from 'vitest';
import { entryDifference } from '../src/entry-difference.js';

/**
 * What a re-derived entry differs from the stored one in (asc-o3tn, asc-j0vh). The collision
 * message used to name a cause it never checked -- "a transcript edited after it was ingested" --
 * for 994 rows whose only difference was a redaction placeholder in the stored copy.
 */

const stored = {
  properties: { project: '-Users-<user>-projects-<project-B>', tool_name: 'Bash' },
  cwd: '/Users/<user>/projects/<project-B>',
  branch: 'main',
};

describe('entryDifference', () => {
  it('names nothing when the two agree', () => {
    expect(entryDifference(stored, stored)).toEqual({ fields: [], redacted: [] });
  });

  it('names each differing property and locality field', () => {
    const derived = {
      ...stored,
      properties: { ...stored.properties, tool_name: 'Edit' },
      branch: 'dev',
    };
    expect(entryDifference(stored, derived)).toEqual({
      fields: ['branch', 'properties.tool_name'],
      redacted: [],
    });
  });

  it('names the fields whose stored placeholders stand where the real values are', () => {
    const derived = {
      properties: { project: '-Users-me-projects-grizzly', tool_name: 'Bash' },
      cwd: '/Users/me/projects/grizzly',
      branch: 'main',
    };
    expect(entryDifference(stored, derived)).toEqual({
      fields: ['cwd', 'properties.project'],
      redacted: ['cwd', 'properties.project'],
    });
  });

  it('does not call a field redacted when it differs outside its placeholders too', () => {
    const derived = {
      properties: { project: '-Users-me-projects-grizzly', tool_name: 'Bash' },
      cwd: '/Users/me/elsewhere/grizzly',
      branch: 'main',
    };
    expect(entryDifference(stored, derived).redacted).toEqual(['properties.project']);
  });

  it('leaves a field with no placeholder out of the redacted ones', () => {
    const derived = {
      properties: { project: '-Users-me-projects-grizzly', tool_name: 'Edit' },
      cwd: '/Users/me/projects/grizzly',
      branch: 'main',
    };
    expect(entryDifference(stored, derived).redacted).toEqual(['cwd', 'properties.project']);
  });

  it('treats an absent field and a null one as the same', () => {
    const derived = {
      properties: stored.properties,
      cwd: stored.cwd,
      branch: 'main',
      evidenceText: null,
    };
    expect(entryDifference(stored, derived).fields).toEqual([]);
  });
});
