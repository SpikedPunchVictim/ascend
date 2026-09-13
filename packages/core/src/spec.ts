/**
 * The declarative property spec -- what an LLM writes at runtime, what gets hashed,
 * versioned and diffed. See ARCHITECTURE.md, "Zod is the enforcement engine".
 *
 * A zod schema is code; storing zod source and `eval`-ing it would be arbitrary code
 * execution and would make a definition unhashable. So the registry persists THIS,
 * and `buildSchema()` (schema.ts) constructs the validator from it.
 *
 * The vocabulary is deliberately ten types, not all of zod. Constraining what an LLM
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
  'json',
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * `json` is the ONE compound type: a JSON **array or object**, and nothing else. Scalars are
 * refused on purpose, and that refusal is the whole reason the type exists rather than reusing
 * `text`.
 *
 * A list-shaped fact (`findings[]`, `what_was_tried`, `options_considered`) has three possible
 * encodings, and two of them are traps. Storing it in a `text` property works at query time --
 * `json_each` reads it straight back into rows -- but validation cannot tell a JSON array from
 * prose, so a recorder that writes "two high-severity bugs" is ACCEPTED and only fails much
 * later, inside a query, far from the entry that caused it. That is a deferred failure with no
 * error at the point of writing, which this project treats as the worst defect class. Declaring
 * the property `json` moves the check to where the recorder can act on it.
 *
 * It is deliberately not unbounded: a type that accepted scalars too would be a superset of
 * `text` and would validate nothing that `text` does not, buying a longer vocabulary and no
 * safety. Array-or-object is the constraint `text` cannot express.
 *
 * There is no schema for the CONTENTS -- no per-key types, no required keys. That is a real
 * limitation, not an oversight: it would be a second, nested definition language, and this one
 * has to stay small enough for an LLM to invent correctly at runtime. The consequence is that
 * `json` validates the SHAPE of the container and leaves the shape of what is inside it to
 * convention and to `asc types brief`'s prose.
 */

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

/**
 * The names the entry ENVELOPE occupies in a generated view, so they cannot also be
 * property names.
 *
 * The envelope is a fixed vocabulary the same way `PROPERTY_TYPES` is, and for the same
 * reason: a property named `source` or `id` cannot be projected faithfully next to it. The
 * generated view claims all 18 of `entries`' columns' worth of namespace for the envelope
 * and projects each property beside them, so `source` as a property and `source` as the
 * envelope are one name for two different values.
 *
 * Measured (asc-865.1, reproduced on the real `registerType` + `recordEntry` path): SQLite
 * does NOT error on that. It keeps the envelope's column and renames the loser to
 * `source:1`, so the exact query ARCHITECTURE.md prescribes --
 * `SELECT source, COUNT(*) FROM v_note_v1 GROUP BY 1` -- returns the ENVELOPE value under
 * the property's name. A wrong answer with no error, which is the class this whole product
 * exists to prevent. So the name is refused at define time, where the cost is one round
 * trip, rather than renamed by SQLite at query time, where the cost is a fabricated finding.
 *
 * These are the columns a view PROJECTS, which is why `ascend_version` and `schema_version`
 * are absent: `entries` carries them, the view does not, so a property named
 * `ascend_version` collides with nothing and is legal. Reserving them would refuse a
 * harmless name.
 *
 * Order is the projection order, and `packages/store/src/sql.ts` projects from this list
 * rather than keeping a second copy of it. `views.test.ts` derives the same set back out of
 * a real view's declared columns, so a column added to the projection without being added
 * here fails a test instead of silently reopening the hole.
 */
export const ENVELOPE_PROPERTY_NAMES = [
  'id',
  'type_name',
  'type_version',
  'type_hash',
  'recorded_at',
  'run_id',
  'workflow',
  'actor',
  'source',
  'cwd',
  'repo',
  'git_sha',
  'branch',
  'evidence_text',
  'properties_json',
  'na_json',
] as const;

/**
 * The pattern a generated view uses for a property's state column: `<property>_state`.
 *
 * Reserved as a PATTERN rather than only against the properties a spec happens to declare,
 * because a major family is versioned and the collision arrives with a LATER version: a spec
 * may declare `error_state` in version 1 and add `error` in version 2, at which point
 * `error_state` is both that property's value column and `error`'s state column. A rule that
 * only fired when both were present would let version 1 through and then have to refuse
 * version 2 -- leaving a registered family that no later version can extend. Refusing the
 * pattern up front is the only form of the rule that is stable under versioning.
 */
export const STATE_COLUMN_SUFFIX = '_state';

/** Why a name is not available as a property name, and a name that is. */
export interface ReservedName {
  /** The reserved name, in canonical form. */
  readonly name: string;
  /** One sentence: which column already occupies the name, and what goes wrong. */
  readonly reason: string;
  /** A name that projects faithfully. Guaranteed not itself reserved. */
  readonly suggestion: string;
}

