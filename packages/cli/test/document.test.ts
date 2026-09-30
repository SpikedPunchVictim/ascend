import { describe, expect, it } from 'vitest';
import { orderedDocument, parseDocument, serializeDocument } from '../src/document.js';

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

describe('asc-bli.2 -- guidance fields in a type document', () => {
  const GUIDANCE = {
    purpose: 'why widgets are reviewed',
    analysis_questions: ['which kinds fail review most?'],
    interpretation_notes: 'widget_kind is omitted for bundles',
    review_after: 30,
  };

  it('parses all four guidance fields', () => {
    const parsed = parseDocument(JSON.stringify({ ...DOC, ...GUIDANCE }), 'g.json');
    expect(parsed).toMatchObject(GUIDANCE);
  });

  it('round-trips them through export with a fixed key order, after record_when and before prose', () => {
    const parsed = parseDocument(
      JSON.stringify({ ...DOC, record_when: 'when', prose: { widget_kind: 'k' }, ...GUIDANCE }),
      'g.json',
    );
    expect(Object.keys(orderedDocument(parsed))).toEqual([
      'name',
      'properties',
      'record_when',
      'purpose',
      'analysis_questions',
      'interpretation_notes',
      'review_after',
      'prose',
    ]);
    expect(parseDocument(serializeDocument(parsed), 'again.json')).toEqual(parsed);
  });

  it.each([
    ['purpose', 7, /g\.json.*purpose/],
    ['analysis_questions', 'one question', /g\.json.*analysis_questions/],
    ['analysis_questions', ['ok', 3], /g\.json.*analysis_questions/],
    ['interpretation_notes', [], /g\.json.*interpretation_notes/],
    ['review_after', '20', /g\.json.*review_after/],
  ])('refuses %s = %j with a message naming the document', (field, value, message) => {
    expect(() => parseDocument(JSON.stringify({ ...DOC, [field]: value }), 'g.json')).toThrow(
      message,
    );
  });

  it.each([
    ['purpose', ''],
    ['analysis_questions', []],
    ['review_after', 0],
    ['review_after', 2.5],
  ])('refuses %s = %j: an empty or impossible value is omitted, never stored', (field, value) => {
    expect(() => parseDocument(JSON.stringify({ ...DOC, [field]: value }), 'g.json')).toThrow(
      new RegExp(`g\\.json.*${field}`),
    );
  });
});

describe('the retirement marker a type line may carry (2026-09-29)', () => {
  /**
   * The field exists because a deprecation had nowhere to live: `deprecateType` changes rows and
   * mints no version, so the tree held no line for it and every rebuild erased it. See
   * `TypeDocument.status` for the measurement.
   *
   * What is asserted here is the CODEC, in both directions, because the field is read off disk as
   * text: a key the writer emits and the parser does not know would refuse every tree ascend wrote,
   * and a key the parser accepts and the writer drops would lose the fact on the way back out.
   */
  it('round-trips through the document format, and sits before type_hash', () => {
    const document = parseDocument(JSON.stringify({ ...DOC, status: 'deprecated' }), 'r.json');

    expect(document.status).toBe('deprecated');
    // The exact bytes rather than a key-order list, because this order is what a `type` line in the
    // tree contains -- `orderedDocument` is shared by `serializeDocument` and the line builder, so a
    // test of one is a test of the other only if this is written as bytes.
    expect(serializeDocument(document)).toBe(
      '{"name":"widget_reviewed","properties":[{"name":"widget_kind","type":"string"}],' +
        '"status":"deprecated"}',
    );
    expect(parseDocument(serializeDocument(document), 'again.json')).toEqual(document);
  });

  it('is absent from an ordinary document, so the lines already in every tree are unchanged', () => {
    // Not tidiness. `documentFromRow` omits the field for an active row, and if it did not, the next
    // write would append `"status":"active"` to every line of every tree already on disk -- a rewrite
    // of the whole corpus for a fact this format defines as the absence of the key.
    expect(serializeDocument(parseDocument(JSON.stringify(DOC), 'r.json'))).toBe(
      '{"name":"widget_reviewed","properties":[{"name":"widget_kind","type":"string"}]}',
    );
  });

  it("refuses 'active', because a reactivation is a thing no operation performs", () => {
    // The refusal rather than a silent drop is the point. A reader that ignored the value would
    // leave a line reading "active" beside a store holding a retired type, and nothing would say so.
    expect(() => parseDocument(JSON.stringify({ ...DOC, status: 'active' }), 'r.json')).toThrow(
      /r\.json.*status.*'deprecated'|only value/i,
    );
  });

  it('refuses an unknown status with a message naming the document', () => {
    expect(() => parseDocument(JSON.stringify({ ...DOC, status: 'retired' }), 'r.json')).toThrow(
      /r\.json.*status/i,
    );
  });

  it('still refuses a key it does not know, which is why the field had to be declared', () => {
    // The control: `status` is accepted because it is now in the allowlist, and not because the
    // allowlist gave up. A parser that had been loosened would pass every test above.
    expect(() => parseDocument(JSON.stringify({ ...DOC, retired: true }), 'r.json')).toThrow(
      /r\.json.*no such field 'retired'/,
    );
  });
});
