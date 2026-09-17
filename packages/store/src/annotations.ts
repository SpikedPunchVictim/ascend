/**
 * Annotation schemes and the annotations they produce.
 *
 * `ARCHITECTURE.md` puts rule-based classification at the centre: the model proposes a RULE (a SQL
 * predicate or an FTS query), ascend applies it deterministically across the corpus, and reports the
 * match count beside the UNCLASSIFIED REMAINDER -- which is the signal that the taxonomy is
 * incomplete. Classification is then a compiled artifact rather than a transcript: cheap,
 * reproducible, auditable, and automatically applied to entries recorded next month. This module is
 * the storage half of that; the proposal half is the model's, and the reporting half is `asc
 * annotate`.
 *
 * A SCHEME STORES ITS RULE, NOT ONLY ITS LABELS. The vocabulary alone would record what was said
 * about the corpus and lose why, and `asc kappa` -- the direct measurement of whether a
 * classification is reproducible or the model is guessing -- would have nothing to compare but two
 * sets of labels whose rules had already been forgotten.
 *
 * VERSION-ON-SHAPE-CHANGE IS AN API GUARANTEE HERE, not a database one, and that difference from
 * `registry.ts` is measurable: `entry_types` carries an immutability trigger and `annotation_schemes`
 * carries none (compare `schema.ts`). So this module is the only thing standing between a stored rule
 * and a silent rewrite of a classification that has already been reported. A scheme whose shape
 * changes gets a NEW version; the old version's annotations stay pinned to it, and remain the
 * evidence of what was actually run.
 *
 * IDEMPOTENCE IS AGAINST THE LATEST VERSION ONLY, and this is a deliberate departure from
 * `registerType`, which matches a shape against ANY registered version. The two answer different
 * questions. A type's identity is its shape, so a shape that was registered once is that type
 * whenever it is proposed again. A scheme's annotations are pinned to a version, so a spec equal to
 * an OLD version is not "the same scheme" -- it is a REVERT, and reviving the old version number
 * would silently adopt every annotation ever written under it into a classification that has changed
 * since. A revert therefore mints a new version, and the old one keeps its own history.
 *
 * ANNOTATIONS ARE APPEND-ONLY, and no function here updates or deletes one. The reason is the second
 * thing `ARCHITECTURE.md` asks of kappa: agreement between TWO RUNS OF ONE SCHEME. A design that let a
 * re-run replace its predecessor would destroy the second pass a moment before it was needed, and
 * nothing would record that it had existed. The table has no uniqueness constraint either, so this is
 * again a guarantee made here rather than enforced by the DDL.
 *
 * THE PASS IS THE TIMESTAMP, because the table has no run or pass column. One `asc annotate` run
 * stamps every row it writes with a single `created_at`, so a pass is `(scheme, scheme_version,
 * created_at)`. That makes a same-millisecond second run indistinguishable from the first, which
 * would silently merge two passes and corrupt the agreement computed from them -- so it is REFUSED
 * rather than written. The refusal is cheap because a failed pass writes nothing (the batch is one
 * transaction), so a genuine retry is a fresh attempt whose clock has moved on.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not evaluate a rule. Reading the corpus is a query, and a
 * query needs a connection, a scope and a read path that this module has no reason to own -- the CLI
 * already runs caller SQL for `asc query`. What it does own is `wrapPredicate` (`statements.ts`),
 * which every caller must go through to turn a stored predicate into a statement, so the
 * silent-truncation hazard cannot be skipped by a future caller who never read `asc query`.
 *
 * Time and ids are INJECTED, never read: see `recorder.ts` for why a default would mean this package
 * touching a clock or drawing randomness, which `test/recorder.test.ts` fails the build over.
 */

import { canonicalJson, nonJsonReason, sha256Hex } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from './db.js';
import { wrapPredicate } from './statements.js';

