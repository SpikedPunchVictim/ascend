#!/usr/bin/env node
/**
 * The `asc` process entry point.
 *
 * **This is TypeScript, and it is the only entry point.** `package.json`'s `bin` points at
 * the compiled `dist/bin.js`, which oclif's own scaffolding does not do -- it generates a
 * hand-written `bin/run.js` next to the source. Two reasons for the deviation:
 *
 *   1. **Everything the entry point does is typed and testable.** The one thing it does
 *      beyond handing over to oclif is the broken-pipe guard (`streams.ts`), and that
 *      decision is covered by a unit test. A plain-JS `bin/run.js` would put it out of
 *      reach of the typechecker: `checkJs` is off, so the error object there is `any`, and
 *      a stream error handler that guesses at the shape of what it was handed is exactly
 *      what must not happen.
 *   2. **No file has to reach into `dist/`.* A hand-written entry point in `bin/` cannot
 *      import the typed source at runtime -- `bin/` is not compiled -- so it would have to
 *      import `../dist/streams.js`. That edge is invisible to every architecture rule,
 *      because build output is excluded from the scan, and `align` says so plainly: *"a
 *      dependency routed through one of these is invisible to every architecture rule, and
 *      a green verdict does not cover it."* Here the edge is `src/bin.ts` -> `src/streams.ts`:
 *      ordinary source, fully visible.
 *
 * The cost is that `asc` exists only after a build. That is already true of the package as
 * a whole -- `main`, `types` and oclif's `commands` directory all point into `dist/` -- and
 * the root `prepare` script builds on `pnpm install`, so a working checkout is one command.
 *
 * Signals are deliberately left alone. Node's default SIGINT already exits 130, and a store
 * write is a single SQLite transaction, so an interrupt cannot leave a half-written entry.
 * An explicit handler would replace a correct inherited behaviour with a hand-written copy.
 */
import { execute } from '@oclif/core';
import { installPipeGuards } from './streams.js';

// Before `execute`, so the guard is in place for every path -- including `--help` and
// `--version`, which oclif answers without ever instantiating a command.
installPipeGuards();

await execute({ dir: import.meta.url });
