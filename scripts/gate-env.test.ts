import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTROL_ENV, INDEX_ENV, stepEnv } from './gate-env.mjs';
import { TEST_SCOPE_ENV } from './gate-scope.mjs';

/**
 * What the gate hands its steps, held to the same bar as the gate.
 *
 * `scripts/gate.mjs` decides what a RUN does from four `ASCEND_` variables in `process.env`, and the
 * hook that starts it exports two of them. Every process the runner spawns inherits what it was
 * given, so a `pnpm test` started by a pre-push gate ran the runner's own control-flow tests under the
 * gate's own mode -- 14 of those 32 tests failed, every push was blocked, and the two paths anyone had
 * driven (`node scripts/gate.mjs` by hand, `git commit`) set neither variable, which is why it went
 * unseen (`dogfood/0097`).
 *
 * Three layers here, and they fail differently on purpose. The pure layer says what a step is handed.
 * The derivation layer says the list of variables being stripped is COMPLETE -- that a knob added to
 * the runner later cannot leak quietly. And the third drives the real runner and reads the environment
 * a real step received, because a stripped list and a stripped environment are two different claims
 * and only one of them is about behaviour.
 */

const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));

/**
 * Every module that makes up the gate, and therefore every file a control variable could be read in.
 *
 * `gate-env.mjs` is deliberately NOT here: it names all four variables by definition, so reading it
 * would make the check below true by construction rather than by agreement.
 */
const GATE_MODULES = [
  'gate.mjs',
  'gate-scope.mjs',
  'gate-lock.mjs',
  'gate-memo.mjs',
  'gate-log.mjs',
];

/**
 * `source` with its comments removed, so the names collected below are the ones a file READS rather
 * than the ones its prose MENTIONS.
 *
 * A scanner rather than a pattern, because a pattern cannot tell a comment from a string, and this
 * check depends on the difference: `const SCOPE_ENV = 'ASCEND_GATE_SCOPE'` is a name the runner reads
 * one line later, and a stripper that dropped string bodies would lose it and then demand that
 * `CONTROL_ENV` not contain it -- a failure with the sign flipped. So string bodies are kept whole and
 * only comments go.
 *
 * What it does not handle: a regular-expression literal containing a comment opener, or a template
 * literal with a nested backtick. Neither exists in these modules. If one is ever added the failure
 * lands in the test below, which is the direction it has to fail in -- a scanner that silently kept a
 * comment is the one that would let a variable go unstripped.
 *
 * @param source
 * @returns the file as code, with every comment replaced by nothing
 */
