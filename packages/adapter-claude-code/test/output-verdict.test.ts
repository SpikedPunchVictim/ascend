import { describe, expect, it } from 'vitest';
import { outputVerdict } from '../src/index.js';

/**
 * The verdict a check's OUTPUT gives, for runs whose exit status is not the check's own
 * (`checkRun(...).exitStatusIsCheck === false`, dogfood/0012).
 *
 * Every fixture line below is copied from a real tool result in the frozen corpus, with paths
 * shortened. The formats are the ones measured in masked check runs (spike/verdict): vitest
 * 1,402, cargo 1,083, tsc 373, align 348, prettier 285, eslint 100, node:test 61. jest, pytest
 * and mocha appeared 0 times, and go printed no failure line at all, so none of them has a
 * parser -- a parser with no real fixture is a guess about someone else's output.
 *
 * THE ASYMMETRY. Output is usually filtered (`| tail`, `| head`, `| grep`), and filtering can
 * remove lines but not invent them. So any failure line proves a failure, while a pass needs an
 * AGGREGATE line -- one that summarizes the whole run. cargo prints one `test result:` per test
 * binary, so `cargo test | head` can show early `ok` lines and cut the `FAILED` that followed:
 * 270 of the 715 ok-only cargo outputs went through head/grep/sed/awk. cargo, tsc and eslint
 * can therefore fail a run but never pass one.
 */

const lines = (...xs: string[]): string => xs.join('\n');

describe('outputVerdict', () => {
  describe('vitest', () => {
    it('passes on an all-passed Test Files summary', () => {
      const out = lines(' Test Files  76 passed (76)', '      Tests  812 passed (812)');
      expect(outputVerdict(out)).toBe('passed');
    });

    it('fails on a summary with any failed file', () => {
      expect(outputVerdict(' Test Files  1 failed | 1 passed (2)')).toBe('failed');
      expect(outputVerdict(' Test Files  1 failed (1)')).toBe('failed');
    });

    it('fails when ANY of several summaries failed, as `pnpm -r test` prints', () => {
      const out = lines(' Test Files  6 passed (6)', ' Test Files  2 failed (2)');
      expect(outputVerdict(out)).toBe('failed');
    });

    it("does not read cargo's `0 failed` as a failure", () => {
      expect(outputVerdict('test result: ok. 4 passed; 0 failed; 0 ignored')).not.toBe('failed');
    });
  });

  describe('cargo: failure only', () => {
    it('fails on any FAILED test result', () => {
      const out = lines(
        'test result: ok. 12 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 0.01s',
        'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 137 filtered out; finished in 0.02s',
      );
      expect(outputVerdict(out)).toBe('failed');
    });

    it('gives NO verdict on ok lines alone: a truncated run looks exactly like this', () => {
      const out =
        'test result: ok. 143 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s';
      expect(outputVerdict(out)).toBeUndefined();
    });
  });

  describe('tsc and eslint: failure only', () => {
    it('fails on a TypeScript error', () => {
      const out =
        "src/x.ts(3,7): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.";
      expect(outputVerdict(out)).toBe('failed');
    });

    it('fails on eslint errors', () => {
      expect(outputVerdict('✖ 2 problems (2 errors, 0 warnings)')).toBe('failed');
    });

    it('gives no verdict on eslint warnings alone, which exit 0', () => {
      expect(outputVerdict('✖ 3 problems (0 errors, 3 warnings)')).toBeUndefined();
    });
  });

  describe('prettier', () => {
    it('passes on the all-files line', () => {
      expect(outputVerdict('All matched files use Prettier code style!')).toBe('passed');
    });

    it('fails on code style issues', () => {
      const out = '[warn] Code style issues found in 2 files. Run Prettier with --write to fix.';
      expect(outputVerdict(out)).toBe('failed');
    });
  });

  describe('align', () => {
    it('passes on a green verdict, provisional or not', () => {
      expect(outputVerdict('verdict: green')).toBe('passed');
      const out = 'verdict: green (provisional — dependencies not fully installed)';
      expect(outputVerdict(out)).toBe('passed');
    });

    it('fails on a red verdict', () => {
      expect(outputVerdict('verdict: red')).toBe('failed');
    });

    it('reads only a verdict at the start of a line, not one quoted in prose', () => {
      expect(outputVerdict('the run said `verdict: red`, but only in dashboards')).toBeUndefined();
    });
  });

  describe('node:test', () => {
    it('passes on `fail 0`, fails on any other count', () => {
      expect(outputVerdict(lines('ℹ tests 61', 'ℹ pass 61', 'ℹ fail 0'))).toBe('passed');
      expect(outputVerdict(lines('ℹ tests 61', 'ℹ pass 60', 'ℹ fail 1'))).toBe('failed');
    });
  });

  describe('across runners', () => {
    it('lets a failure anywhere outweigh a pass elsewhere', () => {
      const out = lines(
        ' Test Files  8 passed (8)',
        'src/a.ts(1,1): error TS2304: Cannot find name',
      );
      expect(outputVerdict(out)).toBe('failed');
    });

    it('gives no verdict on output it does not recognize', () => {
      expect(outputVerdict('(Bash completed with no output)')).toBeUndefined();
      expect(outputVerdict('')).toBeUndefined();
    });
  });
});
