import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatten } from './helpers.js';

/**
 * `asc explore --cluster <column>` -- driven as the real binary against a real store (asc-0hys).
 *
 * A subprocess, for the reason the other `explore` suites give: what can be wrong is the flag
 * parser, the refusals, the exit code and the rendering, and a direct call exercises none of them.
 * `packages/cli/test/explore-cluster.test.ts` covers the CELL-TO-DESIGN mapping as a pure function
 * with hand-derived anchors; this file covers the command a caller actually reaches -- that each of
 * the map's five row families is corrected over ITS OWN denominator, that a narrowing flag narrows
 * the correction too, and that a cluster key the data cannot supply is refused rather than silently
 * uncorrected.
 *
 * **EVERY EXPECTED INTERVAL BELOW WAS DERIVED BY HAND** from the one-way ANOVA estimator
 * (`design-effect.ts`), with the derivation beside the case, so a reader checks the arithmetic rather
 * than the implementation's agreement with itself. Two of them are worth naming here:
 *
 *   - `not_measured` is a CONSTANT OUTCOME -- no entry measured the property -- so both mean squares
 *     are exactly 0 and the ratio is 0/0. The estimator has nothing to say, and the bound is the
 *     only defensible answer: `deff 2.0`, not `deff 1.0`. A zero here would read as "the correction
 *     does not apply" and would be ANTICONSERVATIVE, printing a narrower interval than an
 *     uncorrected one for the same count.
 *   - Three rows come back with NO correction clause at all, because their estimated rho is exactly
 *     0 (the data says the outcome is independent of the session). That is the control arm the whole
 *     file needs: it shows the clause is evidence of a correction rather than decoration stamped on
 *     every row.
 *
 * **A WRONG POPULATION CANNOT PASS THIS FILE SILENTLY.** `wilson` refuses a design whose `n`
 * disagrees with the count it is handed (Stage 2), so a design assembled over the wrong denominator
 * makes the command exit non-zero rather than print a mislabelled interval. That is why one fixture
 * below is built in two versions: an entry recorded BEFORE the property existed is `not_declared`,
 * which makes the type total (7) differ from the declared count (6). If the state rows were built
 * over the total, this file fails loudly.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

/**
 * The fixture store, built ONCE for this file and copied per test.
 *
 * Built by the REAL BINARY, so it keeps producing what `asc init`, `asc types define`, `asc record`
 * and `asc invalidate` produce. Two versions of the type on purpose: `sess` alone first, then
 * `stage` added, so the entry recorded against v1 reads `not_declared` for `stage` -- the one state
 * whose population is the TYPE TOTAL rather than the declared count, and therefore the one that
 * makes a mixed-up denominator visible instead of coincidentally right.
 *
 * The copy is sound for the reason `explore.test.ts` records at length: the store is
 * location-independent, so a copy into a different temporary directory says exactly what the
 * original said. The entries and the two strikes are part of the seed, because every test here reads
 * the same map -- the count is the fixture, not the assertion.
 */
let seedDir: string;

/** The 7 entries, in the order they were recorded: e0 not_declared, e4 not_applicable, the rest measured. */
const IDS: string[] = [];

const V1 = {
  name: 'cluster_probe',
  properties: [{ name: 'sess', type: 'string' }],
};

