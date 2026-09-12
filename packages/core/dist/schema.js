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
/**
 * The zod type for one property. Absence is always legal at this level: a missing key
 * means "not measured", which is the default state, not an error.
 */
export function propertySchema(spec) {
    switch (spec.type) {
        case 'string':
            return z.string();
        case 'number':
            // `finite` rejects NaN and the infinities. A NaN recorded as a measurement is
            // indistinguishable from a bug, and it poisons every downstream statistic.
            return z.number().finite();
        case 'integer':
            return z.number().int().finite();
        case 'boolean':
            return z.boolean();
        case 'enum': {
            // Destructured rather than checked by length: `z.enum` needs a
            // `[string, ...string[]]` tuple, and under `noUncheckedIndexedAccess` only a
            // destructure narrows the first element to `string`. A length check would leave
            // `first` as `string | undefined` and force a type assertion at the call.
            const [first, ...rest] = spec.enum_values ?? [];
            if (first === undefined) {
                // Legal to define, impossible to satisfy. `canonicalizeProperty` warns at
                // define time; this makes the failure legible if one slips through.
                return z.never({
                    message: `enum '${spec.name}' has no enum_values, so no value can satisfy it`,
                });
            }
            return z.enum([first, ...rest]);
        }
        case 'timestamp':
            // ISO 8601, stored as a string so the JSON stays readable and sortable. Offsets
            // are allowed so a recorder is not forced to normalize before writing.
            return z.string().datetime({ offset: true, message: 'expected an ISO 8601 timestamp' });
        case 'duration':
            // A magnitude in `unit` (ms by default). Negative elapsed time is meaningless;
            // it means a clock was read in the wrong order somewhere upstream.
            return z.number().finite().nonnegative();
        case 'ref':
            // An opaque identifier pointing at something else. Deliberately not validated
            // as a UUID or any particular scheme -- a ref may name an entry, a file, a commit.
            return z.string().min(1);
        case 'text':
            // Unstructured prose. This is the long form: `evidence_text` exists for the
            // free text that no property anticipated.
            return z.string();
        default: {
            // Exhaustiveness. If a property type is added to the vocabulary and not handled
            // here, this line fails to compile -- which is the entire point.
            const unhandled = spec.type;
            throw new Error(`unhandled property type: ${String(unhandled)}`);
        }
    }
}
/**
 * The schema for a type's `properties` object: every property optional, each present
 * one validated against its declared type.
 *
 * Unknown keys are stripped rather than rejected, deliberately. A stripped key is
 * recoverable and visible; a rejected entry is lost work, and this tool's primary
 * failure mode is that nothing gets recorded. `validateEntry` reports stripping as a
 * warning so it cannot happen silently.
 */
export function buildSchema(spec) {
    const shape = {};
    for (const property of spec.properties) {
        shape[property.name] = propertySchema(property).optional();
    }
    return z.object(shape);
}
/** A property name in the spec, for membership tests. */
export function isDeclaredProperty(spec, name) {
    return spec.properties.some((property) => property.name === name);
}
/**
 * Prose for what a property accepts, for error messages.
 *
 * Deliberately describes the DECLARED type rather than echoing the value that failed:
 * the useful half of a validation error is what would have been accepted, and the
 * offending value is already in the message next to it.
 */
export function describeProperty(spec) {
    switch (spec.type) {
        case 'string':
            return 'a string';
        case 'number':
            return 'a number';
        case 'integer':
            return 'an integer';
        case 'boolean':
            return 'true or false';
        case 'enum': {
            const values = spec.enum_values ?? [];
            return values.length === 0
                ? 'an enum with no enum_values, so no value can ever satisfy it'
                : `one of: ${values.join(', ')}`;
        }
        case 'timestamp':
            return 'an ISO 8601 timestamp, e.g. 2026-09-11T10:00:00Z';
        case 'duration':
            return `a non-negative magnitude in ${spec.unit ?? 'ms'}`;
        case 'ref':
            return 'a non-empty identifier';
        case 'text':
            return 'text';
        default: {
            const unhandled = spec.type;
            throw new Error(`unhandled property type: ${String(unhandled)}`);
        }
    }
}
/**
 * A value that would satisfy the declared type, for use in a corrected command.
 *
 * Only an enum yields a genuinely runnable example, because its accepted values are
 * the one thing the spec actually names. For every other type this returns a
 * placeholder -- inventing `--prop=count=1` would be a fabricated measurement dressed
 * up as advice, which is the failure mode this whole product exists to prevent.
 */
export function exampleValue(spec) {
    if (spec.type === 'enum') {
        const [first] = spec.enum_values ?? [];
        if (first !== undefined)
            return first;
    }
    return `<${spec.type}>`;
}
//# sourceMappingURL=schema.js.map