/**
 * The one rule this store enforces on a timestamp column it orders as text.
 *
 * One copy, because there were two and that is what the defect looked like: `recorder.ts` refused
 * offsets on `recorded_at` and explained in writing that it did so because the column is compared
 * lexically, and `annotations.ts` repeated the regex and the reasoning for the pass identity. Both
 * of those guards permitted the other way text order and time order come apart.
 *
 * **Both halves are covered now, because the rule is one rule and its argument does not stop at
 * offsets.**
 *
 *   - `2026-09-11T10:00:00+02:00` is a LATER instant than `2026-09-11T09:00:00Z` and sorts BEFORE
 *     it. That is the half `recorder.ts` named, and the half that a `timestamp` property was
 *     exempt from.
 *   - `2026-09-11T10:00:00Z` is an EARLIER instant than `2026-09-11T10:00:00.500Z` and sorts AFTER
 *     it -- `Z` is 0x5A, `.` is 0x2E. That is the half neither guard named: the fraction was
 *     optional and of any width, so a ledger holding a bare `Z` beside a fractional value in the
 *     same second walks out of order and reports an inverted envelope range.
 *
 * So one form is required, and it is the form this store writes: `2000-01-01T00:00:00.000Z`. Fixed
 * width is the entire point -- two conforming values compare as text exactly as they compare as
 * instants, which is the property `profile.ts` claims for timestamp columns and, before this, only
 * asserted.
 *
 * **What requiring it costs.** Measured 2026-10-07 against this project's own ledgers: 7248 of 7248
 * `recorded_at` values in the entry files carry `.mmmZ`, and so do 3905 of 3905 `created_at` values
 * in the annotation files. `packages/cli/src/base.ts:273` produces the former from `toISOString()`,
 * which cannot produce any other width. So the fixed form refuses nothing that exists and nothing a
 * caller can reach -- the two columns this rule guards are written by this store, unlike the
 * property below.
 *
 * **Where this rule does NOT reach, and why that is a decision rather than an oversight.** A
 * `timestamp` PROPERTY is validated by `@ascend/core`'s schema (`schema.ts`) -- a lower layer,
 * which cannot import this one -- and that validator refuses offsets while leaving precision to the
 * writer. Measured the same day: `measured_on`, a property people type by hand, holds 18 distinct
 * values of which **16 are bare `Z`**, against `occurred_at`'s 4166 distinct written by an adapter
 * and conforming in every one. Demanding milliseconds of a hand-written property would have made
 * live rows unreadable -- `findEntry` re-validates every row against its spec on read -- and refused
 * a spelling nobody would think to avoid. The residual is real and is stated rather than hidden: two
 * values of ONE property, in the same second, differing in precision, still compare out of order.
 * `profile.ts`'s note on its range summary says so.
 */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Refuse a timestamp that is not in the one form above.
 *
 * `why` is the caller's own sentence for what goes wrong in ITS column -- the ledger stops sorting
 * chronologically, the annotation passes stop grouping -- because the rule is shared but the
 * consequence is local, and whoever reads the message is looking at their own column. What both
 * columns share, the form and the reason for it, is stated here once.
 */
export function requireUtcTimestamp(field: string, value: string, why: string): void {
  if (!UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(
      `${field} must be an ISO-8601 UTC timestamp with milliseconds (e.g. ` +
        `2026-09-17T10:00:00.000Z), got ${JSON.stringify(value)}. Offsets, local times and ` +
        `variable fractional seconds are refused because ${why}.`,
    );
  }
}
