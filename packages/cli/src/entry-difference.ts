import { canonicalJson } from '@ascend/core';

/**
 * What a re-derived entry differs from the stored one in, and whether every difference is a
 * redaction (asc-o3tn, asc-j0vh).
 *
 * Ingest refuses a re-derived entry whose id is already held by different content -- rightly,
 * since entries are immutable. What it said about WHY was a guess: "a transcript edited after it
 * was ingested". Measured on the live store 2026-09-27, 994 of 994 refused ids were rows holding
 * redaction placeholders (`<user>`, `<project-B>`, `<org-B>`) where the transcript holds the real
 * value, and the transcripts had not been edited at all. So this names the fields that differ
 * instead of a cause, and marks which of them the stored copy holds redacted, rather than asserting
either. Redaction is rarely the whole difference: on the same store every redacted row also held
an absolute `cwd` that the deriver has written project-relative since asc-tlc.
 */

/**
 * The parts of an entry this compares: everything that is NOT its id. Both a `RecordedEntry` (read
 * back from the store) and a `DerivedEntry` (proposed by this sweep) satisfy it, which is what lets
 * a preview compare two proposals without a stored row to hand.
 */
export interface Comparable {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly cwd?: string | null;
  readonly branch?: string | null;
  readonly evidenceText?: string | null;
}

export interface EntryDifference {
  /** `cwd`, `branch`, `evidenceText` and `properties.<name>`, sorted. Empty when the two agree. */
  readonly fields: readonly string[];
  /**
   * The differing fields whose stored value is a placeholder standing where the derived entry has
   * real text, sorted. A subset of `fields`; equal to it when redaction is the whole difference.
   */
  readonly redacted: readonly string[];
}

/**
 * The shape of every placeholder measured in the store: `<user>`, `<org-B>`, `<project-A>`,
 * `<service-A>`, `<tmpdir-id>` -- a lowercase word, optionally with one suffix.
 */
const PLACEHOLDER = /<[a-z]+(?:-[A-Za-z0-9]+)?>/g;

function valuesOf(entry: Comparable): Map<string, string> {
  const values = new Map<string, string>([
    ['cwd', canonicalJson(entry.cwd ?? null)],
    ['branch', canonicalJson(entry.branch ?? null)],
    ['evidenceText', canonicalJson(entry.evidenceText ?? null)],
  ]);
  for (const [name, value] of Object.entries(entry.properties)) {
    values.set(`properties.${name}`, canonicalJson(value ?? null));
  }
  return values;
}

/** Whether `derived` is `stored` with each placeholder filled by some non-empty text. */
function fillsPlaceholders(stored: string, derived: string): boolean {
  const parts = stored.split(PLACEHOLDER);
  if (parts.length === 1) return false;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.+?')}$`, 's').test(derived);
}

export function entryDifference(stored: Comparable, derived: Comparable): EntryDifference {
  const before = valuesOf(stored);
  const after = valuesOf(derived);
  const fields = [...new Set([...before.keys(), ...after.keys()])]
    .filter((field) => (before.get(field) ?? 'null') !== (after.get(field) ?? 'null'))
    .sort();
  const redacted = fields.filter((field) =>
    fillsPlaceholders(before.get(field) ?? '', after.get(field) ?? ''),
  );
  return { fields, redacted };
}
