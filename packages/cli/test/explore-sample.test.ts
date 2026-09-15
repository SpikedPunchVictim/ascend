import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc explore --sample` -- the four sampling modes, driven as the real binary.
 *
 * A subprocess, like the other command suites, because what can be wrong here is the flag parser,
 * the exit code, and what reaches stdout -- and `packages/analysis/test/sample.test.ts` and
 * `packages/store/test/signatures.test.ts` already cover the choosing and the projecting on their
 * own. What is left for this file is the part a caller actually meets.
 *
 * **Two things are asserted that the unit suites cannot see.** First, that the REPORT is honest: the
 * strata a sample carries must be the population's every value with the count selected, because a
 * mode whose whole purpose is to beat a uniform draw on coverage has to show the coverage it got.
 * Second, that a refusal and a usage error stay on their own sides of the exit-code contract -- a
 * `--by` the type does not declare is the world saying no (1), and a `--by` that cannot apply to the
 * mode being run is the caller having typed something impossible (2). The two are easy to swap while
 * both messages still read correctly, and a caller scripting against them would notice.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function asc(args: readonly string[], cwd: string, stdin?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stderr with oclif's wrap decoration removed, so a substring assertion means what it reads like. */
function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Stratum {
  readonly state: string;
  readonly value?: string;
  readonly population: number;
  readonly selected: number;
}

interface Envelope {
  readonly rows: readonly { readonly id: string; readonly properties: unknown }[];
  readonly coverage: { shown: number; total: number; has_more: boolean; percent?: number };
  readonly sample?: {
    readonly mode: string;
    readonly by?: string;
    readonly seed?: string;
    readonly strata: readonly Stratum[];
  };
}

const envelope = (stdout: string): Envelope => JSON.parse(stdout) as Envelope;

/** One enum of two values plus one numeric, so a sample has something to stratify by. */
const SPEC = {
  name: 'verification_run',
  properties: [
    { name: 'verdict', type: 'enum', enum_values: ['passed', 'failed', 'timeout'] },
    { name: 'duration_ms', type: 'integer' },
  ],
};

/**
 * A store holding 30 `passed`, 8 `failed` and 1 `timeout` -- a skewed population with a rare value.
 *
 * Built once and shared, because every `asc record` is a process launch and the fixture is
 * thirty-nine of them: rebuilding it per test cost four minutes across this file. Safe to share
 * because nothing below writes to the store -- every test reads a sample out of it -- and because a
 * sampler is a function of the population rather than of a clock, so a second reader cannot
 * invalidate a first.
 */
let fixture: string | undefined;

function project(): string {
  if (fixture !== undefined) return fixture;

  const dir = mkdtempSync(join(tmpdir(), 'asc-sample-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
  expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);

  // One `record` per line, batched through a single stdin-fed call would be faster still, but the
  // store's own `record` command is the thing under test elsewhere and this fixture only needs the
  // rows to exist -- so it uses the CLI's `--prop` path rather than the bulk one.
  const counts: [string, number][] = [
    ['passed', 30],
    ['failed', 8],
    ['timeout', 1],
  ];
  let at = 0;
  for (const [verdict, count] of counts) {
    for (let index = 0; index < count; index += 1) {
      at += 1;
      const run = asc(
        [
          'record',
          SPEC.name,
          '--prop',
          `verdict=${verdict}`,
          '--prop',
          `duration_ms=${String(at)}`,
          '--json',
        ],
        dir,
      );
      expect(run.status).toBe(0);
    }
  }

  fixture = dir;
  return dir;
}

const idsOf = (run: Run): string[] => envelope(run.stdout).rows.map((row) => row.id);

describe('asc explore --sample: the draw', () => {
  it('returns a subset rather than a page, and says what the subset was drawn from', () => {
    const dir = project();

    const run = asc(['explore', SPEC.name, '--sample', 'random', '--limit', '10', '--json'], dir);

    expect(run.status).toBe(0);
    const body = envelope(run.stdout);
    expect(body.rows).toHaveLength(10);
    // A sample is not a window over an ordering, so there is nothing to resume -- and a cursor here
    // would invite a caller to treat forty samples of forty as one sample of sixteen hundred.
    expect('next_cursor' in body).toBe(false);
    expect(body.coverage).toStrictEqual({ shown: 10, total: 39, has_more: false, percent: 25.6 });
    expect(body.sample).toStrictEqual({ mode: 'random', seed: 'ascend', strata: [] });
  });

  /** A sample with no rows is a real answer -- an empty type -- and not an error. */
  it('reports an empty sample on an empty type rather than refusing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-sample-empty-'));
    dirs.push(dir);
    expect(asc(['init'], dir).status).toBe(0);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
    expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--limit', '5', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    const body = envelope(run.stdout);
    expect(body.rows).toStrictEqual([]);
    expect(body.sample?.strata).toStrictEqual([]);
    expect(body.coverage).toStrictEqual({ shown: 0, total: 0, has_more: false });
  });
});

describe('asc explore --sample stratified: every value appears', () => {
  /**
   * The guarantee, on the population where a uniform draw would fail it.
   *
   * One `timeout` in thirty-nine is 2.6%: at a sample of ten its exact quota is a quarter of a row,
   * and a uniform draw of ten leaves it out about three times in four. A reader who never sees it
   * concludes the value does not occur -- which is the specific wrong belief this mode exists to
   * prevent, so it is asserted as an identity rather than as a probability.
   */
  it('includes a value whose proportional share is below one row', () => {
    const dir = project();

    const run = asc(
      [
        'explore',
        SPEC.name,
        '--sample',
        'stratified',
        '--by',
        'verdict',
        '--limit',
        '10',
        '--json',
      ],
      dir,
    );

    expect(run.status).toBe(0);
    const body = envelope(run.stdout);

    expect(body.sample?.strata).toStrictEqual([
      { state: 'measured', value: 'failed', population: 8, selected: 2 },
      { state: 'measured', value: 'passed', population: 30, selected: 7 },
      { state: 'measured', value: 'timeout', population: 1, selected: 1 },
    ]);
    // The allocation is the decision, so the rows must actually be there: a report claiming a
    // stratum it did not draw from would be the most damaging possible output for this mode.
    const held = body.rows.map((row) => (row.properties as { verdict: string }).verdict);
    expect(held.filter((verdict) => verdict === 'timeout')).toHaveLength(1);
    expect(held.filter((verdict) => verdict === 'passed')).toHaveLength(7);
    expect(held.filter((verdict) => verdict === 'failed')).toHaveLength(2);
  });

  /** The one categorical property a type declares is chosen for the caller, so no flag is needed. */
  it('takes the only categorical property on a type that has exactly one', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--limit', '5', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    expect(envelope(run.stdout).sample?.by).toBe('verdict');
  });

  /**
   * A `--by` that names an undeclared property is the WORLD saying no, so it exits 1 rather than 2.
   *
   * The rule `errors.ts` states: 2 is an operand that cannot be READ. This one reads perfectly well
   * -- it is a fine property name -- and the store simply has no such property. Which side of the
   * contract a refusal lands on is the thing a script branches on, and the message is identical
   * under either code, so nothing but an exit-code assertion catches it.
   */
  it('refuses a property the type does not declare, with exit 1', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'nope', '--limit', '5'],
      dir,
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(flatten(run.stderr)).toContain("declares no property named 'nope'");
    // The message names the alternatives, so the fix does not need a second command to find.
    expect(flatten(run.stderr)).toContain('It has: verdict');
  });

  /**
   * A property that exists but is summarised by `range` is a DIFFERENT mistake and gets a different
   * message: pointing its reader at "the type does not declare it" would send them after a typo that
   * is not there.
   */
  it('refuses a declared property that is not categorical, with exit 1', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'duration_ms', '--limit', '5'],
      dir,
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'duration_ms' is a integer property");
    expect(flatten(run.stderr)).toContain('summarised by range');
  });

  /**
   * Several categorical properties and no `--by` is a refusal rather than a guess.
   *
   * Choosing the first would report proportions over a denominator the caller never named, while
   * looking entirely ordinary -- so the command stops and lists what it could have sampled by.
   */
  it('refuses to guess when a type has several categorical properties', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-sample-two-'));
    dirs.push(dir);
    expect(asc(['init'], dir).status).toBe(0);
    const two = {
      name: 'attempt',
      properties: [
        { name: 'outcome', type: 'enum', enum_values: ['ok', 'bad'] },
        { name: 'runner', type: 'enum', enum_values: ['cargo', 'pnpm'] },
      ],
    };
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(two));
    expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);

    const run = asc(['explore', 'attempt', '--sample', 'stratified', '--limit', '5'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('has 2 properties that could be sampled by');
    expect(flatten(run.stderr)).toContain('It has: outcome, runner');
  });
});

describe('asc explore --sample: a definition gap is not a data gap', () => {
  /**
   * An entry whose `verdict` was never measured is its own stratum, not the `passed` one.
   *
   * This is the stratum key's whole reason for encoding the state beside the value. A key built from
   * the value alone would file `not_measured`/absent under the same label as a measured `false` or,
   * as here, quietly drop it into whichever stratum sorted first -- and the result is a proportion
   * over the wrong denominator that looks entirely ordinary. The report is where a reader would see
   * it, so the report is where this is asserted.
   */
  it('reports an unmeasured entry as its own stratum rather than merging it into a measured one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-sample-gap-'));
    dirs.push(dir);
    expect(asc(['init'], dir).status).toBe(0);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
    expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);

    expect(asc(['record', SPEC.name, '--prop', 'verdict=passed', '--json'], dir).status).toBe(0);
    expect(asc(['record', SPEC.name, '--prop', 'verdict=passed', '--json'], dir).status).toBe(0);
    expect(asc(['record', SPEC.name, '--na', 'verdict', '--json'], dir).status).toBe(0);
    expect(asc(['record', SPEC.name, '--na', 'verdict', '--json'], dir).status).toBe(0);

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'verdict', '--limit', '3', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    const strata = envelope(run.stdout).sample?.strata ?? [];

    // Two strata, not one: a measured value and an absent state. The absent one carries no `value`
    // field at all, which is the same omission `TASKS.md` #7 requires of a number that does not
    // exist -- and it is what makes the two distinguishable in the JSON rather than only by `state`.
    expect(strata).toStrictEqual([
      { state: 'measured', value: 'passed', population: 2, selected: 2 },
      { state: 'not_applicable', population: 2, selected: 1 },
    ]);
    // And the table names the absent stratum by its state, since it has no value to name it by.
    const table = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'verdict', '--limit', '3'],
      dir,
    );
    expect(table.stdout).toContain('not_applicable  1 of 2');
  });

  /**
   * The two ABSENT states are two strata, and this is the case that proves the key carries the state.
   *
   * `not_applicable` and `not_measured` both have no value, so a key built from the value alone --
   * which is the obvious way to write it -- gives them the same string and merges them into one
   * stratum. The result is a report saying "two entries did not have this" when one of them had the
   * question asked and answered `not applicable` and the other was never asked at all. That is a
   * definition gap reported as a data gap, which is the specific conflation the store's three-state
   * model exists to prevent -- so it is asserted at the label, where a reader would meet it.
   */
  it('keeps not_applicable and not_measured in separate strata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-sample-two-gaps-'));
    dirs.push(dir);
    expect(asc(['init'], dir).status).toBe(0);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
    expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);

    expect(asc(['record', SPEC.name, '--prop', 'verdict=passed', '--json'], dir).status).toBe(0);
    expect(asc(['record', SPEC.name, '--na', 'verdict', '--json'], dir).status).toBe(0);
    // No `--prop` and no `--na`: the property was never looked at.
    expect(asc(['record', SPEC.name, '-', '--json'], dir, '{}').status).toBe(0);

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'verdict', '--limit', '3', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    const strata = envelope(run.stdout).sample?.strata ?? [];

    expect(strata).toStrictEqual([
      { state: 'measured', value: 'passed', population: 1, selected: 1 },
      { state: 'not_applicable', population: 1, selected: 1 },
      { state: 'not_measured', population: 1, selected: 1 },
    ]);
    // The header's unsampled count is the summary a reader trusts, so it must agree with the rows.
    const table = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'verdict', '--limit', '3'],
      dir,
    );
    expect(table.stdout).toContain('3 strata, 0 unsampled');
  });
});

describe('asc explore --sample: reproducibility, and which modes have a seed', () => {
  it('draws the same sample twice, and a different one for a different seed', () => {
    const dir = project();
    const args = ['explore', SPEC.name, '--sample', 'random', '--limit', '8', '--json'];

    const first = idsOf(asc(args, dir));
    const again = idsOf(asc(args, dir));
    const other = idsOf(asc([...args, '--seed', 'other'], dir));

    expect(again).toStrictEqual(first);
    expect(other).not.toStrictEqual(first);
    // The seed used is reported, so a reader can re-run what produced the sample they are holding.
    expect(envelope(asc(args, dir).stdout).sample?.seed).toBe('ascend');
    expect(envelope(asc([...args, '--seed', 'other'], dir).stdout).sample?.seed).toBe('other');
  });

  /**
   * `diverse` and `outlier` are maximisations, so they take no seed -- and the report says so by
   * omitting the field rather than echoing the default beside them. A `seed` on a deterministic
   * result would claim a parameter that does not apply, and a reader would reasonably conclude the
   * result could have come out differently.
   */
  it('reports no seed for the modes that take none, and is reproducible without one', () => {
    const dir = project();

    for (const mode of ['diverse', 'outlier']) {
      const args = ['explore', SPEC.name, '--sample', mode, '--limit', '8', '--json'];
      const first = asc(args, dir);
      const body = envelope(first.stdout);

      expect(first.status).toBe(0);
      expect(body.sample?.mode).toBe(mode);
      expect('seed' in (body.sample ?? {})).toBe(false);
      expect(idsOf(asc(args, dir))).toStrictEqual(idsOf(first));
    }
  });

  it('refuses --seed on a mode that takes none, with exit 2', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'diverse', '--limit', '5', '--seed', 'x'],
      dir,
    );

    // Exit 2 rather than 1: nothing about the world is wrong, the caller combined two flags that
    // cannot apply together -- and no amount of looking at the store would resolve it.
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--seed does not apply to --sample diverse');
  });
});

describe('asc explore --sample: the flags that cannot be combined', () => {
  /** A page is a stable window a caller resumes; a sample is not, so the two cannot be one call. */
  it.each([
    [['--sample', 'random', '--page'], 'cannot be combined with --page'],
    [['--sample', 'random', '--cursor', 'asc1:x'], 'cannot be combined with --page'],
  ])('refuses %j, with exit 2', (extra, message) => {
    const dir = project();

    const run = asc(['explore', SPEC.name, '--limit', '5', ...extra], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain(message);
  });

  /**
   * `--by` and `--seed` are meaningless without a mode, and a silently ignored flag is worse than a
   * refusal: the caller believes they sampled by something when they paged instead.
   */
  it.each([
    [['--by', 'verdict'], '--by only applies to --sample'],
    [['--seed', 'x'], '--seed only applies to --sample'],
  ])('refuses %j without a sample, with exit 2', (extra, message) => {
    const dir = project();

    const run = asc(['explore', SPEC.name, '--limit', '5', ...extra], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain(message);
  });

  it('refuses a mode that is not one of the four, with exit 2', () => {
    const dir = project();

    const run = asc(['explore', SPEC.name, '--sample', 'bogus', '--limit', '5'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('Expected --sample=bogus to be one of');
    // The four modes are named in the rejection, so the caller does not have to go to --help.
    expect(flatten(run.stderr)).toContain('random, stratified, diverse, outlier');
  });

  it('refuses a sample size below one, with exit 2', () => {
    const dir = project();

    const run = asc(['explore', SPEC.name, '--sample', 'random', '--limit', '0'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('sample size must be at least 1');
  });
});

describe('asc explore --sample: the modes that do not allocate by a property', () => {
  /**
   * Given `--by`, a mode that does not allocate by it still reports what it achieved.
   *
   * `outlier` is the case that earns this: on a skewed corpus the entries least like the rest are
   * precisely the ones NOT holding the majority value, so a reader asking for the tail should be
   * able to see that the majority was left out. A report listing only the strata it drew from would
   * hide the number they came for.
   */
  it('reports the achieved distribution, including strata it took none of', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'outlier', '--by', 'verdict', '--limit', '5', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    const strata = envelope(run.stdout).sample?.strata ?? [];
    const passed = strata.find((stratum) => stratum.value === 'passed');

    // The whole population's stratum list -- all three values, not only the ones selected from.
    expect(strata.map((stratum) => stratum.value)).toStrictEqual(['failed', 'passed', 'timeout']);
    expect(passed?.population).toBe(30);
    expect(passed?.selected).toBeLessThan(30);
    expect(strata.reduce((sum, stratum) => sum + stratum.selected, 0)).toBe(5);
  });

  /**
   * `diverse` without `--by` reads every categorical property, and stops when the value space is
   * exhausted rather than padding to the requested size.
   *
   * One categorical property with three values means at most three rows carry any spread, so a
   * request for eight returns three -- and the coverage line is what says so. Padding would report a
   * diverse sample of eight where the value space had simply run out.
   */
  it('stops early rather than padding when the value space is exhausted', () => {
    const dir = project();

    const run = asc(['explore', SPEC.name, '--sample', 'diverse', '--limit', '8', '--json'], dir);

    expect(run.status).toBe(0);
    const body = envelope(run.stdout);
    expect(body.rows).toHaveLength(3);
    expect(body.coverage).toStrictEqual({ shown: 3, total: 39, has_more: false, percent: 7.7 });
    // No `by`, because none was asked for -- and the strata list is empty rather than invented.
    expect(body.sample).toStrictEqual({ mode: 'diverse', strata: [] });
  });
});

describe('asc explore --sample: every surface the command owes', () => {
  /**
   * The table's sample block, which is the only place a person meets the strata.
   *
   * Asserted as exact lines because the block is the report: a stratum dropped from it is a value a
   * reader is told does not occur, and the `0 unsampled` header is the summary that must agree with
   * the rows beneath it.
   */
  it('prints the strata under the coverage line in the table', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'verdict', '--limit', '10'],
      dir,
    );

    expect(run.status).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines).toContain('showing 10 of 39, 25.6%');
    expect(lines).toContain('stratified, by verdict, seed "ascend": 3 strata, 0 unsampled');
    // Every stratum, ascending by value, with what was taken of what exists.
    expect(lines).toContain('  failed  2 of 8');
    expect(lines).toContain('  passed  7 of 30');
    expect(lines).toContain('  timeout  1 of 1');
  });

  /** CSV carries rows and nothing else -- a footer after the last record is a row with the wrong arity. */
  it('writes no sample block into CSV', () => {
    const dir = project();

    const run = asc(
      ['explore', SPEC.name, '--sample', 'stratified', '--by', 'verdict', '--limit', '3', '--csv'],
      dir,
    );

    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('id,recorded_at,type_version,properties,evidence_text');
    expect(lines).toHaveLength(4);
    expect(run.stdout).not.toContain('strata');
    expect(run.stdout).not.toContain('showing');
  });

  it('supports --help, and lists the four modes with what each is for', () => {
    const dir = project();

    const run = asc(['explore', '--help'], dir);

    expect(run.status).toBe(0);
    const help = flatten(run.stdout);
    expect(help).toContain('--sample');
    // oclif renders a fixed option set pipe-separated, which is also the form the `--sample=bogus`
    // rejection uses -- so the two agree and a caller reading either learns the same four words.
    expect(help).toContain('<options: random|stratified|diverse|outlier>');
    expect(help).toContain('--by');
    expect(help).toContain('--seed');
    // And `--limit` says it governs a sample as well as a page, since it is the sample size.
    expect(help).toContain('Entries per page, or per sample. Default 40.');
  });

  /** `--by` must name the property it applies to, so its help says which mode requires it. */
  it('says in --by help that stratified requires it', () => {
    const dir = project();

    const help = flatten(asc(['explore', '--help'], dir).stdout);

    expect(help).toContain('Required by --sample stratified');
  });
});