/**
 * Is this name already claimed by the generated view? `undefined` means it is free.
 *
 * Takes the name as written and canonicalizes it first, so the answer does not depend on
 * the caller having canonicalized: `Source` and `source` are the same name and are refused
 * together. A canonical name is a fixed point of `canonicalName`, so callers that already
 * hold one pay nothing for that.
 *
 * Note what this does NOT refuse, deliberately: `_state` canonicalizes to `state` (leading
 * underscores are stripped, as with every other name), and `state` is claimed by nothing --
 * the suffix is only reserved when something precedes it. So the defect is a property named
 * `error_state`, never the literal `_state`.
 */
export function reservedPropertyName(raw: string): ReservedName | undefined {
  const name = canonicalName(raw);

  if ((ENVELOPE_PROPERTY_NAMES as readonly string[]).includes(name)) {
    return {
      name,
      reason:
        `the entry envelope already carries a column called '${name}', so a query selecting ` +
        `'${name}' would read the envelope value instead of the property`,
      suggestion: `${name}_value`,
    };
  }

  if (name.endsWith(STATE_COLUMN_SUFFIX)) {
    const base = name.slice(0, -STATE_COLUMN_SUFFIX.length);
    return {
      name,
      reason:
        `a generated view names a property's state column '<property>${STATE_COLUMN_SUFFIX}', so a ` +
        `property called '${name}' would occupy the same column as the state of property '${base}'`,
      suggestion: `${name}_value`,
    };
  }

  return undefined;
}

/** Why a name cannot be addressed by the JSON path a view builds for it, and a name that can. */
export interface UnaddressableName {
  /** The name as written. Deliberately NOT canonicalized -- see `unaddressablePropertyName`. */
  readonly name: string;
  /** One sentence: what the name does to the path, and what a reader gets instead. */
  readonly reason: string;
  /**
   * The canonical folding of the name, which IS addressable -- canonical names are `[a-z0-9_]`
   * only, and no character of that set is structural in a JSON path.
   *
   * Not promised to be *free* the way `ReservedName.suggestion` is: `'source.'` folds to
   * `'source'`, which is reserved, and `reservedPropertyName` reports that on its own terms.
   */
  readonly suggestion: string;
}

/**
 * The code point that cannot survive the path string: an unpaired surrogate.
 *
 * Scanned by code point rather than by UTF-16 unit, because a well-formed pair is two units and
 * one code point and must NOT be reported. Measured: a name holding a lone surrogate keeps its
 * key in `properties_json` (`json_valid` is still 1, and a sibling property still reads), but
 * `json_extract(..., '$.a<surrogate>b')` returns NULL -- the escape round-trips into a code unit
 * the path string cannot carry.
 */
function loneSurrogateIn(raw: string): string | undefined {
  for (const character of raw) {
    if (character.length !== 1) continue;
    const code = character.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return character;
  }
  return undefined;
}

/**
 * Characters that make `$.<name>` address something other than the key `<name>`.
 *
 * `position` is part of the entry, not a convenience: `.` and `[` are structural wherever they
 * appear, while `"` and NUL are only fatal at the START -- `$.a"b` and `$.a\0b` were both measured
 * addressing their literal key correctly. Collapsing that distinction would refuse names that
 * project faithfully, which is the same defect as failing to refuse one that does not.
 */
const PATH_BREAKERS: readonly {
  readonly character: string;
  readonly anywhere: boolean;
  readonly reason: string;
}[] = [
  {
    character: '.',
    anywhere: true,
    reason:
      'a dot is the path separator, so the path descends into a nested object and finds nothing ' +
      'where the value actually is',
  },
  {
    character: '[',
    anywhere: true,
    reason: 'a bracket begins a subscript, so the path stops addressing the name as a whole key',
  },
  {
    character: '"',
    anywhere: false,
    reason: 'a leading quote opens a quoted key that the path never closes',
  },
  {
    character: '\u0000',
    anywhere: false,
    reason: 'a leading NUL ends the path before it reaches the name',
  },
];

