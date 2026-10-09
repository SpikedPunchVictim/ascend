import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, eventFieldType, type NormalizedEvent } from '@ascend/core';
import {
  FINDING_LENSES,
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
  readonly findings: readonly NormalizedEvent[];
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
  const findings: NormalizedEvent[] = [];

  const take = (event: NormalizedEvent): void => {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (event.kind === 'model.context') contexts.push(event);
    if (event.kind === 'review.finding') findings.push(event);
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
    findings,
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
    // The key IS the event id now -- the `#2` collision suffix was retired (`asc-hbxl`), so no
    // strip is needed and this compares like for like.
    const mismatched = result.derived.filter((entry) => {
      const check = result.checks.get(entry.key);
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

  it('reads review findings from real work, which this corpus could not previously say', async () => {
    // THIS TEST WAS A TRIPWIRE, AND IT FIRED ON 2026-09-29. Its previous form asserted
    // `byKind['review.finding'] === 0`, from a measurement of 2026-09-26: `ReportFindings` had been
    // called 0 times across 1,236 transcript files and 637,258 records, so the branch's only
    // evidence was the fixtures in `normalize.test.ts`. By 2026-09-28 it had been called 33 times
    // (358 findings) -- but every one of those calls was in an EPHEMERAL probe project, which ingest
    // skips by design, so the `reported` route had still never fired on real work. That gap is what
    // the `on_skill` nudge (`handlers/review-finding-nudge.yaml`) exists to close, and it closed
    // here: a session in this project reported a review's findings rather than writing prose.
    //
    // So the zero is replaced by the positive claim the old wording explicitly said it could not
    // make -- that the branch reads real findings, and reads them into the declared vocabulary.
    // Asserting the events AND the counter is deliberate: they are two routes to one claim, and a
    // disagreement between them is the kind of silence this file exists to break.
    const result = await once();
    expect(result.findings.length).toBeGreaterThan(0);
    const slugs = FINDING_LENSES.map((lens) => lens.slug);
    for (const finding of result.findings) {
      expect(slugs).toContain(finding['category']);
    }
    expect(result.counters.offVocabularyFindings).toBe(0);
  }, 180_000);
});
