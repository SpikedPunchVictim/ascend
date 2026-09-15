/**
 * `asc explore --sample` -- turning a mode and a type into a sample, and saying how it chose.
 *
 * WHY THIS IS ITS OWN MODULE. The command's run body is the place where a reader finds out what the
 * command does; sampling adds a mode vocabulary, a property-resolution rule, and a stratum label
 * that has to be built and taken apart again. None of that is the command's story, and the command's
 * doc comment is already long enough to be worth protecting. So the mechanism lives here and the
 * command calls three times: resolve, read, choose.
 *
 * WHY `.db` IS NOT NAMED HERE. `align check` forbids the CLI from importing `node:sqlite`, and a
 * `DatabaseSync` in a signature is that import in all but name. So the store's `signatures` is called
 * by the command -- which reaches the handle through the `Store` it was handed rather than through an
 * import -- and this module works on what came back. That is the layering doing its job rather than
 * being worked around: nothing here needs to know how the rows were read.
 *
 * WHAT A `key` IS. `packages/analysis` groups by an opaque string and the sampler never interprets
 * it; this file is the producer, so this is where the string is defined. It encodes a property's
 * STATE beside its value, because `measured`/`passed` and `not_measured`/absent are different strata
 * and collapsing them would report a definition gap as a data gap. The encoding is
 * `JSON.stringify([state, value])`, which is injective for a pair of strings -- so two different
 * strata cannot share a key, and a property whose value happens to be the text `not_measured` cannot
 * collide with the state of the same name. A `Map` built beside the keys holds the structured form,
 * so nothing ever parses the key back: one encode, one lookup.
 */

import {
  DEFAULT_SEED,
  diverseSample,
  outlierSample,
  randomSample,
  stratifiedSample,
  type Samplable,
} from '@ascend/analysis';
import type {
  EntrySignature,
  PropertyProfile,
  SignatureCell,
  SignatureProperty,
  TypeProfile,
} from '@ascend/store';
import { refusal } from './errors.js';
import type { SampleReport, SampleStratum } from './output.js';

/** The four modes, in the order the flag's help lists them. The vocabulary lives here alone. */
export const SAMPLE_MODES = ['random', 'stratified', 'diverse', 'outlier'] as const;

export type SampleMode = (typeof SAMPLE_MODES)[number];

/** What the caller asked for. `by` and `seed` are absent when the flags were. */
export interface SampleRequest {
  readonly mode: SampleMode;
  readonly size: number;
  readonly by?: string;
  readonly seed?: string;
}

/** A request with the type's own shape applied to it: the property chosen, and what to read. */
export interface ResolvedSample {
  /** The property sampled by, or `null` when the mode works without one. */
  readonly by: PropertyProfile | null;
  /** The properties to project. Empty for `random` without `--by`, which needs only the ids. */
  readonly properties: readonly SignatureProperty[];
}

/**
 * The categorical properties of a type: the ones a sample can group by.
 *
 * `summary === 'top'` rather than a list of declared types written out here, because the profiler
 * already made this decision -- `enum`, `boolean`, `string` and `ref` have a value space small
 * enough that "which values occur, and how often" is the informative summary, and `integer`,
 * `timestamp`, `text` and `json` do not. Asking the same question twice, of two lists that could
 * drift, is how `--by occurred_at` would come to mean something on one release and not the next.
 */
function categorical(profile: TypeProfile): readonly PropertyProfile[] {
  return profile.properties.filter((property) => property.summary === 'top');
}

/** The names a refusal lists, so a caller can fix the command line without a second lookup. */
function nameList(properties: readonly PropertyProfile[]): string {
  if (properties.length === 0) {
    return 'It declares no categorical property, so there is nothing to sample by.';
  }
  return `It has: ${properties.map((property) => property.name).join(', ')}.`;
}

