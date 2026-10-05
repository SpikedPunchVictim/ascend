/**
 * Per-cluster counts, so a row's interval can be corrected at the N it is actually worth (asc-0hys).
 *
 * WHY THESE ARE THEIR OWN QUERIES AND NOT A `ProfileOptions.cluster`. `profileType` runs eight
 * queries and has two callers; `doctor.ts` wants none of this. Threading a cluster dimension through
 * those eight -- one of which (`COUNT(DISTINCT ...)`) cannot take a grouping column without being
 * restructured -- would be a large change to a surface that does not need it, in exchange for cells
 * one caller discards. These functions are additive and read the same scope `--filter`/`--struck`
 * already build, so a narrowed `explore` narrows its corrections the same way.
 *
 * ONE QUERY PER PROPERTY, NOT ONE PER ROW -- and the collapse is sound for a non-obvious reason.
 * `json_extract` is NULL exactly when `json_type` is NULL, which is exactly the `measured` arm of
 * `stateCase`. So a single `GROUP BY <state>, <value>, <cluster>` serves the state rows AND the
 * top-value rows together: `(measured, V, c)` is one top-value cell, and `(not_applicable, NULL, c)`
 * is a declared count. The alternative -- a query per printed row -- measured **42 statements**
 * against this shape's **8** on `tool_denial`, and `spike/e22-row-clusters.mjs` compares the two
 * constructions cell for cell rather than trusting the clever one.
 *
 * **`(measured, NULL, c)` is a real cell and NOT a not-measured count.** A property whose JSON value
 * is `null` has `json_type` `'null'` (a present key, so `measured`) while `json_extract` returns SQL
 * NULL. So a caller must branch on `state`, never on `value === null`, or that entry would be counted
 * into a state it is not in. This is the one place the collapse is not self-evident.
 *
 * Reads `entries`, never a generated view, for `profileType`'s own reason (`profile.ts:141-156`): a
 * view may predate the current definition. That also makes the cell sums agree with the profile's
 * own `states` by construction -- and where they do not, `wilson` refuses the mismatched pair rather
 * than computing an interval at a denominator neither of them measured.
 */

import { canonicalName } from '@ascend/core';
import { INVALIDATION_LABELS, RESERVED_SCHEME, type InvalidationLabel } from './annotations.js';
import { propertiesOf, valueExpr } from './properties.js';
import type { SqlDatabase } from './sql-port.js';
import { typeVersions } from './registry.js';
import { literal, stateCase } from './sql.js';
import { typeFilterScope } from './type-filter.js';

/** The four states a property can be in, identical to `StateCounts`' own keys. */
export type PropertyStateName = 'measured' | 'not_applicable' | 'not_measured' | 'not_declared';

/**
 * Those four, in the order every surface reports them.
 *
 * A VALUE and not only the type, because a surface that iterates the states needs the list -- and a
 * second hand-written list is how two surfaces come to disagree about how many states a property
 * has. `explore` iterates them to print one row per state (`propertyStateRows`), including the ones
 * at zero; `explore-cluster` iterates them to build a design for a state with no cells of its own,
 * which is a row that still exists and still divides by a non-zero population.
 */
export const PROPERTY_STATES = [
  'measured',
  'not_applicable',
  'not_measured',
  'not_declared',
] as const satisfies readonly PropertyStateName[];

/** A caller asked to cluster by something that is not a declared property of the type. */
export class ClusterCellsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterCellsError';
  }
}

/** One (state, value, cluster) cell of one property, as a single `GROUP BY` returns it. */
export interface PropertyClusterCell {
  readonly property: string;
  readonly state: PropertyStateName;
  /** The measured value. Non-null when the state is `measured` -- but see the module comment: a
   * JSON `null` is `measured` AND has a null value, so this is not the test for "was it measured". */
  readonly value: string | null;
  /** The cluster key, or `null` for an entry that carries none -- which the caller must refuse
   * rather than bucket, since such an entry is in no cluster. */
  readonly cluster: string | null;
  readonly count: number;
}

/** One (label, cluster) cell of a type's invalidations. `label: null` is "no invalidation at all",
 * which is what makes the aggregate row's population countable from the same rows. */
