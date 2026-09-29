import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `asc-i5tj.3.1`: **a read never builds the index**, and this file is the half of that guard which
 * a behavioural test cannot reach.
 *
 * EV-33 measured what the alternative costs. `openIndex` used to rebuild on a fingerprint miss with
 * no signal, no progress and no warning -- 2.97 s at this repo's 6,387 entries and **~75 s** at
 * 63,870. A caller running a READ would sit through that unable to tell "working" from "hung", and
 * at EV-32's 3.02 s that was invisible. The settlement chosen is the bead's option 1: the build is an
 * explicit command (`asc index build`) that a read does not run.
 *
 * **Two tests, because the two ways this comes back are invisible to each other.**
 *
 *   1. **A rebuild put back INSIDE `openIndex`.** That is behaviour, and it is caught by driving
 *      `openIndex` on every shape of not-current index and requiring it to refuse and to write
 *      nothing -- `jsonl-index.test.ts` owns that half, next to the function it is about.
 *   2. **A read path SOMEWHERE ELSE reaching for a build** -- a future `jsonl-read.ts`, or a CLI
 *      read command that decides to be helpful -- caught here, by source scan, because no test of
 *      `openIndex` can see a call site in a module that has not run yet.
 *
 * Neither is sufficient, and each one's hole is nameable rather than hidden: this scan cannot see a
 * call added in the same file that *defines* `buildIndex`, and no behavioural test can see code
 * nobody has written. The two together are what makes "a read cannot reach a rebuild" a checked
 * claim instead of a convention the next caller re-introduces.
 *
 * The scan follows `packages/store/test/sql-port.test.ts`, which pins the set of modules naming
 * `node:sqlite` the same way: the assertion names the files it expects rather than counting them, so
 * a second one landing is a failure with a name in it.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = join(REPO, 'packages');

/** `buildIndex` called, as opposed to `buildIndex` discussed. */
const CALL = /\bbuildIndex\s*\(/;

/**
 * Blanks comments, preserving line count and offsets.
 *
 * Load-bearing and measured, exactly as in `sql-port.test.ts`: `jsonl-index.ts` is nearly all prose,
 * and that prose names `buildIndex` -- `openIndex`'s own doc comment discusses what the build does.
 * One of those sentences growing an argument list would match `CALL` and report a file that does not
 * call anything. Stripping is safe here because no comment opener appears inside a string literal
 * anywhere in the five packages' `src` trees; if one ever does, this becomes a scanner that reads a
 * URL as a comment, which is the direction that hides a call rather than inventing one.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');

/** Whether `source` calls `buildIndex`, prose excluded. */
function callsBuildIndex(source: string): boolean {
  return CALL.test(stripComments(source));
}

/**
 * Every file under each package's `src` that calls `buildIndex`, repo-relative and sorted.
 *
 * Includes the module that DEFINES it, because `export function buildIndex(` is a call-shaped match
 * and distinguishing a declaration from a call would need a parser to buy nothing: the definition
 * file is on the expected list by name, so it is allowed, and any OTHER file is not.
 */
function buildCallers(): string[] {
  const callers: string[] = [];

  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, 'src');

    let files: readonly string[];
    try {
      files = readdirSync(src, { recursive: true }).map((name) => String(name));
    } catch {
      // A package with no `src` -- none today, but a scan that throws on one is a scan that
      // fails when a package is added rather than when the rule is broken.
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      if (callsBuildIndex(readFileSync(join(src, file), 'utf8'))) {
        callers.push(`packages/${pkg.name}/src/${file.split('\\').join('/')}`);
      }
    }
  }

  return callers.sort();
}

describe('the index is built by an explicit command, and by nothing else', () => {
  it('is called from exactly two places: its own definition, and the build command', () => {
    // The claim, in full. A read path -- the `openIndex` caller E12.4 will add, a future
    // `jsonl-read.ts`, or an `asc query` that decides to rebuild -- has to appear here to be
    // written, and appearing here is a failure.
    expect(buildCallers()).toEqual([
      'packages/cli/src/commands/index/build.ts',
      'packages/store/src/jsonl-index.ts',
    ]);
  });

  it('would notice a call, and is not fooled by prose about one', () => {
    // The control `purity-enforcement.test.ts` argues for: a rule that never fires looks identical
    // to a rule that passes, and this one passes today by there being nothing to find. Asserted on
    // strings rather than by planting a file in `src`, because a planted file would make the test
    // above fail for a reason that is not a defect -- and because the whole point of this file is
    // that no such file exists.
    expect(callsBuildIndex('const fp = buildIndex(root, db, opts);')).toBe(true);
    expect(callsBuildIndex('// buildIndex(root, db, opts) — the shape a read must not take')).toBe(
      false,
    );
    expect(callsBuildIndex('/*\n * buildIndex(root, db, opts)\n */\nconst fp = 1;')).toBe(false);
  });
});
