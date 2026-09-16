import { describe, expect, it } from 'vitest';
import {
  assistReason,
  buildAssist,
  renderAssist,
  type SearchAssist,
} from '../src/search-assist.js';

/**
 * The zero-result assist as a function.
 *
 * The whole reason this module takes `{entries, indexed}` rather than reaching for a database is
 * that the interesting cases are boundaries, and a boundary is one line here against one fixture
 * there. The three exhaustively-ordered cases below -- empty type, unindexed type, plain miss -- are
 * the entire decision the assist makes about why a search failed, and getting the ORDER wrong is the
 * failure that matters: a type with no entries also has no indexed documents, so a test that only
 * covered "no indexed documents" would pass on an implementation that told every caller with an
 * empty project that their entries were unsearchable.
 *
 * The wording is asserted by substring rather than in full. A test that pins a rendered paragraph
 * character for character fails on every rewording, which trains a reader to update the expectation
 * without reading it -- and the expectations worth defending here are the facts (the two numbers, the
 * reason code, whether values are named at all), not the sentences carrying them.
 */

const reason = (entries: number, indexed: number): string => assistReason({ entries, indexed });

describe('assistReason', () => {
  it('names an empty type before it names an unindexed one', () => {
    // The overlap case, and the only one where the order of two tests is observable: 0 entries
    // implies 0 indexed, so both conditions are true and exactly one is the useful answer.
    expect(reason(0, 0)).toBe('type-empty');
  });

  it('names a type whose entries carry no evidence', () => {
    expect(reason(486, 0)).toBe('nothing-indexed');
  });

  it('names a plain miss on a searchable type', () => {
    expect(reason(486, 486)).toBe('no-match');
  });

  it('names a miss on a PARTLY indexed type as a plain miss', () => {
    // Measured on the frozen corpus, this is the ordinary shape rather than the exotic one: 1,491
    // entries of which 20 are indexed. The reason is still `no-match`, because the query is what
    // failed -- the counts are what tell the caller the search only saw part of the type, and they
    // travel on the assist either way.
    expect(reason(1491, 20)).toBe('no-match');
  });

  it('treats one entry carrying evidence as searchable', () => {
    expect(reason(1, 1)).toBe('no-match');
  });
});

describe('buildAssist', () => {
  it('carries the two counts through unchanged', () => {
    const assist = buildAssist({ entries: 486, indexed: 0 }, []);
    expect(assist.entries).toBe(486);
    expect(assist.indexed).toBe(0);
    expect(assist.reason).toBe('nothing-indexed');
  });

  it('reports an empty value list rather than omitting the field', () => {
    // The field's presence is what distinguishes "searched for property values and found none" from
    // "did not search", which is the distinction every optional block in this CLI makes.
    expect(buildAssist({ entries: 20, indexed: 20 }, []).values).toEqual([]);
  });

  it('projects a store hit down to the three fields the contract names', () => {
    const assist = buildAssist({ entries: 486, indexed: 0 }, [
      { property: 'runner', value: 'cargo test', entries: 127 },
    ]);
    expect(assist.values).toEqual([{ property: 'runner', value: 'cargo test', entries: 127 }]);
  });
});

describe('renderAssist', () => {
  const assist = (
    reason: SearchAssist['reason'],
    values: SearchAssist['values'] = [],
  ): SearchAssist =>
    buildAssist(
      { entries: reason === 'type-empty' ? 0 : 486, indexed: reason === 'no-match' ? 486 : 0 },
      values,
    );

  it('says an empty type has nothing to find, and does not mention the index', () => {
    const text = renderAssist(assist('type-empty'));
    expect(text).toContain('no matches');
    expect(text).toContain('no entries yet');
    // The distinction the reason code exists for: a caller with an empty project must not be sent
    // looking for a problem with the index, which is what the unindexed wording would do.
    expect(text).not.toContain('index holds');
  });

  it('states both counts and tells an unindexed caller to stop rewording', () => {
    const text = renderAssist(assist('nothing-indexed'));
    expect(text).toContain('486 entries');
    expect(text).toContain('index holds none');
    expect(text).toContain('will not help');
  });

  it('states the indexed share on a plain miss', () => {
    const text = renderAssist(assist('no-match'));
    expect(text).toContain('486 entries');
    expect(text).toContain('holds 486');
  });

  it('names each property value with the count that makes it a measurement', () => {
    const text = renderAssist(
      assist('nothing-indexed', [{ property: 'runner', value: 'cargo test', entries: 127 }]),
    );
    expect(text).toContain('runner = "cargo test"');
    expect(text).toContain('127 entries');
  });

  it('quotes a value so a value holding a quote cannot read as prose', () => {
    const text = renderAssist(
      assist('nothing-indexed', [{ property: 'note', value: 'say "hi"', entries: 1 }]),
    );
    expect(text).toContain('note = "say \\"hi\\""');
  });

  it('says no property value matched, rather than showing an empty section', () => {
    // The alternative -- a heading with nothing under it -- reads as a rendering failure, and a
    // caller cannot tell it from an assist that never ran the property lookup.
    expect(renderAssist(assist('no-match'))).toContain('No property value of this type contains');
  });

  it('omits that line when values WERE found', () => {
    const text = renderAssist(
      assist('nothing-indexed', [{ property: 'runner', value: 'cargo test', entries: 127 }]),
    );
    expect(text).not.toContain('No property value of this type contains');
  });

  it('writes one entry as "1 entry", not "1 entries"', () => {
    // A line that says "1 entries" is a line whose reader stops trusting its numbers, and the
    // numbers are the entire content of this block.
    const text = renderAssist(assist('no-match', [{ property: 'note', value: 'x', entries: 1 }]));
    expect(text).toContain('(1 entry)');
    expect(text).not.toContain('(1 entries)');
  });

  it('never claims a match', () => {
    // The assist is advisory in the same sense mast's is: a suggestion that read as a result would
    // be counted as one by a caller skimming, which is the one way this block can do harm.
    for (const reason of ['type-empty', 'nothing-indexed', 'no-match'] as const) {
      expect(renderAssist(assist(reason))).toContain('no matches');
    }
  });
});
