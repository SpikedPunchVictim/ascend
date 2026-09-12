/**
 * Generated per-type SQL views and the indexes they rest on.
 *
 * See ARCHITECTURE.md, "Storage", and `docs/evidence/EV-storage.md` / `EV-write-cost.md`.
 *
 * **Why a view and not a table per type.** A type is defined by an LLM at runtime. Creating a
 * physical table per type would mean DDL on a populated store for every registration -- and
 * EV-4 measured that `ALTER TABLE ADD COLUMN ... STORED` is REJECTED at >= 1 row, so the
 * cheap-looking path does not exist. One `entries` table plus a generated view keeps
 * registration a single INSERT for every type, forever, and still gives real `GROUP BY`
 * ergonomics: `SELECT outcome, COUNT(*) FROM v_review_completed_v1 GROUP BY 1`.
 *
 * **One view per MAJOR family** (`v_<type>_v<major>`), unioning the minor versions inside it.
 * Never across majors: a major bump means an entry recorded against the old definition cannot
 * be read correctly under the new one (`@ascend/core`'s `diffTypeSpec` classifies exactly
 * that), so unioning them would rebuild fold's confound #1 -- two incompatible shapes in one
 * result set with nothing marking the boundary.
 *
 * **The `_state` column carries FOUR values, and the fourth is not in the three-state model.**
 * The three states are defined for an entry against its OWN definition: measured, explicit
 * N/A, or not measured. But a view spans versions, and a property introduced by a later minor
 * version is not in an earlier entry's definition at all -- so for those rows it is neither
 * measured, nor N/A, nor "we did not measure it". Reporting it as `not_measured` would put
 * rows into a coverage denominator for a question they were never asked, which is how a
 * statistic reports a plausible wrong number. `not_declared` is the view's own fourth value
 * and never appears in the entries table or in core's model.
 *
 * **Indexes**, per EV-4's required addition: one composite expression index per property,
 * `(type_name, json_extract(properties_json, '$.<prop>'))`. The bare-expression form is
 * *worse than no index* (449.6 ms vs 231.0 ms) because it cannot carry the `type_name`
 * predicate, so SQLite scans the whole index. Each composite index is also COVERING for a
 * single-property group-by: it already holds the type and the extracted value, so the
 * aggregate needs no row lookup. EV-4's wider covering index was hand-built for a two-property
 * crosstab, which a registry cannot foresee, so no speculative wide index is emitted.
 *
 * EV-8 measured what that rule costs the write path, because the rule permits an unbounded
 * index count: at 20 properties, +0.135 ms per `asc record` and +679 ms on a full backfill.
 * Both are negligible, so the set ships uncapped. The real cost is DISK -- the indexes roughly
 * double the file (98.1 MB -> 204.9 MB at 100k rows) -- which is why `asc doctor` should report
 * store size against type count rather than this module rationing indexes.
 *
 * Every function here is IDEMPOTENT and derived purely from `entry_types`, so a store whose
 * views are missing or stale (an interrupted registration, a hand-edited schema) is repaired
 * by running the refresh again rather than by a migration.
 */
import type { DatabaseSync } from 'node:sqlite';
/** The view for one major family: `v_<type>_v<major>`. */
export declare function viewName(typeName: string, major: number): string;
/** The composite expression index for one property of one type. */
export declare function indexName(typeName: string, property: string): string;
/**
 * Rebuild every view for a type, and ensure its property indexes exist.
 *
 * Idempotent and safe to call at any time. Returns what it did, so `asc types` can report it
 * and a test can assert that a second call is a no-op rather than trusting that it is.
 */
export declare function refreshTypeViews(db: DatabaseSync, typeName: string): RefreshReport;
export interface RefreshReport {
    readonly type: string;
    /** Every view for this type, whether or not it already existed. */
    readonly views: readonly string[];
    /** Only the indexes actually created by THIS call. Empty on a repeat. */
    readonly indexes: readonly string[];
}
//# sourceMappingURL=views.d.ts.map