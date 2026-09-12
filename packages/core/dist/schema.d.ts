/**
 * `buildSchema(spec) -> ZodType`. The enforcement engine, built at runtime from the
 * declarative spec the registry persists.
 *
 * This module is the ONLY place that knows how a property type maps onto a zod type.
 * Keeping that mapping in one exhaustive switch is what makes the bounded vocabulary
 * real: adding a property type means adding a case here, and TypeScript's `never`
 * check makes forgetting one a compile error rather than a silent `z.any()`.
 *
 * What this does NOT do: enforce `required`. `required` means "must have a decision"
 * -- a measured value OR an explicit N/A -- so it cannot be decided from the
 * properties object alone. That rule needs the `na` array too, and lives in
 * `validateEntry` (state.ts), which builds on this.
 */
import { z } from 'zod';
import type { PropertySpec, TypeSpec } from './spec.js';
/**
 * The zod type for one property. Absence is always legal at this level: a missing key
 * means "not measured", which is the default state, not an error.
 */
export declare function propertySchema(spec: PropertySpec): z.ZodTypeAny;
/**
 * The schema for a type's `properties` object: every property optional, each present
 * one validated against its declared type.
 *
 * Unknown keys are stripped rather than rejected, deliberately. A stripped key is
 * recoverable and visible; a rejected entry is lost work, and this tool's primary
 * failure mode is that nothing gets recorded. `validateEntry` reports stripping as a
 * warning so it cannot happen silently.
 */
export declare function buildSchema(spec: TypeSpec): z.ZodObject<Record<string, z.ZodTypeAny>>;
/** A property name in the spec, for membership tests. */
export declare function isDeclaredProperty(spec: TypeSpec, name: string): boolean;
/**
 * Prose for what a property accepts, for error messages.
 *
 * Deliberately describes the DECLARED type rather than echoing the value that failed:
 * the useful half of a validation error is what would have been accepted, and the
 * offending value is already in the message next to it.
 */
export declare function describeProperty(spec: PropertySpec): string;
/**
 * A value that would satisfy the declared type, for use in a corrected command.
 *
 * Only an enum yields a genuinely runnable example, because its accepted values are
 * the one thing the spec actually names. For every other type this returns a
 * placeholder -- inventing `--prop=count=1` would be a fabricated measurement dressed
 * up as advice, which is the failure mode this whole product exists to prevent.
 */
export declare function exampleValue(spec: PropertySpec): string;
//# sourceMappingURL=schema.d.ts.map