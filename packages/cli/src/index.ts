/**
 * @ascend/cli -- the `asc` command line (oclif).
 *
 * Empty at E1 (repo foundation). The oclif skeleton, `asc init`, `asc record`
 * and `asc query` land in E4 -- see beads `asc-m8n`, `asc-pcy`, `asc-gvr`,
 * `asc-6ct`. **Dogfooding starts the moment `asc record` works.**
 *
 * Cold start is measured: oclif costs p50 123 ms / p95 169 ms against a bare
 * Node script's 59/72 ms (2.10x, n=50) -- inside the 300 ms threshold, so the
 * "fast path for `record`" escape hatch stays in the Design Reserve, unbuilt.
 * See docs/evidence/EV-runtime.md.
 */

/** The binary name. */
export const BIN = 'asc';

/**
 * Re-exported so `test/streams.test.ts` can reach it the way every other test reaches its
 * package -- through the alias, not a relative path into `src/`. The entry point
 * (`src/bin.ts`) imports the module directly instead, so that starting `asc` loads one
 * function to install a stream handler rather than whatever the index grows to include.
 */
export { guardBrokenPipes, installPipeGuards } from './streams.js';
export type { ErrorEmitting, PipeGuardDeps } from './streams.js';

/**
 * Re-exported for the same reason, and here the reason is sharper than convenience.
 *
 * The cases that matter to this scanner are the ones a `;` is HIDDEN inside -- a quoted literal, a
 * doubled escape, a comment, a bracketed identifier -- and each is one string with one expected
 * count. Driving those through the binary would mean a test per case spawning a process, and more
 * to the point it would test the count only where it changes an exit code: a scanner that
 * UNDERCOUNTS is the defect this exists to prevent, and an undercount is exactly the case where the
 * command succeeds and the test sees nothing.
 */
export { statementCount } from './sql.js';

/**
 * Re-exported for the same reason again, and here the case is a boundary rather than a case.
 *
 * The defect `asc-bcv.19` fixed lives in the CUT, and the cut is a function of one number:
 * the index the cell's budget lands on. Proving it fixed means walking that index -- every
 * offset an astral character can occupy relative to the cut, both surrogate halves on both
 * sides of it, and widths at and below the clamp. Driving that through the binary would be
 * one spawned process per offset to re-measure the same arithmetic, and the offsets that
 * matter are exactly the ones no command can be talked into producing.
 *
 * `renderTable` also takes its width as a parameter, so the whole boundary sweep runs
 * against the real function with no fixture and no mock.
 */
export { renderTable, renderCsv, renderJson, render, OUTPUT_CONTRACT_VERSION } from './output.js';
export type { Output, OutputFormat, Row, JsonEnvelope } from './output.js';
