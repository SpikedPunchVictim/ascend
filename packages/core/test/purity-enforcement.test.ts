import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The purity contract is the project's most load-bearing invariant: core and
 * analysis must have zero `fs`, zero `Date.now()`, zero network, zero
 * nondeterminism, so the statistics and the spec are testable and deterministic.
 * Time and identifiers are injected.
 *
 * A rule that never fires looks identical to a rule that passes. Two things are
 * therefore checked separately, because they fail differently:
 *
 *   1. Is the rule CONFIGURED for both pure packages? (`--print-config`, with the
 *      store as a negative control -- it is where I/O legitimately lives.)
 *   2. Does the configured rule actually FIRE? (a fixture of planted violations,
 *      asserted by count, so the coverage cannot quietly narrow.)
 *
 * Only having one of the two proves nothing: (1) alone passes while every rule is
 * broken, (2) alone passes while analysis is silently unguarded.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const violation = 'packages/core/test/fixtures/purity-violation.ts';
const clean = 'packages/core/test/fixtures/purity-clean.ts';

/**
 * Memoized by argument list: each spawn costs ~2s of ESLint startup, these tests
 * query the same two fixtures and the same three config paths several times over,
 * and the gate runs on every commit. Nothing in this file edits the fixtures or the
 * config, so a result cannot go stale within a run -- if that ever changes, the
 * cache has to go, because a stale answer would make these tests pass for the wrong
 * reason, which is the exact failure they exist to catch.
 */
const spawnCache = new Map<string, { status: number | null; output: string }>();

function run(args: string[]): { status: number | null; output: string } {
  const key = args.join('\u0000');
  const cached = spawnCache.get(key);
  if (cached !== undefined) return cached;
  const r = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', shell: false });
  const result = { status: r.status, output: r.stdout + r.stderr };
  spawnCache.set(key, result);
  return result;
}

/**
 * NOTE: `pnpm lint` deliberately excludes `packages/*\/test/fixtures/**` (see the
 * `lint` script). This helper does NOT pass that ignore pattern, so it lints the
 * fixtures against the real eslint.config.js -- the same config that guards
 * packages/core/src. `pnpm lint:all` is the invocation that lints everything.
 */
const eslintOn = (file: string): { status: number | null; output: string } =>
  run(['exec', 'eslint', '--no-warn-ignored', file]);

/** How many violations the fixture plants. Each must map to a rule that fires. */
const PLANTED = 5;

