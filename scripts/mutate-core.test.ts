import { describe, expect, it } from 'vitest';
import {
  applyMutant,
  asRecord,
  executed,
  parseArgs,
  resolveSpecPath,
  validateSpec,
} from './mutate.mjs';

/**
 * The mutation runner's decisions, held to the standard the runner holds everything else to.
 *
 * `scripts/mutate.mjs` is the instrument that shows an assertion *fails* before it is trusted to pass
 * (`README.md`, `## Development`), which makes it the one piece of this repo whose own misbehaviour
 * would be invisible: a mutant it applied to the wrong line, or a killer it counted that never ran,
 * comes back as a green verdict and quietly certifies nothing. So the corners tested here are not the
 * happy paths; they are the specific ways this runner could report a green it did not earn.
 *
 * Only the pure decisions are reachable from here. The shell -- spawning vitest, writing the tree,
 * holding the lock -- is deliberately not exported, because a test that exercised it would be a test
 * that mutated the tree it is running in.
 *
 * **The import guard is exercised by every test in this file, and that is the point of them.** The
 * runner ends with `if (import.meta.main) ... main(...)`; if that guard ever failed open under Vitest,
 * importing it here would execute a whole mutation run inside the worker -- the most dangerous
 * failure this promotion could have introduced. There is no assertion for it because there is nothing
 * to assert: the file merely importing successfully, in milliseconds, with no lock left behind and no
 * `vitest` child spawned, IS the check. A future Node or Vite that changed `import.meta.main` would
 * make every test here hang rather than pass, which is the failure mode worth having.
 */

describe('executed()', () => {
  it('reads the count out of vitest’s own summary line', () => {
    const out = [
      ' ✓ packages/store/test/statements.test.ts (12 tests) 40ms',
      '',
      ' Test Files  1 passed (1)',
      '      Tests  12 passed (12)',
      '   Duration  1.20s',
    ].join('\n');

    expect(executed(out)).toBe(12);
  });

  it('counts a fail as an execution, because a failing test did run', () => {
    expect(executed(' Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)')).toBe(12);
  });

  it('is 0 when vitest printed no summary line at all', () => {
    // THE MEASURED FALSE GREEN this function exists for, and the reason it is not a regex for "0
    // failed". Measured 2026-10-08: `vitest run <file> -t <name matching nothing>` exits 0 and prints
    // no `Tests` line. Read naively that is indistinguishable from a test that ran and passed, so a
    // killer whose name had a typo would be scored as a SURVIVED mutant -- a finding about a test that
    // never existed. 0 here is what makes the caller say DEAD KILLER instead.
    expect(executed('No test files found, exiting with code 0')).toBe(0);
    expect(executed('')).toBe(0);
  });

  it('takes the LAST summary line, so a re-run does not resurrect an earlier count', () => {
    const out = ['      Tests  3 passed (3)', '      Tests  1 passed (1)'].join('\n');

    expect(executed(out)).toBe(1);
  });
});

describe('asRecord()', () => {
  it('narrows a plain object', () => {
    expect(asRecord({ id: 'M1' })).toEqual({ id: 'M1' });
  });

  it('rejects everything JSON.stringify can also produce', () => {
    // `JSON.parse` claims `any`, so without this every field of a spec is unvalidated. The array case
    // matters most: `typeof [] === 'object'`, so a bare typeof check would let `mutants: []`-shaped
    // nonsense through as a record.
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord([])).toBeUndefined();
    expect(asRecord('M1')).toBeUndefined();
    expect(asRecord(7)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
  });
});

describe('validateSpec()', () => {
  const clean = () => false;
  const killer = [{ file: 'packages/store/test/statements.test.ts', test: 'counts one statement' }];
  const spec = (mutants: unknown) => ({ mutants });

  it('passes a spec whose every mutant names a file, an anchor and a killer', () => {
    const problems = validateSpec(
      spec([
        {
          id: 'M1',
          file: 'packages/store/src/statements.ts',
          find: 'a',
          replace: 'b',
          killers: killer,
        },
      ]),
      clean,
    );

    expect(problems).toEqual([]);
  });

  it('refuses a spec that holds no mutants', () => {
    // A run that checks nothing must not pass: an empty spec is the cheapest possible way to get a
    // green verdict out of this tool, and it would look exactly like a clean bill of health.
    expect(validateSpec(spec([]), clean)).toEqual([
      'the spec holds no mutants: a run that checks nothing must not pass',
    ]);
    expect(validateSpec({}, clean)).toHaveLength(1);
    expect(validateSpec('not a spec', clean)).toHaveLength(1);
  });

  it('refuses a mutant with no killers, naming it', () => {
    const problems = validateSpec(
      spec([
        {
          id: 'M9',
          file: 'packages/store/src/statements.ts',
          find: 'a',
          replace: 'b',
          killers: [],
        },
      ]),
      clean,
    );

    expect(problems).toEqual(['M9: NO KILLERS -- checks nothing']);
  });

  it('refuses a mutant with no file, and one that is not an object at all', () => {
    expect(
      validateSpec(spec([{ id: 'M9', find: 'a', replace: 'b', killers: killer }]), clean),
    ).toEqual(['M9: NO FILE -- nothing to mutate']);
    expect(validateSpec(spec(['M9']), clean)).toEqual(['a mutant is not an object']);
  });

  it('refuses an intended survivor that does not say why no test can kill it', () => {
    // The `why` is the entire value of declaring a survivor: without it, `survivor: true` is a way to
    // silence a real survivor rather than to record an equivalent mutant.
    const without = spec([
      {
        id: 'S1',
        file: 'packages/store/src/statements.ts',
        find: 'a',
        replace: 'b',
        killers: killer,
        survivor: true,
      },
    ]);
    const blank = spec([
      {
        id: 'S1',
        file: 'packages/store/src/statements.ts',
        find: 'a',
        replace: 'b',
        killers: killer,
        survivor: true,
        why: '   ',
      },
    ]);
    const withReason = spec([
      {
        id: 'S1',
        file: 'packages/store/src/statements.ts',
        find: 'a',
        replace: 'b',
        killers: killer,
        survivor: true,
        why: 'the replaced text is dead',
      },
    ]);

    expect(validateSpec(without, clean)).toEqual(['S1: an intended survivor needs its `why`']);
    expect(validateSpec(blank, clean)).toEqual(['S1: an intended survivor needs its `why`']);
    expect(validateSpec(withReason, clean)).toEqual([]);
  });

  it('refuses to mutate a file that has uncommitted changes', () => {
    // Not a warning. A run restores its target from the bytes read before mutating, so over a dirty
    // file it would silently revert an edit that is not its own. `isDirty` is injected so the CLI can
    // pass its `git status` probe and `--allow-dirty` can pass one that answers `false`.
    const dirty = (path: string) => path === 'packages/store/src/statements.ts';
    const problems = validateSpec(
      spec([
        {
          id: 'M1',
          file: 'packages/store/src/statements.ts',
          find: 'a',
          replace: 'b',
          killers: killer,
        },
      ]),
      dirty,
    );

    expect(problems).toEqual(['M1: packages/store/src/statements.ts has uncommitted changes']);
  });
});