/**
 * Applies the type's shape to the request: which property is sampled by, and what must be read.
 *
 * **The refusals here exit 1 rather than 2**, and the reason is the rule `errors.ts` states: exit 2
 * is an operand that cannot be READ, and these are operands that read perfectly well against a world
 * that does not have what they name. A `--by` naming a property this type does not declare is the
 * same shape of answer as a type name nobody registered, which is already a refusal. Whether a fix
 * is needed at all depends on the type rather than on the command line, which is what makes the
 * world the thing that said no.
 *
 * **A single candidate is chosen, and more than one is not guessed at.** `--sample stratified` on a
 * type with exactly one categorical property picks it, so the common case is one flag; on a type
 * with several it refuses and lists them, because choosing the first would be sampling by a property
 * the caller never named and would report a proportion over the wrong denominator while looking
 * entirely ordinary.
 */
export function resolveSample(profile: TypeProfile, request: SampleRequest): ResolvedSample {
  const eligible = categorical(profile);

  const named =
    request.by === undefined
      ? undefined
      : eligible.find((property) => property.name === request.by);

  if (request.by !== undefined && named === undefined) {
    const declared = profile.properties.find((property) => property.name === request.by);
    // Two different mistakes, said differently: a name this type does not have, and a name it has
    // that cannot be grouped by. A single message would send half its readers after the wrong fix.
    throw refusal(
      declared === undefined
        ? `'${profile.type}' declares no property named '${request.by}'. ${nameList(eligible)}`
        : `'${request.by}' is a ${declared.declaredTypes.join(' | ')} property, summarised by ` +
            `${declared.summary} rather than by its values, so it cannot be sampled by. ` +
            nameList(eligible),
    );
  }

  if (request.mode === 'stratified') {
    const property = named ?? (eligible.length === 1 ? eligible[0] : undefined);
    if (property === undefined) {
      throw refusal(
        eligible.length === 0
          ? `'${profile.type}' cannot be sampled by stratum: ${nameList(eligible)}`
          : `'${profile.type}' has ${String(eligible.length)} properties that could be sampled ` +
              `by, so --by must name one. ${nameList(eligible)}`,
      );
    }
    return { by: property, properties: [signatureProperty(property)] };
  }

  // `random` needs nothing but the ids unless a property was named for the report. `diverse` and
  // `outlier` compare whole signatures, so they read every categorical property whether or not
  // `--by` was given -- there, `--by` adds the achieved distribution rather than the choice.
  if (request.mode === 'random') {
    return {
      by: named ?? null,
      properties: named === undefined ? [] : [signatureProperty(named)],
    };
  }

  return { by: named ?? null, properties: eligible.map(signatureProperty) };
}

/** A profile's property, as the projection needs it. */
function signatureProperty(property: PropertyProfile): SignatureProperty {
  return { name: property.name, declaringVersions: property.declaringVersions };
}

/** `[state, value]` as JSON: injective for a pair of strings, so two strata cannot share a key. */
function keyOf(cell: SignatureCell): string {
  return JSON.stringify([cell.state, cell.value]);
}

/**
 * The key for one property of one entry.
 *
 * A cell missing from the projection is not "not measured" -- it is this code having asked for the
 * wrong property, which is a defect here rather than a fact about the data, so it throws. The store
 * returns one cell per requested property, so the branch is unreachable for a caller that passes the
 * projection it asked for, and the exception is what makes "unreachable" a check rather than a hope.
 */
function cellKey(
  keys: ReadonlyMap<string, string>,
  entry: EntrySignature,
  property: string,
): string {
  const cell = entry.values[property];
  if (cell === undefined) throw new Error(`sample: '${property}' was not projected`);
  const key = keys.get(keyOf(cell));
  if (key === undefined) throw new Error(`sample: no label for '${property}'`);
  return key;
}

/** A stratum and its label, before the counts are attached. */
type StratumLabel = Omit<SampleStratum, 'population' | 'selected'>;

/** A sample, and the report that says how it was chosen. */
export interface ChosenSample {
  readonly ids: readonly string[];
  readonly sample: SampleReport;
}

/**
 * Chooses the sample and states what it chose.
 *
 * The report is built here rather than by the caller because the keys are opaque to everything
 * downstream of this file: the structured stratum, the seed that was actually used, and whether a
 * seed applies at all are all facts this module holds and the command would only be forwarding.
 */