export interface InvalidationClusterCell {
  readonly label: InvalidationLabel | null;
  readonly cluster: string | null;
  readonly count: number;
}

/** Everything `explore --cluster` needs to correct the rows it prints, in one call. */
export interface ClusterCells {
  readonly properties: readonly PropertyClusterCell[];
  readonly invalidations: readonly InvalidationClusterCell[];
}

/**
 * The per-cluster cells for one type, clustered by one of its declared properties.
 *
 * `undefined` when the type is not registered, matching `profileType`. A property the type does not
 * declare is REFUSED by name rather than quietly producing empty cells: an empty cell set is
 * indistinguishable from "the filter excluded everything", and a correction computed over nothing
 * would report `deff = 1` -- the one answer that says "no correction needed" when the truth is "this
 * question was never asked".
 */
export function clusterCells(
  db: SqlDatabase,
  rawType: string,
  clusterProperty: string,
  options: { readonly filter?: string; readonly struck?: boolean } = {},
): ClusterCells | undefined {
  const type = canonicalName(rawType);
  const versions = typeVersions(db, type);
  if (versions.length === 0) return undefined;

  const declared = propertiesOf(versions);
  if (!declared.has(clusterProperty)) {
    throw new ClusterCellsError(
      `'${clusterProperty}' is not a property of '${type}'. Declared properties: ` +
        `${[...declared.keys()].join(', ') || '(none)'}.`,
    );
  }

  const narrowed = options.filter !== undefined || options.struck === true;
  const scopeClause = !narrowed
    ? ''
    : ` AND e.id IN (${typeFilterScope(db, type, options.filter ?? null, {
        struck: options.struck === true,
      })})`;
  const clusterExpr = valueExpr(clusterProperty);

  const properties: PropertyClusterCell[] = [];
  for (const [name, seen] of declared) {
    const rows = db
      .prepare(
        `SELECT ${stateCase(name, seen.declaring)} AS state,\n` +
          `       ${valueExpr(name)} AS value,\n` +
          `       ${clusterExpr} AS cluster,\n` +
          `       COUNT(*) AS n\n` +
          `  FROM entries AS e WHERE e.type_name = ?${scopeClause}\n` +
          ` GROUP BY state, value, cluster`,
      )
      .all(type) as unknown as {
      state: PropertyStateName;
      value: string | null;
      cluster: string | null;
      n: number;
    }[];
    for (const row of rows) {
      properties.push({
        property: name,
        state: row.state,
        value: row.value,
        cluster: row.cluster,
        count: row.n,
      });
    }
  }

  // The same latest-label subquery `invalidatedCounts` uses, so the two cannot disagree about what
  // an entry's label is -- but WITHOUT its `WHERE label IS NOT NULL`, because here the rows with no
  // label are the population the aggregate row's share is over.
  const invalidationRows = db
    .prepare(
      `SELECT label, cluster, COUNT(*) AS n FROM (\n` +
        `  SELECT (SELECT a.label FROM annotations AS a\n` +
        `            WHERE a.entry_id = e.id AND a.scheme = ${literal(RESERVED_SCHEME)}\n` +
        `            ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS label,\n` +
        `         ${clusterExpr} AS cluster\n` +
        `    FROM entries AS e WHERE e.type_name = ?${scopeClause}\n` +
        `) GROUP BY label, cluster`,
    )
    .all(type) as unknown as { label: string | null; cluster: string | null; n: number }[];

  const invalidations = invalidationRows.map((row) => {
    if (row.label !== null && !INVALIDATION_LABELS.includes(row.label as InvalidationLabel)) {
      // `recordInvalidation` refuses every label outside the vocabulary before inserting, so a row
      // read back with one means that invariant broke upstream -- worth failing loudly over, in
      // `invalidatedCounts`' own words.
      throw new ClusterCellsError(
        `clusterCells: '${type}' has an invalidation labelled '${row.label}', which is not one of ` +
          `the reserved vocabulary.`,
      );
    }
    return { label: row.label as InvalidationLabel | null, cluster: row.cluster, count: row.n };
  });

  return { properties, invalidations };
}
