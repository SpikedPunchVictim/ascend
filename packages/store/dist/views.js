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
/** The view for one major family: `v_<type>_v<major>`. */
export function viewName(typeName, major) {
    return `v_${typeName}_v${String(major)}`;
}
/** The composite expression index for one property of one type. */
export function indexName(typeName, property) {
    return `idx_entries_${typeName}_${property}`;
}
/**
 * Quote an identifier for generated SQL.
 *
 * Property names are canonical snake_case (`canonicalName` strips everything else), so this is
 * belt-and-braces rather than load-bearing -- but the input is an LLM's, it is interpolated
 * into DDL, and a quote is free. Doubling embedded quotes is the SQLite escape.
 */
const ident = (name) => `"${name.replace(/"/g, '""')}"`;
/** A literal for generated SQL. Same reasoning as `ident`: LLM-supplied, interpolated. */
const literal = (value) => `'${value.replace(/'/g, "''")}'`;
/**
 * The `_state` CASE for one property, over the versions that DECLARE it.
 *
 * `json_type(json, '$.p')` is NULL exactly when the path is absent -- which is what "measured"
 * means here, since every value in the vocabulary serializes to a non-null JSON type. The
 * membership test over the `na` array uses `json_each` rather than a substring match on the
 * JSON text: `instr(na_json, '"count"')` would also match `"count_of_x"`, and a state column
 * that reports the wrong state is worse than one that costs a parse.
 *
 * Order matters. Measured outranks N/A (the recorder refuses both at once, so this only
 * decides how a hand-written row reads), and `not_declared` is the fall-through: absence from
 * both documents plus a version that never declared the property cannot mean "not measured".
 */
function stateCase(property, declaringVersions) {
    const quoted = literal(property);
    const versions = declaringVersions.map((version) => String(version)).join(', ') || 'NULL';
    return (`CASE` +
        ` WHEN json_type(e.properties_json, '$.${property}') IS NOT NULL THEN 'measured'` +
        ` WHEN EXISTS (SELECT 1 FROM json_each(e.na_json) AS na WHERE na.value = ${quoted})` +
        ` THEN 'not_applicable'` +
        ` WHEN e.type_version IN (${versions}) THEN 'not_measured'` +
        ` ELSE 'not_declared'` +
        ` END`);
}
/** The columns every generated view carries, before the per-property projections. */
const ENVELOPE_COLUMNS = [
    'id',
    'type_name',
    'type_version',
    'type_hash',
    'recorded_at',
    'run_id',
    'workflow',
    'actor',
    'source',
    'cwd',
    'repo',
    'git_sha',
    'branch',
    'evidence_text',
    'properties_json',
    'na_json',
];
/** Every registered version of a type, oldest first. */
function versionsOf(db, typeName) {
    const rows = db
        .prepare('SELECT version, major, spec_json FROM entry_types WHERE name = ? ORDER BY version ASC')
        .all(typeName);
    return rows.map((row) => ({
        version: row.version,
        major: row.major,
        spec: JSON.parse(row.spec_json),
    }));
}
/**
 * Create the composite expression index for one property, if it is not already there.
 *
 * `IF NOT EXISTS` and never a drop: an index is not derived state that can go stale, and a
 * property dropped in a later major still has old rows an analysis query may group by.
 */
function ensurePropertyIndex(db, typeName, property) {
    const name = indexName(typeName, property);
    const existing = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name);
    if (existing !== undefined)
        return false;
    db.exec(`CREATE INDEX ${ident(name)} ON entries (type_name, json_extract(properties_json, ${literal(`$.${property}`)}))`);
    return true;
}
/**
 * Rebuild every view for a type, and ensure its property indexes exist.
 *
 * Idempotent and safe to call at any time. Returns what it did, so `asc types` can report it
 * and a test can assert that a second call is a no-op rather than trusting that it is.
 */
export function refreshTypeViews(db, typeName) {
    const versions = versionsOf(db, typeName);
    if (versions.length === 0) {
        throw new Error(`no entry type '${typeName}' is registered, so it has no views to build`);
    }
    const indexesCreated = [];
    // One index per property, across ALL versions -- a property introduced in a later minor is
    // exactly the one a new query will filter on, and old rows simply have no key to index.
    const indexed = new Set();
    for (const { spec } of versions) {
        for (const property of spec.properties) {
            if (indexed.has(property.name))
                continue;
            indexed.add(property.name);
            if (ensurePropertyIndex(db, typeName, property.name)) {
                indexesCreated.push(indexName(typeName, property.name));
            }
        }
    }
    // Group by major family. A property is a column if ANY version in the family declares it,
    // and `declaringVersions` is what separates not_measured from not_declared per row.
    const families = new Map();
    for (const version of versions) {
        const family = families.get(version.major);
        if (family === undefined)
            families.set(version.major, [version]);
        else
            family.push(version);
    }
    const viewsCreated = [];
    for (const [major, family] of [...families.entries()].sort(([left], [right]) => left - right)) {
        const properties = new Map();
        for (const { version, spec } of family) {
            for (const property of spec.properties) {
                const declaring = properties.get(property.name);
                if (declaring === undefined)
                    properties.set(property.name, [version]);
                else
                    declaring.push(version);
            }
        }
        // Sorted, so the view's column order is a function of the property set rather than of
        // registration history -- two stores with the same types get byte-identical views.
        const names = [...properties.keys()].sort();
        const projections = names.map((property) => `  json_extract(e.properties_json, ${literal(`$.${property}`)}) AS ${ident(property)},\n` +
            `  ${stateCase(property, properties.get(property) ?? [])} AS ${ident(`${property}_state`)}`);
        const name = viewName(typeName, major);
        const selected = [
            ...ENVELOPE_COLUMNS.map((column) => `  e.${column} AS ${ident(column)}`),
            ...projections,
        ].join(',\n');
        const versionsInFamily = family.map(({ version }) => String(version)).join(', ');
        // SQLite has no CREATE OR REPLACE VIEW. Dropping first is safe: a view holds no data, and
        // this runs inside the registration transaction, so no reader observes the gap.
        db.exec(`DROP VIEW IF EXISTS ${ident(name)}`);
        db.exec(`CREATE VIEW ${ident(name)} AS\nSELECT\n${selected}\n` +
            `  FROM entries AS e\n` +
            ` WHERE e.type_name = ${literal(typeName)} AND e.type_version IN (${versionsInFamily})`);
        viewsCreated.push(name);
    }
    return { type: typeName, views: viewsCreated, indexes: indexesCreated };
}
//# sourceMappingURL=views.js.map