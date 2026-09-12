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

import type { TypeSpec } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { ENVELOPE_COLUMNS, ident, literal, stateCase } from './sql.js';

/** The view for one major family: `v_<type>_v<major>`. */
export function viewName(typeName: string, major: number): string {
  return `v_${typeName}_v${String(major)}`;
}

/** The composite expression index for one property of one type. */
export function indexName(typeName: string, property: string): string {
  return `idx_entries_${typeName}_${property}`;
}

interface TypeVersion {
  readonly version: number;
  readonly major: number;
  readonly spec: TypeSpec;
}

/** Every registered version of a type, oldest first. */
function versionsOf(db: DatabaseSync, typeName: string): readonly TypeVersion[] {
  const rows = db
    .prepare(
      'SELECT version, major, spec_json FROM entry_types WHERE name = ? ORDER BY version ASC',
    )
    .all(typeName) as unknown as { version: number; major: number; spec_json: string }[];

  return rows.map((row) => ({
    version: row.version,
    major: row.major,
    spec: JSON.parse(row.spec_json) as TypeSpec,
  }));
}

/**
 * Create the composite expression index for one property, if it is not already there.
 *
 * `IF NOT EXISTS` and never a drop: an index is not derived state that can go stale, and a
 * property dropped in a later major still has old rows an analysis query may group by.
 */
function ensurePropertyIndex(db: DatabaseSync, typeName: string, property: string): boolean {
  const name = indexName(typeName, property);
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name);
  if (existing !== undefined) return false;

  db.exec(
    `CREATE INDEX ${ident(name)} ON entries (type_name, json_extract(properties_json, ${literal(`$.${property}`)}))`,
  );
  return true;
}

/**
 * Rebuild every view for a type, and ensure its property indexes exist.
 *
 * Idempotent and safe to call at any time. Returns what it did, so `asc types` can report it
 * and a test can assert that a second call is a no-op rather than trusting that it is.
 */
export function refreshTypeViews(db: DatabaseSync, typeName: string): RefreshReport {
  const versions = versionsOf(db, typeName);
  if (versions.length === 0) {
    throw new Error(`no entry type '${typeName}' is registered, so it has no views to build`);
  }

  const indexesCreated: string[] = [];

  // One index per property, across ALL versions -- a property introduced in a later minor is
  // exactly the one a new query will filter on, and old rows simply have no key to index.
  const indexed = new Set<string>();
  for (const { spec } of versions) {
    for (const property of spec.properties) {
      if (indexed.has(property.name)) continue;
      indexed.add(property.name);
      if (ensurePropertyIndex(db, typeName, property.name)) {
        indexesCreated.push(indexName(typeName, property.name));
      }
    }
  }

  // Group by major family. A property is a column if ANY version in the family declares it,
  // and `declaringVersions` is what separates not_measured from not_declared per row.
  const families = new Map<number, TypeVersion[]>();
  for (const version of versions) {
    const family = families.get(version.major);
    if (family === undefined) families.set(version.major, [version]);
    else family.push(version);
  }

  const viewsCreated: string[] = [];

  for (const [major, family] of [...families.entries()].sort(([left], [right]) => left - right)) {
    const properties = new Map<string, number[]>();
    for (const { version, spec } of family) {
      for (const property of spec.properties) {
        const declaring = properties.get(property.name);
        if (declaring === undefined) properties.set(property.name, [version]);
        else declaring.push(version);
      }
    }

    // Sorted, so the view's column order is a function of the property set rather than of
    // registration history -- two stores with the same types get byte-identical views.
    const names = [...properties.keys()].sort();
    const projections = names.map(
      (property) =>
        `  json_extract(e.properties_json, ${literal(`$.${property}`)}) AS ${ident(property)},\n` +
        `  ${stateCase(property, properties.get(property) ?? [])} AS ${ident(`${property}_state`)}`,
    );

    const name = viewName(typeName, major);
    const selected = [
      ...ENVELOPE_COLUMNS.map((column) => `  e.${column} AS ${ident(column)}`),
      ...projections,
    ].join(',\n');

    const versionsInFamily = family.map(({ version }) => String(version)).join(', ');

    // SQLite has no CREATE OR REPLACE VIEW. Dropping first is safe: a view holds no data, and
    // this runs inside the registration transaction, so no reader observes the gap.
    db.exec(`DROP VIEW IF EXISTS ${ident(name)}`);
    db.exec(
      `CREATE VIEW ${ident(name)} AS\nSELECT\n${selected}\n` +
        `  FROM entries AS e\n` +
        ` WHERE e.type_name = ${literal(typeName)} AND e.type_version IN (${versionsInFamily})`,
    );
    viewsCreated.push(name);
  }

  return { type: typeName, views: viewsCreated, indexes: indexesCreated };
}

export interface RefreshReport {
  readonly type: string;
  /** Every view for this type, whether or not it already existed. */
  readonly views: readonly string[];
  /** Only the indexes actually created by THIS call. Empty on a repeat. */
  readonly indexes: readonly string[];
}
