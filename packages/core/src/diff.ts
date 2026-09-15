/**
 * Classify the difference between two type definitions as no bump, a minor bump, or a
 * major bump. See ARCHITECTURE.md, "Versioning policy".
 *
 * WHY THIS IS A FUNCTION AND NOT A JUDGMENT CALL: definitions are immutable and a new
 * shape is always a NEW ROW, never an UPDATE. The bump decides how that new row is
 * related to the old one -- and it decides whether existing entries can be read
 * alongside the new ones at all:
 *
 *   | bump  | effect                                                        |
 *   |-------|---------------------------------------------------------------|
 *   | minor | backward compatible; views union across minors                 |
 *   | major | new type version, NOT unioned -- old rows are a different shape |
 *
 * A wrong classification is not a cosmetic bug. Calling a major change minor would
 * union two incompatible shapes into one view, which is the schema-drift confound rebuilt
 * from scratch: schema moving under data with nothing recording that it moved.
 *
 * The axis for every rule below is the same question: **can an entry recorded against
 * the old definition still be read correctly under the new one?**
 */

import { canonicalizeTypeSpec } from './spec.js';
import type { PropertySpec, TypeSpec } from './spec.js';

export const BUMPS = ['none', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];

/**
 * Every way a definition can change. A runtime list rather than a bare union so the
 * tests can assert each one is exercised -- the same reason PROPERTY_TYPES is a value
 * and not just a type. A change kind with no test is a classification rule that has
 * never been shown to fire.
 */
export const CHANGE_KINDS = [
  'property_added',
  'property_removed',
  'property_retyped',
  'became_required',
  'became_optional',
  'enum_value_added',
  'enum_value_removed',
  'unit_changed',
  'metadata_changed',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface SpecChange {
  /** The property name, or the type name itself for metadata changes. */
  readonly subject: string;
  readonly kind: ChangeKind;
  readonly bump: Bump;
  /** Why this bump, in the terms of the axis above. */
  readonly detail: string;
}

export interface SpecDiff {
  /** The largest bump any single change requires. 'none' means the specs are equivalent. */
  readonly bump: Bump;
  readonly changes: readonly SpecChange[];
}

const RANK: Record<Bump, number> = { none: 0, minor: 1, major: 2 };

const worst = (bumps: readonly Bump[]): Bump =>
  bumps.reduce<Bump>((acc, bump) => (RANK[bump] > RANK[acc] ? bump : acc), 'none');

/** Enum values as a set: two spellings of the same set are the same set. */
const enumValues = (spec: PropertySpec): readonly string[] => spec.enum_values ?? [];

/**
 * Compare two definitions and classify the change.
 *
 * Both sides are canonicalized first, so a rename-only difference (`reviewKind` vs
 * `review_kind`) is correctly reported as NO change -- they are the same definition,
 * and treating them as a version bump is the drift this project measured and set out
 * to remove.
 *
 * @throws TypeError if the two specs have different names. These are not two versions
 * of one type; they are two types, and reporting a bump between them would create a
 * version row belonging to the wrong type.
 */
export function diffTypeSpec(from: TypeSpec, to: TypeSpec): SpecDiff {
  const before = canonicalizeTypeSpec(from).spec;
  const after = canonicalizeTypeSpec(to).spec;

  if (before.name !== after.name) {
    throw new TypeError(
      `cannot diff '${before.name}' against '${after.name}': different type names are different types, not versions of one type`,
    );
  }

  const changes: SpecChange[] = [];

  const beforeProps = new Map(before.properties.map((p) => [p.name, p]));
  const afterProps = new Map(after.properties.map((p) => [p.name, p]));

  for (const [name, previous] of beforeProps) {
    const next = afterProps.get(name);
    if (next === undefined) {
      changes.push({
        subject: name,
        kind: 'property_removed',
        bump: 'major',
        detail: `'${name}' was removed; entries recorded against it have nowhere to land`,
      });
      continue;
    }

    if (previous.type !== next.type) {
      changes.push({
        subject: name,
        kind: 'property_retyped',
        bump: 'major',
        // The worst case is not a failed read but a successful wrong one: `count` going
        // from number to string is visible, but number to duration reinterprets every
        // stored value silently.
        detail: `'${name}' changed from ${previous.type} to ${next.type}; stored values are reinterpreted, not converted`,
      });
    }

    const wasRequired = previous.required === true;
    const isRequired = next.required === true;
    if (!wasRequired && isRequired) {
      changes.push({
        subject: name,
        kind: 'became_required',
        bump: 'major',
        detail: `'${name}' became required; entries recorded before this have no decision for it`,
      });
    } else if (wasRequired && !isRequired) {
      changes.push({
        subject: name,
        kind: 'became_optional',
        bump: 'minor',
        detail: `'${name}' became optional; every old entry already satisfies it`,
      });
    }

    if (previous.unit !== next.unit) {
      changes.push({
        subject: name,
        kind: 'unit_changed',
        bump: 'major',
        // 250 means 250ms under one definition and 250s under the other. Nothing about
        // the stored number changes, which is exactly what makes this dangerous.
        detail: `'${name}' changed unit from ${previous.unit ?? '(none)'} to ${next.unit ?? '(none)'}; stored magnitudes now mean something else`,
      });
    }

    const beforeValues = new Set(enumValues(previous));
    const afterValues = new Set(enumValues(next));

    for (const value of afterValues) {
      if (!beforeValues.has(value)) {
        changes.push({
          subject: name,
          kind: 'enum_value_added',
          bump: 'minor',
          detail: `'${name}' now also accepts '${value}'; old entries are still valid`,
        });
      }
    }
    for (const value of beforeValues) {
      if (!afterValues.has(value)) {
        changes.push({
          subject: name,
          kind: 'enum_value_removed',
          bump: 'major',
          // Old rows may hold this value, and it is no longer legal under the new
          // definition -- so they cannot be unioned without them becoming invalid.
          detail: `'${name}' no longer accepts '${value}'; entries already hold it`,
        });
      }
    }
  }

  for (const [name, next] of afterProps) {
    if (beforeProps.has(name)) continue;
    const required = next.required === true;
    changes.push({
      subject: name,
      kind: 'property_added',
      // Adding an OPTIONAL property is the one genuinely backward-compatible shape
      // change: old entries simply have no decision recorded for it, which is the
      // default state, not an error.
      bump: required ? 'major' : 'minor',
      detail: required
        ? `'${name}' was added as required; entries recorded before this have no decision for it`
        : `'${name}' was added as optional; old entries read as 'not measured'`,
    });
  }

  // Prose and labels. These change no shape, so nothing has to be bumped -- and
  // bumping for them would inflate the version history with rows that differ only in
  // wording, making real drift harder to spot.
  for (const [label, previous, next] of [
    ['description', before.description, after.description],
    ['record_when', before.record_when, after.record_when],
  ] as const) {
    if (previous !== next) {
      changes.push({
        subject: before.name,
        kind: 'metadata_changed',
        bump: 'none',
        detail: `${label} changed; no stored value is affected`,
      });
    }
  }

  return { bump: worst(changes.map((change) => change.bump)), changes };
}
