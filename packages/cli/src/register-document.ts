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
 *
 * **The prose question is asked by the producer, not re-derived here (E12.4b3).** This module used
 * to call `registerType` and then decide for itself whether a prose-only edit had happened, by
 * comparing the document against the stored row (`pendingProseChange`) and issuing its own
 * `updateTypeProse`. Both of those are writers, and after the flip a write is only real if a LINE
 * carries it to the tree -- so a `updateTypeProse` issued here would change the index and survive
 * the next rebuild nowhere. `produce.type` already asks exactly this question and already emits the
 * line for it (`line-producers.ts`'s `TypeProduction.proseUpdated`, and the `pendingProseUpdate`
 * call inside `typeLines`), so this module asks the producer instead of keeping a second copy of
 * the rule.
 *
 * The folded property prose is the one thing this module still has to supply, because the producer
 * is handed a `TypeSpec` and a document's inline `properties[].description` is not part of one. It
 * arrives CANONICAL, which is what `pendingProseUpdate` documents it expects, so the comparison the
 * producer makes is against the same spellings the store holds -- the asc-v7t defect, where a
 * `reviewKind` prose key reported a change on every run of an idempotent command. (`replayType`, the
 * other caller of `pendingProseUpdate`, needs nothing here: it is handed a `documentFromRow`, whose
 * keys came back out of the store already canonical.)
 *
 * Canonicalizing changes the key that is COMPARED, never which conflicts are an error: if two of the
 * document's spellings fold to one property, the map goes to the store RAW and `canonicalProseKeys`
 * refuses it, exactly as it would have without this fold. Picking a winner here would be the silent
 * resolution of a conflict the store refuses on purpose (`asc-4if`).
 */

import { canonicalName, GUIDANCE_FIELDS, type Bump, type Rename } from '@ascend/core';
import {
  findType,
  listTypes,
  previewProducedLines,
  typeRegistrationOptions,
  writeProducedLines,
  type Producers,
  type SqlDatabase,
} from '@ascend/store';
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
}

/**
 * The options `registerDocument` itself takes: the same, plus who decides whether anything is
 * written.
 *
 * A separate type rather than an optional field, because the two callers answer it differently and
 * neither should be able to answer it by accident. `registerDocumentVia` is called INSIDE somebody
 * else's sequence -- `asc import` registers a corpus in one transaction -- so whether anything is
 * written is that caller's decision, already made, and there is no honest value for this module to
 * accept here. `registerDocument` is called by `asc types define`, which owns the choice itself.
 */
export interface RegisterDocumentRunOptions extends RegisterDocumentOptions {
  readonly dryRun: boolean;
}

/**
 * Register `document` inside the caller's own producing sequence, and report what it did.
 *
 * **`db` is the sequence's transaction handle, and it is needed rather than passed for symmetry.**
 * `droppedGuidance` below reads version N-1 to warn about a guidance field this version drops, and
 * after the flip the handle a command holds on the way in is read-only -- and would not see N-1
 * beside the N this call just minted even if it were not. So the read comes from the transaction
 * that is minting, which is what `writeProducedLines` hands its body (asc-q4p, closed by shape).
 *
 * **No `dryRun` is passed to the producer, and it could not be.** `registerType` refuses
 * `dryRun: true` inside a caller-managed transaction (`registry.ts`), and a suppressed INSERT would
 * leave `typeLines` reading back no row for the version it just registered, so the line -- the thing
 * the tree is appended from -- would be empty. The preview is `previewProducedLines`' rollback, not
 * the producer's option: the real registration happens and is undone, so what a caller sees is
 * never a guess about what the real run would do.
 */
export function registerDocumentVia(
  produce: Producers,
  db: SqlDatabase,
  document: TypeDocument,
  options: RegisterDocumentOptions,
): DocumentRegistration {
  const propertyProse = documentPropertyProse(document);

  const result = produce.type(documentSpec(document), {
    ...typeRegistrationOptions(document, options.registeredAt),
    // REPLACES the options' own `prose`, which is the document's top-level map alone. See
    // `documentPropertyProse`: the inline `properties[].description` spellings have to reach the
    // store's own comparison or a prose-only edit made that way is silently dropped.
    ...(Object.keys(propertyProse).length === 0 ? {} : { prose: propertyProse }),
  });

  // **A document that says the type is retired is registered retired, through the SAME production
  // `asc types deprecate` uses.** It has to be this production and not a second statement here: the
  // tree is the store, so the only real way to retire a type is to append the repeat line
  // `deprecate` produces, and the rebuild reads that line back through `replayType` -- which does
  // apply the field. A command that passed the document through without this would leave the index
  // saying `deprecated` for a fact no line carries, which is the defect this field exists to close,
  // reached from the other side. Measured while writing it: `asc types export` of a retired type
  // carries the field, and `import` of that export is the shape that would have diverged.
  const retired = document.status === 'deprecated' ? produce.deprecate(result.name) : undefined;

  const outcome: DocumentRegistration['outcome'] =
    result.outcome === 'created' ? 'created' : result.proseUpdated ? 'prose-updated' : 'unchanged';

  return {
    name: result.name,
    version: result.version,
    major: result.major,
    typeHash: result.typeHash,
    outcome,
    bump: result.bump,
    changeCount: result.changes.length,
    renames: result.renames,
    warnings: [
      ...result.warnings,
      ...(result.outcome === 'created'
        ? droppedGuidance(document, db, result.name, result.version)
        : []),
      // Said out loud, because a document's `status` is easy not to notice: it usually arrives one
      // command earlier, through `asc types export` of a type someone retired, and the registration
      // itself reports `created`. `changed` is zero for a family already retired, and there is
      // nothing to announce then.
      ...(retired !== undefined && retired.changed > 0
        ? [
            `the document carries status 'deprecated', so ${retired.name} was registered retired ` +
              `(every version of it, not only ${String(result.version)}).`,
          ]
        : []),
    ],
  };
}

