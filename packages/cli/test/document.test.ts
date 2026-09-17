import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/document.js';

/**
 * `parseDocument` unit-tested directly, the same way `errors.test.ts` tests the error
 * boundary directly -- no CLI subprocess and no `dist/` build.
 */

const DOC = {
  name: 'widget_reviewed',
  properties: [{ name: 'widget_kind', type: 'string' }],
};

describe('asc-zrx -- an empty description or record_when is refused before it reaches the store', () => {
  /**
   * `schema.ts`'s `entry_types` table carries `CHECK (description IS NULL OR description <> '')`
   * and the matching CHECK for `record_when` -- confirmed by reading the schema, not assumed
   * (bug-hunt rule 3: the bead this closes explicitly declined to claim "no upstream guard"
   * without that citation). Before this guard, `parseDocument` accepted an empty string for
   * either field -- it only checked the type was `string`, not that it was non-empty -- and the
   * refusal a caller saw came from the database instead of from the tool.
   */
  it('refuses an empty description with a message naming the document, not a raw CHECK', () => {
    expect(() => parseDocument(JSON.stringify({ ...DOC, description: '' }), 'r.json')).toThrow(
      /r\.json.*description.*empty|r\.json.*description is/i,
    );
  });

  it('refuses an empty record_when the same way', () => {
    expect(() => parseDocument(JSON.stringify({ ...DOC, record_when: '' }), 'r.json')).toThrow(
      /r\.json.*record_when/i,
    );
  });

  it('still accepts an omitted description -- omitting the field is how it stays unset', () => {
    expect(() => parseDocument(JSON.stringify(DOC), 'r.json')).not.toThrow();
  });

  it('still accepts a non-empty description', () => {
    const document = parseDocument(
      JSON.stringify({ ...DOC, description: 'a real sentence' }),
      'r.json',
    );
    expect(document.description).toBe('a real sentence');
  });
});
