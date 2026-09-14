import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every positional argument in this CLI must refuse stdin.
 *
 * `asc-air` was the defect: oclif fills a MISSING positional argument from stdin unless the arg
 * declares `ignoreStdin` (`@oclif/core/lib/parser/parse.js`, `tryStdin`, gated only on
 * `arg.ignoreStdin`). Every operand here is a path or a type name, so a piped document was read as
 * a filename -- and `types export.name`, being `required: false`, did not even fail: a pipe
 * silently narrowed a 7-entry export to 2.
 *
 * Fixing the eight args that existed was not enough, and saying so is the point of this file. The
 * fix commit recorded the limit plainly -- "a new arg added without `ignoreStdin` reintroduces it,
 * and nothing yet fails a build for that; the sweep is a grep, not a check". This is that check.
 *
 * The shape is `packages/store/test/recorder.test.ts`'s single-write-path guard: scan the source,
 * and prove the scanner is neither vacuous nor trigger-happy. A guard that finds nothing passes
 * for the wrong reason, which is the "reports success wrongly" class this project treats as
 * severity-zero.
 */

const SRC = fileURLToPath(new URL('../src/commands', import.meta.url));

/** Every `.ts` under `src/commands`, recursively -- `types/` is a subdirectory. */
function sources(dir: string): { file: string; source: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ file: relative(SRC, path), source: readFileSync(path, 'utf8') }];
  });
}

/**
 * Remove comments, so a brace or a declaration-looking phrase inside one is not read as code.
 *
 * **NOT load-bearing against the sources as they stand, and a mutation run is what established
 * that rather than an argument.** The first draft of this comment claimed the opposite -- that the
 * fix's own prose discusses `ignoreStdin` at length, so an unstripped scan would pass on a file
 * whose code had none. That is false, and measurably so: `grep -rn "ignoreStdin: true"
 * packages/cli/src` returns 8 matches, all of them the declarations. The prose in these files
 * writes `ignoreStdin`, never `ignoreStdin: true`, so it cannot satisfy the regex below at all.
 * Removing this call leaves the guard on the real sources GREEN.
 *
 * It stays for the reason the two synthetic tests pin, and they fail without it: the span is found
 * by counting braces, and a `}` inside a comment would end that span early and hide a declaration
 * that is really there. That is a robustness the sources do not currently exercise -- recorded
 * rather than dressed up, because a comment claiming a test protects something it does not is the
 * class this whole file exists to catch. `packages/store/test/recorder.test.ts` carries the same
 * correction for `(?!\w)`.
 *
 * A block comment is replaced by its own newlines rather than by the empty string, so byte offsets
 * stay true to the file a reader would open -- collapsing lines would shift every span after a
 * multi-line comment.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');

interface Declaration {
  readonly name: string;
  /** The argument's option object, from its opening brace to its matching close. */
  readonly body: string;
}

/**
 * Every `name: Args.<kind>({ ... })` declaration in a source file.
 *
 * The span is found by COUNTING BRACES rather than by searching for `})`. Measured while writing
 * this: `types/deprecate.ts` and the others carry a multi-line comment inside the option object,
 * and a comment can contain a brace, so `indexOf('})')` can stop short of the real close and miss
 * an `ignoreStdin` that is present -- a false failure. Counting is total over any input.
 */
function declarations(source: string): Declaration[] {
  const stripped = stripComments(source);
  const found: Declaration[] = [];
  for (const match of stripped.matchAll(/(\w+):\s*Args\.\w+\(\{/g)) {
    // `match.index` is a number, not `number | undefined`, for `matchAll` -- lint rejects a `?? 0`
    // here as a dead branch, and it is right.
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < stripped.length; end++) {
      if (stripped[end] === '{') depth += 1;
      else if (stripped[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({ name: match[1] ?? '?', body: stripped.slice(open, end + 1) });
  }
  return found;
}

/** The args that would take a value from stdin. `file:line`-ish, so a failure names where to go. */
function argsThatAcceptStdin(files: readonly { file: string; source: string }[]): string[] {
  const missing: string[] = [];
  for (const { file, source } of files) {
    for (const { name, body } of declarations(source)) {
      if (!/ignoreStdin\s*:\s*true/.test(body)) missing.push(`${file}: ${name}`);
    }
  }
  return missing;
}

describe('every positional arg refuses stdin', () => {
  it('declares ignoreStdin on every arg in the CLI', () => {
    expect(argsThatAcceptStdin(sources(SRC))).toEqual([]);
  });

  it('finds the args at all, so a passing scan is not a vacuous one', () => {
    // Without this, deleting every args block would make the test above pass. The count is a
    // floor rather than an equality: adding a command should not fail this test, and the test
    // above is what covers the new arg.
    const all = sources(SRC).flatMap(({ source }) => declarations(source));
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.map((d) => d.name)).toContain('document');
    expect(all.map((d) => d.name)).toContain('sql');
  });

  it('catches a real violation, in the forms a reformat would produce', () => {
    // The guard has to be shown to FAIL before it is trusted to pass. Each spelling is one a
    // plausible edit would produce, and the wrapped one is what this repo's own formatter does.
    const violations = [
      `const A = { x: Args.string({ required: true }) };`,
      `const A = { x: Args.string({\n  description: 'a path',\n  required: true,\n}) };`,
      `const A = { x: Args.string({\n  required: true,\n  ignoreStdin: false,\n}) };`,
    ];
    for (const source of violations) {
      expect(argsThatAcceptStdin([{ file: 'x.ts', source }]), source).toHaveLength(1);
    }
  });

  it('does not read a comment carrying the literal as the declaration', () => {
    // The sources today never spell `ignoreStdin: true` in prose -- `grep` returns 8 matches and
    // all 8 are declarations -- so this pins a robustness rather than a live hazard, and it fails
    // if `stripComments` is dropped. Stated that way on purpose: the first draft of this test was
    // named as though it had caught something real, and the mutation run showed it had not.
    const commentOnly = `const A = {
      // ignoreStdin: true is required by asc-air, because oclif fills a missing positional
      x: Args.string({
        /* ignoreStdin: true */
        required: true,
      }),
    };`;
    expect(argsThatAcceptStdin([{ file: 'x.ts', source: commentOnly }])).toHaveLength(1);
  });

  it('does not stop an arg span early at a brace inside a comment', () => {
    // The brace-counting reason, asserted rather than described: a `}` in a comment would end a
    // naive `indexOf('})')` search before the real close and hide an `ignoreStdin` that IS there.
    const braced = `const A = {
      x: Args.string({
        // the shape is { name, type } and it ends here }
        ignoreStdin: true,
        required: true,
      }),
    };`;
    expect(argsThatAcceptStdin([{ file: 'x.ts', source: braced }])).toEqual([]);
  });
});
