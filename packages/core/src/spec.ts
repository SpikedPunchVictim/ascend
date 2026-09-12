/**
 * The declarative property spec -- what an LLM writes at runtime, what gets hashed,
 * versioned and diffed. See ARCHITECTURE.md, "Zod is the enforcement engine".
 *
 * A zod schema is code; storing zod source and `eval`-ing it would be arbitrary code
 * execution and would make a definition unhashable. So the registry persists THIS,
 * and `buildSchema()` (schema.ts) constructs the validator from it.
 *
 * The vocabulary is deliberately nine types, not all of zod. Constraining what an LLM
 * can invent is the primary structural defense against drift -- but EV-drift measured
 * that it is NOT sufficient on its own, which is why canonicalization lives here too.
 */

/** The bounded vocabulary. Settled in ARCHITECTURE.md, "Decisions settled". */
export const PROPERTY_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
  'timestamp',
  'duration',
  'ref',
  'text',
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Property types whose `unit` is meaningful. A unit on `boolean` is a spec error. */
export const UNIT_BEARING_TYPES: readonly PropertyType[] = ['number', 'integer', 'duration'];

export interface PropertySpec {
  readonly name: string;
  readonly type: PropertyType;
  /**
   * `required` means "must have a DECISION" -- a measured value OR an explicit N/A --
   * never "must have a value". See state.ts and ARCHITECTURE.md, "Three-state property
   * values". Optional is the default.
   */
  readonly required?: boolean;
  /** Only meaningful when `type` is 'enum'. Required in that case, forbidden otherwise. */
  readonly enum_values?: readonly string[];
  readonly description?: string;
  /** Only meaningful for UNIT_BEARING_TYPES. */
  readonly unit?: string;
}

export interface TypeSpec {
  readonly name: string;
  readonly description?: string;
  /** Prose describing when an LLM should record this. Surfaced by `asc types brief`. */
  readonly record_when?: string;
  readonly properties: readonly PropertySpec[];
}

/**
 * Fold a name to its canonical form: snake_case, lowercase.
 *
 * This is the direct fix for the drift EV-drift measured -- across 44 real LLM-authored
 * property names only 9.1% were shared (Jaccard 0.300, thresholds 0.70 / 0.60), with
 * snake_case and camelCase mixed freely. `reviewKind`, `review-kind` and `review_kind`
 * must not be three different properties.
 */
export function canonicalName(raw: string): string {
  return (
    raw
      // camelCase / PascalCase boundaries: reviewKind -> review_Kind
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      // acronym runs: HTTPServer -> HTTP_Server
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      // any other separator run: kebab, dot, space, slash
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
  );
}

/** A single canonicalization applied to a spec, so the caller can surface it. */
export interface Rename {
  readonly from: string;
  readonly to: string;
}

export interface Canonicalized<T> {
  readonly spec: T;
  /** Non-empty when the input was rewritten. Empty means the input was already canonical. */
  readonly renames: readonly Rename[];
  /** Things that are legal but almost certainly a mistake. Not errors. */
  readonly warnings: readonly string[];
}

/**
 * Canonicalize a property spec. Pure: returns a new spec, never mutates.
 *
 * Idempotent by construction -- canonicalName(canonicalName(x)) === canonicalName(x) -- which
 * is what lets the registry treat canonical form as the identity of a definition.
 */
export function canonicalizeProperty(spec: PropertySpec): Canonicalized<PropertySpec> {
  const name = canonicalName(spec.name);
  const renames: Rename[] = [];
  const warnings: string[] = [];

  if (name !== spec.name) renames.push({ from: spec.name, to: name });
  if (name === '') warnings.push(`property name '${spec.name}' canonicalizes to empty`);

  // Trimmed AND sorted. An enum is a SET of allowed values -- the order an author
  // listed them in carries no meaning for validation, so leaving it in would make two
  // spellings of the same set hash differently and read as drift.
  const enum_values = spec.enum_values?.map((v) => v.trim()).sort();
  if (enum_values !== undefined) {
    const seen = new Set<string>();
    for (const value of enum_values) {
      if (seen.has(value)) warnings.push(`property '${name}' repeats enum value '${value}'`);
      seen.add(value);
    }
  }

  if (spec.type === 'enum' && (enum_values === undefined || enum_values.length === 0)) {
    warnings.push(`property '${name}' is an enum with no enum_values; it can never validate`);
  }
  if (spec.type !== 'enum' && spec.enum_values !== undefined) {
    warnings.push(`property '${name}' has enum_values but its type is '${spec.type}'`);
  }
  if (spec.unit !== undefined && !UNIT_BEARING_TYPES.includes(spec.type)) {
    warnings.push(`property '${name}' has a unit but its type is '${spec.type}'`);
  }

  // exactOptionalPropertyTypes is on, so build the object conditionally rather than
  // passing explicit `undefined` -- the two are different types under that flag.
  const canonical: PropertySpec = {
    name,
    type: spec.type,
    ...(spec.required === undefined ? {} : { required: spec.required }),
    ...(enum_values === undefined ? {} : { enum_values }),
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.unit === undefined ? {} : { unit: spec.unit }),
  };

  return { spec: canonical, renames, warnings };
}

/**
 * Canonicalize a whole type spec.
 *
 * Also applies EV-drift's `required` sanity rule: a definition marking every property
 * required is almost certainly wrong. `required` means "must have a decision", so an
 * all-required definition is claiming every property is always meaningful -- the exact
 * shape that pressures a model into fabricating a number when the honest answer is
 * "doesn't apply".
 */
export function canonicalizeTypeSpec(spec: TypeSpec): Canonicalized<TypeSpec> {
  const renames: Rename[] = [];
  const warnings: string[] = [];

  const name = canonicalName(spec.name);
  if (name !== spec.name) renames.push({ from: spec.name, to: name });

  const properties: PropertySpec[] = [];
  const byName = new Map<string, number>();

  for (const property of spec.properties) {
    const result = canonicalizeProperty(property);
    renames.push(...result.renames);
    warnings.push(...result.warnings);

    const existing = byName.get(result.spec.name);
    if (existing !== undefined) {
      // Two properties that canonicalize to the same name is the drift failure mode
      // itself, caught at define time rather than discovered months later.
      warnings.push(
        `properties ${String(existing)} and ${String(properties.length)} both canonicalize to '${result.spec.name}'`,
      );
    }
    byName.set(result.spec.name, properties.length);
    properties.push(result.spec);
  }

  // Sorted by canonical name. Property order is an authoring artifact, not part of the
  // definition: two LLM runs that define the same type with the fields listed in a
  // different order must hash equal, or every such pair reports as drift. This also
  // makes the generated view's column order deterministic.
  properties.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  if (properties.length > 0 && properties.every((p) => p.required === true)) {
    warnings.push(
      `type '${name}' marks every property required; 'required' means "must have a decision", ` +
        `so this claims every property is always meaningful`,
    );
  }

  const canonical: TypeSpec = {
    name,
    properties,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.record_when === undefined ? {} : { record_when: spec.record_when }),
  };

  return { spec: canonical, renames, warnings };
}
