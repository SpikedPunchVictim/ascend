import { describe, expect, it } from 'vitest';
import { parseCorpus, serializeCorpus, type AnnotationLine } from '../src/corpus.js';

/**
 * The corpus line CODEC, unit-tested directly -- the same way `document.test.ts` tests
 * `parseDocument`, with no CLI subprocess and no `dist/` build.
 *
 * `corpus.test.ts` drives the real binary end to end and is the right place for almost everything
 * about this pair. It cannot reach the case below. An annotation whose value is JSON `null` is a
 * row the STORE can hold -- `recordAnnotations` writes the four bytes `null` for it -- but which no
 * CLI command can currently produce, because `asc annotate` has no surface that writes a value at
 * all (checked 2026-09-19). Going through the binary would therefore mean inserting the row behind
 * the store's own writer to construct a state the CLI cannot reach, which tests the fixture as much
 * as the code. The codec is where the distinction is kept or lost, so the codec is what is tested.
 */
describe('an annotation line keeps "no value" and "the value is null" apart', () => {
  /** One annotation line, with `value` left to each case. Everything else is fixed and irrelevant. */
  const base = {
    kind: 'annotation',
    id: 'ann-1',
    entry_id: 'entry-1',
    scheme: 'risk',
    scheme_version: 1,
    label: 'high',
    confidence: null,
    note: null,
    created_by: null,
    created_at: '2026-09-19T00:00:00.000Z',
  } as const;

  /** The one line back out of a round trip through the serializer and the parser. */
  function roundTrip(line: AnnotationLine): AnnotationLine {
    const parsed = parseCorpus(serializeCorpus([line]), 'test');
    const only = parsed[0]?.line;
    if (only === undefined || only.kind !== 'annotation') {
      throw new Error(`expected one annotation line, got ${JSON.stringify(parsed)}`);
    }
    return only;
  }

  it('omits the key entirely when the annotation carried no value', () => {
    const line = roundTrip({ ...base });

    // `toHaveProperty` rather than a comparison against `undefined`: the claim is about the KEY,
    // and `{ value: undefined }` would satisfy `line.value === undefined` while serializing to a
    // different corpus. This is the same distinction `EntryLine`'s omitted provenance fields make.
    expect(line).not.toHaveProperty('value');

    // Hand-written, not read back from the serializer: absence is the ABSENCE of the key, so the
    // bytes must not mention it.
    expect(serializeCorpus([{ ...base }])).not.toContain('"value"');
  });

  it('keeps a JSON null as a value the annotation actually holds', () => {
    const line = roundTrip({ ...base, value: null });

    expect(line).toHaveProperty('value');
    expect(line.value).toBeNull();

    // The byte that carries the distinction, stated literally rather than derived from the module:
    // a held null is spelled out, which is exactly what the omitted case above must not produce.
    expect(serializeCorpus([{ ...base, value: null }])).toContain('"value":null');
  });

  it('carries an ordinary value through unchanged', () => {
    // A guard on the two cases above: a codec that dropped `value` outright would satisfy the
    // first test and fail nothing else, so the ordinary path is asserted alongside them.
    const line = roundTrip({ ...base, value: { score: 0.5, tags: ['a'] } });

    expect(line.value).toEqual({ score: 0.5, tags: ['a'] });
  });

  it('round-trips all three states in one stream, still distinct', () => {
    // Together, because the failure this guards against is a codec that handles each state
    // correctly alone and collapses them when they share a stream -- which is how the defect this
    // test exists for would have shipped: every annotation in the corpus that produced it had no
    // value, so absence and null were never both present to be told apart.
    const lines = parseCorpus(
      serializeCorpus([
        { ...base, id: 'absent' },
        { ...base, id: 'held-null', value: null },
        { ...base, id: 'held-value', value: 7 },
      ]),
      'test',
    ).map(({ line }) => line as AnnotationLine);

    expect(lines.map((line) => line.id)).toEqual(['absent', 'held-null', 'held-value']);
    expect(lines[0]).not.toHaveProperty('value');
    expect(lines[1]).toHaveProperty('value');
    expect(lines[1]?.value).toBeNull();
    expect(lines[2]?.value).toBe(7);
  });
});
