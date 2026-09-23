import { describe, expect, it } from 'vitest';
import { GUIDANCE_FIELDS, guidanceProblems } from '../src/index.js';

describe('guidanceProblems', () => {
  it('accepts no guidance at all', () => {
    expect(guidanceProblems({})).toEqual([]);
  });

  it('accepts every field when each carries real content', () => {
    expect(
      guidanceProblems({
        purpose: 'why this type exists',
        analysis_questions: ['how often does it happen?', 'in which way?'],
        interpretation_notes: '`file` is omitted when repo-wide; absence is not "no file"',
        review_after: 20,
      }),
    ).toEqual([]);
  });

  it('names the four fields, in the order a document writes them', () => {
    expect(GUIDANCE_FIELDS).toEqual([
      'purpose',
      'analysis_questions',
      'interpretation_notes',
      'review_after',
    ]);
  });

  it('refuses an empty purpose or interpretation_notes: omit the field instead', () => {
    expect(guidanceProblems({ purpose: '' })).toEqual([
      expect.stringContaining('purpose is empty'),
    ]);
    expect(guidanceProblems({ interpretation_notes: '' })).toEqual([
      expect.stringContaining('interpretation_notes is empty'),
    ]);
  });

  it('refuses an empty question list, and an empty question inside one', () => {
    expect(guidanceProblems({ analysis_questions: [] })).toEqual([
      expect.stringContaining('analysis_questions is empty'),
    ]);
    expect(guidanceProblems({ analysis_questions: ['real', ''] })).toEqual([
      expect.stringContaining('analysis_questions[1] is empty'),
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses review_after = %s: it is a count of entries, so a positive whole number',
    (value) => {
      expect(guidanceProblems({ review_after: value })).toEqual([
        expect.stringContaining('review_after'),
      ]);
    },
  );

  it('reports every problem at once rather than the first', () => {
    expect(guidanceProblems({ purpose: '', review_after: 0 })).toHaveLength(2);
  });
});
