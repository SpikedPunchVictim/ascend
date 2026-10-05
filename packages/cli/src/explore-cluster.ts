/**
 * `asc explore --cluster <column>` -- turning per-cluster cells into the designs the map's Wilson
 * rows are computed at (asc-0hys).
 *
 * **WHY THIS IS ITS OWN MODULE**, for `explore-group.ts`'s own reason: the command's run body is
 * where a reader finds out what the command does, and this is not the command's story. It is the
 * mapping from a store read (`clusterCells`) to a statistical input (`clusterDesignFromGroups`),
 * and the mapping is the part that can be wrong without crashing.
 *
 * **THE MAPPING IS THE HARD PART AND THE ARITHMETIC IS NOT.** Each of the five Wilson row families
 * divides by a different population -- `count`, `declared`, `measured`, `total` -- and the design
 * handed to it has to be over THAT population, or the correction describes a different question from
 * the row it qualifies. `wilson` refuses a design whose `n` disagrees with the count it is given
 * (Stage 2), so a population assembled wrongly does not print a wrong interval: it throws, naming
 * both populations. That refusal is what makes this module's job checkable rather than merely
 * careful, and it is why the lookups below take the population as an argument.
 *
 * **A LOOKUP MISS ON A NON-EMPTY POPULATION IS REFUSED, NOT RETURNED AS `undefined`.** `undefined`
 * is how a design is ABSENT -- an empty population has none, and `wilson` returns `null` for it
 * anyway -- but `wilson` also accepts `undefined` as "no correction was asked for". So a miss that
 * fell through would print an uncorrected interval under a flag that promised a corrected one,
 * silently. That is the severity-zero shape (`reports success wrongly`), and the two cases are
 * separated by the one number that distinguishes them: the row's own denominator.
 *
 * **THE AGGREGATE AND PER-LABEL INVALIDATION ROWS SHARE ONE POPULATION ON PURPOSE.** Both are shares
 * of the type (`invalidatedRow`'s own comment), so a per-label design over anything else would make
 * the two rows incomparable -- the one thing those rows exist to be.
 *
 * **`measured` IS THE TOP-VALUE ROW'S POPULATION, AND `all` IS THE GROUP CELL'S.** They differ, and
 * so do their designs: a top value is a share of the entries that got a value, while a `--group-by`
 * cell is a share of every entry, non-measured states included (a group cell can literally BE a
 * state). One map keyed by display value would silently serve both and be wrong for one of them.
 */

import { clusterDesignFromGroups, type ClusterDesign, type ClusterGroup } from '@ascend/analysis';
import { PROPERTY_STATES, type ClusterCells, type PropertyStateName } from '@ascend/store';

/**
 * The cells and the rows disagree about which rows exist.
 *
 * Thrown rather than repaired: every repair available here -- dropping the row, bucketing the
 * unclustered entries, falling back to no design -- produces a map whose intervals are computed over
 * populations the rows do not name, which is the class of wrong answer this bead exists to remove.
 */
export class ClusterDesignsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterDesignsError';
  }
}

/**
 * The designs for one `asc explore --cluster` run, looked up the way the rows are built.
 *
 * Every lookup takes the POPULATION the row divides by, and returns the design for it or refuses a
 * miss when that population is non-empty. Passing the denominator rather than reading it off the
 * design is what makes the two impossible to disagree: the same number is used to find the design
 * and to compute the interval.
 */
export interface ClusterDesigns {
  /** The aggregate `invalidated` row -- a share of every entry in the (filtered) type. */
  invalidated(population: number): ClusterDesign | undefined;
  /** One `invalidated.<label>` row -- the same population as the aggregate row. */
  label(label: string, population: number): ClusterDesign | undefined;
  /** One `property.<name>.<state>` row -- `declared` for three states, the type total for not_declared. */
  state(property: string, state: PropertyStateName, population: number): ClusterDesign | undefined;
  /** One `property.<name>.top.<value>` row -- a share of the measured entries. */
  value(property: string, value: string, population: number): ClusterDesign | undefined;
  /** One `--group-by <property>` cell -- a share of every entry, keyed by value OR state. */
  groupKey(property: string, key: string, population: number): ClusterDesign | undefined;
}

/** A cluster's contribution to one population: how many observations, and how many are successes. */
type Tally = { readonly size: number; readonly successes: number };

/** Count one cluster's contribution into a population map, accumulating across cells. */
const bump = (map: Map<string, number>, cluster: string, count: number): void => {
  map.set(cluster, (map.get(cluster) ?? 0) + count);
};

