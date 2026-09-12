/**
 * Cross-project union: reading several `.ascend/` stores as one corpus.
 *
 * Per-project stores fragment the corpus, and volume is the scarce resource (ARCHITECTURE.md,
 * "Cross-project analysis"). The union reads the projects at query time rather than copying their
 * entries into one place, because a copy would duplicate the records and give two answers to "how
 * many entries are there".
 *
 * **`type_hash` is the identity; version numbers are NOT.** This is why the module can refuse
 * instead of guessing. Two projects register `tool_denial` independently, and:
 *
 *   - `type_version` is assigned by LOCAL registration order, so "version 1" here and "version 1"
 *     there are unrelated claims.
 *   - `major` -- and so the generated view name `v_tool_denial_v1` -- derives from that same local
 *     history, so the view names are not comparable either.
 *   - `type_hash` is computed from the definition itself, so equal hashes mean the same shape
 *     wherever and whenever it was registered. `asc types import` preserves it for exactly this.
 *
 * So the union keys on `type_hash`, and when one type NAME resolves to more than one hash it
 * **refuses** (`IncompatibleDefinitionsError`). This is not a rare case: EV-drift measured five
 * independently-authored specs of one concept sharing 9.1 % of their property names, so
 * same-name-different-shape is the *expected* outcome across projects, not the exception.
 * Measured on two real stores, unioning by name alone put `count: 3` next to `count: 250` in one
 * result set -- findings beside milliseconds -- with nothing marking the boundary. That is the
 * plausible wrong number this refusal exists to prevent.
 *
 * **The refusal has a way through, because it has to.** Because diverging definitions are the
 * common case, a caller that already knows which shape it wants can name it: `UnionOptions.typeHash`
 * selects ONE definition explicitly, and the result then reports `entryCount: 0` for every project
 * that holds a different one. Naming a shape is a choice; silently mixing shapes is not, so only
 * the caller can make that choice and only by hash.
 *
 * **A consequence worth stating: this query cannot produce `not_declared`.** Refusing to mix hashes
 * means every row it returns shares ONE definition, so every property of that definition is
 * declared by every row. The four-state model still has four states; this query cannot ask the
 * question that separates the fourth. See `sql.ts`.
 *
 * **One project is attached at a time, and that is deliberate.** `SQLITE_MAX_ATTACHED` defaults to
 * 10 -- measured, `too many attached databases - max 10` on the eleventh -- so a single statement
 * joining every project would break at eleven projects. Attaching one at a time has no ceiling, and
 * concatenating in JS is exactly the union because `UNION ALL` is associative. The suite unions 12
 * projects so a later "optimisation" into one statement fails loudly instead of quietly capping the
 * corpus.
 *
 * The projects given are the whole scope: the connection's own `main` database is not consulted.
 * `--across` means "these projects", and a union that silently added the current one would answer a
 * question the caller did not ask.
 */

import type { TypeSpec } from '@ascend/core';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ENVELOPE_COLUMNS, ident, literal, stateCase } from './sql.js';

/** One project to read. `label` is what the caller calls it; `file` is the store's `.db`. */
export interface ProjectSource {
  readonly label: string;
  readonly file: string;
}

/** A project as the union saw it. */
export interface UnionProject {
  readonly label: string;
  readonly file: string;
  /**
   * Every `type_hash` this project holds for the type name, in its own version order. Empty when
   * the project does not define the type at all. More than one means this project has drifted
   * across majors of its own -- which on its own is enough to make the union refuse.
   */
  readonly hashes: readonly string[];
  /**
   * This project's LOCAL version numbers that carry the selected hash. Reported so the caller can
   * see history; never used as a join key, because version numbers are not comparable across
   * projects.
   */
  readonly versions: readonly number[];
  /**
   * How many rows THIS project contributed. A project holding a different hash contributes 0 even
   * though it is full of entries -- which is why the count is reported per project rather than
   * left to be inferred from the total. Without it, a hash-pinned union over two projects would
   * read as the whole corpus when it is half of it.
   */
  readonly entryCount: number;
}

