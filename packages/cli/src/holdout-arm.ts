/**
 * The live control arm (asc-xn4g): which unit is deliberately NOT shown a handler's guidance.
 *
 * `asc handlers compare` can say what changed after a handler started speaking, but with nothing
 * held back every such reading is before/after with nothing held constant -- the guidance, the
 * session, and the model's own drift all move together. Holding some units out is what separates
 * the lesson's effect from those.
 *
 * **The unit is the one `asc-6ola.4` settled on** (`unitKey`, `handler-replay.ts`): one compaction
 * segment of one stream. Not the session, and not the event. A model that saw the guidance once
 * carries it for the rest of the segment, so assigning per event would put seen and unseen
 * instances of the same carried context in opposite arms; and a compaction is where that
 * carry-over stops being true, so assigning per session would pool two genuinely different states
 * into one arm.
 *
 * **The split is a hash of the key, and so it never reshuffles** -- the property `isHeldOut` exists
 * to provide, reused here rather than re-implemented. That is what lets replay reproduce the
 * decision the live hook made: it is a pure function of the key, not a draw.
 *
 * **What the key is not.** Parts are joined with NUL because no part may contain one. Session ids,
 * handler names and hashes are NUL-free, so the join is unambiguous; a part that introduced a NUL
 * would break that, and nothing here prevents it.
 */

import { isHeldOut } from './holdout.js';

/** Which arm one unit is in. `delivered` is the treatment; `held_out` is the control. */
export type Arm = 'delivered' | 'held_out';

/**
 * One handler's guidance, as an intervention.
 *
 * `id` is the handler's name and is stable across edits; `version` is its content hash, which
 * changes when its meaning does -- including its delivered sentence (`CompiledHandler.hash`).
 * Both are in the key: a new sentence is a new intervention, and its units must not inherit the
 * old one's arm, because comparing deliveries of one version against holdouts of another compares
 * two different things.
 */
export interface Intervention {
  readonly id: string;
  readonly version: string;
}

/**
 * The seed for the arm's hash. A constant, not a parameter: replay must reproduce the live
 * decision, and a seed that varied by run would make the same unit a different arm each time.
 */
const ARM_SEED = 'asc-holdout-arm';

/** The unit and the intervention as one key. See the module doc for what the NUL may assume. */
export function armKey(unit: string, intervention: Intervention): string {
  return `${unit}\u0000${intervention.id}\u0000${intervention.version}`;
}

/**
 * The arm `unit` is in for `intervention`, at `fraction`.
 *
 * `fraction` is a rate strictly between 0 and 1 -- `parseHoldoutFraction` is what vets it, and it
 * refuses 0 and 1 because either leaves one side empty and a comparison over nothing is not a
 * comparison. This function takes the number it is given and does not re-check it.
 */
export function armFor(unit: string, intervention: Intervention, fraction: number): Arm {
  return isHeldOut(armKey(unit, intervention), ARM_SEED, fraction) ? 'held_out' : 'delivered';
}
