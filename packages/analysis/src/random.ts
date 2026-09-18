/**
 * The one seeded generator this package has, and the one notion of a seed that goes with it.
 *
 * WHY THIS FILE EXISTS AT ALL. `sample.ts` needed a reproducible draw and grew a private
 * `mulberry32` to get one. The permutation control in `association.ts` needs the same thing, and
 * `index.ts` carried a standing instruction about what to do when it arrived: "build it on that
 * generator rather than beside it, so one store has one notion of a seed." Two generators would
 * have been two seed vocabularies -- a caller passing `seed: 'ascend'` to a sampler and to a
 * permutation test would reasonably expect the same string to mean the same thing, and with two
 * copies that is true only by coincidence and stays true only by accident. So the generator moved
 * here rather than being copied, and `sample.ts` now imports what it used to own.
 *
 * NOTHING ABOUT THE ARITHMETIC CHANGED IN THE MOVE. `seedOf` and `mulberry32` are the bodies that
 * were in `sample.ts`, unedited; `test/sample.test.ts` pins the sequences they produce, so a
 * transcription slip would have shown up as a changed sample rather than as a silent drift.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`).
 */

/** The seed a caller who names none gets, so an unparameterised run is still reproducible. */
export const DEFAULT_SEED = 'ascend';

/**
 * A 32-bit seed derived from the caller's seed string.
 *
 * FNV-1a, because `analysis` may import no Node builtin -- so it has no hash available to it -- and
 * because a seed needs to be REPRODUCIBLE rather than collision resistant. Stated as a limitation
 * rather than left implicit: 32 bits can be collided deliberately, and the consequence is two seed
 * strings agreeing on a sample. That is a surprising result, not a wrong one.
 */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 -- a small, fast, well-known 32-bit generator.
 *
 * Chosen over `Math.random` for the one property that matters here and that `Math.random` does not
 * have: it can be seeded, so a result is reproducible from its parameters. This store's contract is
 * that a reader can re-run whatever produced a number it is being asked to trust, and an
 * unseedable source makes that impossible for the whole output rather than for one cell.
 *
 * NOT for cryptography. Nothing here needs to be unguessable, and this would not be.
 */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