/**
 * The scheme name ascend reserves for itself.
 *
 * `ARCHITECTURE.md` states that invalidation is an annotation scheme rather than an edit, and the
 * `entries_are_immutable` trigger says so in its own message ("invalidation is an annotation scheme,
 * not an edit"). That sentence is only true of the code if the name cannot be taken by a
 * user-defined scheme whose rules mean something else, so registering under it is refused -- and the
 * refusal names the bead that will implement it, because a reservation with no work behind it is
 * indistinguishable from a typo.
 */
export const RESERVED_SCHEME = 'invalidation';

/** How a rule selects entries. `sql` is a predicate over `entries`; `fts` is a text query. */
export type SchemeRuleKind = 'sql' | 'fts';

/** One rule: the label it assigns, and the query that decides which entries get it. */
export interface SchemeRule {
  readonly label: string;
  readonly kind: SchemeRuleKind;
  /** A predicate for `sql` (see `wrapPredicate`), query text for `fts` (see `toFtsMatch`). */
  readonly query: string;
}

/**
 * A scheme's shape: the labels it may assign, and the rules that assign them.
 *
 * `rules` order is part of the shape, not incidental. Rules are applied in order and the FIRST match
 * wins, so two specs holding the same three rules in a different order classify differently and must
 * not hash alike. `labels` order is not: a vocabulary is a set, so it is sorted before hashing and
 * `['a','b']` and `['b','a']` are one scheme.
 */
export interface SchemeSpec {
  readonly labels: readonly string[];
  readonly rules: readonly SchemeRule[];
}

/** A scheme definition that cannot be registered. */
export class SchemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemeError';
  }
}

/** An annotation write that was refused. */
export class AnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnotationError';
  }
}

/** Injected, never read. See the module comment. */
export interface SchemeContext {
  /** ISO-8601 UTC, ending in `Z`. The registration time of a new version. */
  readonly createdAt: string;
}

/** A scheme as registered. `spec` is the normalized shape the hash was taken over. */
export interface RegisteredScheme {
  readonly name: string;
  readonly version: number;
  /** `created` when this call wrote a new version, `unchanged` when the latest already matched. */
  readonly outcome: 'created' | 'unchanged';
  readonly specHash: string;
  readonly createdAt: string;
  readonly spec: SchemeSpec;
}

/** One annotation to write. `id` is the caller's, exactly as `RecordContext.id` is. */
export interface AnnotationInput {
  readonly id: string;
  readonly entryId: string;
  readonly label: string;
  /** Any JSON value. Omitted rather than stored as `null` when there is none. */
  readonly value?: unknown;
  /** The rater's own confidence in this one label, in [0, 1]. */
  readonly confidence?: number;
  readonly note?: string;
}

/** One pass of one scheme over a set of entries. */
export interface AnnotationPass {
  readonly scheme: string;
  /** Defaults to the latest registered version. Named explicitly only to pin one. */
  readonly schemeVersion?: number;
  readonly annotations: readonly AnnotationInput[];
}

/** Injected, never read. `createdAt` is shared by every row of the pass -- it IS the pass. */
export interface AnnotationContext {
  readonly createdAt: string;
  /** Who or what produced the pass, e.g. `claude-code`. Omitted rather than stored as `''`. */
  readonly createdBy?: string;
}

/** What a pass wrote. */
export interface RecordedAnnotations {
  readonly scheme: string;
  readonly schemeVersion: number;
  /** The pass identity: `(scheme, schemeVersion, createdAt)`. */
  readonly createdAt: string;
  readonly count: number;
}

/** A registered scheme as read back, for listing and for `asc annotate`'s extend step. */
export interface SchemeSummary {
  readonly name: string;
  readonly version: number;
  readonly createdAt: string;
  readonly spec: SchemeSpec;
}

/** One pass of a scheme, as read back. This is what `asc kappa` compares. */
export interface AnnotationPassRow {
  readonly createdAt: string;
  /** Rows in the pass, which is not the number of distinct entries if a scheme reuses a label. */
  readonly count: number;
  readonly createdBy: string | null;
}