const V2 = {
  ...V1,
  properties: [...V1.properties, { name: 'stage', type: 'enum', enum_values: ['draft', 'review'] }],
};

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });

  seedDir = mkdtempSync(join(tmpdir(), 'asc-explore-cluster-seed-'));
  dirs.push(seedDir);
  expect(asc(['init'], seedDir).status).toBe(0);

  // v1: `sess` and nothing else, so the first entry has no `stage` KEY at all rather than a blank
  // one -- `not_declared`, the state a later version's property reads as for an earlier entry.
  writeFileSync(join(seedDir, 'v1.json'), JSON.stringify(V1));
  expect(asc(['types', 'define', join(seedDir, 'v1.json')], seedDir).status).toBe(0);
  IDS.push(record(seedDir, ['sess=s2']));

  writeFileSync(join(seedDir, 'v2.json'), JSON.stringify(V2));
  expect(asc(['types', 'define', join(seedDir, 'v2.json')], seedDir).status).toBe(0);

  // Two sessions of two drafts, one session holding a review and a not_applicable. The struck
  // entries are deliberately BOTH in s1: that is what makes the invalidated rows cluster.
  IDS.push(record(seedDir, ['sess=s1', 'stage=draft'])); // e1
  IDS.push(record(seedDir, ['sess=s1', 'stage=draft'])); // e2
  IDS.push(record(seedDir, ['sess=s2', 'stage=review'])); // e3
  IDS.push(recordNotApplicable(seedDir, 's2')); // e4
  IDS.push(record(seedDir, ['sess=s3', 'stage=draft'])); // e5
  IDS.push(record(seedDir, ['sess=s3', 'stage=draft'])); // e6

  for (const index of [1, 2]) {
    const id = IDS[index] as string;
    const run = asc(
      ['invalidate', id, '--label', 'wrong_value', '--reason', 'struck in a test'],
      seedDir,
    );
    expect(run.status, run.stderr).toBe(0);
  }
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

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project holding the seed's type, entries and strikes, and nothing of any other test's. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-explore-cluster-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.ascend'), { recursive: true });
  cpSync(join(seedDir, '.ascend'), join(dir, '.ascend'), { recursive: true });
  return dir;
}

/** Record one entry, assert it landed, and hand back its id. */
function record(dir: string, props: readonly string[]): string {
  const args = ['record', V1.name, ...props.flatMap((prop) => ['--prop', prop]), '--json'];
  const run = asc(args, dir);
  expect(run.status, run.stderr).toBe(0);
  const parsed = JSON.parse(run.stdout) as { rows: { id: string }[] };
  return (parsed.rows[0] as { id: string }).id;
}

/** An entry whose `stage` was explicitly declined -- `not_applicable`, which is not `not_measured`. */
function recordNotApplicable(dir: string, session: string): string {
  const run = asc(['record', V1.name, '--prop', `sess=${session}`, '--na', 'stage', '--json'], dir);
  expect(run.status, run.stderr).toBe(0);
  const parsed = JSON.parse(run.stdout) as { rows: { id: string }[] };
  return (parsed.rows[0] as { id: string }).id;
}

/** One `{field, value}` map row. */
type Row = Record<string, unknown>;

/** The map's rows, keyed by `field`, for the rows that have one. */
function map(rows: readonly Row[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const row of rows) {
    if (typeof row['field'] === 'string') found.set(row['field'], String(row['value']));
  }
  return found;
}

function rows(dir: string, args: readonly string[]): readonly Row[] {
  const run = asc(['explore', V1.name, ...args, '--json'], dir);
  expect(run.status, run.stderr).toBe(0);
  return (JSON.parse(run.stdout) as { rows: Row[] }).rows;
}

/** The design behind a rendered row, for the assertions the rendered string cannot make. */
interface Design {
  readonly n: number;
  readonly clusters: number;
  readonly largestCluster: number;
  readonly rho: number;
  readonly rhoSource: string;
  readonly designEffect: number;
  readonly effectiveN: number;
}

function design(row: Row): Design | undefined {
  const proportion = row['proportion'];
  if (typeof proportion !== 'object' || proportion === null) return undefined;
  const found = (proportion as Record<string, unknown>)['design'];
  return typeof found === 'object' && found !== null ? (found as Design) : undefined;
}

