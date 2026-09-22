#!/usr/bin/env node
/**
 * The `asc` process entry point.
 *
 * **This is TypeScript, and it is the only entry point.** `package.json`'s `bin` points at
 * the compiled `dist/bin.js`, which oclif's own scaffolding does not do -- it generates a
 * hand-written `bin/run.js` next to the source. Two reasons for the deviation:
 *
 *   1. **Everything the entry point does is typed and testable.** The one thing it does
 *      beyond handing over to oclif is install the stream guards (`streams.ts`) -- the
 *      broken-pipe handler and synchronous writes -- and both decisions are covered by unit
 *      tests. A plain-JS `bin/run.js` would put them out of reach of the typechecker: `checkJs`
 *      is off, so the error object there is `any`, and a stream error handler that guesses at
 *      the shape of what it was handed is exactly what must not happen.
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
 *
 * **Bare `asc` runs `types brief`** (`ARCHITECTURE.md`: "`asc` with no args prints the brief").
 * That default is applied here rather than declared to oclif, and the reason is a measurement
 * rather than a preference: **oclif 5.0.0 has no default-command setting.** `Config` declares no
 * such field, the `oclif.default` key is read nowhere in the library, and `main.js` does the
 * opposite -- *"if (argv.length === 0 && !config.isSingleCommandCLI) return true"*, which sends a
 * bare invocation to help. The one mechanism that looks adjacent, a command file named
 * `index.ts`, is a different feature: it maps to the empty command id, which is only reachable
 * through `oclif.commands.strategy === 'single'`, and that mode inserts a placeholder id into
 * argv -- making the CLI single-command, which would cost every other subcommand.
 *
 * So argv is decided once, here, rather than by rewriting `process.argv` (an ambient mutation
 * whose effect is invisible from anywhere else) or by a hook that never fires (no command is
 * instantiated for a bare invocation, which is why the pipe guard above is installed here too).
 */
import { execute } from '@oclif/core';
import { installPipeGuards } from './streams.js';
import { nodeVersionRefusal } from './node-version.js';

/**
 * The flags that say how to print rather than what to do.
 *
 * Spelled out as argv strings rather than read from `base.ts`'s `OUTPUT_FLAGS`, because the
 * question here is about the ARGV TOKENS -- which strings a caller typed -- and a flags object
 * cannot answer it: it does not say whether `--json=false`, `--no-json` or `-j` should route, and
 * each of those is a different decision. Only the exact spellings route. `help.test.ts` asserts
 * this set against `OUTPUT_FLAGS`, so a fifth output flag cannot be added without one of the two
 * places failing to compile-or-test silently.
 */
const OUTPUT_ONLY_FLAGS: ReadonlySet<string> = new Set(['--json', '--table', '--csv', '--debug']);

/**
 * Whether this invocation named no command at all -- only output flags.
 *
 * `asc --json` used to exit 2 with `command --json not found`, because the default below applied
 * only to a FULLY empty argv. So the base output flags were unreachable on the root: the natural
 * spelling of "the brief, as JSON" was an error, and the only way to get it was to name a command
 * the caller had no reason to know about. Since a bare `asc` already means `types brief`, a bare
 * `asc` plus output flags means `types brief` plus those flags.
 *
 * `--help` and `--version` are deliberately NOT in this set. They are not output flags, oclif
 * answers them without instantiating a command, and routing them would replace two working
 * screens with whatever `types brief` does with them.
 */
function namesNoCommand(argv: readonly string[]): boolean {
  return argv.length > 0 && argv.every((arg) => OUTPUT_ONLY_FLAGS.has(arg));
}

// Before `execute`, so the guard is in place for every path -- including `--help` and
// `--version`, which oclif answers without ever instantiating a command.
installPipeGuards();

// Before argv is even read. `nodeVersionRefusal` is the one call in this file that can fail
// the process outright, and it runs first for two reasons. First, ordering after the pipe
// guard means the write below is already synchronous and cannot be truncated by `process.exit`
// -- the same truncation `streams.ts` documents for oclif's own error path. Second, and the
// reason this isn't routed through `errors.ts`'s `refusal()`: `errors.ts` imports `@ascend/store`
// (for `isBusyError`) and `@ascend/core`/`@ascend/analysis`, so on a Node old enough to lack
// `node:sqlite`, importing `errors.ts` throws the exact confusing error this check exists to
// replace. `node-version.ts` imports nothing, by design, so it is the one module guaranteed to
// still work on the Node it is warning about.
const versionRefusal = nodeVersionRefusal(process.versions.node);
if (versionRefusal !== undefined) {
  process.stderr.write(`Error: ${versionRefusal}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);

await execute({
  dir: import.meta.url,
  // Passed explicitly rather than left to oclif's own `process.argv.slice(2)`, so there is one
  // answer to "what was asked for" instead of two. Everything else is untouched: `asc --help`,
  // `asc --version` and every real command reach oclif exactly as typed.
  args: argv.length === 0 || namesNoCommand(argv) ? ['types', 'brief', ...argv] : argv,
});
