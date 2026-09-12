/**
 * The three-state property model, and the validation that enforces it.
 * See ARCHITECTURE.md, "Three-state property values" -- load-bearing, cannot be
 * retrofitted.
 *
 * | state          | encoding                     | meaning                      |
 * |----------------|------------------------------|------------------------------|
 * | measured       | key present in `properties`  | a real value, INCLUDING `0`  |
 * | not applicable | name listed in `na`          | meaningless in this context  |
 * | not measured   | absent from both             | default; silence never = 0   |
 *
 * The whole product turns on these being three distinct things. The fold corpus
 * collapsed them into one, so `0` meant "measured zero", "unknown" and "doesn't
 * apply" simultaneously, and no downstream statistic could recover which.
 *
 * `required` therefore means "must have a DECISION" -- a value or an explicit N/A --
 * never "must have a value". If it meant the latter, it would pressure a recorder
 * into fabricating a number when the honest answer is "doesn't apply", which is
 * precisely how the fold corpus acquired its ambiguity.
 */
import { describeProperty, exampleValue, isDeclaredProperty, propertySchema } from './schema.js';
/** The property spec for a name, or undefined when it is not declared. */
function declared(spec, name) {
    return spec.properties.find((property) => property.name === name);
}
/** The command form a recorder would use. From ARCHITECTURE.md's CLI surface. */
function recordCommand(spec, property, value) {
    return `asc record ${spec.name} --prop=${property}=${value}`;
}
/**
 * Validate a recording against a type definition and resolve every property's state.
 *
 * Pure: no clock, no I/O. Returns a fresh object and never mutates its input, so a
 * caller can validate speculatively without side effects.
 */
export function validateEntry(spec, input) {
    const errors = [];
    const warnings = [];
    const offered = input.properties ?? {};
    const naInput = input.na ?? [];
    // --- values -----------------------------------------------------------------
    const properties = {};
    for (const [name, value] of Object.entries(offered)) {
        const property = declared(spec, name);
        if (property === undefined) {
            // Stripped rather than rejected: a stripped key is recoverable and visible, a
            // rejected entry is lost work. Stripping is reported so it cannot be silent.
            warnings.push({
                field: name,
                problem: `'${name}' is not a property of ${spec.name}, so it was dropped`,
                fix: `Declared properties: ${spec.properties.map((p) => p.name).join(', ') || '(none)'}. ` +
                    `Remove it, or declare it with 'asc types define' (which adds a new version).`,
            });
            continue;
        }
        const parsed = propertySchema(property).safeParse(value);
        if (!parsed.success) {
            const detail = parsed.error.issues[0]?.message ?? 'invalid value';
            errors.push({
                field: name,
                problem: detail,
                fix: `'${name}' expects ${describeProperty(property)}. ` +
                    `Re-record with: ${recordCommand(spec, name, exampleValue(property))}`,
            });
            continue;
        }
        properties[name] = parsed.data;
    }
    // --- explicit not-applicable ------------------------------------------------
    const na = [];
    const seenNa = new Set();
    for (const raw of naInput) {
        if (!isDeclaredProperty(spec, raw)) {
            warnings.push({
                field: raw,
                problem: `'${raw}' is not a property of ${spec.name}, so it was dropped from na`,
                fix: `Declared properties: ${spec.properties.map((p) => p.name).join(', ') || '(none)'}`,
            });
            continue;
        }
        if (seenNa.has(raw)) {
            warnings.push({
                field: raw,
                problem: `'${raw}' is listed in na more than once`,
                fix: `List each property once: --na ${[...new Set(naInput)].join(',')}`,
            });
            continue;
        }
        seenNa.add(raw);
        na.push(raw);
    }
    // --- resolve states ---------------------------------------------------------
    // Every declared property gets a state, so a caller can compute three-state ratios
    // across the whole definition without re-deriving what "absent" meant.
    const states = {};
    for (const property of spec.properties) {
        if (property.name in properties)
            states[property.name] = 'measured';
        else if (seenNa.has(property.name))
            states[property.name] = 'not_applicable';
        else
            states[property.name] = 'not_measured';
    }
    // --- contradictions ---------------------------------------------------------
    for (const name of na) {
        if (name in properties) {
            // Both measured and declared meaningless. Storing this would put one entry in
            // two states at once, which is the ambiguity the model exists to remove.
            const property = declared(spec, name);
            errors.push({
                field: name,
                problem: `'${name}' is both measured and listed as not applicable`,
                fix: `Choose one. Keep the value (drop it from --na), or keep the N/A ` +
                    `(re-record with: asc record ${spec.name} --na ${name} and without --prop=${name}=...).` +
                    (property === undefined ? '' : ` Accepted: ${describeProperty(property)}.`),
            });
        }
    }
    // --- required means "must have a decision" ----------------------------------
    for (const property of spec.properties) {
        if (property.required !== true)
            continue;
        if (states[property.name] !== 'not_measured')
            continue;
        errors.push({
            field: property.name,
            problem: `'${property.name}' is required and has no decision recorded`,
            fix: `Required means a value OR an explicit N/A -- not necessarily a value. ` +
                `Record: ${recordCommand(spec, property.name, exampleValue(property))}, ` +
                `or: asc record ${spec.name} --na ${property.name}`,
        });
    }
    // --- legal but almost certainly unintended ----------------------------------
    if (spec.properties.length > 0 && na.length === spec.properties.length) {
        warnings.push({
            field: 'na',
            problem: `every property of ${spec.name} is marked not applicable`,
            fix: `An entry where nothing applies may be better recorded as a different type, ` +
                `or not at all. Recording it is legal.`,
        });
    }
    return {
        ok: errors.length === 0,
        properties,
        na,
        states,
        errors,
        warnings,
    };
}
//# sourceMappingURL=state.js.map