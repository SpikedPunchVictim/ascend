import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * "Read-only on ~/.claude/projects" is the adapter's most important promise and
 * the easiest one to break by accident -- one `writeFile` added for a cache, one
 * `rename` for an atomic update, and ascend has modified a user's session
 * history. `~/.claude/projects` is not ascend's data. A single stray write there
 * corrupts something the user cannot regenerate, and no other test in this
 * package could catch it: no test writes there, so no test can fail.
 *
 * So the promise is checked the way this project checks its other invariants --
 * by looking for the capability in the source -- but it checks WHAT IS IMPORTED
 * from `node:fs`, not what words appear in the file.
 *
 * The first version of this file scanned text, and it was wrong in both
 * directions. It flagged `reason: 'symlink'` -- a string literal naming why the
 * walk skipped a path -- and it stripped comments with a lexical pass that
 * collapsed multi-line block comments and shifted every line number it
 * reported. Importing is the real capability; a string that spells a function
 * name is not. Checking imports needs no comment stripping at all, so the class
 * of false positive disappears rather than being tuned away.
 *
 * Two things are proven separately, because they fail differently:
 *
 *   1. Does the check FIRE? A rule that never fires looks identical to a rule
 *      that passes. Planted violations, asserted by count.
 *   2. Is the check reading anything? A regex that matched no imports would
 *      certify every package forever, including one that writes everywhere.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const FS_SPECIFIERS = new Set(['node:fs', 'node:fs/promises']);

/**
 * Every `fs` / `fs.promises` entry point that can create, modify, move or delete
 * anything. Deliberately broad -- a denylist of three would silently admit the
 * fourth, which is the mistake `align.config.ts` already documents for `node:*`.
 *
 * `open` is included even though it can be read-only: opening for write is the
 * mechanism behind several of the others, and the flag is the thing a future
 * edit would get wrong.
 */
const WRITE_BASES = [
  'write',
  'writeFile',
  'appendFile',
  'createWriteStream',
  'writev',
  'truncate',
  'ftruncate',
  'unlink',
  'rm',
  'rmdir',
  'rename',
  'mkdir',
  'mkdtemp',
  'copyFile',
  'cp',
  'chmod',
  'chown',
  'utimes',
  'lutimes',
  'symlink',
  'link',
  'open',
];

/**
 * Both spellings of every name, derived rather than typed out.
 *
 * The list was written by hand once and lost `mkdirSync` in a later edit -- a
 * real gap, and an invisible one: the check still passed, on a file it no longer
 * covered. Deriving the `Sync` form means a name added to the base list cannot
 * arrive in only half its spellings. A few entries have no async/sync twin
 * (`createWriteStream`); including the impossible spelling costs nothing, since
 * it simply never matches.
 */
const WRITE_APIS = new Set(WRITE_BASES.flatMap((base) => [base, `${base}Sync`]));

interface FsImport {
  /** The names the file brings into scope FROM node:fs. */
  readonly named: readonly string[];
  /**
   * True for `import * as fs from 'node:fs'`. Recorded as an offender rather
   * than ignored: a namespace import is uncheckable here, and a check that
   * silently cannot see is worse than one that asks for a human. Conservative
   * on purpose -- the cost of a false alarm is a comment in a test, the cost of
   * a missed write is a user's lost history.
   */
  readonly namespace: boolean;
}

/** Parse every import whose specifier is a raw `fs` module. */
function fsImports(source: string): FsImport[] {
  const imports: FsImport[] = [];
  const statement = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(statement)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? '';
    if (!FS_SPECIFIERS.has(specifier)) continue;

    const named: string[] = [];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced?.[1] !== undefined) {
      for (const part of braced[1].split(',')) {
        // `writeFile as wf` imports `writeFile`; the ORIGINAL name is what
        // matters, an alias is just a local spelling.
        const imported = part.trim().split(/\s+as\s+/)[0] ?? '';
        const name = imported.replace(/^type\s+/, '').trim();
        if (name.length > 0) named.push(name);
      }
    }
    imports.push({ named, namespace: /\*\s+as\s+/.test(clause) });
  }

  return imports;
}