describe('applyMutant()', () => {
  it('applies an anchor that occurs exactly once', () => {
    const result = applyMutant('let count = 0;\n', {
      id: 'M1',
      file: 'x.ts',
      find: 'count = 0',
      replace: 'count = 1',
      killers: [],
    });

    expect(result).toEqual({ ok: true, text: 'let count = 1;\n' });
  });

  it('refuses an anchor occurring twice, rather than mutating the first one it finds', () => {
    // Both occurrences read identically in the spec, so applying to either is a coin flip: half the
    // time the mutant lands on a line no killer names and the run reports a kill for a change nobody
    // tested. Refused instead, which is the whole reason the anchor has to be unique.
    const result = applyMutant('count += 1;\ncount += 1;\n', {
      id: 'M1',
      file: 'x.ts',
      find: 'count += 1;',
      replace: 'count += 2;',
      killers: [],
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ why: '`find` occurs 2 times' });
  });

  it('refuses an anchor occurring zero times, which would score a kill never earned', () => {
    // The stale-anchor case, and the one that rots silently: the file moves on, the string is gone,
    // the mutant changes nothing, and every killer passes over an unchanged tree -- which the runner
    // would otherwise read as "the killers noticed".
    const result = applyMutant('count += 1;\n', {
      id: 'M1',
      file: 'x.ts',
      find: 'count += 7;',
      replace: 'count += 2;',
      killers: [],
    });

    expect(result).toMatchObject({ ok: false, why: '`find` occurs 0 times' });
  });

  it('substitutes the replacement literally, so `$&` in it is not back-referenced', () => {
    // `String.replace` interprets `$&`, `$1` and friends in a STRING replacement. A replacement like
    // `'$&'` would splice the matched text back in and apply no mutation at all, while the runner
    // reported the mutant as applied -- a mutant that ran, changed nothing, and was scored as killed.
    // The implementation passes a function, which turns that off; this is the assertion that holds it
    // to that.
    const result = applyMutant('const changed = false;\n', {
      id: 'M1',
      file: 'x.ts',
      find: 'false',
      replace: '$& || true',
      killers: [],
    });

    expect(result).toEqual({ ok: true, text: 'const changed = $& || true;\n' });
  });
});

describe('parseArgs()', () => {
  it('reads a bare spec id and defaults to a clean-tree run', () => {
    expect(parseArgs(['types-capture'])).toEqual({ spec: 'types-capture', allowDirty: false });
  });

  it('reads --allow-dirty wherever it appears', () => {
    expect(parseArgs(['--allow-dirty', 'types-capture'])).toEqual({
      spec: 'types-capture',
      allowDirty: true,
    });
    expect(parseArgs(['types-capture', '--allow-dirty'])).toEqual({
      spec: 'types-capture',
      allowDirty: true,
    });
  });

  it('refuses a missing spec and an unknown flag', () => {
    // Both exit 2, which is the usage code -- a run that was never started is not a run.
    expect(parseArgs([])).toMatchObject({ problem: 'no spec given' });
    expect(parseArgs(['--help'])).toMatchObject({ problem: 'no spec given' });
    expect(parseArgs(['types-capture', '--force'])).toMatchObject({
      problem: 'unknown flag --force',
    });
  });
});

describe('resolveSpecPath()', () => {
  it('resolves a bare name under scripts/mutations/ with a .json suffix', () => {
    expect(resolveSpecPath('types-capture')).toMatch(/scripts\/mutations\/types-capture\.json$/);
  });

  it('uses anything with a separator or a .json suffix as the path it is', () => {
    expect(resolveSpecPath('scripts/mutations/types-capture.json')).toMatch(
      /scripts\/mutations\/types-capture\.json$/,
    );
    // Deliberately a path that resolves to nothing: this asserts which string comes out, not that a
    // file is there. Naming a real spec here would rot the moment that spec is renamed, and it would
    // still resolve -- the same silent staleness a file:line citation has.
    expect(resolveSpecPath('elsewhere/another-spec.json')).toMatch(
      /elsewhere\/another-spec\.json$/,
    );
  });
});