export function chooseSample(
  entries: readonly EntrySignature[],
  resolved: ResolvedSample,
  request: SampleRequest,
): ChosenSample {
  const names = resolved.properties.map((property) => property.name);

  // One label per distinct cell, built once. A miss in `labels` below would mean a key was made for
  // something the projection never returned, which is a defect here rather than a state of the data
  // -- so it throws rather than inventing a label.
  const labels = new Map<string, StratumLabel>();
  const keys = new Map<string, string>();
  for (const entry of entries) {
    for (const name of names) {
      const cell = entry.values[name];
      if (cell === undefined) continue;
      const key = keyOf(cell);
      if (keys.has(key)) continue;
      keys.set(key, key);
      labels.set(key, { state: cell.state, ...(cell.value === null ? {} : { value: cell.value }) });
    }
  }

  const by = resolved.by;
  // The seed is reported only when the mode used one. `diverse` and `outlier` are maximisations and
  // take no seed, so echoing the default beside them would claim a parameter that does not apply.
  const seeded = request.mode === 'random' || request.mode === 'stratified';
  const seed = seeded ? (request.seed ?? DEFAULT_SEED) : undefined;

  let ids: readonly string[];
  let strata: readonly { key: string; population: number; selected: number }[] = [];

  if (request.mode === 'stratified' && by !== null) {
    const items = entries.map((entry) => ({ id: entry.id, key: cellKey(keys, entry, by.name) }));
    const drawn = stratifiedSample(items, { size: request.size, seed: seed ?? DEFAULT_SEED });
    ids = drawn.items.map((item) => item.id);
    // The allocation itself, which is the number the mode exists to produce -- every stratum's
    // quota is a decision this made, not a count of what happened to fall out.
    strata = drawn.strata;
  } else if (request.mode === 'random') {
    const items: Samplable[] = entries.map((entry) => ({ id: entry.id }));
    ids = randomSample(items, { size: request.size, seed: seed ?? DEFAULT_SEED }).map(
      (item) => item.id,
    );
  } else {
    const items = entries.map((entry) => ({
      id: entry.id,
      keys: names.map((name) => cellKey(keys, entry, name)),
    }));
    ids =
      request.mode === 'diverse'
        ? diverseSample(items, { size: request.size }).map((item) => item.id)
        : outlierSample(items, { size: request.size }).map((item) => item.id);
  }

  // The achieved distribution, for a mode that was given a property but did not allocate by one.
  // Counted from the selection, and EVERY stratum of the population appears -- a zero is the finding
  // these modes are being compared against, and a report that listed only the strata that occurred
  // would hide exactly the number a reader came for.
  if (by !== null && request.mode !== 'stratified') {
    const taken = new Set(ids);
    const counted = new Map<string, { population: number; selected: number }>();
    for (const entry of entries) {
      const key = cellKey(keys, entry, by.name);
      const held = counted.get(key) ?? { population: 0, selected: 0 };
      held.population += 1;
      if (taken.has(entry.id)) held.selected += 1;
      counted.set(key, held);
    }
    strata = [...counted.entries()].map(([key, held]) => ({ key, ...held }));
  }

  const report: SampleReport = {
    mode: request.mode,
    ...(by === null ? {} : { by: by.name }),
    ...(seed === undefined ? {} : { seed }),
    strata: strata
      .map((stratum) => {
        const label = labels.get(stratum.key);
        if (label === undefined) throw new Error('sample: a stratum has no label');
        return { ...label, population: stratum.population, selected: stratum.selected };
      })
      .sort(compareStrata),
  };

  return { ids, sample: report };
}

/**
 * Every stratum named, so the order is total and two runs agree.
 *
 * Measured values first, ascending; then the absent states grouped by name. A reader comparing two
 * reports is comparing like with like only if the rows are in the same order, and the order a
 * `Map` happened to be filled in is not one anybody can reproduce.
 */
function compareStrata(a: SampleStratum, b: SampleStratum): number {
  const rank = (stratum: SampleStratum): number => (stratum.value === undefined ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const left = a.value ?? a.state;
  const right = b.value ?? b.state;
  return left < right ? -1 : left > right ? 1 : 0;
}