/** An entry as a cross-project read. Shaped like `RecordedEntry`, not like a SQL row. */
export interface UnionRow {
  readonly project: string;
  readonly id: string;
  readonly typeName: string;
  /** This project's local version number. Not comparable with another project's. */
  readonly typeVersion: number;
  readonly recordedAt: string;
  readonly source: string;
  readonly runId: string | null;
  readonly workflow: string | null;
  readonly actor: string | null;
  readonly cwd: string | null;
  readonly repo: string | null;
  readonly gitSha: string | null;
  readonly branch: string | null;
  readonly evidenceText: string | null;
  /** Exactly the selected definition's properties -- the same key set as `states`. */
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * One state per property of the selected definition: `measured`, `not_applicable` or
   * `not_measured`. Never `not_declared` -- the union cannot ask that question.
   */
  readonly states: Readonly<Record<string, string>>;
}

export interface UnionOptions {
  /**
   * Select one definition by hash instead of refusing when several share the name.
   *
   * Only a caller who has seen the hashes (from `IncompatibleDefinitionsError`, or from
   * `asc types`) can supply this, which is the point: the choice is explicit and named.
   */
  readonly typeHash?: string;
}

export interface UnionResult {
  readonly type: string;
  /** The single definition every returned row was read against. */
  readonly typeHash: string;
  /** Every project inspected, contributing or not, with what each contributed. */
  readonly projects: readonly UnionProject[];
  /** The selected definition's property names, sorted. */
  readonly properties: readonly string[];
  /** Rows from every contributing project, ordered by `recordedAt`. */
  readonly rows: readonly UnionRow[];
}

/** One type name resolving to several definitions, and which projects hold each. */
export interface DefinitionGroup {
  readonly typeHash: string;
  readonly projects: readonly string[];
}

const renderGroups = (groups: readonly DefinitionGroup[]): string =>
  groups.map((group) => `  ${group.typeHash}  ${group.projects.join(', ')}`).join('\n');

/** A project that is not a readable ascend store. */
export class NotAnAscendStoreError extends Error {
  constructor(
    readonly label: string,
    readonly file: string,
    detail: string,
  ) {
    super(
      `'${label}' (${file}) is not an ascend store: ${detail}. ` +
        `Every project passed to --across must be one. Treating an unreadable project as empty ` +
        `would report a fragment of the corpus as the whole of it.`,
    );
    this.name = 'NotAnAscendStoreError';
  }
}

/** The same store named twice -- which would count every entry in it twice. */
export class DuplicateProjectError extends Error {
  constructor(
    readonly label: string,
    readonly file: string,
    readonly firstLabel: string,
  ) {
    super(
      `'${label}' and '${firstLabel}' are the same store (${file}), so every entry in it would be ` +
        `counted twice. Two paths can name one file -- a symlink, or a different spelling of the ` +
        `same directory -- so they are compared after resolving the path, not before.`,
    );
    this.name = 'DuplicateProjectError';
  }
}

/** No project in scope defines the type. */
export class TypeNotInAnyProjectError extends Error {
  constructor(
    readonly type: string,
    readonly projects: readonly string[],
  ) {
    super(
      `no project defines an entry type named '${type}'. ` +
        `Searched: ${projects.join(', ')}. ` +
        `A union over projects that do not define the type has no rows to return, and reporting ` +
        `that as an empty result would look like an empty corpus rather than a missing type.`,
    );
    this.name = 'TypeNotInAnyProjectError';
  }
}

/** One name, several definitions. The refusal. */
export class IncompatibleDefinitionsError extends Error {
  constructor(
    readonly type: string,
    readonly groups: readonly DefinitionGroup[],
  ) {
    super(
      `cannot union '${type}' across projects: ${String(groups.length)} different definitions ` +
        `share that name.\n${renderGroups(groups)}\n` +
        `These are not the same type -- the name is all they have in common -- so unioning them ` +
        `would mix values that mean different things while the result looked like one set of ` +
        `numbers. Rename one of them, query the projects separately, or select one definition by ` +
        `passing its hash.`,
    );
    this.name = 'IncompatibleDefinitionsError';
  }
}

