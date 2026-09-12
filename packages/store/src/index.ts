/**
 * @ascend/store -- SQLite persistence.
 *
 * This is the ONLY package permitted to touch SQLite (`node:sqlite`) or the
 * filesystem. Empty at E1 (repo foundation); the schema, migrations and view
 * generation land in E3 -- see beads `asc-0j0`, `asc-fso`, `asc-uy7`.
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

/** The per-project store directory name. Gitignored; never committed. */
export const STORE_DIR = '.ascend';
