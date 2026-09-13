/**
 * @ascend/core -- pure core.
 *
 * Purity contract (ARCHITECTURE.md; enforced by the ESLint purity block, by
 * `packages/core/test/purity-enforcement.test.ts`, and by `align check`):
 * zero `fs`, zero `Date.now()`, zero network. Time and identifiers are injected,
 * never read from the ambient environment.
 *
 * That contract is why the modules below are all pure functions over plain values:
 * the statistics and the spec logic stay testable against fixtures with hand-computed
 * expected values, with no database and no clock in the way.
 */

export {
  ENVELOPE_PROPERTY_NAMES,
  PROPERTY_TYPES,
  STATE_COLUMN_SUFFIX,
  UNIT_BEARING_TYPES,
  canonicalName,
  canonicalizeProperty,
  canonicalizeTypeSpec,
  definitionShape,
  reservedPropertyName,
  type Canonicalized,
  type PropertySpec,
  type PropertyType,
  type Rename,
  type ReservedName,
  type TypeSpec,
} from './spec.js';

export { confusableNames, nameTokens, type ConfusableName } from './names.js';

export {
  buildSchema,
  describeProperty,
  isDeclaredProperty,
  propertySchema,
  runnableValue,
} from './schema.js';

export {
  validateEntry,
  type EntryInput,
  type PropertyState,
  type ValidatedEntry,
  type ValidationIssue,
} from './state.js';

export {
  BUMPS,
  CHANGE_KINDS,
  diffTypeSpec,
  type Bump,
  type ChangeKind,
  type SpecChange,
  type SpecDiff,
} from './diff.js';

export { canonicalJson, sha256Hex, typeHash, type Json } from './hash.js';