/** A hash the caller named that no project holds. */
export class UnknownTypeHashError extends Error {
  constructor(
    readonly type: string,
    readonly requested: string,
    readonly groups: readonly DefinitionGroup[],
  ) {
    super(
      `no project holds a definition of '${type}' with hash ${requested}. ` +
        (groups.length === 0
          ? `No project defines that type at all.`
          : `Available:\n${renderGroups(groups)}`) +
        ` Selecting by hash must name a definition that exists, or the empty result would read ` +
        `as a corpus with no entries in it.`,
    );
    this.name = 'UnknownTypeHashError';
  }
}

/** One registered version of a type, as a project reports it. */
interface VersionRow {
  readonly version: number;
  readonly type_hash: string;
  readonly spec_json: string;
}

/** What one project holds for the type name. Empty `versions` means it does not define it. */
interface Reading {
  readonly source: ProjectSource;
  readonly versions: readonly VersionRow[];
}

/** Every distinct hash this project holds, in its own version order. */
const hashesOf = (reading: Reading): readonly string[] => [
  ...new Set(reading.versions.map((row) => row.type_hash)),
];

const versionsWithHash = (reading: Reading, hash: string): readonly number[] =>
  reading.versions.filter((row) => row.type_hash === hash).map((row) => row.version);

/** The definition a hash describes, from the oldest version carrying it. */
function specFor(reading: Reading, hash: string): TypeSpec | null {
  const row = reading.versions.find((candidate) => candidate.type_hash === hash);
  return row === undefined ? null : (JSON.parse(row.spec_json) as TypeSpec);
}

/**
 * An alias no attachment is using.
 *
 * Namespaced, and then checked: a caller that has already attached something under the name this
 * module was about to use would otherwise get `database is already in use` from a function whose
 * only job was to read.
 */
