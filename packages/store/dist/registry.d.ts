/**
 * The type registry: the only place an entry type is registered.
 *
 * The rule this module exists to enforce: **a shape change INSERTS a new version row;
 * it never UPDATEs.** A registered definition is what an entry's properties were
 * validated against, so rewriting one would silently reinterpret every entry already
 * recorded under it -- fold's confound #1, where the schema drifted under the data and
 * nothing recorded that it had. The database enforces it with triggers, but callers
 * must never be *asking* for an update in the first place, which is what this does.
 *
 * Identity is the SHAPE, not the prose. `type_hash` is computed over
 * `definitionShape(spec)` -- the fields a validator actually reads -- so two runs that
 * described the same shape in different words register as the SAME definition, and an
 * entry recorded under either wording attaches to both. The reasoning is in
 * core/src/spec.ts; the consequence here is that registering is IDEMPOTENT: registering
 * an already-known shape writes nothing and reports `unchanged`.
 *
 * Time is injected, never read. `registeredAt` is a parameter for the same reason core
 * takes a clock: a store whose rows carry an ambient timestamp cannot be tested
 * against fixtures, and `asc` has to be reproducible.
 */
import { type Bump, type Rename, type SpecChange, type TypeSpec } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
export interface RegisterTypeOptions {
    /**
     * ISO-8601 UTC. Injected -- the registry never reads a clock.
     */
    readonly registeredAt: string;
    /** Prose shown by `asc types brief`. Not part of the identity; editable in place. */
    readonly description?: string;
    readonly recordWhen?: string;
    /** Per-property prose, keyed by canonical property name. Also not identity. */
    readonly prose?: Readonly<Record<string, string>>;
}
export interface RegisteredType {
    readonly name: string;
    readonly version: number;
    /** The major-version family a generated view unions across. */
    readonly major: number;
    readonly typeHash: string;
    /** `unchanged` means this exact shape was already registered; nothing was written. */
    readonly outcome: 'created' | 'unchanged';
    /** `none` when unchanged. Otherwise the worst change against the previous version. */
    readonly bump: Bump;
    readonly changes: readonly SpecChange[];
    /** Names canonicalization rewrote, so callers can tell the user what was changed. */
    readonly renames: readonly Rename[];
    /** Legal but almost certainly a mistake. Never blocks registration. */
    readonly warnings: readonly string[];
}
/** A registered version, as read back out of the store. */
export interface TypeVersionRow {
    readonly name: string;
    readonly version: number;
    readonly major: number;
    readonly typeHash: string;
    readonly spec: TypeSpec;
    readonly description: string | null;
    readonly recordWhen: string | null;
    readonly prose: Readonly<Record<string, string>>;
    readonly status: 'active' | 'deprecated';
    readonly registeredAt: string;
}
/**
 * Register a type definition, or report that this shape is already known.
 *
 * Idempotent on shape. Never updates a registered row's identity -- see the module
 * comment. `asc types deprecate` and prose edits are separate operations, because they
 * are the only changes a registered version permits.
 */
export declare function registerType(db: DatabaseSync, spec: TypeSpec, options: RegisterTypeOptions): RegisteredType;
/**
 * Every version of a type, oldest first.
 *
 * All of them, not just the latest: a query that unions minor versions needs each
 * version's own property list, since that is what its entries were validated against.
 */
export declare function typeVersions(db: DatabaseSync, name: string): readonly TypeVersionRow[];
/**
 * The version of a type, or the latest one when `version` is omitted.
 *
 * Returns undefined rather than throwing: "not registered" is an ordinary answer for
 * `asc types show`, and the caller decides what it means.
 */
export declare function findType(db: DatabaseSync, name: string, version?: number): TypeVersionRow | undefined;
/**
 * Retire a type without deleting or rewriting it.
 *
 * Deprecation is a status change, not a version: entries recorded under a deprecated
 * type remain valid and remain queryable. Deleting or editing them would be the
 * rewrite the whole store is built to prevent.
 */
export declare function deprecateType(db: DatabaseSync, name: string): number;
/**
 * Replace a registered version's prose.
 *
 * The one permitted edit to a registered version, and only because prose is not part
 * of the identity: it changes what the recorder is TOLD, never what a stored value
 * means, so no entry is invalidated and no version is minted. The database trigger
 * permits exactly this and refuses everything else.
 *
 * `undefined` leaves a field alone; `null` clears it. The two are different requests,
 * which is why the parameter is not simply optional-and-truthy.
 */
export declare function updateTypeProse(db: DatabaseSync, name: string, version: number, prose: {
    readonly description?: string | null;
    readonly recordWhen?: string | null;
    readonly propertyProse?: Readonly<Record<string, string>>;
}): void;
//# sourceMappingURL=registry.d.ts.map