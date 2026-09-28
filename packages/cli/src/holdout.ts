/**
 * The train/holdout split `asc annotate --backtest --holdout` grades a rule on (asc-z41.2).
 *
 * A rule written after reading the whole hand sample can score well by reproducing it, so a score
 * over that sample measures fit, not generalisation. Holding some of the sample out, and scoring
 * the rule there separately, is what separates the two.
 *
 * **The split is a hash of each entry id, seeded, and so it never reshuffles.** Every backtest of
 * one hand scheme puts every entry on the same side, whatever the rule or the run. A split drawn
 * afresh per run would show the author a different holdout each time, and after a few runs they
 * would have seen all of it -- which is the same as having no holdout.
 *
 * **What this cannot do** is stop an author who keeps editing the rule until the holdout score
 * looks good: that fits the holdout too. The command's half of the defence is to report holdout
 * rows WITHOUT the ids of the entries they got wrong (`annotate.ts`), so that the natural next
 * step -- read the misses, fix the rule -- only ever reads training entries.
 */

import { createHash } from 'node:crypto';

/** Whether `id` falls in the holdout, for a given seed and holdout fraction (0 < fraction < 1). */
export function isHeldOut(id: string, seed: string, fraction: number): boolean {
  const digest = createHash('sha256').update(`${seed}\u0000${id}`).digest();
  // The first four bytes as an unsigned integer, scaled to [0, 1).
  return digest.readUInt32BE(0) / 0x1_0000_0000 < fraction;
}

export interface Split<T> {
  readonly train: readonly T[];
  readonly holdout: readonly T[];
}

/** `items` divided by `isHeldOut`, preserving their order on each side. */
export function splitHoldout<T extends { readonly id: string }>(
  items: readonly T[],
  seed: string,
  fraction: number,
): Split<T> {
  const train: T[] = [];
  const holdout: T[] = [];
  for (const item of items) (isHeldOut(item.id, seed, fraction) ? holdout : train).push(item);
  return { train, holdout };
}

/**
 * The `--holdout` value as a fraction strictly between 0 and 1, or a message saying why not.
 * Zero and one are refused: either leaves one side empty, and a score over nothing is not a score.
 */
export function parseHoldoutFraction(raw: string): number | string {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    return `--holdout takes a fraction strictly between 0 and 1, such as 0.3; got '${raw}'.`;
  }
  return value;
}
