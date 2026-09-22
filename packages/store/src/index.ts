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

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  isBusyError,
  sqlitePrimaryCode,
  openStore,
  PragmaError,
  ForeignStoreError,
  StaleStoreError,
  StoreBusyError,
  withRollback,
  withTransaction,
  STORE_DIR,
  STORE_FILE,
  CWD_CONVENTION_KEY,
  CWD_CONVENTION_PROJECT_RELATIVE,
  verifyPragmas,
  type OpenOptions,
  type Store,
} from './db.js';

export {
  assertNotAhead,
  HIGHEST_MARKED_VERSION,
  LedgerMismatchError,
  migrate,
  MIGRATIONS,
  NewerSchemaError,
  SCHEMA_VERSION,
  userVersion,
  type Migration,
  type MigrationResult,
} from './schema.js';

export {
  deprecateType,
  findType,
  listTypes,
  registeredNames,
  registerType,
  UnusableDefinitionError,
  UnusableProseError,
  specHash,
  typeVersions,
  updateTypeProse,
  type RegisteredType,
  type RegisterTypeOptions,
  type TypeSummary,
  type TypeVersionRow,
} from './registry.js';

export { indexName, refreshTypeViews, viewName, type RefreshReport } from './views.js';

export {
  DuplicateEntryError,
  ENTRY_SOURCES,
  EntryRejectedError,
  findEntry,
  recordEntry,
  UnknownTypeError,
  type EntrySource,
  type RecordContext,
  type RecordedEntry,
  type RecordRequest,
  type RecordResult,
} from './recorder.js';

export {
  countSearchMatches,
  indexedDocumentCount,
  propertyValueMatches,
  searchEntries,
  searchScope,
  searchTerms,
  toFtsMatch,
  type PropertyValueHit,
  type SearchHit,
  type SearchOptions,
  type SearchScope,
} from './search.js';

export { entryIds, pageEntries, type PageOptions, type PageResult } from './pages.js';

export { PredicateError, statementCount, wrapPredicate } from './statements.js';

export { typeFilterScope } from './type-filter.js';

export {
  AnnotationError,
  annotationPasses,
  annotationRows,
  INVALIDATION_LABELS,
  listInvalidations,
  listSchemes,
  matchingEntryIds,
  recordAnnotations,
  recordInvalidation,
  registerScheme,
  RESERVED_SCHEME,
  schemeCensus,
  schemeHash,
  SchemeError,
  schemeVersions,
  type AnnotationContext,
  type AnnotationInput,
  type AnnotationPass,
  type AnnotationPassRow,
  type AnnotationRow,
  type InvalidationLabel,
  type InvalidationRow,
  type RecordedAnnotations,
  type RecordedInvalidation,
  type RecordInvalidationInput,
  type RegisteredScheme,
  type SchemeCensus,
  type SchemeContext,
  type SchemeRule,
  type SchemeRuleKind,
  type SchemeSpec,
  type SchemeSummary,
} from './annotations.js';

export {
  signatures,
  type EntrySignature,
  type SignatureCell,
  type SignatureProperty,
} from './signatures.js';

export type { EntryState } from './sql.js';

export {
  profileType,
  TOP_K,
  type InvalidatedLabelCount,
  type InvalidatedSummary,
  type ProfileOptions,
  type PropertyProfile,
  type PropertySummary,
  type PropertyValueCount,
  type StateCounts,
  type TypeProfile,
  type VersionProfile,
} from './profile.js';

export {
  entryStates,
  groupEntries,
  GroupKeyCountError,
  GroupTopKError,
  UngroupablePropertyError,
  UnknownGroupKeyError,
  type GroupAxis,
  type GroupCount,
  type GroupKeyValue,
  type GroupRequest,
  type GroupResult,
} from './crosstab.js';

export {
  AliasInUseError,
  attachStore,
  attachHeadroom,
  databaseNames,
  detachStore,
  foldDatabaseName,
  DuplicateProjectError,
  IncompatibleDefinitionsError,
  NotAnAscendStoreError,
  requireStore,
  TypeNotInAnyProjectError,
  unionEntries,
  UnknownTypeHashError,
  type Attachment,
  type DefinitionGroup,
  type ProjectSource,
  type UnionOptions,
  type UnionProject,
  type UnionResult,
  type UnionRow,
} from './union.js';
