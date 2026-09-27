import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, eventFieldType, type NormalizedEvent } from '@ascend/core';
import {
  createDeriver,
  createNormalizer,
  defaultTranscriptRoot,
  streamCorpus,
  type NormalizeCounters,
} from '../src/index.js';

/**
 * The normalizer over the REAL corpus, read-only, beside the deriver on the same records.
 *
 * `check.run` must read every verdict exactly as `verification_run` v2 does, because both
 * call `checkRun` and `readVerdict`. The deriver keeps only verdict changes, so the comparison
 * is: every `verification_run` entry has a `check.run` with its tool-use id and the same
 * verdict and source, and the measured / not-measured split equals the deriver's own counts.
 * Asserted as invariants, because the corpus is live and its counts move.
 *
 * Skips where `~/.claude/projects` does not exist, like `derive-real-corpus.test.ts`.
 */

const available = existsSync(defaultTranscriptRoot());

interface Sweep {
  readonly counters: NormalizeCounters;
  readonly byKind: Readonly<Record<string, number>>;
  readonly undeclared: readonly string[];
  readonly nonMonotonic: number;
  readonly checks: ReadonlyMap<string, NormalizedEvent>;
  readonly measured: number;
  readonly notMeasured: number;
  readonly derived: readonly { key: string; verdict: unknown; source: unknown }[];
  readonly deriverMasked: number;
  readonly deriverUnverdictable: number;
  readonly streams: number;
  readonly contexts: readonly NormalizedEvent[];
}

async function sweep(): Promise<Sweep> {
  const normalizer = createNormalizer();
  const deriver = createDeriver();
  const byKind: Record<string, number> = {};
  const undeclared = new Set<string>();
  const checks = new Map<string, NormalizedEvent>();
  const derived: { key: string; verdict: unknown; source: unknown }[] = [];
  let measured = 0;
  let notMeasured = 0;
  let nonMonotonic = 0;
  let streams = 0;
  let lastSeq = -1;
  const contexts: NormalizedEvent[] = [];

  const take = (event: NormalizedEvent): void => {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (event.kind === 'model.context') contexts.push(event);
    if (!Object.hasOwn(EVENT_KINDS, event.kind)) undeclared.add(event.kind);
    for (const field of Object.keys(event)) {
      if (eventFieldType(event.kind, field) === undefined) undeclared.add(`${event.kind}.${field}`);
    }
    if (event.seq !== lastSeq + 1) nonMonotonic += 1;
    lastSeq = event.kind === 'session.end' ? -1 : event.seq;
    if (event.kind === 'session.end') streams += 1;
    if (event.kind === 'check.run') {
      if (event['verdict_state'] === 'measured') measured += 1;
      else notMeasured += 1;
      checks.set(`${event.session_id}:${String(event['id'])}`, event);
    }
  };

  await streamCorpus((record, file) => {
    for (const event of normalizer.accept(record, file)) take(event);
    for (const entry of deriver.accept(record, file)) {
      if (entry.type !== 'verification_run') continue;
      derived.push({
        key: entry.key,
        verdict: entry.properties['verdict'],
        source: entry.properties['verdict_source'],
      });
    }
  }, {});
  for (const event of normalizer.drain()) take(event);
  deriver.drain();

  return {
    counters: normalizer.counters,
    byKind,
    undeclared: [...undeclared],
    nonMonotonic,
    checks,
    measured,
    notMeasured,
    derived,
    deriverMasked: deriver.counters.masked,
    deriverUnverdictable: deriver.counters.unverdictable,
    streams,
    contexts,
  };
}

let shared: Promise<Sweep> | undefined;
const once = (): Promise<Sweep> => (shared ??= sweep());

describe.skipIf(!available)('the normalizer against the real corpus', () => {
  it('emits only declared kinds and fields, in seq order, one session.end per stream', async () => {
    const result = await once();
    expect(result.undeclared).toEqual([]);
    expect(result.nonMonotonic).toBe(0);
    expect(result.streams).toBeGreaterThan(100);
    for (const kind of [
      'prompt.submit',
      'tool.use.end',
      'command.run',
      'search.run',
      'file.read',
      'file.changed',
      'check.run',
      'agent.spawn',
      'model.context',
    ]) {
      expect(result.byKind[kind] ?? 0, kind).toBeGreaterThan(10);
    }
  }, 180_000);

  /**
   * The end-to-end half of `model.context` (asc-6ola.10). `normalize.test.ts` drives the semantics
   * against object literals, which cannot show that `message.model` and the top-level `version`
   * survive `decode.ts` and the reader on the way in -- a field dropped there would leave every
   * literal test passing and the real key empty.
   */
  it('reads a real model and harness version, and never carries a synthetic one', async () => {
    const result = await once();
    // Measured 2026-09-26: 1,226 context events over 1,231 streams, 93 synthetic assistant
    // records skipped. The count itself is not asserted -- the corpus is live -- so what is
    // asserted is that each guard has observations rather than passing on an empty set.
    expect(result.contexts.length).toBeGreaterThan(100);
    expect(result.counters.syntheticModelRecords).toBeGreaterThan(0);
    for (const event of result.contexts) {
      expect(event['model'], 'a context event with no model').toBeDefined();
      expect(event['model']).not.toBe('<synthetic>');
      // Half the key. A harness that stops writing `version` should fail this rather than let
      // the stratification quietly lose its other dimension.
      expect(event['harness_version'], String(event['model'])).toBeDefined();
    }
  }, 180_000);

  it('reads every check verdict the deriver reads, and the same one', async () => {
    const result = await once();
    // The deriver's keys may carry a `#2` collision suffix; the event id never does.
    const mismatched = result.derived.filter((entry) => {
      const check = result.checks.get(entry.key.replace(/#\d+$/, ''));
      return (
        check === undefined ||
        check['verdict'] !== entry.verdict ||
        check['verdict_source'] !== entry.source
      );
    });
    expect(mismatched.slice(0, 10)).toEqual([]);
    expect(result.derived.length).toBeGreaterThan(50);
  }, 180_000);

  it('splits measured and not-measured exactly as the deriver counts masked runs', async () => {
    const result = await once();
    expect(result.notMeasured).toBe(result.deriverMasked + result.deriverUnverdictable);
    expect(result.measured).toBeGreaterThan(result.derived.length);
  }, 180_000);

  it('has NEVER seen a review finding, which is the only thing it can say', async () => {
    const result = await once();
    // The zero is the assertion, and it is deliberately the SHAPE of the zero that is checked:
    // both counters are asserted, so the day either is non-zero this goes red and names which.
    //
    // What this does NOT establish, and the distinction is the whole reason this test is worded
    // this way: it is not evidence that the `review.finding` branch works. Measured 2026-09-26,
    // `ReportFindings` has been called 0 times across 1,236 transcript files and 637,258
    // records, so this branch has never been reached by a real corpus at all -- the fixtures in
    // `normalize.test.ts` are its entire evidence, and a green run here means the corpus had
    // nothing to say rather than that the code agrees with it.
    expect(result.byKind['review.finding'] ?? 0).toBe(0);
    expect(result.counters.offVocabularyFindings).toBe(0);
  }, 180_000);
});