/** The per-cluster map for one key of a two-level map (state, value or group key). */
const forKey = <K>(map: Map<K, Map<string, number>>, key: K): Map<string, number> => {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, number>();
  map.set(key, created);
  return created;
};

/**
 * The groups one population contributes: every cluster the population is present in, paired with
 * the successes in that cluster.
 *
 * **EVERY CLUSTER OF THE POPULATION, NOT EVERY CLUSTER OF THE SUCCESSES.** A session that
 * contributed observations of the property but none OF THIS VALUE is a cluster with `successes = 0`,
 * and dropping it would shrink `k` and change the estimator's between-cluster variance -- the
 * correction for a rare value would be computed as though the sessions it is absent from did not
 * exist.
 */
const groupsOf = (
  population: ReadonlyMap<string, number>,
  successes: ReadonlyMap<string, number> | undefined,
): readonly ClusterGroup[] =>
  [...population].map(([cluster, size]) => ({
    size,
    successes: successes?.get(cluster) ?? 0,
  }));

/**
 * The design over one population, or `undefined` when the population has no observations.
 *
 * `undefined` rather than a thrown refusal for the empty case, because there genuinely is no design
 * over nothing: a `--filter` that matched no entries still renders the map, every row of it reads
 * `wilson(x, 0) === null`, and a correction invented for it would be a number attached to no
 * observation.
 */
const designOf = (groups: readonly ClusterGroup[]): ClusterDesign | undefined =>
  groups.length === 0 ? undefined : clusterDesignFromGroups(groups);

/**
 * The designs for a type's per-cluster cells, clustered by `clusterProperty`.
 *
 * `clusterProperty` is used for the refusal message and for nothing else -- the arithmetic never
 * looks at the key. That is the analysis package's own contract (`design-effect.ts`: the cluster key
 * is the caller's, always), arriving here as a name that only ever appears in prose.
 */
