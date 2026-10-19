/**
 * The gate's run record: one append-only JSONL line per run, beside the gate's other
 * machine-local files.
 *
 * WHY A FILE AND NOT A COUNTER. `asc-09wx.14` asks for a before-number per step, and a
 * gate whose cost "moves with machine load rather than with the diff" (this repo's own
 * measurement: 229 s quiet, 672 s loaded) cannot be graded from a single figure. The rows
 * are the sample; `docs/evidence/EV-70.md` is the reading of them.
 *
 * WHY NOT `.testcount/`. That directory is about what vitest collected. This is about the
 * gate's own steps, which includes steps that are not tests, so it lives under `.ascend/`
 * with the other machine-local state (`.ascend/ingest-cursor.json`, `.ascend/events/`) and
 * is named individually in `.gitignore` -- the convention `.align/telemetry.jsonl` sets.
 *
 * APPEND-ONLY, AND NEVER LOAD-BEARING. Nothing reads this file to decide anything, and the
 * write is best-effort by construction: a failure to record a run returns a failure and
 * says so, but it must never be able to change a gate's verdict. `dogfood/0061` is this
 * repo's record of what an unmeasured step costs; a measurement that can turn a green gate
 * red would be a worse version of the same defect.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Relative to the repository root, which is the gate's working directory. */
export const LOG_PATH = '.ascend/gate-runs.jsonl';

/** The row schema's version. Bumped when a field changes meaning, never when one is added. */
export const ROW_VERSION = 1;

/**
 * Whether the write landed, where it went, and why not if it did not.
 *
 * @typedef {object} AppendResult
 * @property {boolean} ok
 * @property {string} path
 * @property {string} [error]
 */

/**
 * Appends one row. Returns `{ ok, path }` or `{ ok: false, path, error }` -- it does not
 * throw, because a caller that has to catch cannot promise the verdict is unaffected.
 *
 * @param {unknown} row
 * @param {{ root?: string, logPath?: string }} [options]
 * @returns {AppendResult}
 */
export function appendRun(row, { root = process.cwd(), logPath = LOG_PATH } = {}) {
  // `resolve`, not `join`: a PUSH run happens in a temporary worktree but must record its row in the
  // checkout's log (`scripts/push-gate.mjs`), so the path it passes is absolute. `join(root, '/abs')`
  // silently produces `<root>/abs`, which would write the row into the worktree and lose it.
  const path = resolve(root, logPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, path, error: message };
  }
}
