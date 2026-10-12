import { describe, expect, it } from 'vitest';
import { createNormalizer, type TranscriptRecord } from '../src/index.js';
import { hasCompactionBoundary, segmentIndexFrom } from '../src/segment.js';

/**
 * The ONE definition of a compaction boundary, and the live count that reuses it (asc-xn4g).
 *
 * The normalizer advances `segment` when it sees a boundary; the live hook needs the same number
 * WITHOUT normalizing a whole transcript on every tool call. Two counters that merely look alike
 * would be free to drift, so the equivalence below is the point of this file: the fast path is
 * only trusted because it is shown to agree with the slow one on the same records.
 */

const TS = '2026-10-12T00:00:00.000Z';

/** The shape the real corpus carries (`type: system`, `subtype: compact_boundary`). */
const compaction = (trigger: string): TranscriptRecord => ({
  type: 'system',
  subtype: 'compact_boundary',
  sessionId: 'sess-1',
  timestamp: TS,
  compactMetadata: { trigger, preTokens: 100, postTokens: 10 },
});

const prompt = (text: string): TranscriptRecord => ({
  type: 'user',
  sessionId: 'sess-1',
  timestamp: TS,
  message: { content: text },
});

const assistant = (id: string): TranscriptRecord => ({
  type: 'assistant',
  sessionId: 'sess-1',
  timestamp: TS,
  message: { content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
});

const asTranscript = (records: readonly unknown[]): string =>
  records.map((one) => JSON.stringify(one)).join('\n');

/** The segment the normalizer itself reaches, over the same records. */
const normalizerSegment = (records: readonly TranscriptRecord[]): number => {
  const normalizer = createNormalizer();
  const events = records.flatMap((one) => normalizer.accept(one, MAIN));
  events.push(...normalizer.drain());
  return events.reduce((high, event) => Math.max(high, Number(event['segment'] ?? 0)), 0);
};

const MAIN = {
  path: 'proj/sess-1.jsonl',
  project: 'proj',
  session: 'sess-1',
  kind: 'session',
} as const;

describe('segmentIndexFrom', () => {
  it('agrees with the normalizer on a mixed transcript', () => {
    // The equivalence the whole fast path rests on. Prompts, assistant records and boundaries --
    // not boundaries alone, because a boundary on a record type the normalizer skips would be
    // exactly the divergence this test exists to catch.
    const records = [
      prompt('one'),
      assistant('t1'),
      compaction('auto'),
      prompt('two'),
      assistant('t2'),
      compaction('manual'),
      prompt('three'),
    ];
    expect(segmentIndexFrom(asTranscript(records))).toBe(2);
    expect(segmentIndexFrom(asTranscript(records))).toBe(normalizerSegment(records));
  });

  it('is 0 for a transcript that has never compacted', () => {
    expect(segmentIndexFrom(asTranscript([prompt('one'), assistant('t1')]))).toBe(0);
    expect(segmentIndexFrom('')).toBe(0);
  });

  it('counts one segment per boundary, in order', () => {
    const one = asTranscript([compaction('auto')]);
    const three = asTranscript([
      compaction('auto'),
      prompt('x'),
      compaction('auto'),
      compaction('manual'),
    ]);
    expect(segmentIndexFrom(one)).toBe(1);
    expect(segmentIndexFrom(three)).toBe(3);
  });

  it('skips a line that is not JSON rather than throwing', () => {
    // A transcript being appended to can be read mid-line. A hook that threw here would exit
    // non-zero and be shown to the user as a hook error on every tool call.
    const text = `${asTranscript([compaction('auto')])}\n{"type":"user","mes`;
    expect(segmentIndexFrom(text)).toBe(1);
  });
});

describe('hasCompactionBoundary', () => {
  it('is true for the corpus shape and false for an ordinary record', () => {
    expect(hasCompactionBoundary(compaction('auto'))).toBe(true);
    expect(hasCompactionBoundary(prompt('one'))).toBe(false);
  });

  it('is false when compactMetadata is present but not an object the normalizer would read', () => {
    // The normalizer's guard is `rec(record['compactMetadata']) !== undefined`, which a null or a
    // string fails. Mirroring it exactly is what keeps the two counts equal on odd data.
    for (const value of [null, 'yes', 7, ['a']]) {
      expect(hasCompactionBoundary({ type: 'system', compactMetadata: value })).toBe(false);
    }
  });

  it('is false for a non-record', () => {
    for (const value of [null, undefined, 3, 'x', []]) {
      expect(hasCompactionBoundary(value)).toBe(false);
    }
  });
});