/** One stored annotation. */
export interface AnnotationRow {
  readonly id: string;
  readonly entryId: string;
  readonly label: string;
  readonly value: unknown;
  readonly confidence: number | null;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * How a scheme's labels came out over a body of entries.
 *
 * `unclassified` is the number the architecture calls the signal that the taxonomy is incomplete, and
 * it is a COUNT rather than a rate because the scope is enumerated: every entry in scope is either
 * labelled or not, so the share is exact and an interval would imply a sampling that never happened.
 * `renderCoverage` in the CLI makes the same distinction for the same reason.
 */
export interface SchemeCensus {
  /** Entries examined. Every entry unless the caller narrowed the scope. */
  readonly considered: number;
  /** Distinct entries carrying at least one label from this scheme. */
  readonly labelled: number;
  /** Entries in scope with no label from this scheme -- the remainder. */
  readonly unclassified: number;
  /** Per-label counts, ordered by count descending then label, so the biggest class reads first. */
  readonly labels: readonly { readonly label: string; readonly count: number }[];
}

const RULE_KINDS: readonly SchemeRuleKind[] = ['sql', 'fts'];

/**
 * The stored projection of a spec: labels sorted and deduplicated, rules as given.
 *
 * Everything the hash covers goes through here, so a spec and its hash can never be taken over
 * different shapes -- the failure that would let a changed rule reuse a version number.
 */
function normalizeSpec(spec: SchemeSpec): SchemeSpec {
  const labels = [...new Set(spec.labels)].sort();

  for (const label of labels) {
    if (label === '') {
      throw new SchemeError(
        "a scheme label is empty. An empty label is a missing value wearing a value's clothes, and " +
          'counting it as a label would put unlabelled entries into the vocabulary.',
      );
    }
  }

  const rules = spec.rules.map((rule) => {
    if (!RULE_KINDS.includes(rule.kind)) {
      throw new SchemeError(
        `rule for label '${rule.label}' has kind ${JSON.stringify(rule.kind)}, which is not one of ` +
          `${RULE_KINDS.map((kind) => `'${kind}'`).join(' or ')}. A rule that runs as neither a ` +
          `predicate nor a text query could not be applied by anything.`,
      );
    }
    if (rule.query === '') {
      throw new SchemeError(
        `rule for label '${rule.label}' has an empty ${rule.kind} query. An empty predicate ` +
          `matches nothing and an empty text query matches nothing, either way a rule that silently ` +
          `labels no entry rather than a rule that was meant to.`,
      );
    }
    if (!labels.includes(rule.label)) {
      throw new SchemeError(
        `rule assigns label '${rule.label}', which is not in the scheme's vocabulary ` +
          `(${labels.map((label) => `'${label}'`).join(', ') || 'empty'}). A rule outside the ` +
          `vocabulary would write a label the scheme does not declare, which is a contradiction ` +
          `rather than a classification.`,
      );
    }
    return { label: rule.label, kind: rule.kind, query: rule.query };
  });

  return { labels, rules };
}

/** The stable identity of a scheme shape. Over the normalized projection, never a raw spec. */
export function schemeHash(spec: SchemeSpec): string {
  return sha256Hex(canonicalJson(normalizeSpec(spec)));
}

/** The registered scheme names, for the error message that tells a caller what exists. */
function registeredSchemes(db: DatabaseSync): readonly string[] {
  const rows = db
    .prepare('SELECT DISTINCT name FROM annotation_schemes ORDER BY name ASC')
    .all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

function requireName(db: DatabaseSync, name: string): void {
  if (name === '') {
    throw new SchemeError(
      'a scheme name is empty. An empty string is a real value in SQLite, not "unknown" -- name ' +
        'the scheme.',
    );
  }
  if (name === RESERVED_SCHEME) {
    throw new SchemeError(
      `'${RESERVED_SCHEME}' is a reserved scheme name: ARCHITECTURE.md makes invalidation an ` +
        `annotation scheme rather than an edit, so this name belongs to the store and must not ` +
        `mean a user's rules. The command that will use it is asc-88m; until then nothing may ` +
        `register under it. Registered schemes: ${registeredSchemes(db).join(', ') || '(none)'}.`,
    );
  }
}

/**
 * The latest version of a scheme, or the named one.
 *
 * Throws rather than returning undefined, because every caller of this is about to write against the
 * version it returns and a silent undefined would become `undefined` in a version column.
 */
function requireScheme(
  db: DatabaseSync,
  name: string,
  version?: number,
): { readonly version: number; readonly created_at: string; readonly spec_json: string } {
  const row =
    version === undefined
      ? (db
          .prepare(
            'SELECT version, created_at, spec_json FROM annotation_schemes WHERE name = ? ' +
              'ORDER BY version DESC LIMIT 1',
          )
          .get(name) as { version: number; created_at: string; spec_json: string } | undefined)
      : (db
          .prepare(
            'SELECT version, created_at, spec_json FROM annotation_schemes WHERE name = ? AND version = ?',
          )
          .get(name, version) as
          { version: number; created_at: string; spec_json: string } | undefined);

  if (row === undefined) {
    const known = registeredSchemes(db);
    throw new SchemeError(
      version === undefined
        ? `no annotation scheme named '${name}' is registered. ` +
            `Registered schemes: ${known.join(', ') || '(none)'}.`
        : `annotation scheme '${name}' has no version ${String(version)}. ` +
            `Its versions: ${
              (
                db
                  .prepare(
                    'SELECT version FROM annotation_schemes WHERE name = ? ORDER BY version ASC',
                  )
                  .all(name) as unknown as { version: number }[]
              )
                .map((entry) => String(entry.version))
                .join(', ') || '(none)'
            }.`,
    );
  }

  return row;
}

/**
 * Register a scheme, or report that the latest version already has this shape.
 *
 * Idempotent against the LATEST version only -- see the module comment for why that differs from
 * `registerType` and why the difference is the point.
 */
export function registerScheme(
  db: DatabaseSync,
  name: string,
  spec: SchemeSpec,
  context: SchemeContext,
): RegisteredScheme {
  requireName(db, name);
  requireUtc(context.createdAt, 'createdAt');

  const shape = normalizeSpec(spec);
  const hash = schemeHash(shape);

  // The version read is the CHECK and the insert is the ACT, so they are one decision and take one
  // transaction -- the placement `registerType` argues for at length and measured: with the BEGIN
  // below the read, two processes racing this function each computed the same version number and
  // inserted it, and the loser got a raw SQLite UNIQUE message for a registration that was legal.
  // `IMMEDIATE` so a concurrent registration waits at this line, where the busy timeout applies,
  // rather than taking a deferred snapshot a commit can invalidate.
  //
  // The caller's transaction is JOINED rather than nested into, because SQLite rejects a nested
  // BEGIN outright -- and `asc annotate` registers and writes in one transaction, which is the case
  // this exists for.
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');

  let ended = false;
  const finish = (statement: 'COMMIT' | 'ROLLBACK'): void => {
    if (ownsTransaction) db.exec(statement);
    ended = true;
  };
  // A function rather than the inline condition, for the reason `registerType` records: TypeScript
  // does not model a closure assigning to a captured `let`, so at the catch below the guard reads as
  // dead while guarding the double-rollback it exists to prevent.
  const hasOpenTransaction = (): boolean => ownsTransaction && !ended;

  try {
    const latest = db
      .prepare(
        'SELECT version, created_at, spec_json FROM annotation_schemes WHERE name = ? ' +
          'ORDER BY version DESC LIMIT 1',
      )
      .get(name) as { version: number; created_at: string; spec_json: string } | undefined;

    if (latest !== undefined && sha256Hex(canonicalJson(JSON.parse(latest.spec_json))) === hash) {
      finish('COMMIT');
      return {
        name,
        version: latest.version,
        outcome: 'unchanged',
        specHash: hash,
        createdAt: latest.created_at,
        spec: shape,
      };
    }

    const version = latest === undefined ? 1 : latest.version + 1;
    db.prepare(
      'INSERT INTO annotation_schemes (name, version, spec_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(name, version, canonicalJson(shape), context.createdAt);

    finish('COMMIT');
    return {
      name,
      version,
      outcome: 'created',
      specHash: hash,
      createdAt: context.createdAt,
      spec: shape,
    };
  } catch (error) {
    if (hasOpenTransaction()) db.exec('ROLLBACK');
    throw error;
  }
}

/** ISO-8601 UTC, enforced for the reason `recorder.ts` gives: these columns are compared as text. */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function requireUtc(value: string, field: string): void {
  if (!UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(
      `${field} must be an ISO-8601 UTC timestamp ending in 'Z' (e.g. 2026-09-17T10:00:00.000Z), ` +
        `got ${JSON.stringify(value)}. Offsets and local times are refused because the pass identity ` +
        `is a text comparison, so a mixed-zone ledger would not group into passes reliably.`,
    );
  }
}

/**
 * Write one pass of annotations. The only way an annotation is ever written.
 *
 * Atomic: every row lands or none does, so a pass is never half-written and a retry after a refusal
 * cannot have to reason about the part that got through.
 *
 * Refuses rather than persists on: an unknown scheme or version, a label outside the scheme's
 * vocabulary, an entry that does not exist, a non-JSON value, an out-of-range confidence, an empty
 * id or note, a non-UTC timestamp, and a second pass sharing this one's millisecond. Every one of
 * those is a hard error, and none of them writes a row.
 */
export function recordAnnotations(
  db: DatabaseSync,
  pass: AnnotationPass,
  context: AnnotationContext,
): RecordedAnnotations {
  requireUtc(context.createdAt, 'createdAt');
  if (context.createdBy !== undefined && context.createdBy === '') {
    throw new AnnotationError(
      'createdBy is empty. An empty string is a real value in SQLite, not "unknown" -- omit the ' +
        'field instead so it is stored as NULL.',
    );
  }

  const scheme = requireScheme(db, pass.scheme, pass.schemeVersion);
  const spec = JSON.parse(scheme.spec_json) as SchemeSpec;

  return withTransaction(db, () => {
    // Before any insert, and it has to be: with the rows already written the check could not tell
    // which of the two passes it was looking at, and neither could `asc kappa`.
    const existing = db
      .prepare(
        'SELECT count(*) AS n FROM annotations WHERE scheme = ? AND scheme_version = ? AND created_at = ?',
      )
      .get(pass.scheme, scheme.version, context.createdAt) as { n: number };

    if (existing.n > 0) {
      throw new AnnotationError(
        `scheme '${pass.scheme}' version ${String(scheme.version)} already has a pass at ` +
          `${context.createdAt} (${String(existing.n)} annotations). A pass is identified by its ` +
          `timestamp -- the table has no run column -- so two passes in the same millisecond are ` +
          `indistinguishable and any agreement measured between them would compare a pass with ` +
          `itself. Wait a millisecond and run again.`,
      );
    }

    for (const annotation of pass.annotations) {
      if (annotation.id === '') {
        throw new AnnotationError('an annotation id is empty. Every annotation names its own row.');
      }
      if (annotation.label === '') {
        throw new AnnotationError(
          `annotation for entry '${annotation.entryId}' has an empty label. An empty label is a ` +
            `missing value wearing a value's clothes, and the unclassified remainder is what says ` +
            `an entry has no label -- not a label that says nothing.`,
        );
      }
      if (!spec.labels.includes(annotation.label)) {
        throw new AnnotationError(
          `label '${annotation.label}' is not in scheme '${pass.scheme}' version ` +
            `${String(scheme.version)}'s vocabulary (` +
            `${spec.labels.map((label) => `'${label}'`).join(', ') || 'empty'}). A label outside ` +
            `the vocabulary is a contradiction rather than a classification, and it would also make ` +
            `\`asc kappa\`'s expected agreement depend on a label no rule can produce.`,
        );
      }
      if (annotation.note !== undefined && annotation.note === '') {
        throw new AnnotationError(
          `annotation for entry '${annotation.entryId}' has an empty note. Omit the note instead so ` +
            `it is stored as NULL.`,
        );
      }
      if (
        annotation.confidence !== undefined &&
        (!Number.isFinite(annotation.confidence) ||
          annotation.confidence < 0 ||
          annotation.confidence > 1)
      ) {
        throw new AnnotationError(
          `confidence for entry '${annotation.entryId}' is ${String(annotation.confidence)}, which ` +
            `is outside [0, 1]. The column's CHECK refuses it too, but as a constraint failure ` +
            `rather than as a statement about what a confidence is.`,
        );
      }

      let valueJson: string | null = null;
      if (annotation.value !== undefined) {
        const reason = nonJsonReason(annotation.value);
        if (reason !== undefined) {
          throw new AnnotationError(
            `value for entry '${annotation.entryId}' is ${reason}. A value_json column holds JSON, ` +
              `and a value that is not JSON cannot be stored without inventing a representation ` +
              `for it that a later reader would mistake for the value itself.`,
          );
        }
        valueJson = canonicalJson(annotation.value);
      }

      const entry = db
        .prepare('SELECT 1 AS present FROM entries WHERE id = ?')
        .get(annotation.entryId);
      if (entry === undefined) {
        throw new AnnotationError(
          `entry '${annotation.entryId}' does not exist, so there is nothing to annotate. ` +
            `annotations.entry_id is a foreign key to entries(id) -- an annotation of a missing ` +
            `entry would be unfindable by every query that joins them.`,
        );
      }

      db.prepare(
        `INSERT INTO annotations
           (id, entry_id, scheme, scheme_version, label, value_json, confidence, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        annotation.id,
        annotation.entryId,
        pass.scheme,
        scheme.version,
        annotation.label,
        valueJson,
        annotation.confidence ?? null,
        annotation.note ?? null,
        context.createdBy ?? null,
        context.createdAt,
      );
    }

    return {
      scheme: pass.scheme,
      schemeVersion: scheme.version,
      createdAt: context.createdAt,
      count: pass.annotations.length,
    };
  });
}

/** Every registered scheme's latest version, oldest name first. */
export function listSchemes(db: DatabaseSync): readonly SchemeSummary[] {
  const rows = db
    .prepare(
      `SELECT s.name AS name, s.version AS version, s.created_at AS created_at, s.spec_json AS spec_json
         FROM annotation_schemes s
         JOIN (SELECT name, max(version) AS version FROM annotation_schemes GROUP BY name) latest
           ON latest.name = s.name AND latest.version = s.version
        ORDER BY s.name ASC`,
    )
    .all() as unknown as {
    name: string;
    version: number;
    created_at: string;
    spec_json: string;
  }[];

  return rows.map((row) => ({
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    spec: JSON.parse(row.spec_json) as SchemeSpec,
  }));
}

/** Every pass of a scheme, oldest first -- the list `asc kappa` chooses two passes from. */
export function annotationPasses(
  db: DatabaseSync,
  name: string,
  version?: number,
): readonly AnnotationPassRow[] {
  const scheme = requireScheme(db, name, version);
  const rows = db
    .prepare(
      `SELECT created_at AS created_at, count(*) AS n, max(created_by) AS created_by
         FROM annotations
        WHERE scheme = ? AND scheme_version = ?
        GROUP BY created_at
        ORDER BY created_at ASC`,
    )
    .all(name, scheme.version) as unknown as {
    created_at: string;
    n: number;
    created_by: string | null;
  }[];

  return rows.map((row) => ({
    createdAt: row.created_at,
    count: row.n,
    createdBy: row.created_by,
  }));
}

/**
 * The annotations of one scheme, optionally narrowed to one version or one pass.
 *
 * Order is `created_at`, then entry id: a caller building a rater's label list gets a stable order
 * without having to sort, and `cohenKappa` is order-independent anyway, so the order is for
 * readability rather than for correctness.
 */
export function annotationRows(
  db: DatabaseSync,
  options: { readonly scheme: string; readonly version?: number; readonly pass?: string },
): readonly AnnotationRow[] {
  const scheme = requireScheme(db, options.scheme, options.version);
  const clauses = ['scheme = ?', 'scheme_version = ?'];
  const parameters: (string | number)[] = [options.scheme, scheme.version];
  if (options.pass !== undefined) {
    clauses.push('created_at = ?');
    parameters.push(options.pass);
  }

  const rows = db
    .prepare(
      `SELECT id, entry_id, label, value_json, confidence, note, created_by, created_at
         FROM annotations
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at ASC, entry_id ASC`,
    )
    .all(...parameters) as unknown as {
    id: string;
    entry_id: string;
    label: string;
    value_json: string | null;
    confidence: number | null;
    note: string | null;
    created_by: string | null;
    created_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    label: row.label,
    // `as unknown` rather than a narrower cast: what a caller stored under `value` is theirs, and the
    // store's only claim about it is that `canonicalJson` accepted it on the way in. Widening it to a
    // type here would assert a shape nothing checked.
    value: row.value_json === null ? undefined : (JSON.parse(row.value_json) as unknown),
    confidence: row.confidence,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

/**
 * How a scheme's labels came out, against a body of entries named by `scope`.
 *
 * `scope` is a predicate over `entries`, wrapped by `wrapPredicate` so a fragment carrying a second
 * statement is refused here rather than silently truncated. Omitted, the scope is every entry, which
 * is what "applies it across the whole corpus" means.
 *
 * `label` filtering and the pass filter are separate on purpose: a census over ALL passes answers
 * "what has this scheme ever said", while a census over one pass answers "what did this run say".
 * Both are real questions and the caller has to say which one it is asking.
 */
export function schemeCensus(
  db: DatabaseSync,
  options: {
    readonly scheme: string;
    readonly version?: number;
    readonly pass?: string;
    readonly scope?: string;
  },
): SchemeCensus {
  const scheme = requireScheme(db, options.scheme, options.version);
  // Through `wrapPredicate`, so a fragment carrying a second statement is refused here rather than
  // silently truncated -- and so a caller passing a stored predicate cannot skip that refusal by
  // never having read `asc query`.
  const scopeStatement =
    options.scope === undefined
      ? 'SELECT id FROM entries'
      : wrapPredicate('entries', options.scope);

  const considered = (
    db.prepare(`SELECT count(*) AS n FROM (${scopeStatement})`).get() as { n: number }
  ).n;

  const passClause = options.pass === undefined ? '' : ' AND a.created_at = ?';
  const parameters: (string | number)[] = [options.scheme, scheme.version];
  if (options.pass !== undefined) parameters.push(options.pass);

  const labelled = (
    db
      .prepare(
        `SELECT count(DISTINCT a.entry_id) AS n
           FROM annotations a
          WHERE a.scheme = ? AND a.scheme_version = ?${passClause}`,
      )
      .get(...parameters) as { n: number }
  ).n;

  const labelRows = db
    .prepare(
      `SELECT a.label AS label, count(DISTINCT a.entry_id) AS n
         FROM annotations a
        WHERE a.scheme = ? AND a.scheme_version = ?${passClause}
        GROUP BY a.label
        ORDER BY n DESC, a.label ASC`,
    )
    .all(...parameters) as unknown as { label: string; n: number }[];

  return {
    considered,
    labelled,
    unclassified: considered - labelled,
    labels: labelRows.map((row) => ({ label: row.label, count: row.n })),
  };
}
