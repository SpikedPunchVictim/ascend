/**
 * The single entry write path.
 *
 * **This is the only module in ascend that INSERTs into `entries`.** Nothing else may,
 * and that is enforced rather than intended: a test scans the package's source and fails
 * if a second `INSERT INTO entries` appears anywhere (test/recorder.test.ts, "exactly one
 * write path").
 * The discipline is align's one-recorder rule, and the reason it is worth a test is
 * that a second write path is invisible until the two disagree -- one of them adds a
 * field, or validates differently, and the corpus quietly contains two shapes of record
 * that no query can tell apart.
 *
 * The envelope is built HERE, and the type identity is resolved HERE, from the store.
 * A caller names a type and offers values; it cannot supply a `type_version` or a
 * `type_hash`. That is deliberate: those three columns are one foreign key, and letting
 * a caller pass them independently is exactly how an entry ends up claiming a definition
 * whose shape it does not have (fold's confound #1). The caller supplies intent; the
 * recorder supplies identity.
 *
 * Time and identifiers are INJECTED, never read. `id`, `recordedAt`, `runId` and the
 * provenance fields all arrive in the context, so this module contains no `Date.now()` and
 * no `randomUUID()` -- tested, not asserted, by the same source scan. The command boundary
 * mints them; the store only records what it was handed.
 *
 * Validation is NOT re-implemented here. `@ascend/core`'s `validateEntry` owns the
 * three-state model and the required-means-a-decision rule, and it is pure, so it can be
 * exercised against hand-written fixtures with no database in the way. The recorder's job
 * is only to refuse to persist what did not validate.
 */
import { type PropertyState, type ValidationIssue } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
/** Where an entry came from. Mirrors the `source` CHECK constraint. */
export declare const ENTRY_SOURCES: readonly ["self", "derived:claude-code"];
export type EntrySource = (typeof ENTRY_SOURCES)[number];
/** What a recorder asks for: a type, and what it observed. */
export interface RecordRequest {
    readonly type: string;
    /** Defaults to the latest registered version. Named explicitly only to pin one. */
    readonly version?: number;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly na?: readonly string[];
}
/**
 * Everything about the recording that is not the observation.
 *
 * `id` and `recordedAt` are required and have no defaults: a default would mean this
 * module reading a clock or drawing randomness, which is the thing it must not do.
 */
export interface RecordContext {
    readonly id: string;
    /** ISO-8601 UTC, ending in `Z`. See `requireUtcTimestamp` for why that is enforced. */
    readonly recordedAt: string;
    /** The ascend build that wrote this row, e.g. from package.json. Not read here. */
    readonly ascendVersion: string;
    readonly source?: EntrySource;
    /** Defaults to this build's schema version. Present so `asc import` can preserve one. */
    readonly schemaVersion?: number;
    readonly runId?: string;
    readonly workflow?: string;
    readonly actor?: string;
    readonly cwd?: string;
    readonly repo?: string;
    readonly gitSha?: string;
    readonly branch?: string;
    readonly evidenceText?: string;
}
/** A recorded entry, as written and as read back. */
export interface RecordedEntry {
    readonly id: string;
    readonly typeName: string;
    readonly typeVersion: number;
    readonly typeHash: string;
    readonly recordedAt: string;
    readonly source: EntrySource;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly na: readonly string[];
    /**
     * Derivable from the entry plus its definition, and returned anyway because every
     * consumer that reports a ratio needs all three states at once -- recomputing it at
     * each call site is how one of them eventually forgets `not_measured`.
     */
    readonly states: Readonly<Record<string, PropertyState>>;
    readonly runId: string | null;
    readonly workflow: string | null;
    readonly actor: string | null;
    readonly cwd: string | null;
    readonly repo: string | null;
    readonly gitSha: string | null;
    readonly branch: string | null;
    readonly evidenceText: string | null;
    readonly ascendVersion: string;
    readonly schemaVersion: number;
}
export interface RecordResult {
    readonly entry: RecordedEntry;
    /** Legal but almost certainly unintended. The row WAS written. */
    readonly warnings: readonly ValidationIssue[];
}
/** Thrown when the named type, or the named version of it, is not registered. */
export declare class UnknownTypeError extends Error {
    readonly typeName: string;
    readonly version: number | undefined;
    constructor(typeName: string, version: number | undefined, registered: readonly string[]);
}
/**
 * Thrown when the values offered do not satisfy the type definition.
 *
 * Carries the issues rather than only a rendered message, so a caller can print them
 * however it likes -- and the message already contains the fixes, because a recorder
 * that has to ask what went wrong costs a round trip that a self-correcting one does not.
 */
export declare class EntryRejectedError extends Error {
    readonly typeName: string;
    readonly issues: readonly ValidationIssue[];
    constructor(typeName: string, issues: readonly ValidationIssue[]);
}
/** Thrown when an entry with this id already exists. */
export declare class DuplicateEntryError extends Error {
    readonly id: string;
    constructor(id: string);
}
/**
 * Record one entry. The only way an entry is ever written.
 *
 * Refuses rather than persists on: an unknown type, a version that is not registered,
 * values that do not satisfy the definition, a duplicate id, an empty required field,
 * or a non-UTC timestamp. Every one of those is a hard error and none of them writes a
 * row -- an entry that is half-right is worse than no entry, because it reads as data.
 *
 * Returns warnings alongside the entry. Warnings never block: they mark things that are
 * legal and almost certainly unintended (an undeclared property, every property N/A, a
 * deprecated type), and the entry was written.
 */
export declare function recordEntry(db: DatabaseSync, request: RecordRequest, context: RecordContext): RecordResult;
/**
 * One entry by id, as it was written, or undefined.
 *
 * `states` is recomputed against the definition THIS ENTRY names -- not against the
 * type's latest version. An entry's states are a property of the definition it was
 * recorded against, so deriving them from whatever the type looks like today would
 * report three-state ratios for a shape the values never had.
 */
export declare function findEntry(db: DatabaseSync, id: string): RecordedEntry | undefined;
//# sourceMappingURL=recorder.d.ts.map