describe('asc explore --cluster: the map is corrected, and says at which n', () => {
  it('corrects every row family over its own denominator and states the effective n', () => {
    // The fixture, in clusters of (s1: 2, s2: 3, s3: 2) -- 7 entries over 3 sessions, with e1 and
    // e2 (both s1) struck.
    const list = map(rows(project(), ['--cluster', 'sess']));

    // INVALIDATED. N=7, k=3, m=(2,3,2), S=2 (both in s1), A = s1^2/m1 = 4/2 = 2.
    //   sizeFactor = sum(m^2)/N = (4+9+4)/7 = 17/7
    //   MSB = (2 - 4/7)/2 = 5/7 ;  MSW = (2 - 2)/4 = 0 ;  m0 = (7 - 17/7)/2 = 16/7
    //   rho = (5/7) / (5/7 + (16/7 - 1)(0)) = 1 ;  deff = 1 + (17/7 - 1) = 17/7 ;  n_eff = 7/(17/7) = 49/17
    expect(list.get('invalidated')).toBe(
      '28.6% (95% CI 4.5-77.1%, n=7, effective n=3 over 3 clusters, deff 2.4)' +
        '  [SMALL GROUP n=3 < 20 -- treat as anecdote, not estimate]',
    );

    // PER LABEL: the same population and therefore the same design, on purpose -- the two rows exist
    // to be compared with each other, so a per-label design over anything else would break exactly
    // that. (49/17 rounds to 3, 17/7 to 2.4.)
    expect(list.get('invalidated.wrong_value')).toBe(list.get('invalidated'));

    // TOP VALUE. The population is the MEASURED entries -- 5 of the 7, since e0 is not_declared and
    // e4 is not_applicable -- clustered (s1: 2, s2: 1, s3: 2), with 4 successes (all the drafts).
    //   A = 4/2 + 0 + 4/2 = 4 ;  sizeFactor = (4+1+4)/5 = 9/5
    //   MSB = (4 - 16/5)/2 = 2/5 ;  MSW = (4 - 4)/3 = 0 ;  rho = 1 ;  deff = 9/5 ;  n_eff = 5/(9/5) = 25/9
    expect(list.get('property.stage.top.draft')).toBe(
      '80.0% (95% CI 27.5-97.7%, n=5, effective n=3 over 3 clusters, deff 1.8)' +
        '  [SMALL GROUP n=3 < 20 -- treat as anecdote, not estimate]',
    );
    expect(list.get('property.stage.top.review')).toContain(
      'n=5, effective n=3 over 3 clusters, deff 1.8',
    );

    // THE CONTROL ARM: without the flag, every byte is what it always was -- the same point estimate
    // and the same n, on an interval that is NARROWER (8.2-64.1 against 4.5-77.1). The difference
    // between those two lines is the entire reason this flag exists, and printing the corrected
    // interval without this control would leave it indistinguishable from a change to the arithmetic.
    const plain = map(rows(project(), []));
    expect(plain.get('invalidated')).toBe(
      '28.6% (95% CI 8.2-64.1%, n=7)  [SMALL GROUP n=7 < 20 -- treat as anecdote, not estimate]',
    );
  });

  it('corrects the state rows over the DECLARED count, not the type total', () => {
    const list = map(rows(project(), ['--cluster', 'sess']));

    // 6 of the 7 entries are at a version that declares `stage` -- e0 predates it and reads
    // `not_declared`. So `measured`, `not_applicable` and `not_measured` all divide by 6 while
    // `not_declared` divides by 7. A design over the wrong one of those numbers is refused by
    // `wilson`, so this assertion is the one that would catch a state loop reading `all`.
    for (const state of ['measured', 'not_applicable', 'not_measured']) {
      expect(list.get(`property.stage.${state}`), state).toContain('n=6');
      expect(list.get(`property.stage.${state}`), state).not.toContain('n=7');
    }
    expect(list.get('property.stage.not_declared')).toContain('n=7');

    // And `not_declared` is a share of the TOTAL: its interval is 1/7, not 1/6.
    expect(list.get('property.stage.not_declared')).toContain('14.3%');
  });

  it('reports a constant outcome at the bound, never as an uncorrected row', () => {
    // `not_measured` is 0 of 6: every observation carries the same value, so S = 0, A = 0, and both
    // mean squares are exactly 0. The ratio is 0/0 and the estimator has nothing to say. The bound
    // is the answer -- and it is the difference between the two lines below, which differ ONLY in
    // the correction: `deff 2.0` at n_eff 3 against the uncorrected 6.
    //
    // The uncorrected line would be `0.0% (95% CI 0.0-39.0%)`, computed at six independent
    // observations that are in fact three sessions' worth. The corrected upper bound is what a
    // reader owes the arithmetic.
    const list = map(rows(project(), ['--cluster', 'sess']));
    expect(list.get('property.stage.not_measured')).toBe(
      '0.0% (95% CI 0.0-56.1%, n=6, effective n=3 over 3 clusters, deff 2.0)' +
        '  [SMALL GROUP n=3 < 20 -- treat as anecdote, not estimate]',
    );
    expect(list.get('property.stage.not_measured')).not.toContain('0.0-39.0%');
  });

  it('leaves a row alone when the estimate says the outcome is independent of the cluster', () => {
    // The other end of the estimator, and the reason the clause means something: for these two rows
    // rho comes out at exactly 0 -- MSB and MSW agree -- so `deff` is 1 and there is nothing to
    // print. `measured` is 5 of 6 over clusters of (2,2,2) with successes (2,1,2):
    //   A = 4/2 + 1/2 + 4/2 = 4.5 ;  MSB = (4.5 - 25/6)/2 = 1/6 ;  MSW = (5 - 4.5)/3 = 1/6
    // Two identical mean squares is a measurement of NO clustering, not a failure to measure one,
    // and the two must not render the same way.
    const list = map(rows(project(), ['--cluster', 'sess']));
    for (const field of ['property.stage.measured', 'property.stage.not_applicable']) {
      expect(list.get(field), field).not.toContain('effective n');
      expect(list.get(field), field).not.toContain('deff');
    }
    expect(list.get('property.stage.measured')).toContain('n=6');

    // The design is still carried on the row -- the clause is a rendering rule, and a caller
    // reading `--json` gets the numbers either way.
    const measured = rows(project(), ['--cluster', 'sess']).find(
      (row) => row['field'] === 'property.stage.measured',
    );
    expect(design(measured as Row)?.designEffect).toBe(1);
    expect(design(measured as Row)?.rhoSource).toBe('estimated');
  });
});

