/**
 * @ascend/store -- SQLite persistence.
 *
 * This is the ONLY package permitted to touch SQLite (`node:sqlite`) or the
 * filesystem. Pure logic lives in @ascend/core; everything here is the boundary.
 *
 * Storage decisions carried in from the Stage 0 spike (docs/evidence/):
 *   - `node:sqlite`, not `better-sqlite3` -- faster (1,201,616 vs 988,435
 *     rows/sec) and no native dependency (EV-runtime.md).
 *   - One `entries` table with a `properties` JSON document + a generated
 *     per-type view (EV-storage.md).
 *   - The registry MUST emit composite expression indexes of the form
 *     `(type_name, json_extract(properties_json, '$.<prop>'))`. The bare
 *     expression index is WORSE THAN NO INDEX -- it cannot carry the type_name
 *     predicate, so SQLite scans the entire index (EV-storage.md).
 *   - FTS5 over `evidence_text` uses the `trigram` tokenizer, chosen on measured
 *     partial-token coverage (100% vs 60%), NOT inherited from mast (EV-fts.md).
 *   - `ALTER TABLE ADD COLUMN ... STORED` is rejected on any populated table.
 *     Only VIRTUAL generated columns are available at runtime (EV-storage.md).
 */
export { DEFAULT_BUSY_TIMEOUT_MS, openStore, PragmaError, STORE_DIR, STORE_FILE, verifyPragmas, } from './db.js';
export { migrate, MIGRATIONS, NewerSchemaError, SCHEMA_VERSION, userVersion, } from './schema.js';
export { deprecateType, findType, registerType, typeVersions, updateTypeProse, } from './registry.js';
export { indexName, refreshTypeViews, viewName } from './views.js';
export { DuplicateEntryError, ENTRY_SOURCES, EntryRejectedError, findEntry, recordEntry, UnknownTypeError, } from './recorder.js';
export { indexedDocumentCount, searchEntries, toFtsMatch, } from './search.js';
//# sourceMappingURL=index.js.map