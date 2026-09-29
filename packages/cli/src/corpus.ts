/**
 * The corpus stream: one JSON object per line, in the order `type`, `entry`, `scheme`,
 * `annotation`.
 *
 * `asc-brt`. The store is per-project and gitignored, so `asc export` is the only thing that
 * carries a corpus out of a working copy. `asc types export` moves DEFINITIONS between projects
 * and says nothing about entries; this is the corpus itself -- and, since `asc-6u5`, the whole
 * corpus, hand labels and kappa passes included, not only what a trigger cannot protect.
 *
 * ```jsonl
 * {"kind":"type","name":"decision","properties":[…],"type_hash":"…"}
 * {"kind":"entry","id":"…","type_name":"decision","type_version":1,"type_hash":"…", …}
 * {"kind":"scheme","name":"risk","version":1,"created_at":"…","spec":{"labels":[…],"rules":[…]},"scheme_hash":"…"}
 * {"kind":"annotation","id":"…","entry_id":"…","scheme":"risk","scheme_version":1,"label":"high", …}
 * ```
 *
 * **JSONL rather than one big array, and the reason is the failure mode.** A corpus is the thing
 * you read after something went wrong, and an array is all-or-nothing: one truncated byte at the
 * end and no parser will hand you the entries before it. A line stream is read up to the damage.
 * It also streams in both directions -- `asc export | asc import -` never holds the corpus in
 * memory twice -- and appends, so a caller can concatenate two exports.
 *
 * **The order is a contract, not a preference.** `annotations` carries `FOREIGN KEY (entry_id)
 * REFERENCES entries (id)` and `FOREIGN KEY (scheme, scheme_version) REFERENCES
 * annotation_schemes (name, version)` (`schema.ts`), so an annotation line has to reach `import`
 * after both the entry it labels and the scheme it was labelled under, or the write fails on a
 * foreign key it never gets a chance to explain. `type`, `entry`, `scheme`, `annotation` is the
 * one order that satisfies both constraints at once.
 *
 * **The definitions are required, not optional -- and that now covers schemes too.** An entry's
 * `type_hash` points at a type version, so a corpus restored without its definitions cannot
 * render its own views: every generated view and every `asc query` needs the spec the entries
 * were validated against. An annotation's `(scheme, scheme_version)` is the same kind of pointer
 * into `annotation_schemes`, for the same reason: `asc kappa` and `schemeCensus` both need the
 * rule an annotation was produced under, not only the label it left behind. `export` therefore
 * always writes definitions before the rows that depend on them, and `import` refuses to restore
 * either kind of row whose definition is not in the file.
 *
 * **`type_hash`, `type_version`, and now `scheme_hash` are carried and CHECKED, never trusted.**
 * `type_hash` is a pure function of the canonical shape (`specHash`), so a matching hash is
 * evidence the definition survived the trip rather than something that makes two corpora
 * comparable -- which is exactly the argument `document.ts` makes for the same field, and the
 * check is `registerDocument`'s. An entry's `type_version` is corroborating evidence of the same
 * kind: `import` resolves the version by HASH and refuses if the file claims a different number,
 * because the two disagreeing means the file is describing an entry that was not recorded against
 * the definition it names. `scheme_hash` is `schemeHash` (`@ascend/store`) applied to the exact
 * same argument: a scheme line's `spec` is what `import` recomputes the hash from, and a claimed
 * `scheme_hash` that disagrees is refused rather than trusted, by `verifySchemeLine`.
 *
 * **`recorded_at` and `id` are restored verbatim, and so is everything else in the row.** That is
 * the whole point: a restored corpus is the same corpus, not a re-recording of it. The one column
 * that cannot be restored is `entry_types.registered_at`, which `registerType` takes from the
 * caller -- a type's registration timestamp becomes the moment of the import. An entry's
 * `ascend_version` and `schema_version` ARE restored, so the file's record of which build wrote
 * each row survives even though the definitions' does not.
 *
 * **An annotation line restores as part of a PASS, not as an independent row.**
 * `recordAnnotations` stamps `created_at` and `created_by` onto every row of one call
 * (`annotations.ts:655-669`), and `RecordedAnnotations`'s own doc calls `(scheme, schemeVersion,
 * createdAt)` the pass identity that `asc kappa` compares. So `import` groups the stream's
 * annotation lines by that identity (`created_by` travels with it, since two passes can share a
 * timestamp only in theory and never in the same group) and issues one `recordAnnotations` call
 * per group, passing the group's own `created_at`/`created_by` back in as the context that call
 * takes. Restoring row by row instead would stamp every annotation with the import's own clock
 * and collapse every pass a scheme ever ran into one -- the corpus would still contain every
 * label, and `asc kappa` would still run without error, but it would be comparing a scheme against
 * itself. A row count cannot see that defect; only the count of DISTINCT pass identities can.
 *
 * **Backward and forward compatibility.** Neither `scheme` nor `annotation` lines are required:
 * an export written before `asc-6u5` has neither, and it restores exactly as it always did --
 * `refuseUnrestorable` only requires a scheme for an annotation that is actually present, the same
 * way it only requires a type for an entry that is. A newer stream fed to an OLDER binary is not
 * handled by any code here: that binary's `parseCorpus` does not know the two new kinds and
 * refuses the first `scheme` or `annotation` line it meets, which is the correct outcome and does
 * not need a compatibility shim -- an old binary restoring a new corpus silently and dropping the
 * annotations would be this exact bead recurring one release later.
 */

/**
 * Re-exported so every existing importer -- `export.ts`, `import.ts`, `redact.ts`, `secrets.ts` --
 * keeps working unchanged.
 *
 * The whole format lives in `@ascend/store` now (`asc-i5tj`): the four line kinds, their
 * constructors, `orderedLine` and `serializeCorpus` moved first (the store had become a writer of
 * these bytes); the parsers -- `parseCorpus`, `verifyTypeLine`, `verifySchemeLine` -- and
 * `ParsedLine` followed, because the store's own read layer parses the same lines and `align`
 * forbids `store -> cli`. They threw this package's `refusal` only because they lived here, and
 * `refusal` is exactly `new Error(message)`, so the messages are byte-identical. That module
 * carries the full rationale.
 */
export {
  annotationLine,
  entryLine,
  orderedLine,
  parseCorpus,
  schemeLine,
  serializeCorpus,
  typeLine,
  verifySchemeLine,
  verifyTypeLine,
} from '@ascend/store';
export type {
  AnnotationLine,
  CorpusLine,
  EntryLine,
  ParsedLine,
  SchemeLine,
  TypeLine,
} from '@ascend/store';
