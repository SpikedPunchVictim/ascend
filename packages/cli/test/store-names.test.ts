import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * E12.4's naming rule, made checkable: **the store is the JSONL tree, and `ascend.db` is a file from
 * before the flip that exactly one command may still know about.**
 *
 * The epic is a change of what the store IS, and the change is invisible in the type system. A
 * module that opens `ascend.db` and a module that opens `index.db` both compile, both run, and
 * disagree about where the records are -- which is why the plan's own words for this stage are "a
 * half-flipped store reads one source and writes the other". Nothing about a function signature
 * prevents it, so it is checked by scanning the source, in the style of
 * `index-build-is-explicit.test.ts` and `packages/store/test/sql-port.test.ts`.
 *
 * Four claims, and each one names its files rather than counting them, so a second file landing is a
 * failure with a name in it:
 *
 *   1. **Who may NAME `STORE_FILE`** -- the const for `ascend.db`. Four store modules -- the
 *      definition, the re-export, the migration, and the index module that refuses to build from a
 *      tree while a legacy store sits beside it -- and `asc init`, which detects a legacy store,
 *      migrates it, and names its WAL/SHM in `.gitignore`.
 *   2. **Who may CALL `openStore`** -- the raw SQLite opener. The index's own module must, because
 *      the index IS a SQLite file; `asc init` must, to preview against a legacy store or an
 *      in-memory one; `migrate.ts` must, to read the store it is migrating; `project.ts` must, for
 *      the one case with no tree to read (`asc query` outside any project). Every other module reads
 *      through `openIndex`, which is the currency check as well as the open.
 *   3. **Who may spell `'ascend.db'` as a literal** -- `db.ts` alone, where it is the const's value.
 *      A literal anywhere else is a path built by hand, which is how a rename misses a call site.
 *   4. **Who may spell `'index.db'` as a literal** -- `jsonl-index.ts` alone, for the same reason.
 *
 * **This scan cannot see a name built at runtime** (`join(dir, name)` where `name` is a value), and
 * that is a real hole rather than a hidden one: the guard covers the way this mistake is actually
 * made -- a literal, typed once -- and a module that assembles the path from parameters has already
 * gone somewhere no scan of this shape can follow. It is stated so the hole is not mistaken for
 * coverage.
 *
 * Comments are stripped, and that is load-bearing: `jsonl-index.ts`'s doc for `INDEX_FILE` explains
 * at length why it is NOT `STORE_FILE`, `project.ts` describes the layout it replaced, and `migrate.ts`
 * is mostly prose about a database. A scanner without stripping would report those files as naming a
 * const they only discuss.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = join(REPO, 'packages');

/** Blanks comments, preserving line count and offsets. See this file's header for why. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');

/** Every `packages/<pkg>/src/**\/*.ts` file, repo-relative, with its comments stripped. */
function sources(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();

  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, 'src');

    let files: readonly string[];
    try {
      files = readdirSync(src, { recursive: true }).map((name) => String(name));
    } catch {
      // A package with no `src`. A scan that threw on one would fail when a package is added rather
      // than when the rule is broken.
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const relative = file.split('\\').join('/');
      out.set(
        `packages/${pkg.name}/src/${relative}`,
        stripComments(readFileSync(join(src, file), 'utf8')),
      );
    }
  }

  return out;
}

/** The modules whose CODE matches `pattern`, sorted. */
function naming(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [path, source] of sources()) {
    if (pattern.test(source)) found.push(path);
  }
  return found.sort();
}

describe('the store is the tree, and only one command may still know the old file', () => {
  it('names STORE_FILE in five modules, and each has a reason to', () => {
    expect(naming(/\bSTORE_FILE\b/)).toEqual([
      // Detects a legacy store, migrates it, and names its WAL/SHM in `.gitignore`.
      'packages/cli/src/commands/init.ts',
      // The definition.
      'packages/store/src/db.ts',
      // The re-export.
      'packages/store/src/index.ts',
      // Refusing to build an index from a tree while a legacy store sits beside it. The one module
      // that must know both names, because it is the one that can tell the two stores apart.
      'packages/store/src/jsonl-index.ts',
      // The migration, which is the one function whose job is to read a file of that name.
      'packages/store/src/migrate.ts',
    ]);
  });

  it('calls openStore in five modules, and every read path goes through openIndex instead', () => {
    expect(naming(/\bopenStore\s*\(/)).toEqual([
      // The previews -- against a legacy store, or against `:memory:` on a fresh directory.
      'packages/cli/src/commands/init.ts',
      // The one case with no tree to read: `asc query` outside any project gets an in-memory store.
      'packages/cli/src/project.ts',
      // The definition.
      'packages/store/src/db.ts',
      // The index itself, which is a SQLite file: the staging build, the writable open and the
      // read-only open all go through here.
      'packages/store/src/jsonl-index.ts',
      // Reading the store that is about to be archived.
      'packages/store/src/migrate.ts',
    ]);
  });

  it("spells 'ascend.db' in exactly one module, and there as the const's value", () => {
    expect(naming(/ascend\.db/)).toEqual(['packages/store/src/db.ts']);
  });

  it("spells 'index.db' in exactly one module, where the const is defined", () => {
    expect(naming(/['"`]index\.db['"`]/)).toEqual(['packages/store/src/jsonl-index.ts']);
  });

  it('would notice a name, and is not fooled by prose about one', () => {
    // The control `purity-enforcement.test.ts` argues for: a rule that never fires looks identical
    // to a rule that passes, and every claim above passes today by there being nothing to find.
    // Asserted on strings rather than by planting a file in `src`, because a planted file would
    // fail the claims for a reason that is not a defect.
    const strip = (text: string): string => stripComments(text);
    expect(/\bSTORE_FILE\b/.test(strip('join(dir, STORE_FILE);'))).toBe(true);
    expect(/\bSTORE_FILE\b/.test(strip('// STORE_FILE is the old name\nconst x = 1;'))).toBe(false);
    expect(/\bopenStore\s*\(/.test(strip('/*\n * openStore({ dir })\n */\nconst x = 1;'))).toBe(
      false,
    );
    expect(/ascend\.db/.test(strip("const p = join(dir, 'ascend.db');"))).toBe(true);
    expect(
      /ascend\.db/.test(strip('/*\n * <project>/.ascend/ascend.db, which no longer exists\n */')),
    ).toBe(false);
  });
});