export function designsFromCells(cells: ClusterCells, clusterProperty: string): ClusterDesigns {
  // Refused before anything is assembled. An entry that does not record the cluster property is in
  // NO cluster, so it would be counted into the population of none of them -- leaving the design's
  // `n` short of the row's `n`, which `wilson` refuses with a message about populations rather than
  // about the missing key. `cells.invalidations` is the entry-level partition (one row per entry,
  // label or no label), so its counts are entries and the message can say how many.
  const unclustered = cells.invalidations
    .filter((cell) => cell.cluster === null)
    .reduce((sum, cell) => sum + cell.count, 0);
  if (unclustered > 0) {
    throw new ClusterDesignsError(
      `--cluster '${clusterProperty}': ${String(unclustered)} of this type's entries do not record ` +
        `a '${clusterProperty}', so they belong to no cluster and nothing about them can be corrected ` +
        `for one. Cluster by a property every entry carries, or narrow the population with --filter ` +
        `so only entries that have it are counted.`,
    );
  }

  // The same guard for the property cells, which are a second read of the same column. Unreachable
  // once the check above has passed -- both come from one `valueExpr(clusterProperty)` -- so this
  // exists to fail loudly if that stops being true rather than to handle a live case.
  const clusterOf = (cluster: string | null): string => {
    if (cluster === null) {
      throw new ClusterDesignsError(
        `--cluster '${clusterProperty}': a property cell reports no cluster key, which the entry ` +
          'counts say cannot happen. The two reads of this type disagree, so no interval on this ' +
          'map can be trusted. Re-run, or drop --cluster.',
      );
    }
    return cluster;
  };

  // --- the invalidation populations ------------------------------------------------------------
  // `size` accumulates across every label including none, so one pass gives both the aggregate
  // row's population and its successes.
  const invalidationTotals = new Map<string, Tally>();
  const byLabel = new Map<string, Map<string, number>>();
  const entriesPerCluster = new Map<string, number>();
  for (const cell of cells.invalidations) {
    const cluster = clusterOf(cell.cluster);
    bump(entriesPerCluster, cluster, cell.count);
    const tally = invalidationTotals.get(cluster) ?? { size: 0, successes: 0 };
    invalidationTotals.set(cluster, {
      size: tally.size + cell.count,
      successes: tally.successes + (cell.label === null ? 0 : cell.count),
    });
    if (cell.label !== null) bump(forKey(byLabel, cell.label), cluster, cell.count);
  }

  const invalidated = designOf(
    [...invalidationTotals.values()].map((tally) => ({
      size: tally.size,
      successes: tally.successes,
    })),
  );
  const labels = new Map<string, ClusterDesign>();
  for (const [label, successes] of byLabel) {
    const design = designOf(groupsOf(entriesPerCluster, successes));
    if (design !== undefined) labels.set(label, design);
  }

  // --- the per-property populations ------------------------------------------------------------
  const states = new Map<string, Map<PropertyStateName, ClusterDesign>>();
  const values = new Map<string, Map<string, ClusterDesign>>();
  const groupKeys = new Map<string, Map<string, ClusterDesign>>();

  for (const property of new Set(cells.properties.map((cell) => cell.property))) {
    const declared = new Map<string, number>();
    const measured = new Map<string, number>();
    const all = new Map<string, number>();
    const byState = new Map<PropertyStateName, Map<string, number>>();
    const byValue = new Map<string, Map<string, number>>();
    const byKey = new Map<string, Map<string, number>>();

    for (const cell of cells.properties) {
      if (cell.property !== property) continue;
      const cluster = clusterOf(cell.cluster);
      bump(all, cluster, cell.count);
      bump(forKey(byState, cell.state), cluster, cell.count);
      // The display key a `--group-by` cell and this cell share: the value when there is one, the
      // state name otherwise -- the store's own contract, and the one `cellRow` renders.
      bump(forKey(byKey, cell.value ?? cell.state), cluster, cell.count);

      if (cell.state === 'not_declared') continue;
      // `declared` is the three other states together, which is `declaredCount` in the command --
      // spelled here as "not not_declared" so a fifth state added to the model cannot silently join
      // the three shares of `declared`.
      bump(declared, cluster, cell.count);
      if (cell.state !== 'measured') continue;
      bump(measured, cluster, cell.count);
      // Skipped when the JSON value is `null`: `topValues` refuses a null measured value outright
      // (`profile.ts`), so no top row can ever ask for one, and keying it under the state name
      // would put it in the map a top row reads from.
      if (cell.value !== null) bump(forKey(byValue, cell.value), cluster, cell.count);
    }

    const stateDesigns = new Map<PropertyStateName, ClusterDesign>();
    // EVERY state, not only the ones with cells. `propertyStateRows` prints one row per state
    // INCLUDING the states at zero (`renderStates`' own comment: `not_applicable 0` is a finding,
    // not noise), and such a row still divides by `declared` -- a non-zero population with no
    // successes. Iterating the cells would leave that row with no design and a live population,
    // which is the miss `required` refuses; iterating the vocabulary gives it the right design: the
    // declared population, zero successes everywhere.
    for (const state of PROPERTY_STATES) {
      const population = state === 'not_declared' ? all : declared;
      const design = designOf(groupsOf(population, byState.get(state)));
      if (design !== undefined) stateDesigns.set(state, design);
    }
    states.set(property, stateDesigns);

    const valueDesigns = new Map<string, ClusterDesign>();
    for (const [value, successes] of byValue) {
      const design = designOf(groupsOf(measured, successes));
      if (design !== undefined) valueDesigns.set(value, design);
    }
    values.set(property, valueDesigns);

    const groupDesigns = new Map<string, ClusterDesign>();
    for (const [key, successes] of byKey) {
      const design = designOf(groupsOf(all, successes));
      if (design !== undefined) groupDesigns.set(key, design);
    }
    groupKeys.set(property, groupDesigns);
  }

  // A miss is only a refusal when the row it belongs to HAS a population; see the module comment.
  const required = (
    design: ClusterDesign | undefined,
    what: string,
    population: number,
  ): ClusterDesign | undefined => {
    if (design === undefined && population > 0) {
      throw new ClusterDesignsError(
        `--cluster: the cells hold no design for ${what}, but that row reports a population of ` +
          `${String(population)}. The two reads of this type disagree about which rows exist, so ` +
          'every interval on this map would be mislabelled. Re-run, or drop --cluster.',
      );
    }
    return design;
  };

  return {
    invalidated: (population) => required(invalidated, 'the invalidated row', population),
    label: (label, population) => required(labels.get(label), `invalidated.${label}`, population),
    state: (property, state, population) =>
      required(states.get(property)?.get(state), `property.${property}.${state}`, population),
    value: (property, value, population) =>
      required(values.get(property)?.get(value), `property.${property}.top.${value}`, population),
    groupKey: (property, key, population) =>
      required(groupKeys.get(property)?.get(key), `${property} = ${key}`, population),
  };
}
