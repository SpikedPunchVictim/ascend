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
 * that), so unioning them would rebuild the schema-drift confound -- two incompatible shapes in one
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
 * **A property may not be named after a column the view already projects** (`id`, `source`,
 * `workflow`, `properties_json`, ...) **or end in `_state`**, because those names are taken and
 * SQLite resolves a duplicate by renaming the loser to `source:1` -- silently, so the query above
 * would read the ENVELOPE value under the property's name. `@ascend/core`'s
 * `reservedPropertyName` owns the vocabulary and `registerType` refuses on it, which is where the
 * author can still cheaply rename; `assertProjectable` below is the second line, for a spec that
 * reached the store without passing the registry. Measured and reproduced in views.test.ts
 * (`asc-865.1`).
 *
 * **A property name must also be one JSON path segment** (`asc-bcv.16`, F5). `reservedPropertyName`
 * is about the COLUMN a name occupies; this is about the PATH it is read through, and the two
 * catch different names. `a.b` is not a reserved name, so it passed -- and the generated index and
 * view embedded it as `'$.a.b'`, which addresses field `b` of an object `a`. Measured on the real
 * generator: `properties_json` held `{"a.b":"the-value"}`, the view's column read NULL, and the
 * index matched nothing. `@ascend/core`'s `unaddressablePropertyName` owns that rule, and
 * `assertProjectable` refuses on it below, before any DDL runs. `registerType` cannot store such a
 * name (`canonicalName('a.b')` is `'a_b'`, and the author is told it was renamed), so this too is
 * the second line -- but the union reads specs from attached stores the local registry never saw,
 * so `union.ts` asks the same question at its own boundary.
 *
 * **A property name may not be empty either** (`asc-0w9`), and that one is the worst of the three
 * to miss: the path the view builds is `$.`, which is not a path, and because the index sits on
 * `entries` rather than on one type, SQLite evaluates it for EVERY insert -- so one hand-inserted
 * version row stops the store accepting entries of any type at all. `registerType` refuses it, and
 * has since `asc-0w9`; this guard did not, which is the gap `asc-bcv.21` closed. `assertProjectable`
 * refuses it below, before any DDL runs.
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

import {
  emptyPropertyName,
  reservedPropertyName,
  unaddressablePropertyName,
  type TypeSpec,
} from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { ENVELOPE_COLUMNS, ident, literal, stateCase } from './sql.js';

/**
 * Refuse to build a view for a version that names a property the view has already claimed.
 *
 * `registerType` refuses these names, so this is the second line rather than the first: the
 * specs that reach it were written without the registry -- a version row inserted by hand, or
 * a store created before the rule existed. Both are states where the alternative is a view
 * SQLite would happily build with a duplicate column renamed to `source:1`, and a query that
 * selects `source` then reads the envelope. A refusal that names the property is legible; the
 * renamed column is not.
 *
 * Thrown BEFORE any DDL runs, so a refused refresh changes nothing -- not the indexes, not the
 * other families' views. It is deliberately not repaired here, either: a registered definition
 * is immutable by design, so the repair is a new major version with the property renamed, and
 * silently dropping or renaming the old family's columns would be the rewrite the registry
 * exists to prevent.
 */
