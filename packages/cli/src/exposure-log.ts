/**
 * `guidance.decided` -- the live half of the exposure pair (asc-xn4g).
 *
 * `asc handlers compare` can only call a comparison controlled if it knows which units were shown
 * a lesson and which were deliberately not. The transcript cannot tell it: a withheld lesson leaves
 * the same trace as a lesson no handler matched. So the dispatcher writes its decision at the moment
 * it makes it, and replay joins on `exposure_id` to find what became of it.
 *
 * **NOT A STORE TYPE, ON PURPOSE**, for the reason `events/` is not one either: this is written by a
 * hook on the tool-call path, and a store write carries validation, immutability and a hash per
 * record that a decision record neither needs nor can afford there. It is plain append-only JSONL
 * under `.ascend/`, the same shape the record tree and the event log already use.
 *
 * **`tree` is the STORE tree -- `<root>/.ascend` -- not the project root**, matching the store's own
 * API (`readRecordTree(tree)`). Every function here takes it in that one form, and a caller must
 * make the `join(root, STORE_DIR)` that `storePaths` exists to make once. Passed the project root,
 * this writes `<project>/exposure/decided.jsonl`: outside the store, untracked by nothing, and gone
 * from the next clone -- which is the identical mistake `storePaths`' own docblock was written about
 * after it made `treeFingerprint` hash a directory that does not exist.
 *
 * **A decision is written for a held-out unit TOO.** That is the whole point -- recording only what
 * was delivered makes the control arm invisible, and a comparison that cannot see its controls is
 * the before/after reading the holdout exists to replace.
 *
 * **No rolling yet, and that is a measured statement rather than an oversight.** Nothing under
 * `handlers/` currently declares a `stage:`, so no decision has ever been written by this project
 * and the file is empty; the growth that forced `events/` to roll (~1.33 MB/day, `EV-39` Q1) is a
 * rate this log does not have. Rolling is added when there is a rate to roll at.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Arm } from './holdout-arm.js';

/** The directory under the store tree. `events/` and `entries/` are its siblings. */
export const EXPOSURE_DIR = 'exposure';

/** The one file this log holds. See the module doc for why it does not roll. */
export const DECIDED_FILE = 'decided.jsonl';

/**
 * One decision: this intervention, at this trigger, in this unit, took this arm.
 *
 * A held-out unit has no payload and no channel, so those fields are OPTIONAL. `arm` and the unit
 * are not optional; without them there is nothing to join.
 *
 * **There is deliberately no `payload_sha256`/`payload_bytes` here** (`asc-xn4g`). They were declared
 * for a marker scheme that was designed and then not built, and the numbers they would hold are not
 * the hook's to take: the hook decides and exits, and what the harness recorded after it is in the
 * transcript, not in this record. That measurement lives on `hook.delivery` (`bytes`, `sha256`),
 * where it is read back off the harness's own `attachment` record -- see the kind's docblock in
 * `@ascend/core`. Declaring them here would advertise a writer that does not exist.
 */
export interface DecidedRecord {
  /** The join key, and the string embedded in the delivered payload's markers. */
  readonly exposure_id: string;
  readonly intervention_id: string;
  readonly intervention_version: string;
  readonly arm: Arm;
  /**
   * The rate the decision was made at. Stored rather than left to the installed settings, for the
   * reason `chars_per_token` is reported: it is an assumption the reading depends on, and a record
   * that does not state it cannot be re-derived later without going to look.
   */
  readonly rate: number;
  readonly session: string;
  /** The stream: `main`, or the id of the subagent whose transcript this is. */
  readonly agent: string;
  readonly segment: number;
  readonly hook_event: string;
  readonly tool_use_id?: string;
  readonly prompt_id?: string;
  /** How it was sent, when it was. */
  readonly channel?: string;
}

const path = (tree: string): string => join(tree, EXPOSURE_DIR, DECIDED_FILE);

/**
 * The join key for one exposure, built from parts rather than drawn.
 *
 * Rebuilding it must reproduce the live value exactly, since a marker the payload carries and a key
 * the log holds are the same string; a random id could not be checked against anything.
 */
export function exposureIdOf(parts: {
  readonly intervention: string;
  readonly version: string;
  readonly unit: string;
  readonly trigger: string;
}): string {
  return `${parts.intervention}@${parts.version}:${parts.unit}:${parts.trigger}`;
}

/**
 * Append one decision. Throws on a filesystem failure: the caller decides whether a decision that
 * could not be recorded should stop the delivery it describes, and hiding the failure here would
 * take that decision away from it.
 */
export function writeDecided(tree: string, record: DecidedRecord): void {
  mkdirSync(join(tree, EXPOSURE_DIR), { recursive: true });
  appendFileSync(path(tree), `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Every decision recorded, oldest first. A line that is not a whole record is skipped, not thrown:
 * a torn tail is what a log looks like mid-append, and losing the records before it to a parse
 * error would be the worse answer. Missing tree is the ordinary case, and reads as empty.
 */
export function readDecided(tree: string): readonly DecidedRecord[] {
  let text: string;
  try {
    text = readFileSync(path(tree), 'utf8');
  } catch {
    return [];
  }
  const out: DecidedRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as DecidedRecord);
    } catch {
      continue;
    }
  }
  return out;
}
