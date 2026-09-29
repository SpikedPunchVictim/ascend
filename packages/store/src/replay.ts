/**
 * Turning a corpus LINE back into the store's own write call, for every path that replays one.
 *
 * There are two such paths today and they are not the same operation: `asc import` restores a corpus
 * into a store that may already hold records (so it refuses taken ids, resolves version conflicts,
 * and reports per-line outcomes), while the derived index (E12.2) replays a whole tree into an empty
 * store. What they DO share is the mapping from a line's columns to `recordEntry`'s request and
 * context, field by field, including the `null`-means-absent rules that `exactOptionalPropertyTypes`
 * makes load-bearing.
 *
 * **That mapping is what lives here, and nothing else.** It is the part where a second spelling is
 * invisible and permanent: an entry restored by one path with `cwd: ''` where the other omitted it
 * would not fail anything -- `recordEntry` refuses an empty string -- but a field mapped to the
 * wrong column, or a `null` passed through where the key should be absent, produces a row that is
 * *nearly* the one the tree describes. Two stores then disagree about a corpus with nothing
 * reporting that they do.
 *
 * The drivers are deliberately NOT shared. `import`'s refusals are about a target store's prior
 * state and the index has no prior state; folding them together would put branches on the index's
 * hot path that can never be taken there.
 */

import type { TypeDocument } from './document.js';
import { documentGuidance } from './document.js';
import type { EntryLine } from './jsonl.js';
import type { RecordContext, RecordRequest } from './recorder.js';
import type { RegisterTypeOptions } from './registry.js';

/** One entry line, as the two arguments `recordEntry` takes. */
export function entryFromLine(line: EntryLine): {
  readonly request: RecordRequest;
  readonly context: RecordContext;
} {
  const request: RecordRequest = {
    type: line.type_name,
    version: line.type_version,
    properties: line.properties,
    na: line.na,
  };

  // Every optional field is omitted rather than passed as `null`. The store's `requireNonEmpty`
  // treats a present-but-empty value as an error, so passing the nulls through would turn "not
  // recorded" into a refusal -- and an explicit `undefined` is a different type from an absent key.
  const context: RecordContext = {
    id: line.id,
    recordedAt: line.recorded_at,
    source: line.source,
    ascendVersion: line.ascend_version,
    schemaVersion: line.schema_version,
    ...(line.run_id === null ? {} : { runId: line.run_id }),
    ...(line.workflow === null ? {} : { workflow: line.workflow }),
    ...(line.actor === null ? {} : { actor: line.actor }),
    ...(line.cwd === null ? {} : { cwd: line.cwd }),
    ...(line.repo === null ? {} : { repo: line.repo }),
    ...(line.git_sha === null ? {} : { gitSha: line.git_sha }),
    ...(line.branch === null ? {} : { branch: line.branch }),
    ...(line.evidence_text === null ? {} : { evidenceText: line.evidence_text }),
  };

  return { request, context };
}

/**
 * One type line, as the options `registerType` takes.
 *
 * The prose fields are passed through one by one and omitted when the document omits them, which is
 * the only way a replayed document can DROP a prose field: a version keeps what its document says
 * and nothing else, so copying a field forward from the previous version would make "this version
 * needs no `review_after`" unsayable.
 *
 * `registeredAt` is the caller's because a `TypeLine` carries no registration timestamp --
 * `documentFromRow` drops it -- so a replayed type is stamped with the moment of the replay. That is
 * a property of the format rather than of this function; the index's module doc names it as the one
 * column the tree cannot determine.
 */
export function typeRegistrationOptions(
  document: TypeDocument,
  registeredAt: string,
): RegisterTypeOptions {
  const guidance = documentGuidance(document);

  return {
    registeredAt,
    ...(Object.keys(guidance).length === 0 ? {} : { guidance }),
    ...(document.description === undefined ? {} : { description: document.description }),
    ...(document.record_when === undefined ? {} : { recordWhen: document.record_when }),
    ...(document.prose === undefined ? {} : { prose: document.prose }),
  };
}