function freeAlias(db: DatabaseSync): string {
  const taken = new Set(
    (db.prepare('PRAGMA database_list').all() as unknown as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  for (let index = 0; ; index++) {
    const candidate = `asc_union_${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Attach one project, hand its alias to `body`, and detach it whatever happens.
 *
 * The `finally` is not tidiness. A leaked attachment holds the project's file open and its
 * snapshot readable for the rest of the process, so a later query could answer from a database
 * nobody meant to consult any more.
 */
function withProject<T>(db: DatabaseSync, source: ProjectSource, body: (alias: string) => T): T {
  if (!existsSync(source.file)) {
    // Checked before attaching, because ATTACH CREATES a database file when the path does not
    // exist and its directory does (measured). A read-only query would then leave a stray empty
    // file behind wherever the caller mistyped.
    throw new NotAnAscendStoreError(
      source.label,
      source.file,
      'there is no file at that path (SQLite would create an empty database for it, so this is ' +
        'refused before anything is attached)',
    );
  }

  const name = freeAlias(db);
  db.exec(`ATTACH DATABASE ${literal(source.file)} AS ${ident(name)}`);
  try {
    return body(name);
  } finally {
    db.exec(`DETACH DATABASE ${ident(name)}`);
  }
}

/** The path SQLite resolved the attachment to, which is how two names for one file are caught. */
function resolvedPath(db: DatabaseSync, name: string): string {
  const row = (
    db.prepare('PRAGMA database_list').all() as unknown as {
      name: string;
      file: string;
    }[]
  ).find((candidate) => candidate.name === name);
  if (row === undefined) throw new Error(`unreachable: '${name}' is not attached`);
  return row.file;
}

/** Fail before reading if the attached database is not an ascend store this build can read. */
function requireStore(db: DatabaseSync, name: string, source: ProjectSource): void {
  const found = (
    db
      .prepare(
        `SELECT name FROM ${ident(name)}.sqlite_master
          WHERE type = 'table' AND name IN ('entries', 'entry_types')`,
      )
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);

  for (const table of ['entries', 'entry_types']) {
    if (!found.includes(table)) {
      throw new NotAnAscendStoreError(source.label, source.file, `it has no '${table}' table`);
    }
  }

  const columns = (
    db.prepare(`PRAGMA ${ident(name)}.table_info('entries')`).all() as unknown as {
      name: string;
    }[]
  ).map((column) => column.name);

  for (const column of ENVELOPE_COLUMNS) {
    if (!columns.includes(column)) {
      throw new NotAnAscendStoreError(
        source.label,
        source.file,
        `its 'entries' table has no '${column}' column, so it was written by an ascend that ` +
          `stored entries differently`,
      );
    }
  }
}

/** Read one project: attach, check it, read its versions of the type, detach. */
function readProject(
  db: DatabaseSync,
  source: ProjectSource,
  type: string,
  seen: Map<string, string>,
): Reading {
  return withProject(db, source, (name) => {
    const resolved = resolvedPath(db, name);
    const first = seen.get(resolved);
    if (first !== undefined) throw new DuplicateProjectError(source.label, resolved, first);
    seen.set(resolved, source.label);

    requireStore(db, name, source);

    // Local version numbers, oldest first. They order this project's own history and nothing else.
    const versions = db
      .prepare(
        `SELECT version, type_hash, spec_json FROM ${ident(name)}.entry_types
          WHERE name = ? ORDER BY version ASC`,
      )
      .all(type) as unknown as VersionRow[];

    return { source, versions };
  });
}

/** Read every project, then settle which definition the union will use. */
function survey(
  db: DatabaseSync,
  type: string,
  projects: readonly ProjectSource[],
  requested: string | undefined,
): { readonly readings: readonly Reading[]; readonly hash: string } {
  const seen = new Map<string, string>();
  const readings = projects.map((source) => readProject(db, source, type, seen));

  const holders = new Map<string, string[]>();
  for (const reading of readings) {
    for (const hash of hashesOf(reading)) {
      const labels = holders.get(hash);
      if (labels === undefined) holders.set(hash, [reading.source.label]);
      else labels.push(reading.source.label);
    }
  }

  const groups: DefinitionGroup[] = [...holders.entries()].map(([typeHash, labels]) => ({
    typeHash,
    projects: labels,
  }));

  if (groups.length === 0) {
    throw new TypeNotInAnyProjectError(
      type,
      readings.map((reading) => reading.source.label),
    );
  }

  if (requested !== undefined) {
    if (!holders.has(requested)) throw new UnknownTypeHashError(type, requested, groups);
    return { readings, hash: requested };
  }

  if (groups.length > 1) throw new IncompatibleDefinitionsError(type, groups);

  const only = groups[0] as DefinitionGroup;
  return { readings, hash: only.typeHash };
}

/**
 * Union one entry type across several projects.
 *
 * Refuses -- with `IncompatibleDefinitionsError` -- when the type name means more than one
 * definition, rather than returning a result set that mixes them. Pass `options.typeHash` to
 * select one of them explicitly.
 */
export function unionEntries(
  db: DatabaseSync,
  type: string,
  projects: readonly ProjectSource[],
  options: UnionOptions = {},
): UnionResult {
  if (projects.length === 0) {
    throw new Error(
      `no projects given to union '${type}' across. An empty project list would return no rows ` +
        `and read as an empty corpus rather than as a missing argument.`,
    );
  }

  const { readings, hash } = survey(db, type, projects, options.typeHash);

  const contributing = readings.filter((reading) => versionsWithHash(reading, hash).length > 0);
  const definition = specFor(contributing[0] as Reading, hash);
  if (definition === null) throw new Error('unreachable: a contributing project held no spec');

  // Sorted, so the projection is a function of the property set rather than of registration order.
  const properties = definition.properties.map((property) => property.name).sort();

  // Properties and states are aliased under `p.` and `s.` prefixes. A property name is canonical
  // (`[A-Za-z0-9_]` only, see @ascend/core), so neither prefix can occur inside one -- whereas
  // without a prefix a property called `id` or `source` collides with an envelope column, and
  // SQLite silently renames the loser to `id:1` in `SELECT *` (measured).
  const projections = properties.flatMap((property) => [
    `  json_extract(e.properties_json, ${literal(`$.${property}`)}) AS ${ident(`p.${property}`)}`,
    `  ${stateCase(property, null)} AS ${ident(`s.${property}`)}`,
  ]);

  const select = (name: string, label: string): string =>
    `SELECT ${literal(label)} AS ${ident('project')},\n` +
    [...ENVELOPE_COLUMNS.map((column) => `  e.${column} AS ${ident(column)}`), ...projections].join(
      ',\n',
    ) +
    `\n  FROM ${ident(name)}.entries AS e\n` +
    ` WHERE e.type_name = ${literal(type)} AND e.type_hash = ${literal(hash)}`;

  const rows: UnionRow[] = [];
  const unionProjects: UnionProject[] = [];

  for (const reading of readings) {
    const versions = versionsWithHash(reading, hash);
    if (versions.length === 0) {
      // Still reported, with a count of zero: a project that holds a different definition is
      // visibly contributing nothing rather than invisible.
      unionProjects.push({
        label: reading.source.label,
        file: reading.source.file,
        hashes: hashesOf(reading),
        versions: [],
        entryCount: 0,
      });
      continue;
    }

    const selected = withProject(
      db,
      reading.source,
      (name) =>
        db.prepare(select(name, reading.source.label)).all() as unknown as Record<
          string,
          unknown
        >[],
    );

    for (const row of selected) rows.push(shapeRow(row));

    unionProjects.push({
      label: reading.source.label,
      file: reading.source.file,
      hashes: hashesOf(reading),
      versions,
      entryCount: selected.length,
    });
  }

  // Ordered here rather than in SQL: the rows come from one statement per project, so an ORDER BY
  // inside each would order each project's share instead of the union.
  rows.sort((left, right) =>
    left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0,
  );

  return { type, typeHash: hash, projects: unionProjects, properties, rows };
}

/** The envelope columns carried on the row itself rather than into `properties`. */
const ENVELOPE_KEYS: readonly string[] = [...ENVELOPE_COLUMNS, 'project'];

/**
 * A column the projection knows is text, or a loud failure.
 *
 * `String(value)` would do here and would be wrong: it turns a numeric column into `"250"` and an
 * object into `"[object Object]"`, both of which read as a real value. A column that arrives as the
 * wrong type means the projection changed, and that is worth an error rather than a coercion.
 */
function requireText(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `unreachable: the union read '${column}' as ${typeof value}, and it is always text`,
    );
  }
  return value;
}

/**
 * Split the flat projected columns back into properties, states, and the entry envelope.
 *
 * A column that is neither known nor prefixed throws rather than being dropped: it would mean the
 * projection above and this parser had drifted, and a silently dropped column is a value the
 * caller never sees while the query reports success.
 */
function shapeRow(row: Record<string, unknown>): UnionRow {
  const properties: Record<string, unknown> = {};
  const states: Record<string, string> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('p.')) properties[key.slice(2)] = value;
    else if (key.startsWith('s.')) states[key.slice(2)] = requireText(value, key);
    else if (!ENVELOPE_KEYS.includes(key)) {
      throw new Error(
        `unreachable: the union selected a column '${key}' it does not know how to read`,
      );
    }
  }

  const text = (key: string): string | null => {
    const value = row[key];
    return value === null || value === undefined ? null : requireText(value, key);
  };

  return {
    project: String(row['project']),
    id: String(row['id']),
    typeName: String(row['type_name']),
    typeVersion: Number(row['type_version']),
    recordedAt: String(row['recorded_at']),
    source: String(row['source']),
    runId: text('run_id'),
    workflow: text('workflow'),
    actor: text('actor'),
    cwd: text('cwd'),
    repo: text('repo'),
    gitSha: text('git_sha'),
    branch: text('branch'),
    evidenceText: text('evidence_text'),
    properties,
    states,
  };
}