/**
 * Can a generated view address this name? `undefined` means yes.
 *
 * **What this is for.** A view projects a property with
 * `json_extract(properties_json, '$.<name>')`, so a name that is not a single JSON path segment
 * addresses something else and the column reads NULL while the value sits in the row. That is the
 * failure this module's callers exist to prevent: a queryable surface that reports a plausible
 * wrong answer. `registerType` canonicalizes names on the way in and so cannot store an
 * unaddressable one; this is for the specs that reach the view generator without the registry --
 * a version row inserted by hand, or a store created before the rule existed.
 *
 * **Deliberately does NOT canonicalize, and that is the whole difference from
 * `reservedPropertyName`.** Folding first would HIDE the defect: `canonicalName('a.b')` is
 * `'a_b'`, which is perfectly addressable, so a check on the folded name would report every
 * dotted name as fine. The property's identity is canonical, but the string the view interpolates
 * is the one stored, so this one asks about the string as written. `name` is carried unfolded for
 * the same reason -- a caller printing the canonical form would name a property the store does not
 * hold.
 *
 * **The character set is MEASURED, not read off the grammar.** Every code point from U+0000 to
 * U+10FFFF was probed in four positions (leading, middle, trailing, alone) against a document
 * whose only key was that name, with a well-formed surrogate pair skipped as its own case and a
 * lone surrogate measured separately: 4,448,256 probes, and exactly 12 of them failed to return
 * the value. All 12 come from the four characters above. Two things that grammar would suggest are
 * refuted by that: `]` is harmless on its own (`$.a]b` finds `a]b`), and both `"` and NUL are
 * harmless away from the start. Refusing either would be a false refusal.
 */
export function unaddressablePropertyName(raw: string): UnaddressableName | undefined {
  const folded = canonicalName(raw);
  const suggestion = folded === '' ? 'value' : folded;

  for (const { character, anywhere, reason } of PATH_BREAKERS) {
    if (!raw.includes(character)) continue;
    if (!anywhere && !raw.startsWith(character)) continue;
    return { name: raw, reason, suggestion };
  }

  const surrogate = loneSurrogateIn(raw);
  if (surrogate !== undefined) {
    return {
      name: raw,
      reason: 'it holds an unpaired surrogate, which the JSON path string cannot carry',
      suggestion,
    };
  }

  return undefined;
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
  /**
   * Reasons this spec cannot be USED, however it is spelled. Distinct from `warnings` in
   * kind, not in severity: a warning is a legal spec someone probably did not mean, while an
   * error is a spec no canonicalization can rescue.
   *
   * Canonicalization is where this is decided because it is the one place every spec
   * already passes through, so a caller cannot forget to ask. The registry refuses on a
   * non-empty list; nothing here throws, so a caller can still inspect the canonical form
   * and explain the refusal.
   */
  readonly errors: readonly string[];
}

