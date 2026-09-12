/**
 * Reading a JSON wire format: the shape test and the two error helpers.
 *
 * These three live here rather than in either format's module because there are now two wire
 * formats -- the type document (`document.ts`) and the entry document (`entry-document.ts`) -- and
 * they must report a bad field *identically*. The message wording is the load-bearing part: a
 * model correcting its own output reads one of these, and `must be an object, but it is "x"` is a
 * thing to fix while `invalid input` is a thing to guess at. Two copies of a rule with one owner
 * is how the owner stops being one, and the drift here would be invisible -- both copies would
 * still look right in isolation.
 *
 * **These are refusals, not usage errors.** A document's contents are data rather than argv
 * (`errors.ts`): the command line was fine and the file said something impossible. Exit 1, so a
 * script branching on the exit code does not retry a typo that was never on the command line.
 */

import { refusal } from './errors.js';

/** A JSON object, as opposed to a JSON array or any scalar. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A value as it should appear in an error message.
 *
 * `JSON.stringify` in preference to `String` because it quotes a string, so `"3"` and `3` stay
 * distinguishable in the message. Its declared return type is `string`, but it returns
 * `undefined` at runtime for `undefined`, a function and a symbol; the type is widened to say
 * so rather than leaving an unreachable-looking branch that is in fact reachable.
 */
export function describeValue(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined;
  return json ?? String(value);
}

/**
 * A refusal naming the field, what was expected, and what arrived.
 *
 * The `const`'s type is annotated rather than merely inferred from the arrow, and that is
 * load-bearing: TypeScript only treats a call as never-returning -- and so only narrows the code
 * after it -- when the callee is a function declaration or a `const` with an explicit type.
 * Without the annotation every call site would need its own redundant `return`.
 */
export const fieldError: (
  source: string,
  field: string,
  expected: string,
  got: unknown,
) => never = (source, field, expected, got) => {
  throw refusal(`${source}: '${field}' must be ${expected}, but it is ${describeValue(got)}.`);
};