describe('asc explore --cluster: the narrowing flags narrow the correction too', () => {
  it('computes the correction over the FILTERED population, not the type', () => {
    // `stage = 'draft'` selects e1, e2 (s1) and e5, e6 (s3): 4 entries over 2 clusters, and both
    // struck entries are still in it. A correction over the type's 7 entries would be the wrong N
    // for a row that reports 4 -- and `wilson` would refuse it, which is why the count is asserted
    // beside the design.
    const list = map(rows(project(), ['--filter', "stage = 'draft'", '--cluster', 'sess']));
    expect(list.get('count')).toBe('4');
    // m = (2,2), S = 2 (both in s1): A = 4/2 = 2, sizeFactor = 8/4 = 2,
    //   MSB = (2 - 1)/1 = 1 ;  MSW = 0 ;  rho = 1 ;  deff = 2 ;  n_eff = 2 = k.
    expect(list.get('invalidated')).toContain('n=4, effective n=2 over 2 clusters, deff 2.0');
    expect(list.get('property.stage.top.draft')).toContain(
      'n=4, effective n=2 over 2 clusters, deff 2.0',
    );
    // And the unfiltered run is a different correction over the same rows, so this is a narrowing
    // rather than a second spelling of the same design.
    expect(list.get('invalidated')).not.toContain('n=7');
  });

  it('corrects the struck population alone when --struck narrows it', () => {
    // Both struck entries are in s1, so the struck population is ONE cluster of 2: with k = 1 there
    // is no within-cluster degree of freedom and the bound is assumed -- deff = sum(m^2)/N = 4/2 = 2,
    // so two observations are worth ONE. The singular "1 cluster" in the rendering is part of the
    // assertion, because the plural would claim a second cluster that does not exist.
    const list = map(rows(project(), ['--struck', '--cluster', 'sess']));
    expect(list.get('count')).toBe('2');
    expect(list.get('invalidated')).toContain('n=2, effective n=1 over 1 cluster, deff 2.0');
    expect(list.get('invalidated')).not.toContain('clusters');

    const row = rows(project(), ['--struck', '--cluster', 'sess']).find(
      (entry) => entry['field'] === 'invalidated',
    );
    expect(design(row as Row)?.rhoSource).toBe('assumed-perfect');
  });
});

