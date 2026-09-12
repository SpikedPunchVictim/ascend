/**
 * The three-state property model, and the validation that enforces it.
 * See ARCHITECTURE.md, "Three-state property values" -- load-bearing, cannot be
 * retrofitted.
 *
 * | state          | encoding                     | meaning                      |
 * |----------------|------------------------------|------------------------------|
 * | measured       | key present in `properties`  | a real value, INCLUDING `0`  |
 * | not applicable | name listed in `na`          | meaningless in this context  |
 * | not measured   | absent from both             | default; silence never = 0   |
 *
 * The whole product turns on these being three distinct things. The fold corpus
 * collapsed them into one, so `0` meant "measured zero", "unknown" and "doesn't
 * apply" simultaneously, and no downstream statistic could recover which.
 *
 * `required` therefore means "must have a DECISION" -- a value or an explicit N/A --
 * never "must have a value". If it meant the latter, it would pressure a recorder
 * into fabricating a number when the honest answer is "doesn't apply", which is
 * precisely how the fold corpus acquired its ambiguity.
 */
import type { TypeSpec } from './spec.js';
/** The three states. `not_measured` is the default and needs no encoding at all. */
export type PropertyState = 'measured' | 'not_applicable' | 'not_measured';
/**
 * One problem or caution, shaped for a human or an LLM to act on in one read.
 *
 * `fix` is not decoration. A validation error that only says "invalid" costs a round
 * trip to resolve; naming the accepted shape and the command that would have worked
 * is the difference between a self-correcting recorder and a stuck one.
 */
export interface ValidationIssue {
    /** The property name, or `na` / `properties` for whole-object problems. */
    readonly field: string;
    readonly problem: string;
    readonly fix: string;
}
/** What a recorder offers: values, explicit N/As, or both. */
export interface EntryInput {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly na?: readonly string[];
}
export interface ValidatedEntry {
    /** False means DO NOT PERSIST -- at least one error is present. */
    readonly ok: boolean;
    /** Declared, type-valid values only. Undeclared keys are stripped. */
    readonly properties: Readonly<Record<string, unknown>>;
    /** Declared, deduplicated names only. Undeclared names are dropped. */
    readonly na: readonly string[];
    /** One state for EVERY declared property, so ratios are computable without re-deriving. */
    readonly states: Readonly<Record<string, PropertyState>>;
    readonly errors: readonly ValidationIssue[];
    /** Legal but almost certainly unintended. Never blocks persistence. */
    readonly warnings: readonly ValidationIssue[];
}
/**
 * Validate a recording against a type definition and resolve every property's state.
 *
 * Pure: no clock, no I/O. Returns a fresh object and never mutates its input, so a
 * caller can validate speculatively without side effects.
 */
export declare function validateEntry(spec: TypeSpec, input: EntryInput): ValidatedEntry;
//# sourceMappingURL=state.d.ts.map