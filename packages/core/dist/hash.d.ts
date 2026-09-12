/**
 * Canonical serialization and `type_hash`.
 *
 * WHY A HASH AT ALL: each entry stores the `type_hash` of the definition it was
 * recorded against. That is what makes "did the schema drift under this data?"
 * answerable after the fact -- the direct fix for fold's confound #1, where the
 * schema moved while the rows stayed put and no one could tell which shape any
 * given row meant.
 *
 * WHY SHA-256 IMPLEMENTED HERE rather than `node:crypto`: core is pure -- zero
 * `fs`, zero network, zero Node builtins (TASKS.md non-negotiable #6, enforced by
 * ESLint and `align check`). Injecting a hasher was the alternative and was
 * rejected: a hash that depends on who computed it is not an identity, and this
 * value is compared across machines and across time.
 *
 * Collision resistance is not decoration here. If two different specs hashed equal,
 * entries recorded against one would silently be read as belonging to the other --
 * the exact class of defect this file exists to prevent.
 */
/** A value that survives a JSON round trip. */
export type Json = null | boolean | number | string | Json[] | {
    readonly [key: string]: Json;
};
/** SHA-256 of a UTF-8 string, lowercase hex. */
export declare function sha256Hex(input: string): string;
/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace.
 *
 * Key order must not affect the hash. Two specs that differ only in the order their
 * author happened to write the fields are the SAME definition, and if they hashed
 * differently every entry recorded against one would look like drift from the other.
 */
export declare function canonicalJson(value: unknown): string;
/**
 * The stable identity of a type definition.
 *
 * Callers must pass an ALREADY-CANONICALIZED spec (`canonicalizeTypeSpec`). Hashing a
 * raw spec would give `reviewKind` and `review_kind` different hashes, which is the
 * drift this is supposed to detect rather than reproduce.
 */
export declare function typeHash(canonicalSpec: unknown): string;
//# sourceMappingURL=hash.d.ts.map