/** The write-capable names one source file brings into scope from `node:fs`. */
function writeCapableImports(source: string): string[] {
  const offenders: string[] = [];
  for (const imported of fsImports(source)) {
    if (imported.namespace) offenders.push('* (namespace import)');
    for (const name of imported.named) {
      if (WRITE_APIS.has(name)) offenders.push(name);
    }
  }
  return offenders;
}

const sourceFiles = (): string[] =>
  readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();

const read = (name: string): string => readFileSync(join(SRC, name), 'utf8');

describe('the read-only check fires', () => {
  it('flags a planted writeFileSync import', () => {
    expect(writeCapableImports("import { writeFileSync } from 'node:fs';")).toEqual([
      'writeFileSync',
    ]);
  });

  it('flags a planted createWriteStream through fs/promises', () => {
    // Both specifiers, because `node:fs/promises` is the one a future edit is
    // most likely to reach for and the easiest to forget to cover.
    expect(writeCapableImports("import { createWriteStream } from 'node:fs/promises';")).toEqual([
      'createWriteStream',
    ]);
  });

  it('flags a write API hidden behind an alias', () => {
    expect(writeCapableImports("import { unlink as remove } from 'node:fs';")).toEqual(['unlink']);
  });

  it('flags a namespace import, because it cannot be checked', () => {
    expect(writeCapableImports("import * as fs from 'node:fs';")).toEqual(['* (namespace import)']);
  });

  it('flags a write API inside a mixed import list', () => {
    expect(
      writeCapableImports("import { readFileSync, mkdtempSync, statSync } from 'node:fs';"),
    ).toEqual(['mkdtempSync']);
  });

  it('does NOT flag read-only imports', () => {
    // The negative control. Without it, a check that flagged every import would
    // make the real assertion below fail -- and the tempting fix would be to
    // weaken the check rather than to notice it was wrong.
    expect(
      writeCapableImports("import { readFileSync, createReadStream, readdir } from 'node:fs';"),
    ).toEqual([]);
  });

  it('does NOT flag a string literal that merely spells a write API', () => {
    // The exact false positive the first version of this file produced:
    // `reason: 'symlink'` is a label, not a capability.
    expect(writeCapableImports("import { readdir } from 'node:fs';\nconst r = 'symlink';")).toEqual(
      [],
    );
  });

  it('does NOT flag an unrelated module that happens to export a similar name', () => {
    expect(writeCapableImports("import { open } from 'node:stream';")).toEqual([]);
    expect(writeCapableImports("import { mkdir } from 'node:path';")).toEqual([]);
  });
});

describe('the check is not vacuous', () => {
  it('reads every source file in the package', () => {
    expect(sourceFiles()).toEqual([
      'decode.ts',
      'index.ts',
      'reader.ts',
      'transcript-file.ts',
      'transcript-root.ts',
    ]);
  });

  it('actually finds fs imports to judge', () => {
    // The anti-vacuity guard. If the import regex stopped matching -- a NodeNext
    // syntax change, a reformat -- every file would scan clean and this suite
    // would certify a package it never read. Measured today: the reader is the
    // only file that touches the filesystem at all, and the other four are pure.
    const importing = sourceFiles().filter((name) => fsImports(read(name)).length > 0);
    expect(importing).toEqual(['reader.ts']);
  });
});

describe('the adapter never writes', () => {
  it('imports no write-capable fs binding in any source file', () => {
    const offenders = sourceFiles()
      .flatMap((name) => writeCapableImports(read(name)).map((api) => `${name}: ${api}`))
      .filter((entry) => entry.length > 0);

    expect(offenders).toEqual([]);
  });
});