/**
 * Register `document` as a write of its own: one fused produce-and-append, or a preview of one.
 *
 * The standalone half, for `asc types define`, which registers exactly one document and has no
 * sequence to put it in. `dryRun` picks `previewProducedLines`, which produces the real lines under
 * a rollback and writes neither the tree nor the index -- and which, unlike a write, REFUSES a stale
 * index rather than building one, because a caller who asked not to write did not ask for a ~75 s
 * rebuild either.
 */
export function registerDocument(
  root: string,
  indexFile: string,
  document: TypeDocument,
  options: RegisterDocumentRunOptions,
): DocumentRegistration {
  const body = (produce: Producers, db: SqlDatabase): DocumentRegistration =>
    registerDocumentVia(produce, db, document, options);

  return options.dryRun
    ? previewProducedLines(root, indexFile, body)
    : writeProducedLines(root, indexFile, { now: options.registeredAt }, body).result;
}

/**
 * One warning per guidance field version N-1 declared and this document, minting version N, does
 * not (asc-6jf).
 *
 * A warning, not a carry-forward. A new version takes only what its document says -- as
 * `description` and `record_when` always have -- and inheriting guidance alone would be a rule a
 * reader has to know. Omission is also the only way a document can DROP a field, so copying it
 * forward would make "this version needs no review_after" unsayable. What was wrong was the
 * silence: a shape bump from a hand-written document took `review_after` away, and with it the
 * readiness line in `asc types brief` and the `asc record` advisory, and nothing said so.
 *
 * Computed on a dry run too, because that is when the document can still be fixed.
 */
function droppedGuidance(
  document: TypeDocument,
  db: SqlDatabase,
  name: string,
  version: number,
): string[] {
  if (version <= 1) return [];
  const previous = findType(db, name, version - 1);
  if (previous === undefined) return [];
  return GUIDANCE_FIELDS.filter(
    (field) => previous.guidance[field] !== undefined && document[field] === undefined,
  ).map(
    (field) =>
      `version ${String(version)} of ${name} declares no ${field}; version ${String(version - 1)} ` +
      `declared ${JSON.stringify(previous.guidance[field])}. A new version keeps only what its ` +
      `document says, so it has none -- add ${field} to the document and define it again to keep it.`,
  );
}

/**
 * A document's per-property prose, keyed as the STORE spells the property name.
 *
 * Two spellings exist in the document format (`document.ts`'s file comment): a property's own
 * `description`, and the top-level `prose` map. Both are folded into one map, inline first and the
 * top-level map over -- the same precedence `toStorage` (`registry.ts`) applies to the same two
 * spellings on the create path, reused rather than re-decided here, because create and update
 * disagreeing about which spelling wins would be a new cross-implementation divergence of exactly
 * the kind this module's file comment already warns about.
 *
 * The keys are then canonicalized, which is the second half of asc-v7t and not decoration. The
 * store holds prose under canonical names (`canonicalProseKeys` folds `reviewKind` to `review_kind`
 * on the way in), and the store's own comparison -- `pendingProseUpdate`, which decides whether this
 * registration emits a line at all -- compares this map against those stored keys. A raw key here
 * therefore does not mean "the same property, differently spelled"; it means the comparison misses,
 * and what it reports depends on the path: an unchanged inline description looks like no change (the
 * edit is silently dropped from the tree), while a `reviewKind` key that IS stored looks like a
 * change on every run of an idempotent command.
 */
function documentPropertyProse(document: TypeDocument): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const property of document.properties) {
    if (property.description !== undefined) merged[property.name] = property.description;
  }
  for (const [key, value] of Object.entries(document.prose ?? {})) {
    merged[key] = value;
  }
  return canonicalProseKeys(merged);
}

/**
 * The same map keyed canonically -- or `merged` unchanged when the fold would have to choose.
 *
 * Two of the document's spellings can name one property (`review_kind` and `reviewKind` both in the
 * top-level map). Canonicalizing there would leave one key where there were two, and the store's
 * `canonicalProseKeys` refuses that input precisely because there is no principled winner
 * (`asc-4if`). So the fold is abandoned for that input rather than resolved: the raw map reaches the
 * store, and the store reports the conflict it always reported. The guard exists to keep the
 * refusal, not to avoid one.
 */
function canonicalProseKeys(merged: Record<string, string>): Record<string, string> {
  const keyed: Record<string, string> = {};
  const spelled = new Map<string, string>();
  for (const [key, value] of Object.entries(merged)) {
    const canonical = canonicalName(key);
    if (spelled.has(canonical)) return merged;
    spelled.set(canonical, key);
    keyed[canonical] = value;
  }
  return keyed;
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
export function knownNames(db: SqlDatabase): string {
  const names = listTypes(db).map((summary) => summary.name);
  return names.length === 0
    ? 'No entry types are registered in this project yet.'
    : `The types in this project are: ${names.join(', ')}.`;
}
