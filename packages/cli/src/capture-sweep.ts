/**
 * The corpus side of a capture plan (asc-tuur.5): stream a project's transcripts through the
 * planner, draft from the strongest table signal, and verify the draft by running it through the
 * typed-handler path ingest uses. Shared by `asc types capture`, which prints all of it, and
 * `asc types define`, which says in one line whether there is anything to capture.
 */

import { MIN_N } from '@ascend/analysis';
import { streamCorpus } from '@ascend/adapter-claude-code';
import { validateEntry, type TypeSpec } from '@ascend/core';
import {
  createCapturePlanner,
  draftSayHandler,
  draftTableHandler,
  type CapturePlan,
} from './capture-plan.js';
import { loadHandler } from './handler-yaml.js';
import { createHandlerProducer } from './typed-handlers.js';

export interface CaptureSweep {
  readonly files: number;
  /**
   * Paths the sweep could not read, so the plan below is over a corpus that was not read in full.
   *
   * `files` counts DISCOVERED transcripts (`reader.ts:517`), not read ones, so it stays non-zero
   * over a corpus where every file failed to open -- which is why a caller gating on `files` alone
   * reports "nothing to capture" rather than "nothing could be read". This is the second fact:
   * `totals.failures` is per-file incomplete reads, and a directory the walk may not enter is
   * recorded by the reader as an `'unreadable'` skip (`reader.ts:263`). Summed for the reason
   * `handler-replay.ts:244` sums them: the fact is the same one -- records that exist and did not
   * reach the plan.
   *
   * `'symlink'` is not counted. Not following one is a decision the walk makes, not damage it
   * suffered, and a healthy corpus can hold one.
   */
  readonly unreadable: number;
  readonly plan: CapturePlan;
  readonly table: string | undefined;
  readonly say: string | undefined;
  readonly verified: Verification | undefined;
}

type SweepOptions = NonNullable<Parameters<typeof streamCorpus>[1]>;

/** Plan capture for `spec` over the transcripts `options` names. Reads; writes nothing. */
export async function sweepCapture(spec: TypeSpec, options: SweepOptions): Promise<CaptureSweep> {
  const planner = createCapturePlanner(spec);
  const totals = await streamCorpus((record, file) => {
    planner.accept(record, file);
  }, options);
  const plan = planner.finish();
  const best = plan.tables[0];
  const table =
    best === undefined ? undefined : draftTableHandler(spec, best, sessionsNote(best.sessions));
  const say = best === undefined ? undefined : draftSayHandler(spec, best);
  const verified = table === undefined ? undefined : await verify(spec, table, options);
  return {
    files: totals.files,
    unreadable:
      totals.failures.length +
      totals.skipped.filter((entry) => entry.reason === 'unreadable').length,
    plan,
    table,
    say,
    verified,
  };
}

/** `n session(s)`, flagged when it is under `MIN_N`. */
export function sessionsNote(n: number): string {
  return n < MIN_N
    ? `${String(n)} session(s) -- under ${String(MIN_N)}, an anecdote`
    : `${String(n)} sessions`;
}

/** What the draft would do if saved: rows it writes, rows the type refuses, and why. */
export interface Verification {
  readonly rows: number;
  readonly valid: number;
  readonly refused: number;
  /** Refused rows per field, most common first. */
  readonly reasons: readonly (readonly [string, number])[];
}

/** Compile the draft and run it over the same transcripts, the way ingest would. */
async function verify(spec: TypeSpec, draft: string, options: SweepOptions): Promise<Verification> {
  const specFor = (type: string): TypeSpec | undefined => (type === spec.name ? spec : undefined);
  const handler = loadHandler(draft);
  if (handler.type === undefined) throw new Error('a table draft always declares its type');
  const producer = createHandlerProducer(
    [{ name: 'draft', handler: { ...handler, type: handler.type } }],
    specFor,
  );
  await streamCorpus((record, file) => {
    producer.accept(record, file);
  }, options);
  const { entries, outcomes } = producer.finish(new Map());
  const reasons = new Map<string, number>();
  let valid = 0;
  for (const entry of entries) {
    const result = validateEntry(spec, { properties: entry.properties });
    if (result.ok) {
      valid += 1;
      continue;
    }
    // Rows per field, not issues: one row can carry two issues on one field.
    for (const field of new Set(result.errors.map((issue) => issue.field))) {
      reasons.set(field, (reasons.get(field) ?? 0) + 1);
    }
  }
  return {
    rows: outcomes[0]?.rows ?? entries.length,
    valid,
    refused: entries.length - valid,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
  };
}
