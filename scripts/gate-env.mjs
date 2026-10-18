#!/usr/bin/env node
/**
 * What a gate step inherits from the gate, and what it must not.
 *
 * WHY THIS EXISTS. `scripts/gate.mjs` decides what a RUN does by reading four `ASCEND_` variables out
 * of `process.env`: which hook is talking, whether the cuts are off, which scope to take, whether to
 * record. The hook that starts it exports two of them, and every process the runner then spawns
 * INHERITS them -- the suite most of all. `packages/cli/test/dev-hooks.test.ts` and
 * `scripts/gate.test.ts` both drive the real runner for real, so a `pnpm test` started by a pre-push
 * gate ran the runner's own control-flow tests with the gate's own mode switched on: those tests
 * asserted a hook (`[pre-commit]`) and a step list they were never handed, and the extra `align check`
 * step had nothing to spawn, which is where the `127`s came from.
 *
 * Measured 2026-10-14, `npx vitest run scripts/gate.test.ts` on one machine, 32 tests:
 *
 *   nothing set                                      32 passed
 *   `ASCEND_GATE_HOOK=pre-push`                       3 failed / 29 passed
 *   `ASCEND_PRECOMMIT_FULL=1`                        13 failed / 19 passed
 *   both, as `.githooks/pre-push` exports them       14 failed / 18 passed
 *
 * So EVERY push was blocked by the gate's own tests, from any tree -- `but push` and nothing else set
 * those two, and nothing had ever pushed. It is the shape `dogfood/0095` records: an instrument
 * verified through paths that are not the one it is used by (`dogfood/0097`).
 *
 * `TEST_STEP`'s docblock names this same class for `ASCEND_TEST_SCOPE` and answers it a different way:
 * that step STATES the value it wants instead of inferring one from what it inherited. That is right
 * for a variable a step has a value for. These four are not values a step holds -- they are the runner
 * talking to ITSELF, and a step that inherited one is answering a question nobody asked it. So they
 * come out, and a step's own `env` is applied AFTER the strip, so a step that really does want one can
 * still say so and be understood to have meant it.
 *
 * THE LIST IS COMPLETENESS-CHECKED, and that is the point of the module rather than of the strip.
 * `scripts/gate-env.test.ts` reads the source of every `scripts/gate*.mjs` module, takes each
 * `ASCEND_` name that appears in CODE -- comments removed, because a name mentioned in prose is not a
 * name the runner reads -- and asserts this list is exactly that set. A knob added to the runner and
 * not added here fails the suite, rather than leaking quietly into every step the gate spawns.
 */

/**
 * The variables the runner reads to decide what the RUN does. Never inherited by a step.
 *
 * Sorted, so the diff of an addition reads as an addition rather than as a reshuffle.
 *
 * @type {readonly string[]}
 */
export const CONTROL_ENV = Object.freeze([
  'ASCEND_GATE_HOOK',
  'ASCEND_GATE_NO_RECORD',
  'ASCEND_GATE_SCOPE',
  'ASCEND_PRECOMMIT_FULL',
]);

/**
 * Variables GIT sets for the COMMIT BEING MADE, which change what "the index" means.
 *
 * `git commit -- <paths>` hands the hook a temporary index holding only those paths and points
 * `GIT_INDEX_FILE` at it. Every process the gate spawns inherits that, so a `git ls-files` inside the
 * suite enumerates the commit instead of the tree: measured 2026-10-18 against an index holding one
 * file, `packages/core/test/purity-enforcement.test.ts` failed four assertions that pass against the
 * real index (`asc-09wx.18`, `dogfood/0118`).
 *
 * They are stripped for the reason the four above are -- a step that inherited one is answering a
 * question nobody asked it -- with an exception those four do not need. Two steps DO mean "the commit
 * being made": `store verify --staged` and `duplicate entry ids` both read `git ls-files -s`, which is
 * the index and nothing else, so they state `keeps: INDEX_ENV`. The strip is a default, not a blanket.
 *
 * NOT completeness-checked, and it cannot be: these modules hold no source of truth for the names git
 * sets. It is a short explicit list rather than a pattern, so adding one is a decision on the record.
 *
 * @type {readonly string[]}
 */
export const INDEX_ENV = Object.freeze(['GIT_INDEX_FILE']);

/**
 * The environment for one spawned step: this process's own, without the variables above, plus whatever
 * the step states for itself.
 *
 * A fresh object every time rather than `process.env` itself, because the caller is about to remove
 * keys from it and this process is the gate.
 *
 * @param {Record<string, string | undefined>} base
 * @param {Record<string, string>} [extra] What the step states. Applied after the strip, so it wins.
 * @param {readonly string[]} [keeps] Names this step means to receive anyway. A step that reads the
 * index on purpose says so here rather than the strip being written around it.
 * @returns {Record<string, string | undefined>}
 */
export function stepEnv(base, extra, keeps) {
  const env = { ...base };
  for (const name of [...CONTROL_ENV, ...INDEX_ENV]) {
    if (keeps !== undefined && keeps.includes(name)) continue;
    Reflect.deleteProperty(env, name);
  }
  return extra === undefined ? env : { ...env, ...extra };
}
