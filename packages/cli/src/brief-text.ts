/**
 * The text of `asc types brief`, shared with `asc doctor` (asc-12a) so that the size doctor
 * reports is the size of what the brief actually prints -- a second rendering would be a second
 * number that could drift from the first.
 */

import type { TypeSummary } from '@ascend/store';

/**
 * The byte count this command refuses to exceed on its own stdout.
 *
 * Below every point measured **delivered** (8,990 bytes arrived whole) and below the smallest point
 * measured **truncated** (10,495), so the cap sits inside the region the measurement covers rather
 * than at its edge. The ceiling itself is bracketed, not located -- the bead says in as many words
 * not to quote a figure for it -- so the ~990 bytes of headroom (11%) are a judgement, stated here
 * as one rather than implied, and this constant is the single place to move it.
 *
 * The unit is BYTES because that is what the platform counts: `bd prime` at 47,381 bytes was
 * reported in this repository's own session as "Output too large (46.3KB)", and 47,381 / 1024 =
 * 46.3 exactly. A cap in code points would be the wrong unit by a factor that varies with the
 * text.
 */
export const BRIEF_CAP_BYTES = 8_000;

/**
 * Whether a type holds at least the entries its `review_after` names (asc-bli.6).
 *
 * A LEVEL, where `asc record`'s advisory is an edge: the advisory speaks once, on the write that
 * crosses; the brief states, every session, that the point has been reached. It stays true until
 * someone raises `review_after` -- dismissal is a real act of intent, and there is no snooze state
 * by design. It is never a gate and never a claim of statistical sufficiency; nobody measured one.
 */
export function reviewAfterReached(summary: TypeSummary): boolean | undefined {
  return summary.reviewAfter === null ? undefined : summary.entryCount >= summary.reviewAfter;
}

/**
 * The line a model reads. Recorded-never is stated, not left blank -- blank reads as "unknown".
 *
 * A reached `review_after` marks the existing line rather than adding a section, and costs nothing
 * on a type that has not reached it: this is the SessionStart payload, and EV-16 measured its cost
 * as linear in lines, so a header or a per-type count on every line would be a tax on every session.
 */
export function briefLine(summary: TypeSummary): string {
  const marker =
    reviewAfterReached(summary) === true
      ? ` [review_after ${String(summary.reviewAfter)} reached: ${String(summary.entryCount)} entries]`
      : '';
  return summary.recordWhen === null
    ? `${summary.name}${marker} -- no record_when given`
    : `${summary.name}${marker} -- ${summary.recordWhen}`;
}