describe('asc explore --cluster: a one-key --group-by cell is corrected through the same design', () => {
  it('carries the design on the cell row and states the effective n in its rendering', () => {
    const cells = rows(project(), ['--group-by', 'stage', '--cluster', 'sess']);
    const draft = cells.find((cell) => cell['stage'] === 'draft') as Row;

    // A group cell is a share of EVERY entry, not of the measured ones -- a group cell can literally
    // BE a state -- so this is the same population and the same design as the `invalidated` row of
    // the unfiltered map: 7 entries over 3, deff 17/7.
    expect(draft['count']).toBe(4);
    expect(String(draft['value'])).toContain('n=7, effective n=3 over 3 clusters, deff 2.4');
    expect(design(draft)?.clusters).toBe(3);
    expect(design(draft)?.effectiveN).toBeCloseTo(49 / 17, 12);

    // The control: without --cluster the cell renders exactly as it always did.
    const plain = rows(project(), ['--group-by', 'stage']).find(
      (cell) => cell['stage'] === 'draft',
    ) as Row;
    expect(String(plain['value'])).not.toContain('effective n');
  });
});

describe('asc explore --cluster: what it refuses', () => {
  it('refuses a column this type does not declare, naming it and listing the ones it has', () => {
    const run = asc(['explore', V1.name, '--cluster', 'nope', '--json'], project());
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'nope' is not a property of 'cluster_probe'");
    expect(flatten(run.stderr)).toContain('Declared properties: sess, stage');
  });

  it('refuses an entry that records no cluster key, naming the property and how many', () => {
    // An entry with no value for the cluster column is in NO cluster, so counting it into any
    // cluster would leave the design's n short of the row's n -- and `wilson` would then refuse with
    // a message about populations rather than about the missing key. Refused up front instead.
    //
    // TWO of this fixture's seven entries have no `stage`: e0 was recorded before the property
    // existed (`not_declared`) and e4 declined it (`not_applicable`). Both are absent from the JSON,
    // which is the point -- a state is not a value -- so the count is a count of entries, and the
    // message says which property they are missing.
    const dir = project();
    const run = asc(['explore', V1.name, '--cluster', 'stage', '--json'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain(
      "--cluster 'stage': 2 of this type's entries do not record a 'stage'",
    );
    expect(flatten(run.stderr)).toContain('belong to no cluster');
  });

  it('refuses the modes that print entries, since they print no proportion to correct', () => {
    // A flag honoured by no output is the silently-ignored class this command refuses everywhere
    // else. Four modes print entries or counts rather than proportions, so all four are refused --
    // and they are refused by naming the mode, so the message says which flag to drop.
    //
    // `--limit` stands in for the paging family, since it implies `--page`; the message names the
    // whole family rather than the one flag that was typed.
    const dir = project();
    const cases: readonly (readonly string[])[] = [
      ['--dump', join(dir, 'out')],
      ['--page'],
      ['--limit', '2'],
      ['--sample=random'],
      ['--group-by', 'stage,sess'],
    ];
    const names = ['--dump', '--page', '--page (or', '--sample', '--group-by with two keys'];
    cases.forEach((args, index) => {
      const run = asc(['explore', V1.name, '--cluster', 'sess', ...args], dir);
      const label = args.join(' ');
      expect(run.status, label).toBe(2);
      expect(flatten(run.stderr), label).toContain('corrects the proportions this command prints');
      expect(flatten(run.stderr), label).toContain(names[index] as string);
    });
  });

  it('leaves --filter and --struck combinable, because both still print proportions', () => {
    // The control arm for the refusals above: the flag composes with the two narrowing flags rather
    // than being refused beside them. `--filter` alone is already covered; the point here is that
    // neither is caught by the inert-mode check.
    const dir = project();
    for (const args of [
      ['--filter', "stage = 'draft'"],
      ['--struck'],
      ['--filter', "stage = 'draft'", '--struck'],
    ]) {
      const run = asc(['explore', V1.name, '--cluster', 'sess', ...args, '--json'], dir);
      expect(run.status, run.stderr).toBe(0);
    }
  });
});
