/**
 * Pure decoding of one transcript line.
 *
 * No `fs`, no clock, no environment: the same string always yields the same
 * result, so every branch below is reachable by passing a string literal rather
 * than by laying down a file. That split is what makes the reader's tolerance
 * contract provable -- `reader.ts` owns the I/O, this owns the judgement about
 * what a line IS, and the judgement is the part worth testing precisely.
 *
 * Deliberately shallow. A decoded record is a JSON object and nothing more: no
 * per-field validation lives here. Every field a derived type needs is optional
 * in the corpus and its absence is meaningful (see ARCHITECTURE.md on the three
 * states, which exist because absent-vs-zero cannot be recovered once destroyed), so a validator at this
 * layer could only guess at which fields matter. Guessing here would silently
 * drop records that a type registered tomorrow would have used.
 */

/**
 * A parsed transcript line. Opaque on purpose -- the record's shape is the
 * corpus's business, not this module's. Consumers narrow field by field.
 *
 * Note the consequence of `noPropertyAccessFromIndexSignature`: `record.sessionId`
 * does not compile. That is the point. Every field read must be narrowed from
 * `unknown` at the point of use, because every field is absent on some real line.
 */
export type TranscriptRecord = Record<string, unknown>;

/**
 * Why a line did not decode. Three distinct things, counted separately, because
 * they mean different things to whoever is reading the counters:
 *
 * - `empty`   -- a blank line. Normal in a JSONL file; NOT a defect.
 * - `not_json`-- a line that is not JSON at all: a truncated tail from a process
 *                killed mid-write, or a partially-flushed buffer.
 * - `not_object` -- valid JSON that is not an object (a bare number, a string,
 *                an array). Structurally valid, semantically not a record.
 *
 * Collapsing these into one "bad lines" number would make a healthy file with
 * trailing newlines look corrupt, and a genuinely truncated file look healthy.
 */
export type DecodeFailure = 'empty' | 'not_json' | 'not_object';

export type DecodedLine =
  | { readonly ok: true; readonly record: TranscriptRecord }
  | { readonly ok: false; readonly failure: DecodeFailure };

/** The byte-order mark a text editor or a BOM-emitting writer prepends. Not JSON whitespace. */
const BOM = '\uFEFF';

/**
 * Decode one line. Total: never throws, for any input.
 *
 * `empty` is decided on the TRIMMED line, so a whitespace-only line is blank
 * rather than malformed. `JSON.parse` accepts leading/trailing whitespace, so
 * this only moves genuinely-blank lines out of the malformed count. `String.prototype.trim`
 * treats U+FEFF as whitespace too (ECMAScript's own `WhiteSpace` production includes it), which
 * is why a line holding nothing BUT a BOM already classifies as `empty` rather than reaching the
 * strip below.
 *
 * A SINGLE leading BOM is stripped before parsing (`asc-c10`): `JSON.parse` rejects U+FEFF as a
 * syntax error even though it is invisible in an editor and legal at the front of a UTF-8 file
 * per the Unicode standard, so a line whose JSON payload is perfectly well formed classified as
 * `not_json` -- indistinguishable, in the reader's undifferentiated `malformed` total, from
 * genuine truncation. Only ONE is stripped, and only at the very front: a line with two,
 * `\uFEFF\uFEFF{...}`, still fails to parse and is reported as `not_json` rather than silently
 * unwrapped twice, because a doubled mark is evidence of something stranger than routine
 * encoding and this function's job is to tolerate the routine case, not every case. A BOM
 * appearing anywhere else in the line -- inside a JSON string's own content, say -- is untouched:
 * only a match at index 0 is a byte-order mark, everywhere else it is data.
 */
export function decodeLine(line: string): DecodedLine {
  if (line.trim().length === 0) return { ok: false, failure: 'empty' };

  const unmarked = line.startsWith(BOM) ? line.slice(BOM.length) : line;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unmarked);
  } catch {
    return { ok: false, failure: 'not_json' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, failure: 'not_object' };
  }

  return { ok: true, record: parsed as TranscriptRecord };
}
