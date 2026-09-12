/**
 * Classify the difference between two type definitions as no bump, a minor bump, or a
 * major bump. See ARCHITECTURE.md, "Versioning policy".
 *
 * WHY THIS IS A FUNCTION AND NOT A JUDGMENT CALL: definitions are immutable and a new
 * shape is always a NEW ROW, never an UPDATE. The bump decides how that new row is
 * related to the old one -- and it decides whether existing entries can be read
 * alongside the new ones at all:
 *
 *   | bump  | effect                                                        |
 *   |-------|---------------------------------------------------------------|
 *   | minor | backward compatible; views union across minors                 |
 *   | major | new type version, NOT unioned -- old rows are a different shape |
 *
 * A wrong classification is not a cosmetic bug. Calling a major change minor would
 * union two incompatible shapes into one view, which is fold's confound #1 rebuilt
 * from scratch: schema moving under data with nothing recording that it moved.
 *
 * The axis for every rule below is the same question: **can an entry recorded against
 * the old definition still be read correctly under the new one?**
 */
import type { TypeSpec } from './spec.js';
export declare const BUMPS: readonly ["none", "minor", "major"];
export type Bump = (typeof BUMPS)[number];
/**
 * Every way a definition can change. A runtime list rather than a bare union so the
 * tests can assert each one is exercised -- the same reason PROPERTY_TYPES is a value
 * and not just a type. A change kind with no test is a classification rule that has
 * never been shown to fire.
 */
export declare const CHANGE_KINDS: readonly ["property_added", "property_removed", "property_retyped", "became_required", "became_optional", "enum_value_added", "enum_value_removed", "unit_changed", "metadata_changed"];
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export interface SpecChange {
    /** The property name, or the type name itself for metadata changes. */
    readonly subject: string;
    readonly kind: ChangeKind;
    readonly bump: Bump;
    /** Why this bump, in the terms of the axis above. */
    readonly detail: string;
}
export interface SpecDiff {
    /** The largest bump any single change requires. 'none' means the specs are equivalent. */
    readonly bump: Bump;
    readonly changes: readonly SpecChange[];
}
/**
 * Compare two definitions and classify the change.
 *
 * Both sides are canonicalized first, so a rename-only difference (`reviewKind` vs
 * `review_kind`) is correctly reported as NO change -- they are the same definition,
 * and treating them as a version bump is the drift this project measured and set out
 * to remove.
 *
 * @throws TypeError if the two specs have different names. These are not two versions
 * of one type; they are two types, and reporting a bump between them would create a
 * version row belonging to the wrong type.
 */
export declare function diffTypeSpec(from: TypeSpec, to: TypeSpec): SpecDiff;
//# sourceMappingURL=diff.d.ts.map