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
export { PROPERTY_TYPES, UNIT_BEARING_TYPES, canonicalName, canonicalizeProperty, canonicalizeTypeSpec, } from './spec.js';
export { buildSchema, describeProperty, exampleValue, isDeclaredProperty, propertySchema, } from './schema.js';
export { validateEntry, } from './state.js';
export { BUMPS, CHANGE_KINDS, diffTypeSpec, } from './diff.js';
export { canonicalJson, sha256Hex, typeHash } from './hash.js';
//# sourceMappingURL=index.js.map