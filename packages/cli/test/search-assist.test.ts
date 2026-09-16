import { describe, expect, it } from 'vitest';
import {
  assistReason,
  buildAssist,
  renderAssist,
  type SearchAssist,
} from '../src/search-assist.js';

/**
 * The search assist as a function.
 *
 * The whole reason this module takes `{entries, indexed}` rather than reaching for a database is
 * that the interesting cases are boundaries, and a boundary is one line here against one fixture
 * there. The four exhaustively-ordered cases below -- rows returned, empty type, unindexed type,
 * plain miss -- are the entire decision the assist makes about what a search has to say for itself,
 * and getting the ORDER wrong is the failure that matters. Two overlaps are live: `rows-returned`
 * dominates all three zero-result codes, because a search that returned rows is not a dead end of
 * any kind; and a type with no entries also has no indexed documents, so a test that only covered
 * "no indexed documents" would pass on an implementation that told every caller with an empty
 * project that their entries were unsearchable.
 *
 * The wording is asserted by substring rather than in full. A test that pins a rendered paragraph
 * character for character fails on every rewording, which trains a reader to update the expectation
 * without reading it -- and the expectations worth defending here are the facts (the two numbers, the
 * reason code, whether values are named at all), not the sentences carrying them.
 */

const reason = (entries: number, indexed: number, rowsReturned = false): string =>
  assistReason({ entries, indexed }, rowsReturned);

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

  it('names returned rows ahead of every zero-result code', () => {
    // The four overlap cases, all at once. Each of these counts would otherwise produce a
    // zero-result code, and every one of them is the wrong thing to tell a caller whose search
    // succeeded -- `nothing-indexed` in particular, which instructs the reader to stop rewording
    // because no query can match. That instruction, printed under a result set, is the defect this
    // case was added for.
    expect(reason(1491, 20, true)).toBe('rows-returned');
    expect(reason(486, 486, true)).toBe('rows-returned');
    expect(reason(486, 0, true)).toBe('rows-returned');
    expect(reason(0, 0, true)).toBe('rows-returned');
  });
});

describe('buildAssist', () => {
  it('carries the two counts through unchanged', () => {
    const assist = buildAssist({ entries: 486, indexed: 0 }, [], false);
    expect(assist.entries).toBe(486);
    expect(assist.indexed).toBe(0);
    expect(assist.reason).toBe('nothing-indexed');
  });

  it('reports an empty value list rather than omitting the field', () => {
    // The field's presence is what distinguishes "searched for property values and found none" from
    // "did not search", which is the distinction every optional block in this CLI makes.
    expect(buildAssist({ entries: 20, indexed: 20 }, [], false).values).toEqual([]);
  });

  it('projects a store hit down to the three fields the contract names', () => {
    const assist = buildAssist(
      { entries: 486, indexed: 0 },
      [{ property: 'runner', value: 'cargo test', entries: 127 }],
      false,
    );
    expect(assist.values).toEqual([{ property: 'runner', value: 'cargo test', entries: 127 }]);
  });

  it('takes rowsReturned from its caller rather than inferring it from the counts', () => {
    // The counts describe the type and cannot say whether THIS query matched. A build that guessed
    // `entries > 0 && indexed > 0` would mark every miss on a populated type as a success.
    const scope = { entries: 486, indexed: 486 };
    expect(buildAssist(scope, [], false).reason).toBe('no-match');
    expect(buildAssist(scope, [], true).reason).toBe('rows-returned');
  });
});

describe('renderAssist', () => {
  const assist = (
    reason: SearchAssist['reason'],
    values: SearchAssist['values'] = [],
  ): SearchAssist =>
    buildAssist(
      {
        entries: reason === 'type-empty' ? 0 : 486,
        // A search that returned rows came from a type that has them and indexes them, so the
        // searchable shape is the only one that can carry this reason.
        indexed: reason === 'no-match' || reason === 'rows-returned' ? 486 : 0,
      },
      values,
      reason === 'rows-returned',
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

  it('does NOT say "no matches" when rows came back', () => {
    // The lead line is the whole difference between the two paths, and printing it under a result
    // set would be the exact falsehood this block exists to prevent -- committed by the block
    // itself. Asserted as an absence because the risk is a line left in from the zero-result path.
    const text = renderAssist(assist('rows-returned'));
    expect(text).not.toContain('no matches');
    expect(text).not.toContain('will not help');
  });

  it('says where else the terms occur when rows came back and values were found', () => {
    const text = renderAssist(
      assist('rows-returned', [{ property: 'error_text', value: 'module not found', entries: 3 }]),
    );
    expect(text).toContain('also occur as property values');
    expect(text).toContain('error_text = "module not found"');
    expect(text).toContain('3 entries');
  });

  it('says the result is complete when rows came back and nothing else holds the terms', () => {
    // The reassuring half, and the reason this block earns its cost on the rows>0 path: without it
    // a caller cannot tell "nothing is withheld" from "nothing was looked for", which is the same
    // silence the zero-result path was built to break.
    const text = renderAssist(assist('rows-returned'));
    expect(text).toContain('nowhere else in');
    expect(text).not.toContain('either');
  });
});

// The call-site gate that produced the defect -- an assist built only when `rows.length === 0` -- is
// guarded where a caller reaches it rather than here: `search-cli.test.ts`, 'offers the property
// values a RESULT SET does not cover'. A source scan would have been the cheaper guard and the worse
// one: it asserts the shape of an expression, where the behavioural test asserts that a search
// returning rows still reports what it does not cover -- which is the property, not the text.
