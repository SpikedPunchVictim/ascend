/**
 * How one property reads, and how a stored spec gets its prose back.
 *
 * **Two commands need both, so neither owns them.** `asc types show` renders each property as a
 * line for a person; `asc record --scaffold` renders the same lines to stderr beside the skeleton
 * it writes to stdout. They must agree -- a recorder reading the scaffold and a reader checking
 * `types show` are looking at the same type, and a second implementation of "how a property reads"
 * would agree with the first right up until one of them changed.
 *
 * **`renderProperty` is a DISPLAY, and it is the lossy one.** `enum required [approved,
 * changes_requested] -- What the review concluded.` is not a format anything should parse. The
 * structured keys are the parseable answer, and `types show --json` emits those.
 *
 * **`describedProperties` exists because `registry.ts` stores prose separately.** `toStorage`
 * strips every prose field into its own column before a spec is hashed, so
 * `spec.properties[].description` is ALWAYS undefined on a row read back from the store --
 * measured on a real registration, and the reason `asc types show` printed `json` with no
 * description at all for a while (see the comment at its call site). Putting the prose back is
 * therefore not tidiness: for a `json` property the description is the ONLY place the shape inside
 * the container is written down, so a reader without it has the field name and nothing else.
 */

import type { PropertySpec } from '@ascend/core';

/**
 * The stored properties with their prose restored, in the order the store holds them.
 *
 * **That order is the store's, and it is NOT the order the definition document wrote.** Measured,
 * not assumed: a type declaring `o_string, o_number, o_bool, o_time, o_json` scaffolds as
 * `o_bool, o_json, o_number, o_string, o_time`. `canonicalizeTypeSpec` sorts properties by
 * canonical name before the spec is hashed (`core/spec.ts`), deliberately -- two runs that defined
 * the same shape with the fields listed in a different order must hash EQUAL, or every such pair
 * reports as drift and the registry invents a version bump with nothing to justify it. Enum members
 * are sorted there for the same reason. So declaration order is not recoverable here, and this
 * function does not pretend otherwise: it preserves what it was given.
 *
 * The consequence for a reader is only cosmetic, and it is a consistency rather than a loss --
 * `asc types show`, `asc types export` and the scaffold's legend all read the same stored spec, so
 * all three show one type's properties in one order.
 */
export function describedProperties(
  properties: readonly PropertySpec[],
  prose: Readonly<Record<string, string>>,
): readonly PropertySpec[] {
  return properties.map((property) => {
    const description = prose[property.name];
    return description === undefined ? property : { ...property, description };
  });
}

/** One property as a person reads it. Not a format -- see this module's header. */
export function renderProperty(property: PropertySpec): string {
  const parts: string[] = [property.type];
  if (property.required === true) parts.push('required');
  if (property.enum_values !== undefined) parts.push(`[${property.enum_values.join(', ')}]`);
  if (property.unit !== undefined) parts.push(`in ${property.unit}`);
  return property.description === undefined
    ? parts.join(' ')
    : `${parts.join(' ')} -- ${property.description}`;
}
