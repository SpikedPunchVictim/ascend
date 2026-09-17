import { describe, expect, it } from 'vitest';
import { decodeLine, type TranscriptRecord } from '../src/index.js';

/**
 * The reader's tolerance contract is only as good as the judgement underneath
 * it, and that judgement is here. These are pure functions of a string, so there
 * is no reason for any branch to be untested -- and one branch in particular
 * matters more than it looks: `empty` versus `not_json`.
 *
 * A healthy transcript ends in a newline. If a blank line were counted as
 * malformed, every healthy file in the corpus would report a defect, the counter
 * would be noise, and a genuinely truncated file would be invisible inside it.
 * The distinction is the difference between a usable signal and an unusable one.
 */

const recordOf = (line: string): TranscriptRecord => {
  const decoded = decodeLine(line);
  if (!decoded.ok) throw new Error(`expected a record, got ${decoded.failure}`);
  return decoded.record;
};

describe('decodeLine: what a line is', () => {
  it('decodes a JSON object into a record', () => {
    expect(recordOf('{"type":"user","n":0}')).toEqual({ type: 'user', n: 0 });
  });

  it('decodes an empty object, which is still a record', () => {
    // `{}` carries no fields, but it is a line the corpus really contains and
    // dropping it would be the reader editorializing about content it cannot know.
    expect(recordOf('{}')).toEqual({});
  });

  it('preserves a measured 0 rather than coercing it to absence', () => {
    // The project's founding distinction, restated at the reader: a 0 that is
    // present must arrive present. The reader must not "helpfully" normalize.
    const record = recordOf('{"preTokens":0}');
    expect('preTokens' in record).toBe(true);
    expect(record['preTokens']).toBe(0);
  });
});

describe('decodeLine: blank is not malformed', () => {
  it('classifies an empty line as empty', () => {
    expect(decodeLine('')).toEqual({ ok: false, failure: 'empty' });
  });

  it('classifies a whitespace-only line as empty, not malformed', () => {
    // JSON.parse accepts surrounding whitespace, so a line of spaces carries no
    // information; counting it as a defect would inflate the malformed count on
    // files that are perfectly fine.
    expect(decodeLine('   ')).toEqual({ ok: false, failure: 'empty' });
    expect(decodeLine('\t')).toEqual({ ok: false, failure: 'empty' });
  });
});

describe('decodeLine: malformed has two distinct causes', () => {
  it('classifies a truncated line as not_json', () => {
    // The realistic damage: a process killed mid-write, leaving a half-flushed
    // buffer. This is routine traffic in a directory being appended to live.
    expect(decodeLine('{"type":"assistant","sessionId":"11111111')).toEqual({
      ok: false,
      failure: 'not_json',
    });
  });

  it('classifies non-JSON text as not_json', () => {
    expect(decodeLine('not json at all')).toEqual({ ok: false, failure: 'not_json' });
  });

  it.each([
    ['a number', '42'],
    ['a string', '"a transcript line"'],
    ['null', 'null'],
    ['an array', '[{"type":"user"}]'],
    ['a boolean', 'true'],
  ])('classifies %s as not_object', (_label, line) => {
    // Valid JSON, not a record. Separated from not_json because the fix differs:
    // not_json means the file is damaged, not_object means something wrote a
    // non-record into it.
    expect(decodeLine(line)).toEqual({ ok: false, failure: 'not_object' });
  });
});

describe('decodeLine: a UTF-8 BOM is not corruption', () => {
  // `asc-c10`: this exact line, `'\uFEFF{}'`, was already in the hostile-input list below --
  // but that test only asserted `not.toThrow()`, never the classification, so a decoder that
  // classified it `not_json` (which it did) passed anyway. That is the gap this block closes.

  it('decodes JSON preceded by a single leading BOM', () => {
    expect(decodeLine('\uFEFF{}')).toEqual({ ok: true, record: {} });
    expect(recordOf('\uFEFF{"type":"user","n":0}')).toEqual({ type: 'user', n: 0 });
  });

  it('classifies a line holding ONLY a BOM as empty, not malformed', () => {
    // `String.prototype.trim` treats U+FEFF as whitespace, so this reaches the same `empty`
    // branch a blank line does, before the strip below it ever runs.
    expect(decodeLine('\uFEFF')).toEqual({ ok: false, failure: 'empty' });
  });

  it('does NOT unwrap a second, doubled BOM', () => {
    // Only the routine case -- one writer, one mark -- is tolerated. Two is a stranger shape
    // than a BOM-emitting writer produces, and reported honestly as malformed rather than
    // silently stripped twice.
    expect(decodeLine('\uFEFF\uFEFF{}')).toEqual({ ok: false, failure: 'not_json' });
  });

  it('leaves a BOM alone when it is not at the very front', () => {
    // Only a match at index 0 is a byte-order mark; here it is a character inside the JSON
    // string's own content, and stripping it would corrupt the value the transcript recorded.
    expect(recordOf('{"a":"\uFEFF"}')).toEqual({ a: '\uFEFF' });
  });
});

describe('decodeLine is total', () => {
  it('never throws, for any input', () => {
    // "Advisory analysis must never crash the thing it observes." A decoder that
    // can throw is a decoder that can abort an 843-file sweep, so totality is a
    // property worth asserting rather than assuming.
    const hostile = [
      '',
      ' ',
      '{',
      '}',
      '[',
      '{"a":}',
      '{"a":1,}',
      '"\\uD800"',
      '{"deep":' + '['.repeat(200) + ']'.repeat(200) + '}',
      '\u0000',
      '\uFEFF{}',
      '{"emoji":"👍🏽"}',
    ];
    for (const line of hostile) {
      expect(() => decodeLine(line)).not.toThrow();
    }
  });
});
