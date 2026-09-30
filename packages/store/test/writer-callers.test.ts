import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * E12.4b3: **the six writers are called from inside a production, and from nowhere else.**
 *
 * `writeProducedLines`'s body is handed the transaction's own `db` (see its doc), because four of the
 * six write sites make a read that decides what they write -- `annotate.ts`'s `listSchemes` (asc-q4p),
 * `record.ts`'s `entryCount`, `import.ts`'s `versionsByHash`, `register-document.ts`'s `findType` --
 * and after the flip the handle a command holds on the way in is READ-ONLY (`EV-35`, blocker 1: the
 * preview's INSERT was refused by it). That is what puts every such read inside `BEGIN IMMEDIATE`.
 *
 * The cost of the fix is that a direct writer call on that handle is now SPELLABLE from a body, and
 * the shape it breaks is silent: the tree is appended from the lines `produceLines` collected, never
 * from the database, so a body that calls `recordEntry(db, ...)` itself has written a row that
 * survives the rollback nowhere and is reported by nothing. The next read of the tree would simply
 * not have it.
 *
 * So the allowed callers are pinned by source scan, the same instrument
 * `packages/cli/test/index-build-is-explicit.test.ts` uses for `buildIndex` and
 * `packages/store/test/sql-port.test.ts` uses for `node:sqlite`. **Each is a module that owns a
 * reason to call a writer directly:**
 *
 *   - `recorder.ts`, `registry.ts`, `annotations.ts` -- they DEFINE the writers.
 *   - `line-producers.ts` -- the producers, which are the one supported way to call them.
 *   - `jsonl-index.ts` -- `replay`, which rebuilds the index from lines that already exist.
 *
 * **The six CLI modules below are on this list only until stage C of this change moves them**, and
 * they are written out rather than excused so that each move is a visible edit here: a site that was
 * migrated and a site that was forgotten look identical from the CLI's side, and only this list tells
 * them apart. When the last one is gone the list must be down to the five store modules, and the
 * scan's name becomes true without qualification.
 *
 * **What this cannot see, stated rather than implied:** a call added inside one of the five allowed
 * modules, and a call reached through a re-export or a string. It is a guard against the mistake a
 * person makes, not against a determined one.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = join(REPO, 'packages');

/** Every writer whose direct call has to come from inside a production. */
const WRITERS = [
  'recordEntry',
  'registerType',
  'registerScheme',
  'recordAnnotations',
  'recordInvalidation',
  'updateTypeProse',
] as const;

const CALL = new RegExp(`\\b(${WRITERS.join('|')})\\s*\\(`, 'g');

/** The five modules that own a reason, plus the six sites stage C has not moved yet. */
const ALLOWED = [
  'packages/cli/src/commands/annotate.ts',
  'packages/cli/src/commands/import.ts',
  'packages/cli/src/commands/ingest/claude-code.ts',
  'packages/cli/src/commands/invalidate.ts',
  'packages/cli/src/commands/record.ts',
  'packages/cli/src/register-document.ts',
  'packages/store/src/annotations.ts',
  'packages/store/src/jsonl-index.ts',
  'packages/store/src/line-producers.ts',
  'packages/store/src/recorder.ts',
  'packages/store/src/registry.ts',
];

/**
 * Blanks comments, preserving line count and offsets.
 *
 * The same helper, and the same measured justification, as `index-build-is-explicit.test.ts`: these
 * modules are substantially prose, and the prose names the writers -- `writeProducedLines`' own doc
 * discusses what a body may call. Stripping is safe because no comment opener appears inside a string
 * literal anywhere in the packages' `src` trees, which that file's scan already asserts; if one ever
 * does, both scanners read a URL as a comment, which hides a call rather than inventing one.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');

/** The writers `source` calls, prose excluded, deduplicated and sorted. */
function writersCalled(source: string): string[] {
  const stripped = stripComments(source);
  const found = new Set<string>();
  for (const match of stripped.matchAll(CALL)) found.add(String(match[1]));
  return [...found].sort();
}

/** Every file under each package's `src` that calls a writer, repo-relative and sorted. */
function callers(): string[] {
  const found: string[] = [];

  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, 'src');

    let files: readonly string[];
    try {
      files = readdirSync(src, { recursive: true }).map((name) => String(name));
    } catch {
      // A package with no `src` -- none today, but a scan that throws on one fails when a package is
      // added rather than when the rule is broken.
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      if (writersCalled(readFileSync(join(src, file), 'utf8')).length > 0) {
        found.push(`packages/${pkg.name}/src/${file.split('\\').join('/')}`);
      }
    }
  }

  return found.sort();
}

describe('a writer is called by a production, and by nothing else', () => {
  it('names every module that calls one, and every one of them is allowed', () => {
    // The claim, in full. A seventh write site -- a new command, a helper that "just records this
    // one thing" -- has to appear here to be written, and appearing here is a failure.
    expect(callers()).toEqual(ALLOWED);
  });

  it('would notice a call, and is not fooled by prose about one', () => {
    // The control the file's own header argues for: a rule that never fires looks identical to a rule
    // that passes. Asserted on strings rather than by planting a file in `src`, because a planted
    // file would make the test above fail for a reason that is not a defect.
    expect(writersCalled('const r = recordEntry(db, req, ctx);')).toEqual(['recordEntry']);
    expect(writersCalled('produce.entry(req, ctx); produce.type(spec, opts);')).toEqual([]);
    expect(writersCalled('// recordEntry(db, req, ctx) — outside a body, so invisible')).toEqual(
      [],
    );
    expect(writersCalled('/*\n * updateTypeProse(db, n, v, text)\n */\nconst x = 1;')).toEqual([]);
    // A call inside a body is still a call: the scan is about the CALL, not about which function
    // encloses it, because the enclosing function is the thing a reader cannot check from a diff.
    expect(
      writersCalled('writeProducedLines(root, db, o, (produce, db) => recordEntry(db, r, c));'),
    ).toEqual(['recordEntry']);
  });
});
