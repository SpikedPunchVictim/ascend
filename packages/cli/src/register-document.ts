/**
 * Registering one parsed document: the step `define` and `import` both perform.
 *
 * It lives here rather than in either command because the interesting part is a refusal that
 * must happen in both. `registerType` writes nothing when a shape is already known -- it
 * reports `unchanged` -- so a document whose *prose* was edited would be dropped in silence
 * while its command reported success. That is the severity-zero class this project treats as
 * worse than a failure, and it is exactly the kind of fix that gets applied to the command
 * someone noticed it in and not to the one they did not. So there is one implementation, and
 * both commands call it.
 *
 * Prose is safe to update in place because it is not identity: `type_hash` is computed over
 * `definitionShape`, which drops every prose field, so `updateTypeProse` changes what the
 * recorder is *told* and never what a stored value *means*. No entry is invalidated, no
 * version is minted, and two projects that described the same shape in different words stay
 * comparable.
 */

import { canonicalName, type Bump, type Rename } from '@ascend/core';
import { findType, listTypes, registerType, updateTypeProse, type Store } from '@ascend/store';
import { documentSpec, type TypeDocument } from './document.js';

/** What registering a document did, in the terms a caller cares about. */
export interface DocumentRegistration {
  readonly name: string;
  readonly version: number;
  readonly major: number;
  readonly typeHash: string;
  /**
   * `prose-updated` is a third outcome, not a flavour of `unchanged`: the shape was already
   * known *and* this call changed what the store says about it. Collapsing it into
   * `unchanged` is precisely the silent no-op this module exists to prevent.
   */
  readonly outcome: 'created' | 'unchanged' | 'prose-updated';
  readonly bump: Bump;
  readonly changeCount: number;
  readonly renames: readonly Rename[];
  readonly warnings: readonly string[];
}

export interface RegisterDocumentOptions {
  /** ISO-8601 UTC. Injected -- nothing here reads a clock. */
  readonly registeredAt: string;
  readonly dryRun: boolean;
}

/**
 * Register `document`, updating its prose if the shape was already known.
 *
 * `dryRun` runs the whole thing and rolls it back (`registerType`'s own option), and the
 * prose update is skipped rather than rolled back with it: `updateTypeProse` is a separate
 * statement outside that transaction, so previewing it means not issuing it. The preview is
 * still computed by the same code that decides the real thing -- `pendingProseChange` below --
 * so a dry run cannot report an outcome the real run would not produce.
 */
export function registerDocument(
  store: Store,
  document: TypeDocument,
  options: RegisterDocumentOptions,
): DocumentRegistration {
  const result = registerType(store.db, documentSpec(document), {
    registeredAt: options.registeredAt,
    ...(document.description === undefined ? {} : { description: document.description }),
    ...(document.record_when === undefined ? {} : { recordWhen: document.record_when }),
    ...(document.prose === undefined ? {} : { prose: document.prose }),
    ...(options.dryRun ? { dryRun: true } : {}),
  });

  const proseChanged =
    pendingProseChange(document, store, result.name, result.version) !== undefined;
  const outcome: DocumentRegistration['outcome'] =
    result.outcome === 'created' ? 'created' : proseChanged ? 'prose-updated' : 'unchanged';

  if (outcome === 'prose-updated' && !options.dryRun) {
    // Merges property prose rather than replacing it, so a document that mentions one
    // property leaves the prose of the others alone.
    const propertyProse = documentPropertyProse(document);
    updateTypeProse(store.db, result.name, result.version, {
      ...(document.description === undefined ? {} : { description: document.description }),
      ...(document.record_when === undefined ? {} : { recordWhen: document.record_when }),
      ...(Object.keys(propertyProse).length === 0 ? {} : { propertyProse }),
    });
  }

  return {
    name: result.name,
    version: result.version,
    major: result.major,
    typeHash: result.typeHash,
    outcome,
    bump: result.bump,
    changeCount: result.changes.length,
    renames: result.renames,
    warnings: result.warnings,
  };
}

/**
 * A document's per-property prose, keyed as the document spells the property name.
 *
 * Two spellings exist in the document format (`document.ts`'s file comment): a property's own
 * `description`, and the top-level `prose` map. `toStorage` (`registry.ts`) folds both into one
 * map on the CREATE path -- inline first, then the top-level map overrides -- and this is the
 * same fold, so a document that uses both spellings for one property is resolved identically
 * whether it is registering a first version or updating an existing one. Reusing that precedence
 * rather than re-deciding it here is what asc-v7t's fix direction calls out explicitly: create
 * and update disagreeing about which spelling wins would be a new cross-implementation
 * divergence of exactly the kind this module's file comment already warns about.
 */
function documentPropertyProse(document: TypeDocument): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const property of document.properties) {
    if (property.description !== undefined) merged[property.name] = property.description;
  }
  for (const [key, value] of Object.entries(document.prose ?? {})) {
    merged[key] = value;
  }
  return merged;
}

/**
 * The prose update this document would make, or `undefined` if there is nothing to change.
 *
 * Returns the work rather than doing it, so that a dry run reports the outcome the real run
 * would produce without the two drifting into separate code paths -- the preview is computed
 * by the code that decides the real thing, not by a description of it.
 *
 * Only fields the document actually mentions are compared. A document that says nothing about
 * `record_when` is not asking for its stored value to be cleared.
 */
function pendingProseChange(
  document: TypeDocument,
  store: Store,
  name: string,
  version: number,
): 'pending' | undefined {
  const stored = findType(store.db, name, version);
  if (stored === undefined) return undefined;

  if (
    document.description !== undefined &&
    document.description !== (stored.description ?? undefined)
  ) {
    return 'pending';
  }
  if (
    document.record_when !== undefined &&
    document.record_when !== (stored.recordWhen ?? undefined)
  ) {
    return 'pending';
  }
  // Inline `properties[].description` and the top-level `prose` map both land here (asc-v7t):
  // comparing only the top-level map is how a re-registration with an edited INLINE description
  // reported `unchanged` while the prose sat un-updated in the store.
  for (const [property, text] of Object.entries(documentPropertyProse(document))) {
    // Folded, because the store folded it on the way in: a document that spells a property
    // `reviewKind` has its prose stored under `review_kind` (`canonicalProseKeys`), and comparing
    // the document's raw key against the stored map would miss -- so this would answer `pending`
    // for prose that is already exactly what the document asks for. That is a false "changed"
    // reported on every run of an idempotent command, which is the class of wrong answer this
    // whole module exists to prevent. Measured before the fold was added here: `asc types define`
    // with a `reviewKind` prose key reported `prose-updated` on the second run of the same file.
    if (stored.prose[canonicalName(property)] !== text) return 'pending';
  }
  return undefined;
}

/**
 * The known type names, for the "no such type" message.
 *
 * Every command that refuses an unknown name prints the names that exist, because the useful
 * question after "no such type 'review'" is *which* types there are. Read through `listTypes`
 * rather than a query of its own, so this cannot list a different set than `asc types list`.
 *
 * An empty registry says so rather than rendering an empty list, which would read as a command
 * that failed to produce output.
 */
export function knownNames(store: Store): string {
  const names = listTypes(store.db).map((summary) => summary.name);
  return names.length === 0
    ? 'No entry types are registered in this project yet.'
    : `The types in this project are: ${names.join(', ')}.`;
}
