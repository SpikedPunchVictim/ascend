/**
 * The real `node:sqlite`, reached without a static import specifier.
 *
 * Vitest 2 / Vite 5 cannot import `node:sqlite` from test source: Vite's builtin
 * check strips the `node:` prefix and tests the bare name against
 * `builtinModules`, which lists this module ONLY in prefixed form. The specifier
 * is rewritten to bare `sqlite` and the module fails to load. The full
 * measurement, and why every plugin-based fix is inert, is in `vitest.config.ts`.
 *
 * `createRequire` sidesteps it: the specifier is a string argument, not an
 * import, so it never enters Vite's module graph. The `node:` prefix is REQUIRED
 * here too -- bare `sqlite` does not resolve under Node either.
 *
 * The assertion is unavoidable and not a cover-up: `createRequire` is typed
 * `NodeRequire`, whose call signature returns `any` by design (it resolves
 * arbitrary specifiers). The asserted type is checked against the same
 * `@types/node` the production import uses, so it cannot drift into a shape the
 * real module does not have.
 *
 * Test-only. Production code imports `node:sqlite` directly and is not aliased
 * outside Vitest. Delete this when Vitest ships a Vite that knows `node:sqlite`.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const { DatabaseSync } = sqlite;
export default sqlite;