function assertProjectable(versions: readonly TypeVersion[]): void {
  const problems: string[] = [];

  // Three rules, and all of them may be reported for one property: `reservedPropertyName` folds the
  // name before answering while `unaddressablePropertyName` deliberately does not, so `'source.'` is
  // reserved AND unaddressable, and the author needs both sentences to fix it in one edit. A
  // `continue` between them would report whichever was asked first and hide the other.
  // `emptyPropertyName` is the one rule that cannot overlap either: it fires only on a name with no
  // characters in it at all, so there is nothing for the other two to find.
  //
  // Each problem cites ITS OWN finding rather than the function citing one. The three rules came
  // from three different bugs (`asc-865.1` reserved a name a view claims, `asc-bcv.16` refused a
  // name the path cannot address, `asc-0w9` refused a name with no path to address), and a shared
  // citation would send a reader holding one to the bead for another -- which is a wrong answer
  // that looks like a right one. `asc-0w9` in particular matters: its bead is where the empty name
  // was measured bricking every insert, and the other two describe a NULL column instead.
  const refuse = (problem: {
    readonly version: number;
    readonly name: string;
    readonly reason: string;
    readonly suggestion: string;
    readonly reference: string;
  }): void => {
    problems.push(
      `version ${String(problem.version)} declares property '${problem.name}': ${problem.reason}. ` +
        `Rename it -- '${problem.suggestion}' projects faithfully. ` +
        `The view was NOT built -- registering a corrected version is the fix ` +
        `(${problem.reference}).`,
    );
  };

  for (const { version, spec } of versions) {
    for (const property of spec.properties) {
      const reserved = reservedPropertyName(property.name);
      if (reserved !== undefined) {
        refuse({ version, ...reserved, reference: 'asc-865.1' });
      }

      const unaddressable = unaddressablePropertyName(property.name);
      if (unaddressable !== undefined) {
        refuse({ version, ...unaddressable, reference: 'asc-bcv.16' });
      }

      const nameless = emptyPropertyName(property.name);
      if (nameless !== undefined) {
        refuse({ version, ...nameless, reference: 'asc-0w9' });
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `cannot build a faithful view for these definitions:\n` +
        problems.map((problem) => `  ${problem}`).join('\n'),
    );
  }
}

/** The view for one major family: `v_<type>_v<major>`. */
export function viewName(typeName: string, major: number): string {
  return `v_${typeName}_v${String(major)}`;
}

/**
 * The composite expression index for one property of the store.
 *
 * **One index per PROPERTY, not per (type, property), and this was measured rather than
 * preferred** (`asc-bcv.17`, F6). The index is `(type_name, json_extract(properties_json,
 * '$.<property>'))`: `type_name` is a COLUMN of that index, not part of its identity. Two types
 * declaring the same property therefore produce two byte-identical indexes, and SQLite takes
 * either for either type. Measured (`/tmp/f6-shared.mjs`, with `alpha` and `beta` both declaring
 * `stage`): the planner answered `alpha`'s view with `USING INDEX idx_entries_beta_stage`, and
 * went on answering that after `idx_entries_alpha_stage` had been dropped. A second copy buys no
 * query anything; it costs an insert every time, forever.
 *
 * The name is a bijection on the property, which is the point: it cannot collide, so "an index
 * with this name exists" is finally the same question as "this property is indexed". `idx_prop_`
 * is also a namespace no name this codebase has ever created can occupy -- every property index
 * used to be `idx_entries_<type>_<property>`, and the schema's own indexes are `idx_entries_*`,
 * `idx_entry_types_*` and `idx_annotations_*`. So a pre-rename index cannot be mistaken for one
 * of these, and the pair that collided before cannot collide now.
 */
export function indexName(property: string): string {
  return `idx_prop_${property}`;
}

/**
 * The one `CREATE INDEX` statement this file emits for a property, so that "is this index the
 * one I am looking for?" can be asked by DEFINITION rather than by name.
 *
 * Measured (`/tmp/f6-sql.mjs`): `sqlite_master.sql` holds the statement text byte for byte as it
 * was written -- same quoting, same doubled `'` inside the JSON path, same spacing. That is what
 * makes an exact string comparison a sound test of "these two names are the same index".
 */
function indexDefinition(name: string, property: string): string {
  return `CREATE INDEX ${ident(name)} ON entries (type_name, json_extract(properties_json, ${literal(`$.${property}`)}))`;
}

/**
 * Whether `name` is an index on `entries` whose definition is exactly this one for `property`.
 *
 * This is the question `ensurePropertyIndex` has to answer, and for four versions of this file it
 * answered a different one: "is this NAME taken?". Those differ wherever a name means more than
 * one thing, and both of the ways they differed were real. `('test','run_count')` and
 * `('test_run','count')` spelled one name, so the second property was reported as already indexed
 * and never indexed at all. And `type{time}` spelled the schema's `idx_entries_type_time`, which
 * is on `(type_name, recorded_at)` -- a name that was taken by an index over a different
 * expression, answered "yes, you are covered" to a property with no index anywhere.
 */
function holdsDefinition(db: DatabaseSync, name: string, property: string): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string } | undefined;

  return row !== undefined && row.sql === indexDefinition(name, property);
}

