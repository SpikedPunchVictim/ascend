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
/**
 * The DEFINITION of a type: everything a stored value is validated against, and
 * nothing else.
 *
 * Prose is removed here, at every level -- `description` and `record_when` on the
 * type, `description` on each property. A `type_hash` is computed over this, so this
 * function decides what it means for two definitions to be THE SAME DEFINITION.
 *
 * Prose is excluded deliberately, and it is the same argument as the property-order
 * and enum-order canonicalization above, one step further out:
 *
 *   - Prose affects no stored value. `diffTypeSpec` already says so, classifying a
 *     `record_when` change as `bump: 'none'` with "no stored value is affected".
 *   - Prose is LLM-authored and varies freely between runs. EV-drift measured that
 *     across real model output only 9.1% of property names were shared between runs;
 *     the prose around a definition is at least that variable. Hashing it would mean
 *     two runs that defined the *identical shape* hashed differently and reported as
 *     drift -- recreating the exact problem canonicalization exists to remove.
 *   - `asc types import` moves a definition between projects "preserving `type_hash`"
 *     (ARCHITECTURE.md). That promise is only keepable if the wording each project
 *     shows its recorder does not change the identity of the shape.
 *
 * The consequence is that an entry recorded under one wording and an entry recorded
 * under another are attached to the SAME definition, which is correct: they validate
 * identically, and a query that unions them is unioning comparable values.
 *
 * Each field is kept ONLY where it actually constrains a value, because a field that
 * constrains nothing must not change the hash:
 *
 *   - `required` is kept only when true. `required: false` and omitting it are the
 *     same rule -- optional -- and `buildSchema` treats them identically.
 *   - `enum_values` is kept only on an `enum`, where `buildSchema` uses it. On a
 *     `string` it validates nothing (canonicalizeProperty warns about it), so two
 *     specs differing only there must not read as two definitions.
 *   - `unit` is kept only on a unit-bearing type, for the same reason.
 *
 * That precision is load-bearing rather than tidiness. `diffTypeSpec` classifies
 * changes to the fields that matter and is silent about the rest, so a field kept
 * here but ignored there would let two specs hash DIFFERENTLY while the diff reports
 * no change at all -- the registry would have to invent a version bump with nothing
 * to justify it. Keeping this projection equal to what the validator reads closes
 * that gap by construction.
 *
 * Pure: returns a new spec, never mutates.
 */
export declare function definitionShape(spec: TypeSpec): TypeSpec;
//# sourceMappingURL=spec.d.ts.map