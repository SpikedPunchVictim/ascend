/**
 * The declarative property spec -- what an LLM writes at runtime, what gets hashed,
 * versioned and diffed. See ARCHITECTURE.md, "Zod is the enforcement engine".
 *
 * A zod schema is code; storing zod source and `eval`-ing it would be arbitrary code
 * execution and would make a definition unhashable. So the registry persists THIS,
 * and `buildSchema()` (schema.ts) constructs the validator from it.
 *
 * The vocabulary is deliberately nine types, not all of zod. Constraining what an LLM
 * can invent is the primary structural defense against drift -- but EV-drift measured
 * that it is NOT sufficient on its own, which is why canonicalization lives here too.
 */
/** The bounded vocabulary. Settled in ARCHITECTURE.md, "Decisions settled". */
export declare const PROPERTY_TYPES: readonly ["string", "number", "integer", "boolean", "enum", "timestamp", "duration", "ref", "text"];
export type PropertyType = (typeof PROPERTY_TYPES)[number];
/** Property types whose `unit` is meaningful. A unit on `boolean` is a spec error. */
export declare const UNIT_BEARING_TYPES: readonly PropertyType[];
export interface PropertySpec {
    readonly name: string;
    readonly type: PropertyType;
    /**
     * `required` means "must have a DECISION" -- a measured value OR an explicit N/A --
     * never "must have a value". See state.ts and ARCHITECTURE.md, "Three-state property
     * values". Optional is the default.
     */
    readonly required?: boolean;
    /** Only meaningful when `type` is 'enum'. Required in that case, forbidden otherwise. */
    readonly enum_values?: readonly string[];
    readonly description?: string;
    /** Only meaningful for UNIT_BEARING_TYPES. */
    readonly unit?: string;
}
export interface TypeSpec {
    readonly name: string;
    readonly description?: string;
    /** Prose describing when an LLM should record this. Surfaced by `asc types brief`. */
    readonly record_when?: string;
    readonly properties: readonly PropertySpec[];
}
/**
 * Fold a name to its canonical form: snake_case, lowercase.
 *
 * This is the direct fix for the drift EV-drift measured -- across 44 real LLM-authored
 * property names only 9.1% were shared (Jaccard 0.300, thresholds 0.70 / 0.60), with
 * snake_case and camelCase mixed freely. `reviewKind`, `review-kind` and `review_kind`
 * must not be three different properties.
 */
export declare function canonicalName(raw: string): string;
/** A single canonicalization applied to a spec, so the caller can surface it. */
export interface Rename {
    readonly from: string;
    readonly to: string;
}
export interface Canonicalized<T> {
    readonly spec: T;
    /** Non-empty when the input was rewritten. Empty means the input was already canonical. */
    readonly renames: readonly Rename[];
    /** Things that are legal but almost certainly a mistake. Not errors. */
    readonly warnings: readonly string[];
}
/**
 * Canonicalize a property spec. Pure: returns a new spec, never mutates.
 *
 * Idempotent by construction -- canonicalName(canonicalName(x)) === canonicalName(x) -- which
 * is what lets the registry treat canonical form as the identity of a definition.
 */
export declare function canonicalizeProperty(spec: PropertySpec): Canonicalized<PropertySpec>;
/**
 * Canonicalize a whole type spec.
 *
 * Also applies EV-drift's `required` sanity rule: a definition marking every property
 * required is almost certainly wrong. `required` means "must have a decision", so an
 * all-required definition is claiming every property is always meaningful -- the exact
 * shape that pressures a model into fabricating a number when the honest answer is
 * "doesn't apply".
 */
export declare function canonicalizeTypeSpec(spec: TypeSpec): Canonicalized<TypeSpec>;
//# sourceMappingURL=spec.d.ts.map