describe('purity lint enforcement: the rules fire', () => {
  it('rejects an fs import in core', () => {
    const { status, output } = eslintOn(violation);
    expect(output).toContain('no-restricted-imports');
    expect(output).toContain('node:fs');
    expect(status).not.toBe(0);
  });

  it('rejects reading the ambient clock', () => {
    const { output } = eslintOn(violation);
    expect(output).toContain('no-restricted-globals');
    expect(output).toMatch(/Date/);
  });

  it('rejects nondeterminism, so a result is reproducible', () => {
    // The "IDs and randomness are injected" half of the contract. Without this rule
    // a statistic could differ between two runs on the same data and nothing would
    // say why.
    const { output } = eslintOn(violation);
    expect(output).toContain('no-restricted-properties');
    expect(output).toContain('Math.random');
  });

  it('rejects the monotonic clock, which is still an ambient clock', () => {
    const { output } = eslintOn(violation);
    expect(output).toMatch(/performance/);
  });

  it('rejects ambient randomness drawn for an identifier', () => {
    const { output } = eslintOn(violation);
    expect(output).toMatch(/crypto/);
  });

  it('flags EVERY planted violation, so the coverage cannot quietly narrow', () => {
    // Counted, not sampled: adding a dimension to the contract without adding a
    // fixture violation for it fails here rather than passing unexercised.
    const { output } = eslintOn(violation);
    expect(output).toMatch(new RegExp(`${String(PLANTED)} problems`));
  });

  it('accepts an injected clock', () => {
    const { status, output } = eslintOn(clean);
    expect(output.trim()).toBe('');
    expect(status).toBe(0);
  });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

interface Restrictions {
  readonly globals: readonly string[];
  readonly properties: readonly string[];
  readonly imports: readonly string[];
}

/**
 * The purity restrictions ESLint would actually apply to a given path.
 *
 * Uses `--print-config`, which resolves config by PATH PATTERN and does not require
 * the file to exist -- so the pure packages can be checked before they have any
 * source, and a path outside the purity block can be checked as a control.
 */
function restrictionsOn(file: string): Restrictions {
  const r = run(['exec', 'eslint', '--print-config', file]);
  if (r.status !== 0) throw new Error(`eslint --print-config ${file} failed:\n${r.output}`);

  const parsed = JSON.parse(r.output) as { rules?: Record<string, unknown> };
  const rule = (name: string): unknown[] => {
    const entry = parsed.rules?.[name];
    return Array.isArray(entry) ? entry : [];
  };
  const named = (values: unknown[]): string[] =>
    values
      .filter(isRecord)
      .map((item) => asString(item['name']))
      .filter((name): name is string => name !== undefined);

  const globals = named(rule('no-restricted-globals'));

  const properties = rule('no-restricted-properties')
    .filter(isRecord)
    .map((item) => `${asString(item['object']) ?? '?'}.${asString(item['property']) ?? '?'}`);

  const imports = rule('no-restricted-imports')
    .filter(isRecord)
    .flatMap((config) => {
      const paths = config['paths'];
      return Array.isArray(paths) ? named(paths) : [];
    });

  return { globals, properties, imports };
}

describe('purity lint enforcement: both pure packages are guarded', () => {
  const PURE = ['packages/core/src/index.ts', 'packages/analysis/src/index.ts'];

  it.each(PURE)('applies every dimension of the contract to %s', (file) => {
    const { globals, properties, imports } = restrictionsOn(file);
    expect(globals).toEqual(expect.arrayContaining(['Date', 'process', 'performance', 'crypto']));
    expect(properties).toContain('Math.random');
    expect(imports).toEqual(
      expect.arrayContaining(['node:fs', 'node:fs/promises', 'node:crypto', 'node:http']),
    );
  });

  it('leaves the store unrestricted, because store is where I/O belongs', () => {
    // The negative control. If this ever reports restrictions, the purity block's
    // `files` patterns have widened to cover the whole repo -- and the rules would
    // then be banning fs in the one package whose job is to use it.
    const { globals, properties, imports } = restrictionsOn('packages/store/src/index.ts');
    expect(globals).toEqual([]);
    expect(properties).toEqual([]);
    expect(imports).toEqual([]);
  });
});

/**
 * A tracked source file must not carry an invisible character.
 *
 * Measured rather than theoretical (asc-b2j). Four files held a literal NUL, and git
 * treated every one of them as BINARY: `git diff` reported `- -`, so a change to them
 * showed no content at all and could not be reviewed; `git blame` rendered the byte as
 * a space, so the line git displayed differed from the line the compiler ran; and
 * `grep` silently skipped the file's contents, so a repo-wide search returned nothing
 * and read as "not present" when the thing searched for was present. The sharpest of
 * the four was this repo's own purity-enforcement suite -- the file whose job is to
 * prove these rules FIRE, and the one a review named as existing to prevent
 * false-greens -- sitting unsearchable. The hazard then reproduced while the issue
 * ABOUT it was being written, which is why the rule is enforced here rather than
 * merely documented.
 *
 * Bidi controls and zero-width characters are checked for the same reason and one
 * more: they are invisible in every editor and in every diff, and a bidi override can
 * reorder how a line READS without changing what it DOES.
 *
 * Every character below is built with `String.fromCharCode`, never written literally,
 * because writing one literally is the defect this asserts against.
 */
const INVISIBLE: readonly (readonly [number, string])[] = [
  [0x0000, 'NUL'],
  [0x200b, 'zero-width space'],
  [0x200c, 'zero-width non-joiner'],
  [0x200d, 'zero-width joiner'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x202a, 'left-to-right embedding'],
  [0x202b, 'right-to-left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left-to-right override'],
  [0x202e, 'right-to-left override'],
  [0x2066, 'left-to-right isolate'],
  [0x2067, 'right-to-left isolate'],
  [0x2068, 'first-strong isolate'],
  [0x2069, 'pop directional isolate'],
  [0xfeff, 'byte-order mark / zero-width no-break space'],
];

/** Extensions this rule covers. A NUL inside a PNG is not a defect; inside source it is. */
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|sql|sh|css|html)$/;

const trackedSourceFiles = (): readonly string[] => {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (${String(result.status)}): ${result.stderr}`);
  }
  // `-z` separates with NUL, which is the one separator a filename cannot contain.
  // The separator is built, not written, for the same reason the list above is.
  return result.stdout
    .split(String.fromCharCode(0))
    .filter((f) => f !== '' && SOURCE_EXTENSIONS.test(f));
};

/** Every invisible character in `source`, as lines naming the file, line and character. */
const invisibleOffenders = (source: string, label: string): readonly string[] => {
  const offenders: string[] = [];
  for (const [codePoint, name] of INVISIBLE) {
    const at = source.indexOf(String.fromCharCode(codePoint));
    if (at === -1) continue;
    const line = source.slice(0, at).split('\n').length;
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    offenders.push(`${label}:${String(line)} holds U+${hex} (${name})`);
  }
  return offenders;
};

describe('source hygiene: no tracked source file carries an invisible character', () => {
  const files = trackedSourceFiles();

  it('detects every character it claims to look for', () => {
    // Two controls, because they fail differently and one alone is not enough.
    //
    // The first is written out in full and names no variable: it pins the case that was
    // MEASURED -- a NUL, on line 1, in a file called probe.ts. An earlier version of
    // this test derived both sides from INVISIBLE, so emptying that list would have
    // left it green: planted would be '' and found would be []. A control that cannot
    // fail is the thing it is meant to catch.
    expect(invisibleOffenders(`const a = ${String.fromCharCode(0)};\n`, 'probe.ts')).toEqual([
      'probe.ts:1 holds U+0000 (NUL)',
    ]);

    // The second walks the list itself, which catches a broken comparison or a
    // character that String.fromCharCode does not produce -- neither of which the
    // pinned case above would notice.
    const planted = INVISIBLE.map(([codePoint]) => String.fromCharCode(codePoint)).join('\n');
    const found = invisibleOffenders(planted, 'synthetic');
    expect(found).toHaveLength(INVISIBLE.length);
    for (const [codePoint] of INVISIBLE) {
      const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
      expect(found.some((line) => line.includes(`U+${hex}`))).toBe(true);
    }
  });

  it('scans a real number of files, so a broken enumerator cannot pass by scanning none', () => {
    // The negative control for the check below. `git ls-files` failing, the extension
    // filter going wrong, or the repo moving would all make the scan find nothing --
    // and finding nothing is exactly what the check below calls success.
    expect(files.length).toBeGreaterThan(150);
  });

  it('finds none of them in any tracked source file', () => {
    const offenders = files.flatMap((file) =>
      invisibleOffenders(readFileSync(join(root, file), 'utf8'), file),
    );
    // Reported as a list rather than as a boolean, so a failure names the file, the
    // line and the character -- the three things needed to act on it.
    expect(offenders).toEqual([]);
  });
});

/**
 * A citation names a file AND a line, and the line is the part that goes stale.
 *
 * dogfood/0077 measured that rather than asserting it: of 7 citations followed by hand, 5 pointed
 * at the wrong line. A stale citation and a fresh one look identical -- the file it names is real
 * and only the number is wrong -- so a reader who follows one learns something false with nothing
 * to signal it. The owner's standing rule says the same thing from the other end: no line numbers
 * in a bead or in documentation.
 *
 * The sweep (asc-3sfk) removed 116 of them from comment lines across 57 tracked files. This
 * asserts the class cannot return, because a sweep is a moment and a rule nothing checks is a rule
 * that decays.
 *
 * WHERE A CITATION IS READ AS A CLAIM. Every line of a file whose text is all about this tree --
 * shipped source, and markdown, which has no comment syntax at all -- and the comment text of
 * everything else. Two channels are read as DATA rather than as claims, so only their comments are
 * scanned: a test file, and a spike script. A fixture has to carry a path and a line number to be
 * the fixture it is -- a review table, a stack frame, a tool's own output -- whether it sits in
 * packages/core/test/handler-table.test.ts or in spike/ladder/probe.mjs (30 such lines today,
 * every one a string). A rule over them would report 30 false positives and teach the next reader
 * to ignore the rule.
 *
 * The STRING channel in shipped source is in scope because of what leaving it out cost. The
 * derive-version refusal in packages/cli/src/event-log.ts held a citation in a user-facing error,
 * saying the rule lived at a line of event.ts -- a claim about this tree that a user reads, that a
 * comment-only rule cannot see, and the only one of its kind in the tree. A guard that misses the
 * one live instance of the class it exists for is a guard with a hole it already knows about.
 */

/** Extensions a citation can name. Every one is checked, so widening this is a decision. */
const CITED_EXTENSIONS = 'ts|tsx|js|mjs|cjs|yaml|yml|json|md';

const CITATION = new RegExp(
  `([A-Za-z0-9_./@-]+\\.(?:${CITED_EXTENSIONS})):\\d+(?:[-,]\\s*\\d+)*`,
  'gu',
);

/**
 * Paths where a citation is evidence rather than guidance.
 *
 * dogfood/ and docs/evidence/ are RECORDS: each says what was found on the day it was written and
 * is immutable, so a citation inside one is part of the finding -- several of them are the wrong
 * citations dogfood/0077 is about. Rewriting one would falsify the record. 61 tracked records hold
 * a citation today, so this exclusion is load-bearing rather than decorative, and the control
 * below asserts that rather than trusting it. A spike's FINDINGS.md is the same kind of artifact:
 * spike/event-log/FINDINGS.md is what event-log.ts cites for its retention claim.
 */
const RECORD_PATH = /^(?:dogfood|docs\/evidence)\//u;
const FINDINGS_PATH = /^spike\/[^/]+\/FINDINGS\.md$/u;

/**
 * A mutation spec: fixture text whose prose cannot be separated from it.
 *
 * A spec's `find` and `replace` ARE the text a mutant plants, so a spec that exercises THIS guard
 * holds a citation by construction and cannot avoid it -- the spec that does is the reason this
 * constant exists. It is excluded from the scan outright rather than read as a fixture channel,
 * because a JSON file has no comment syntax: the comment-only rule cannot tell a spec's fixture
 * strings from its prose, and it reads a line as comment text whenever a `//` appears anywhere in
 * it -- which a planted `//` comment line does. Measured: that is what kept this check red on
 * lines 8 and 20 of the spec after the first attempt at this carve-out, with line 20 being the
 * mutant that plants a citation INTO a comment and line 8 the one that plants it into a string.
 *
 * The cost is stated rather than glossed: a spec's `_` note and its `why` entries are prose, and
 * this exclusion stops them being scanned. Of 22 specs, exactly one holds a citation, both of its
 * occurrences sit in `find` fields, and none holds one in its prose -- so nothing is hidden today.
 * The control below is what keeps that a measurement rather than a hope.
 */
const SPEC_PATH = /^scripts\/mutations\//u;

/**
 * A file whose text reproduces other text: a test, or a spike script.
 *
 * Only its comments are read, because the rest of it is a fixture -- a review table, a stack
 * frame, a tool's own output -- and a fixture is not a claim about this tree even when it names a
 * path and a line.
 */
const FIXTURE_CHANNEL = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|^spike\//u;

/** Markdown has no comment syntax, so the whole file is prose. */
const PROSE_FILE = /\.md$/u;

/** Whether every line of `file` is a claim about the tree, rather than only its comment text. */
const wholeFile = (file: string): boolean => PROSE_FILE.test(file) || !FIXTURE_CHANNEL.test(file);

/**
 * Whether `line` is comment text.
 *
 * A leading `//`, `/*` or `*` continuation is the obvious case, and `#` covers a YAML or shell
 * comment. The trailing case is the one the first sweep missed: a constant followed by a comment
 * naming jsonl-files.ts is a citation in a comment as much as a line that opens with one, and
 * spike/event-log/record-size.mjs held one -- measured AFTER that sweep had reported the tree
 * clean. `//` must follow whitespace or open the line, so a `https://` URL is not mistaken for a
 * comment.
 */
const isComment = (line: string): boolean => {
  if (/^\s*(?:\/\/|\/\*|\*|#)/u.test(line)) return true;
  return /(?:^|\s)\/\//u.test(line);
};

/** Every citation `line` holds, as the text that matched. */
const citationsIn = (line: string): readonly string[] => line.match(CITATION) ?? [];

/**
 * The citations in `source` that read as claims about this tree, each as `<label>:<line> cites
 * <text>`.
 *
 * `whole` selects the whole-file rule (see `wholeFile`); otherwise only comment text is read.
 * Returned as a list rather than a boolean so a failure names the file, the line and the citation
 * -- the three things needed to act on it, the same shape `invisibleOffenders` returns.
 */
const citationOffendersIn = (source: string, label: string, whole: boolean): readonly string[] =>
  source.split('\n').flatMap((line, index) => {
    const found = whole || isComment(line) ? citationsIn(line) : [];
    return found.length === 0 ? [] : [`${label}:${String(index + 1)} cites ${found.join(', ')}`];
  });

/** The tracked files whose citations would be claims about the current tree. */
const citationScannedFiles = (): readonly string[] =>
  trackedSourceFiles().filter(
    (file) => !RECORD_PATH.test(file) && !FINDINGS_PATH.test(file) && !SPEC_PATH.test(file),
  );

/**
 * A citation, built from parts rather than written out.
 *
 * Same reason as the invisible characters above: this file is scanned by the guard it defines, so
 * a fixture spelling a citation in full would be one by the guard's own rule -- this file's
 * comments are read -- and the check would be red on itself. Interpolating `CITE` keeps the
 * literal out of every line here while the string a test builds still holds it.
 */
const CITE = 'event.ts:45';
/** A comment marker, built for the same reason, and needed where one sits mid-string. */
const MARKER = '//';

describe('source hygiene: no tracked source file cites another by line', () => {
  const files = citationScannedFiles();

  it('reads a citation as a comment only where it is one', () => {
    expect(isComment(`// a count moves when the version moves (${CITE})`)).toBe(true);
    expect(isComment(`const CAP = 1_048_576; ${MARKER} a note`)).toBe(true);
    expect(isComment(' * a docblock continuation')).toBe(true);
    expect(isComment('# a handler comment')).toBe(true);
    // A `//` inside a URL is not a comment marker, so the tail of one is not comment text.
    expect(isComment("const url = 'https://host/x/a.ts:1';")).toBe(false);
    // Nor is a plain code line.
    expect(isComment(`throw new Error('the rule is at ${CITE}');`)).toBe(false);
  });

  it('reads a citation in a file whose text is a claim, and not one in a fixture', () => {
    // The pinned case first, written out in full rather than derived from the constants above, for
    // the reason the NUL control is: it names a shape that was MEASURED -- a leading `//` comment
    // on a line about the derive version -- so narrowing the constants cannot leave this green
    // while it detects nothing.
    expect(
      citationOffendersIn(`// a count moves when the version moves (${CITE})\n`, 'p.ts', false),
    ).toEqual([`p.ts:1 cites ${CITE}`]);

    // A trailing comment is comment text, and this is the case the first sweep missed.
    expect(
      citationOffendersIn(`const CAP = 1_048_576; ${MARKER} jsonl-files.ts:152\n`, 'p.ts', false),
    ).toEqual(['p.ts:1 cites jsonl-files.ts:152']);

    // A shipped source file's STRINGS are read too. This is the channel the one live error-string
    // citation lived in; a comment-only rule cannot see it.
    expect(
      citationOffendersIn(`throw new Error('the rule is at ${CITE}');\n`, 'src/x.ts', true),
    ).toEqual([`src/x.ts:1 cites ${CITE}`]);

    // A test file's strings are NOT read: that channel is where the fixtures live.
    expect(
      citationOffendersIn(
        "summary: 'src/state.ts:412 -- a separator is kept',\n",
        'x.test.ts',
        false,
      ),
    ).toEqual([]);

    // Markdown is prose -- no comment syntax -- so every line is read, table row or not.
    expect(citationOffendersIn('see `src/a.ts:3` for the check\n', 'README.md', true)).toEqual([
      'README.md:1 cites src/a.ts:3',
    ]);

    // A range and a list are the same claim with more numbers in it -- the shape most of the 116
    // removed sites had.
    expect(citationOffendersIn('// pkg/a.ts:12-18 and pkg/b.ts:3, 9\n', 'p.ts', false)).toEqual([
      'p.ts:1 cites pkg/a.ts:12-18, pkg/b.ts:3, 9',
    ]);
  });

  it('names every extension a citation can carry, so the list cannot narrow unnoticed', () => {
    // A pinned case first, and it is the shape a reviewer reaches for last: a citation naming a
    // DOCUMENT rather than a source file, which is what dogfood/0028 holds. Narrowing the list by
    // that one extension is a plausible edit, and it survived the first version of this suite.
    expect(citationOffendersIn('// see ARCHITECTURE.md:333\n', 'p.ts', false)).toEqual([
      'p.ts:1 cites ARCHITECTURE.md:333',
    ]);

    // Then the whole list walked. The pinned case cannot notice an extension ADDED to the list;
    // the walk cannot notice the list emptied, which is why both are here -- the same pair, failing
    // differently, that the invisible-character guard carries. Derived from `CITED_EXTENSIONS` on
    // both sides is safe only because the pinned case above is not.
    const extensions = CITED_EXTENSIONS.split('|');
    const planted = extensions.map((extension) => `// see src/x.${extension}:7`);
    const found = planted.flatMap((line) => citationOffendersIn(`${line}\n`, 'p.ts', false));
    expect(found).toHaveLength(extensions.length);
  });

  it('scans a real number of files, so a broken enumerator cannot pass by scanning none', () => {
    // The negative control for the check below, and the same one the invisible-character guard
    // carries: `git ls-files` failing, the extension filter narrowing to the wrong thing, or the
    // repo moving would all make the scan find nothing -- which is exactly what the check below
    // calls success.
    expect(files.length).toBeGreaterThan(150);
  });

  it('would fail on a record, so the exclusion is load-bearing rather than decorative', () => {
    // Without the record exclusion this check is red the day it lands: 61 tracked records hold a
    // citation, and dogfood/0028 holds the analysis proportion citation that dogfood/0077 measured
    // wrong in all 28 of its occurrences. Asserted rather than left implicit, because an exclusion
    // that never mattered is an exclusion nobody would notice removing.
    const records = trackedSourceFiles().filter(
      (file) => RECORD_PATH.test(file) || FINDINGS_PATH.test(file),
    );
    const wouldFail = records.filter(
      (file) =>
        citationOffendersIn(readFileSync(join(root, file), 'utf8'), file, wholeFile(file)).length >
        0,
    );
    expect(wouldFail.length).toBeGreaterThan(10);
  });

  it('would fail on a mutation spec, so the spec exclusion is load-bearing', () => {
    // Same shape as the record control above, and for the same reason: an exclusion that never
    // mattered is an exclusion nobody would notice removing. It is not hypothetical here -- the
    // spec that exercises this guard was tracked, the whole-file rule read its `find` as an
    // offender, and this check went red on a tree that was otherwise clean. The reading below uses
    // the whole-file rule deliberately: that is what the scan would apply if the spec were not
    // excluded, which is the state this constant exists to keep it out of.
    const specs = trackedSourceFiles().filter((file) => SPEC_PATH.test(file));
    const wouldFail = specs.filter(
      (file) => citationOffendersIn(readFileSync(join(root, file), 'utf8'), file, true).length > 0,
    );
    expect(wouldFail.length).toBeGreaterThan(0);
  });

  it('finds none of them in any tracked file', () => {
    const offenders = files.flatMap((file) =>
      citationOffendersIn(readFileSync(join(root, file), 'utf8'), file, wholeFile(file)),
    );
    // A list rather than a boolean, so a failure names the file, the line and the citation.
    expect(offenders).toEqual([]);
  });
});