function code(source: string): string {
  let out = '';
  let at = 0;
  while (at < source.length) {
    const pair = source.slice(at, at + 2);
    if (pair === '//') {
      while (at < source.length && source.charAt(at) !== '\n') at += 1;
      continue;
    }
    if (pair === '/*') {
      const end = source.indexOf('*/', at + 2);
      at = end === -1 ? source.length : end + 2;
      continue;
    }
    const char = source.charAt(at);
    if (char === '"' || char === "'" || char === '`') {
      let end = at + 1;
      while (end < source.length && source.charAt(end) !== char) {
        if (source.charAt(end) === '\\') end += 1;
        end += 1;
      }
      out += source.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

/** Every `ASCEND_` name appearing in `file`'s code. */
function namesIn(file: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
  return code(source).match(/\bASCEND_[A-Z0-9_]+\b/g) ?? [];
}

/** Every directory this file made, so the suite removes exactly those and nothing else. */
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a `pnpm` that prints the control variables it RECEIVED, a `node` that answers the three steps
 * that would otherwise run against this checkout, and an `align` that answers the full-mode step.
 *
 * The environment is the whole point of the fixture, so the stub prints it rather than the test
 * inferring it: a step's own environment is a fact only the step can report.
 */
function sandbox(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asc-gate-env-'));
  const bin = mkdtempSync(join(tmpdir(), 'asc-gate-env-bin-'));
  made.push(dir, bin);

  const shown = [...CONTROL_ENV, TEST_SCOPE_ENV, ...INDEX_ENV]
    .map((name) => `[${name}=$${name}]`)
    .join(' ');
  const fakePnpm = join(bin, 'pnpm');
  writeFileSync(fakePnpm, `#!/bin/sh\necho "pnpm-stub: $* ${shown}"\nexit 0\n`, 'utf8');
  chmodSync(fakePnpm, 0o755);

  const fakeNode = join(bin, 'node');
  writeFileSync(
    fakeNode,
    '#!/bin/sh\n' +
      'case "$*" in\n' +
      // The two steps that read the index say what they were handed, so the exemption is checked
      // through the real runner and not only in stepEnv's own unit test.
      '  *packages/cli/dist/bin.js*) echo "node-stub: staged [GIT_INDEX_FILE=$GIT_INDEX_FILE]"; exit 0 ;;\n' +
      '  *scripts/gate-duplicate-ids.mjs*) echo "node-stub: duplicate-ids [GIT_INDEX_FILE=$GIT_INDEX_FILE]"; exit 0 ;;\n' +
      '  *scripts/test-baseline.mjs*) exit 0 ;;\n' +
      'esac\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    'utf8',
  );
  chmodSync(fakeNode, 0o755);

  // The run below sets `ASCEND_PRECOMMIT_FULL`, which appends `align check` to the step list. Left
  // missing, that step could not be started and the gate would block -- and the assertions below would
  // then be about a red run instead of about the environment each step was handed.
  const align = join(dir, 'node_modules', '.bin', 'align');
  mkdirSync(dirname(align), { recursive: true });
  writeFileSync(align, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(align, 0o755);

  return { dir, bin };
}

describe('the environment a step is handed', () => {
  it('takes every variable the runner reads back out of it', () => {
    const base: Record<string, string> = { PATH: '/bin', HOME: '/home/x' };
    for (const name of CONTROL_ENV) base[name] = 'set';

    const env = stepEnv(base);
    for (const name of CONTROL_ENV) {
      expect(env[name]).toBeUndefined();
    }
    // Everything else survives. A step run in a different world than the gate would be its own defect,
    // and a strip written as "hand the step nothing" would have this pass and the line above pass too.
    expect(env['PATH']).toBe('/bin');
    expect(env['HOME']).toBe('/home/x');
  });

  it('leaves an environment with none of them in it alone', () => {
    expect(stepEnv({ PATH: '/bin' })).toStrictEqual({ PATH: '/bin' });
  });

  it('takes the index git set for the commit being made back out of it, unless the step means it', () => {
    // A path-limited commit hands the hook a temporary index and points GIT_INDEX_FILE at it. Every
    // `git ls-files` below the gate then enumerates the commit instead of the tree -- four assertions
    // in purity-enforcement.test.ts, measured 2026-10-18 (`asc-09wx.18`, `dogfood/0118`).
    const base = { PATH: '/bin', GIT_INDEX_FILE: '/tmp/partial.idx' };
    expect(stepEnv(base)['GIT_INDEX_FILE']).toBeUndefined();
    // The two steps that read `git ls-files -s` mean the index, and say so.
    expect(stepEnv(base, undefined, INDEX_ENV)['GIT_INDEX_FILE']).toBe('/tmp/partial.idx');
    // A keep list is not a licence to keep something else: it exempts exactly what it names.
    expect(
      stepEnv({ ASCEND_GATE_HOOK: 'pre-push', GIT_INDEX_FILE: '/x' }, undefined, INDEX_ENV),
    ).toStrictEqual({ GIT_INDEX_FILE: '/x' });
  });

  it("keeps a step's own value, because the strip happens first", () => {
    // The order is the assertion. Applied before the step's environment, a strip would delete the one
    // value the step exists to state -- and `TEST_STEP` states exactly this variable to stop
    // `vitest.test-count.ts` overwriting the full-suite scan with a subset.
    expect(stepEnv({ [TEST_SCOPE_ENV]: 'subset' }, { [TEST_SCOPE_ENV]: '' })).toStrictEqual({
      [TEST_SCOPE_ENV]: '',
    });
    // The same door, for the variables above: a step that means one says so, and is obeyed.
    expect(stepEnv({ ASCEND_GATE_SCOPE: 'full' }, { ASCEND_GATE_SCOPE: 'full' })).toStrictEqual({
      ASCEND_GATE_SCOPE: 'full',
    });
  });
});

describe('the list of variables that gets stripped', () => {
  it('reads names from code and not from prose, which is what makes the check below meaningful', () => {
    // Asserted directly, because this is the one part of the derivation that could be quietly wrong in
    // the direction that matters: a scanner that kept comments would make the check below fail loudly,
    // but a scanner that dropped string bodies would make it fail with the sign flipped.
    expect(code('// ASCEND_GATE_IN_A_COMMENT\n')).not.toContain('ASCEND_GATE_IN_A_COMMENT');
    expect(code('/* ASCEND_GATE_IN_A_BLOCK */')).not.toContain('ASCEND_GATE_IN_A_BLOCK');
    expect(code("const A = 'ASCEND_GATE_IN_A_STRING';")).toContain('ASCEND_GATE_IN_A_STRING');
  });

  it('is exactly the set of variables the gate modules read in code', () => {
    const found = new Set(GATE_MODULES.flatMap((file) => namesIn(file)));
    // `ASCEND_TEST_SCOPE` is the one name these modules CARRY rather than read: a step states it and
    // `vitest.test-count.ts` is what reads it. It is named here rather than left out quietly, so that
    // renaming it in `gate-scope.mjs` moves this too -- and so that the exemption is a decision on the
    // record rather than a hole in the check.
    const carried = new Set([TEST_SCOPE_ENV]);

    // A failure here is one of two things, and both are the point of the test. A name on the left and
    // not the right is a knob the runner reads and the strip does not remove, which leaks it into
    // every step the gate spawns -- the defect this module exists for. A name on the right and not the
    // left is an entry that has outlived the read it was added for, which would strip a variable out
    // from under a step that has a use for it.
    expect([...found].sort()).toStrictEqual([...new Set([...CONTROL_ENV, ...carried])].sort());
  });
});

describe('a step, driven through the real runner', () => {
  it('is handed none of the variables the runner reads', () => {
    const { dir, bin } = sandbox();
    // Every one of them at once, which is what `.githooks/pre-push` does with two and what the suites'
    // own fixtures do with the rest. `ASCEND_GATE_NO_RECORD` keeps this run out of the real lock and
    // the real log, the way `gate.test.ts` and `dev-hooks.test.ts` both do.
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      ASCEND_GATE_HOOK: 'pre-push',
      ASCEND_PRECOMMIT_FULL: '1',
      ASCEND_GATE_SCOPE: 'full',
      ASCEND_GATE_NO_RECORD: '1',
      // What a path-limited commit hands the hook. Without the strip, the suite's `git ls-files`
      // enumerators see this index instead of the tree (`dogfood/0118`).
      GIT_INDEX_FILE: '/tmp/partial.idx',
    };

    const result = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env });

    expect(result.status).toBe(0);
    // The runner itself still reads them, and that is what makes this a strip rather than a rename:
    // the run below is a pre-push run taking no cuts, and it says so on its own first line.
    expect(result.stdout).toContain('[pre-push] scope: everything');
    expect(result.stdout).toContain('[pre-push] align check');

    // And every step it spawned was handed an environment with none of them in it. Before the strip,
    // the first line below read `[ASCEND_GATE_HOOK=pre-push] [ASCEND_PRECOMMIT_FULL=1] ...` -- which is
    // how a nested gate came to print `[pre-push]` in the middle of a `[pre-commit]` suite and append
    // an `align check` step nothing had stubbed, for a 127 the runner reported as a blocked push.
    //
    // WRITTEN OUT LITERALLY, not `CONTROL_ENV.map(…)`, and for the reason `gate.test.ts` writes its
    // step labels out: a name that left the list would otherwise leave this assertion with it, and the
    // line would go on passing over an environment it no longer checks. It was measured doing exactly
    // that -- with `'ASCEND_GATE_HOOK'` deleted from `CONTROL_ENV`, this test still passed. So the two
    // layers cover different halves: this one that every variable in the list is stripped, the
    // derivation test above that the list is the right one.
    const blank =
      '[ASCEND_GATE_HOOK=] [ASCEND_GATE_NO_RECORD=] [ASCEND_GATE_SCOPE=] ' +
      '[ASCEND_GATE_STATE_ROOT=] [ASCEND_PRECOMMIT_FULL=]';
    expect(result.stdout).toContain(`pnpm-stub: format:check ${blank} `);
    expect(result.stdout).toContain(`pnpm-stub: test ${blank} `);
    // Not over-broad. `ASCEND_TEST_SCOPE` is not the runner's to remove, and the full-suite step still
    // states it -- this is the other direction of the same fix, and a strip written as "remove every
    // ASCEND_ variable" would pass everything above and fail here.
    // `asc-19x2`: the full-suite step names the word instead of leaving the variable silent.
    expect(result.stdout).toContain(`pnpm-stub: test ${blank} [${TEST_SCOPE_ENV}=full]`);
    // The index variable goes for the suite, where it is the whole defect, and stays for the two
    // steps whose subject IS the index. Both directions, through the real runner.
    expect(result.stdout).toContain(
      `pnpm-stub: test ${blank} [${TEST_SCOPE_ENV}=full] [GIT_INDEX_FILE=]`,
    );
    expect(result.stdout).toContain('node-stub: staged [GIT_INDEX_FILE=/tmp/partial.idx]');
    expect(result.stdout).toContain('node-stub: duplicate-ids [GIT_INDEX_FILE=/tmp/partial.idx]');
  });
});
