/**
 * The compaction boundary, defined ONCE (asc-xn4g).
 *
 * A holdout unit is one compaction segment of one stream (`unitKey`, `handler-replay.ts`), so
 * "which segment am I in" is a number two different callers need: the normalizer, which stamps
 * `segment` on every event it emits, and the live hook, which must decide an arm at the moment it
 * speaks. The hook cannot get the number from the normalizer -- it is handed one turn's records,
 * not a transcript, so its normalizer always sits at segment 0 -- and counting compactions a
 * second way would be two implementations of one definition, free to drift apart silently.
 *
 * So the predicate lives here and both callers use it: `createNormalizer` advances `segment` with
 * it, and `segmentIndexFrom` counts a transcript's boundaries with it. The test beside this file
 * asserts the two agree on the same records, which is what makes the cheap path trustworthy rather
 * than merely similar.
 *
 * **A record is a boundary when it carries a `compactMetadata` OBJECT.** That is the whole rule,
 * and it is the normalizer's own guard: a `null`, a string or an array does not open a segment.
 * The observed corpus shape is `type: "system"` with `subtype: "compact_boundary"`, but the
 * predicate deliberately does not test those, because the normalizer does not -- keying on more
 * than the normalizer keys on would make the two counts disagree on exactly the odd records this
 * module exists to keep them agreeing on.
 */

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Whether `record` opens the next compaction segment. See the module doc for the rule. */
export function hasCompactionBoundary(record: unknown): boolean {
  const one = rec(record);
  return one !== undefined && rec(one['compactMetadata']) !== undefined;
}

/**
 * How many compaction boundaries a transcript holds -- the segment index its last event is in.
 *
 * Reads the transcript's JSONL text rather than normalizing it, because this runs on every tool
 * call and a whole-transcript normalize is not a price a hook may charge. A line that is not JSON
 * is skipped: a transcript being appended to can be read mid-line, and a hook that threw would
 * exit non-zero, which the harness shows the user on every tool call.
 */
export function segmentIndexFrom(text: string): number {
  let segment = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (hasCompactionBoundary(record)) segment += 1;
  }
  return segment;
}