/**
 * The name this index was spelled with before `asc-bcv.17`, when it was per TYPE:
 * `idx_entries_<type>_<property>`.
 *
 * It is not injective -- `('test','run_count')` and `('test_run','count')` are the same string --
 * which is the defect that bead was filed for. Kept here because every store built by an earlier
 * version holds its indexes under this spelling and is migrated in place by the next refresh of
 * each of its types; after that nothing uses it again.
 */
function legacyIndexName(typeName: string, property: string): string {
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
 * Create the expression index for one property, if it is not already there, and retire the twin
 * an earlier version left under the per-type spelling.
 *
 * **It drops exactly one thing, and only when that thing is provably the same index.** An index
 * is not derived state that can go stale, and a property dropped in a later major still has old
 * rows an analysis query may group by -- so nothing is dropped for being unused, and the legacy
 * name is only retired when `holdsDefinition` says the index under it is the very index being
 * created, on the very same expression. The audit's note that a rename here is "additive and
 * benign" is not supported by a number: leaving the twin doubles the index bytes of every store
 * that is refreshed, and measured across the 156 stores on this machine that is 34,165,736 bytes
 * of `idx_entries%` indexes -- 60.7% of those stores' total bytes -- with every insert afterwards
 * maintaining two copies of one index.
 *
 * The twin is retired BEFORE the check for the new name rather than after it, so a store that
 * already has the new index still loses the old one. If the `CREATE` then failed, the index would
 * be gone until the next refresh -- this function is idempotent, and a missing index is a
 * performance defect rather than a wrong answer, which is the class this bead is in.
 *
 * A `CREATE` can only fail on the new name if something else already holds it. `idx_prop_` is
 * disjoint from every name this codebase creates, so the only way there is a hand-written index;
 * that fails loudly rather than being read as "already indexed", which is the direction this
 * bead was filed about.
 */
function ensurePropertyIndex(
  db: DatabaseSync,
  typeName: string,
  property: string,
): { created: boolean; renamed: string | undefined } {
  const name = indexName(property);

  const legacy = legacyIndexName(typeName, property);
  const renamed = holdsDefinition(db, legacy, property) ? legacy : undefined;
  if (renamed !== undefined) db.exec(`DROP INDEX ${ident(renamed)}`);

  if (holdsDefinition(db, name, property)) return { created: false, renamed };

  db.exec(indexDefinition(name, property));
  return { created: true, renamed };
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

  assertProjectable(versions);

  const indexesCreated: string[] = [];
  const indexesRenamed: string[] = [];

  // One index per property, across ALL versions -- a property introduced in a later minor is
  // exactly the one a new query will filter on, and old rows simply have no key to index.
  const indexed = new Set<string>();
  for (const { spec } of versions) {
    for (const property of spec.properties) {
      if (indexed.has(property.name)) continue;
      indexed.add(property.name);
      const { created, renamed } = ensurePropertyIndex(db, typeName, property.name);
      if (created) indexesCreated.push(indexName(property.name));
      if (renamed !== undefined) indexesRenamed.push(renamed);
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

  return {
    type: typeName,
    views: viewsCreated,
    indexes: indexesCreated,
    renamed: indexesRenamed,
  };
}

export interface RefreshReport {
  readonly type: string;
  /** Every view for this type, whether or not it already existed. */
  readonly views: readonly string[];
  /** Only the indexes actually created by THIS call. Empty on a repeat. */
  readonly indexes: readonly string[];
  /**
   * The pre-`asc-bcv.17` names of indexes THIS call retired, having recreated the same index
   * under the name above. Empty unless the store was built by an earlier version -- this is the
   * one-time migration, and it is reported rather than done quietly because it removes an object
   * from a store the user already had.
   */
  readonly renamed: readonly string[];
}