/** The refusal message for one reserved name, phrased for a human or an LLM to act on. */
function reservedMessage(reserved: ReservedName): string {
  return (
    `property '${reserved.name}' cannot be projected: ${reserved.reason}. ` +
    `Rename it -- '${reserved.suggestion}' projects faithfully.`
  );
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
  const errors: string[] = [];

  if (name !== spec.name) renames.push({ from: spec.name, to: name });
  // An ERROR, and it was a WARNING until asc-0w9. The warning shipped a defect that bricked the
  // whole store, measured end to end: the generated view and its index address a property by JSON
  // path `$.<name>`, and `$.` is not a path. The index is built on `entries`, not on one type, so
  // SQLite evaluates it for EVERY insert -- after defining one empty property name, `asc record`
  // failed with `bad JSON path: '$.'` even for an unrelated, healthy type, while `types list` and
  // `types brief` still exited 0 and the store looked fine. Nothing repairs that store: entries are
  // immutable, types cannot be deleted, and no command drops an index. The sibling reserved-name
  // case below is refused for a strictly smaller reason, which is what makes the old split wrong.
  if (name === '') {
    errors.push(
      `property name '${spec.name}' canonicalizes to empty, so the generated view and its index ` +
        `have no JSON path to address it by ('$.' is not a path) and recording would fail for ` +
        `every type afterwards. Name it with at least one letter or digit.`,
    );
  }

  // Checked on the CANONICAL name, so no spelling of a reserved name gets through: the
  // canonical form is the identity of the property, so it is the form the view would project.
  const reserved = reservedPropertyName(name);
  if (reserved !== undefined) errors.push(reservedMessage(reserved));

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

  return { spec: canonical, renames, warnings, errors };
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
  const errors: string[] = [];

  const name = canonicalName(spec.name);
  if (name !== spec.name) renames.push({ from: spec.name, to: name });

  // Refused here rather than left to the store's `name <> ''` CHECK (asc-0w9), which is the same
  // defect one size smaller: measured, it reached the user as `Error: CHECK constraint failed:
  // name <> ''` -- naming neither canonicalization nor the name nor the fix. The type name is part
  // of every generated view and index name, so it is checked where every spec already passes.
  if (name === '') {
    errors.push(
      `type name '${spec.name}' canonicalizes to empty. A type's name is part of every generated ` +
        `view and index name, so name it with at least one letter or digit.`,
    );
  }

  const properties: PropertySpec[] = [];
  // Keyed by canonical name, and the value carries the spelling the author actually WROTE. The
  // whole point of this check is that two different spellings are one name, so a message quoting
  // only the canonical form would name a string the author never typed -- and `reviewKind` versus
  // `review_kind` is unguessable from the fold alone.
  const byName = new Map<string, { index: number; spelling: string }>();

  for (const property of spec.properties) {
    const result = canonicalizeProperty(property);
    renames.push(...result.renames);
    warnings.push(...result.warnings);
    errors.push(...result.errors);

    const existing = byName.get(result.spec.name);
    if (existing !== undefined) {
      // An ERROR, and it was a WARNING until asc-4if. Two properties that canonicalize to one name
      // is the drift failure mode itself -- but warning about it here did not catch the drift, it
      // *preserved* it. The registry keeps the LAST declaration, so measured end to end on the real
      // binary:
      //
      //   {"name":"rc","properties":[{"name":"review_kind","type":"text"},
      //                               {"name":"reviewKind","type":"number"}]}
      //
      // exited 0, registered ONE property, kept the NUMBER, and silently dropped the author's text
      // declaration. `asc types show` then printed the survivor alone, so the store's own record
      // contradicted the document that had been submitted, and nothing told the author that one of
      // their two declarations had been discarded. A stored shape that disagrees with the submitted
      // document is the false-green class this project treats as severity-zero, so this is refused
      // -- the same branch the reserved-name check above takes, for the same reason.
      errors.push(
        `properties ${String(existing.index)} ('${existing.spelling}') and ` +
          `${String(properties.length)} ('${property.name}') are the same name: both canonicalize ` +
          `to '${result.spec.name}', so the generated view would project one column for two ` +
          `declarations and only one of them could ever be recorded. Rename one of them.`,
      );
    }
    byName.set(result.spec.name, { index: properties.length, spelling: property.name });
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

  return { spec: canonical, renames, warnings, errors };
}

/**
 * The DEFINITION of a type: everything a stored value is validated against, and
 * nothing else.
 *
 * Prose is removed here, at every level -- `description` and `record_when` on the
 * type, `description` on each property. A `type_hash` is computed over this, so this
 * function decides what it means for two definitions to be THE SAME DEFINITION.
 *
 * Prose is excluded deliberately, and it is the same argument as the property-order
 * and enum-order canonicalization above, one step further out:
 *
 *   - Prose affects no stored value. `diffTypeSpec` already says so, classifying a
 *     `record_when` change as `bump: 'none'` with "no stored value is affected".
 *   - Prose is LLM-authored and varies freely between runs. EV-drift measured that
 *     across real model output only 9.1% of property names were shared between runs;
 *     the prose around a definition is at least that variable. Hashing it would mean
 *     two runs that defined the *identical shape* hashed differently and reported as
 *     drift -- recreating the exact problem canonicalization exists to remove.
 *   - `asc types import` moves a definition between projects "preserving `type_hash`"
 *     (ARCHITECTURE.md). That promise is only keepable if the wording each project
 *     shows its recorder does not change the identity of the shape.
 *
 * The consequence is that an entry recorded under one wording and an entry recorded
 * under another are attached to the SAME definition, which is correct: they validate
 * identically, and a query that unions them is unioning comparable values.
 *
 * Each field is kept ONLY where it actually constrains a value, because a field that
 * constrains nothing must not change the hash:
 *
 *   - `required` is kept only when true. `required: false` and omitting it are the
 *     same rule -- optional -- and `buildSchema` treats them identically.
 *   - `enum_values` is kept only on an `enum`, where `buildSchema` uses it. On a
 *     `string` it validates nothing (canonicalizeProperty warns about it), so two
 *     specs differing only there must not read as two definitions.
 *   - `unit` is kept only on a unit-bearing type, for the same reason.
 *
 * That precision is load-bearing rather than tidiness. `diffTypeSpec` classifies
 * changes to the fields that matter and is silent about the rest, so a field kept
 * here but ignored there would let two specs hash DIFFERENTLY while the diff reports
 * no change at all -- the registry would have to invent a version bump with nothing
 * to justify it. Keeping this projection equal to what the validator reads closes
 * that gap by construction.
 *
 * Pure: returns a new spec, never mutates.
 */
export function definitionShape(spec: TypeSpec): TypeSpec {
  return {
    name: spec.name,
    properties: spec.properties.map((property) => ({
      name: property.name,
      type: property.type,
      // exactOptionalPropertyTypes is on: build conditionally rather than passing
      // explicit `undefined`, which would be a different type.
      ...(property.required === true ? { required: true } : {}),
      ...(property.type === 'enum' && property.enum_values !== undefined
        ? { enum_values: property.enum_values }
        : {}),
      ...(UNIT_BEARING_TYPES.includes(property.type) && property.unit !== undefined
        ? { unit: property.unit }
        : {}),
    })),
  };
}
