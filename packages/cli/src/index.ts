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
