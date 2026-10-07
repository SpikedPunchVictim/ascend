import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatten } from './helpers.js';

/**
 * `asc stats`, driven as the real binary against a real store.
 *
 * A subprocess rather than a direct call, for `cli.test.ts`'s reason: what can be wrong here is the
 * flag parser, the mode-exclusivity check, the exit code and oclif's discovery, and a direct call
 * exercises none of them. The cost is that this file needs `dist/`, so it builds in `beforeAll`.
 *
 * **EVERY EXPECTATION IS HAND-DERIVABLE FROM THE FIXTURE, never read back from what the command
 * printed the first time it ran.** The fixtures are built so the right answer can be computed on
 * paper: two equally-sized topics that perfectly predict two stages carry exactly one bit of mutual
 * information; two groups of three documents over disjoint vocabularies are exactly two clusters
 * with a silhouette of exactly 1; entries on 1, 2 and 10 January make exactly ten daily periods.
 * The arithmetic is written out at each assertion. A test that pinned the module's own output would
 * pass just as happily against a wrong one.
 *
 * **What is tested here is the COMMAND, not the statistics.** Each primitive already has its own
 * suite in `packages/analysis/test/`, with published anchors. This file tests the four things only
 * the command can get wrong: which properties are fed to which instrument, which clock a time
 * series is read from, what happens when there is nothing to measure, and whether two modes can be
 * run at once.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

/**
 * The fixture store, built ONCE for this file and copied per test.
 *
 * `project()` used to spawn the binary THREE times for EVERY test -- `init` and one `types define`
 * per spec -- and that was the file's floor, not the tests. Measured 2026-09-28: this file takes
 * 48.22 s and its tests measure roughly 1.5-2 s each, while the same `init`/`types define` sequence
 * replicated outside vitest costs well under a second (the eight-spawn sequence in
 * `annotations.test.ts` measured 1.866 s, asc-37es).
 *
 * Copying is sound because the store is LOCATION-INDEPENDENT, and that was measured rather than
 * assumed -- on the `annotations.test.ts` seed, which is built the same way -- and RE-measured
 * 2026-09-29 against the record tree, because what this paragraph used to cite described the SQLite
 * store the flip retires (`asc-i5tj`): one file, `.ascend/ascend.db`, 200 K, no `-wal`/`-shm`, and
 * `meta` holding `created_by_ascend_version` and `cwd_convention`. A fresh `asc init` now lays
 * out a DIRECTORY: `.gitattributes` (20 bytes), `types/0001.jsonl` (the starter types, 6,952), and
 * the DERIVED `index.db` (200,704 -- the SQLite schema itself, and exactly the file the old 200 K
 * figure described); one `record` adds `entries/decision-<hash>/0001.jsonl` (468). A scan of
 * every one of those files for the seed directory's absolute path returned
 * ZERO hits; and the two `meta` keys are gone with the store, because no corpus line kind carries
 * them. A copy into a different temporary directory therefore says exactly what the original said,
 * views and all -- and so does copying `.ascend/` WHOLE: the index travels with the tree and is
 * still current there, because `treeFingerprint` hashes the record files' RELATIVE paths and never
 * their absolute ones.
 *
 * The fixture is still built by the REAL BINARY rather than through `@ascend/store`, so it keeps
 * producing what `asc init` and `asc types define` actually produce, generated views included.
 *
 * `record()` is deliberately NOT hoisted: it writes each test's OWN entries, so it stays a per-test
 * call. What is NOT changed is the part under test: every assertion below still runs the real binary
 * as a subprocess and still hand-derives its expectations.
 */
let seedDir: string;

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });

  seedDir = mkdtempSync(join(tmpdir(), 'asc-stats-seed-'));
  dirs.push(seedDir);
  expect(asc(['init'], seedDir).status).toBe(0);
  for (const spec of [SPEC, BARE, TIMED, SESSIONS, INDEPENDENT] as readonly Spec[]) {
    const file = join(seedDir, `${spec.name}.json`);
    writeFileSync(file, JSON.stringify(spec));
    expect(asc(['types', 'define', file], seedDir).status).toBe(0);
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

function asc(args: readonly string[], cwd: string, stdin?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  return { status: result.status ?? null, stdout: result.stdout, stderr: result.stderr };
}

type Row = Record<string, unknown>;

/**
 * The `--json` envelope's rows, with a failure surfaced as one rather than parsed as JSON.
 *
 * stderr is NOT asserted empty. Every mode writes what its numbers are worth to stderr -- the
 * family size the q-values were corrected across, the coverage, the warning that a silhouette
 * measures separation and not meaning -- so an empty stderr would be the anomaly. What must never
 * appear is the `Error:` label, and a `JSON.parse` of an error's empty stdout would otherwise fail
 * with a message about the letter `u` rather than about the command.
 */
function rows(run: Run): readonly Row[] {
  expect(flatten(run.stderr)).not.toContain('Error:');
  expect(run.status).toBe(0);
  return (JSON.parse(run.stdout) as { rows: Row[] }).rows;
}

/**
 * Six properties, one of each shape that matters to the routing.
 *
 * `topic`, `stage` and `label` are the categorical surface; `body` is the prose surface; `at` is a
 * clock; `size` is neither. A spec with only the properties a test uses could not catch the defect
 * these tests exist to catch -- feeding a timestamp to a crosstab, or a categorical label to a text
 * instrument -- because there would be nothing in the type to feed wrongly.
 */
const SPEC = {
  name: 'finding',
  properties: [
    { name: 'topic', type: 'enum', enum_values: ['alpha', 'beta'] },
    { name: 'stage', type: 'enum', enum_values: ['early', 'late'] },
    { name: 'label', type: 'string' },
    { name: 'body', type: 'text' },
    { name: 'at', type: 'timestamp' },
    { name: 'size', type: 'integer' },
  ],
};

/** A type with no `text` property and no clock: the corpus a text mode cannot see. */
const BARE = {
  name: 'bare',
  properties: [
    { name: 'topic', type: 'enum', enum_values: ['alpha', 'beta'] },
    { name: 'stage', type: 'enum', enum_values: ['early', 'late'] },
  ],
};

/**
 * The corpus the two controls need, and the one `finding` cannot be.
 *
 * `day` and `weekday` are BOTH `string`, because that is the point of the pair: a weekday and a
 * project name are the same type, so nothing in the store can tell which one came from a timestamp
 * and the CLI has to be TOLD (`--temporal`). `weekday` is a strict function of `day`, which makes
 * `day x weekday` a definitional pair by construction -- the exact shape the tautology check exists
 * to suppress, and the reason this fixture rather than a correlated one is the interesting case.
 */
const TIMED = {
  name: 'timed',
  properties: [
    { name: 'day', type: 'string' },
    { name: 'weekday', type: 'string' },
    { name: 'kind', type: 'string' },
  ],
};

interface Spec {
  readonly name: string;
  readonly properties: readonly Record<string, unknown>[];
}

/**
 * The two corpora the pseudoreplication check needs (asc-qt6r), which no existing fixture is.
 *
 * `session_id` and `occurred_at` are declared `string` rather than the `ref` a derived type
 * declares, because what the check reads is the VALUE: it partitions by whatever `session_id` holds
 * and orders by `occurred_at`, and it cannot see how either column was declared.
 *
 * `sessions` is the corpus that collapses -- `state` holds one value across all six entries of each
 * session, so twelve rows carry two observations -- and `kind` alternates, so it is the same corpus
 * carrying a column that does NOT collapse. One fixture, both verdicts, which is the only way to
 * show the check is reading the column rather than the corpus.
 *
 * `independent` is one entry per session, so no two rows are ever adjacent inside a partition.
 */
const SESSIONS = {
  name: 'sessions',
  properties: [
    { name: 'session_id', type: 'string' },
    { name: 'occurred_at', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'kind', type: 'string' },
  ],
};

const INDEPENDENT = {
  name: 'independent',
  properties: [
    { name: 'session_id', type: 'string' },
    { name: 'occurred_at', type: 'string' },
    { name: 'label', type: 'string' },
    { name: 'kind', type: 'string' },
  ],
};

/**
 * An initialised project with both specs registered and nothing recorded: a copy of the seed above.
 *
 * Its own directory, so a test that writes cannot reach the seed or any other test. That isolation
 * is the reason to copy rather than to share one store, and it is the whole of what this function
 * still does.
 */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-stats-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.ascend'), { recursive: true });
  cpSync(join(seedDir, '.ascend'), join(dir, '.ascend'), {
    recursive: true,
  });
  return dir;
}

/** Record a batch in one call. Twenty-four subprocesses would make this suite minutes long. */
function record(dir: string, type: string, entries: readonly Record<string, unknown>[]): void {
  const document = JSON.stringify(entries.map((properties) => ({ properties })));
  const run = asc(['record', type, '-', '--json'], dir, document);
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
}

describe('asc stats: one mode per run', () => {
  it('refuses two modes rather than picking one', () => {
    const dir = project();
    const run = asc(['stats', 'finding', '--cluster', '--duplicates'], dir);
    // Exit 2 is the usage code: the caller's command line is wrong, not their store.
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--cluster and --duplicates were given together');
    expect(flatten(run.stderr)).toContain('not composable');
    expect(run.stdout).toBe('');
  });

  it('names every mode when none was given', () => {
    const dir = project();
    const run = asc(['stats', 'finding'], dir);
    expect(run.status).toBe(2);
    // All seven, so a caller who guessed at the flag name learns the whole surface from one error
    // rather than from the help of a command they have already failed to run.
    for (const mode of [
      '--assoc',
      '--correlate',
      '--rules',
      '--changepoints',
      '--distinctive',
      '--cluster',
      '--duplicates',
    ]) {
      expect(flatten(run.stderr)).toContain(mode);
    }
  });

  it('refuses a type nobody registered, and names how to list what is', () => {
    const dir = project();
    const run = asc(['stats', 'nope', '--assoc'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("there is no entry type named 'nope'");
    expect(flatten(run.stderr)).toContain('asc types list');
  });

  it('refuses a registered type with no entries rather than reporting an empty analysis', () => {
    const dir = project();
    const run = asc(['stats', 'finding', '--assoc'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'finding' has no entries");
  });

  /**
   * The help has to say these p-values are uncorrected, and a sentence in help text that nothing
   * checks is exactly the kind of claim that drifts away from the behaviour it describes.
   *
   * `asc-0hys` shipped a design-effect correction on `asc explore <type> --cluster`'s Wilson rows
   * and deliberately did NOT reach the chi-square and permutation p-values here: those need a
   * Rao-Scott correction, which adjusts the test statistic and its degrees of freedom rather than
   * scaling N. Correcting one surface and staying silent on the other would leave a reader to assume
   * the flag reached both, so the description names the corrected surface by name.
   */
  it('says in its help that its p-values are not corrected for clustering', () => {
    const run = asc(['stats', '--help'], project());
    expect(run.status).toBe(0);
    expect(flatten(run.stdout)).toContain('NOT corrected for clustering');
    expect(flatten(run.stdout)).toContain('asc explore <type> --cluster');
  });
});

describe('asc stats --assoc', () => {
  /**
   * Ten alpha/early and ten beta/late: `stage` is a function of `topic` and each is an even split.
   *
   * On paper: H(topic) = H(stage) = 1 bit (two equally likely values), and the joint distribution
   * has just two cells of ten, so H(topic, stage) = 1 bit as well. Mutual information is
   * H(A) + H(B) - H(A,B) = 1 + 1 - 1 = 1 bit exactly, and symmetric uncertainty is
   * 2 * 1 / (1 + 1) = 1. Neither number comes from running the command.
   */
  function perfect(dir: string): void {
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push({ topic: 'alpha', stage: 'early', label: 'shared', size: i });
      entries.push({ topic: 'beta', stage: 'late', label: 'shared', size: i });
    }
    record(dir, 'finding', entries);
  }

  it('compares only the `string` and `enum` properties', () => {
    const dir = project();
    perfect(dir);
    const run = asc(['stats', 'finding', '--assoc', '--json'], dir);
    const list = rows(run);

    // Three categorical properties -- topic, stage, label -- make C(3,2) = 3 pairs. `body` (text),
    // `at` (timestamp) and `size` (integer) contribute none: a crosstab of `size` against `topic`
    // would have one row per distinct size and report a Cramer's V near 1 that measured nothing.
    //
    // Counted as REPORTED PLUS DISCLOSED, because this fixture's `stage` is a function of `topic`:
    // since asc-fwpe the pair is suppressed from the table and named on stderr instead, and a test
    // that only counted the table would now read a suppression as a property having gone missing.
    // The claim under test is about which PROPERTIES are compared, so it has to count both.
    const named = list.map((row) => `${String(row['a'])}/${String(row['b'])}`).sort();
    expect(named).toEqual(['label/stage', 'label/topic']);

    // Pair names are `label/...` and `stage/topic` rather than the order this file declared them in,
    // because `defineType` sorts a spec's properties by canonical name (`core/spec.ts`: "Property
    // order is an authoring artifact, not part of the definition"). The pairs are therefore
    // (label, stage), (label, topic), (stage, topic) -- the upper triangle of the SORTED list.
    const disclosed = flatten(run.stderr).match(/stage x topic at [\d.]+/);
    expect(disclosed).not.toBeNull();
    expect(named.length + 1).toBe(3);
  });

  it('suppresses a pair that determines itself, and discloses it by name', () => {
    const dir = project();
    perfect(dir);
    const run = asc(['stats', 'finding', '--assoc', '--json'], dir);
    const list = rows(run);

    // The pair is GONE from the table. This is the whole behaviour: `stage` is a function of `topic`
    // (every alpha is early, every beta is late), so the association is one fact told twice.
    const pair = list.find(
      (row) => [row['a'], row['b']].sort().join() === ['topic', 'stage'].sort().join(),
    );
    expect(pair).toBeUndefined();

    // ...and it is NOT gone from the report. A suppression nobody can see is indistinguishable from
    // a pair the corpus never had, so the line names both properties, the coefficient and the n.
    // The coefficient is exactly 1, hand-derived: each of the two values of `topic` maps to exactly
    // one value of `stage` and back, so knowing either removes ALL of the other's 1 bit.
    const said = flatten(run.stderr);
    expect(said).toContain('SUPPRESSED as DEFINITIONAL');
    expect(said).toContain('stage x topic at 1.000 (n=20)');
  });

  /**
   * The arm that decides what ships. A threshold that suppressed every association would pass the
   * test above perfectly, so a correlated-but-not-definitional pair is fed through the real command
   * and its bit count claimed to the bit.
   *
   * On paper, 10 alpha and 10 beta, each split 7/3 the opposite way: H(topic) = H(outcome) = 1 bit,
   * and MI = 2 * (0.35 log2(0.35/0.25) + 0.15 log2(0.15/0.25)) = 2 * (0.1698994 - 0.1105448)
   * = 0.1187092. That is 0.119 in each direction -- under the 0.5 threshold by a wide margin, which
   * is the assertion that fails if `DEFINITIONAL_AT` is ever set by taste instead of by the measured
   * gap. Neither number comes from running the command.
   */
  it('keeps a correlated pair that does not determine itself', () => {
    const dir = project();
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push({ topic: 'alpha', stage: i < 7 ? 'early' : 'late' });
      entries.push({ topic: 'beta', stage: i < 7 ? 'late' : 'early' });
    }
    record(dir, 'bare', entries);
    const list = rows(asc(['stats', 'bare', '--assoc', '--json'], dir));

    const pair = list.find(
      (row) => [row['a'], row['b']].sort().join() === ['stage', 'topic'].sort().join(),
    ) as Row;
    expect(pair).toBeDefined();
    expect(pair['mutual_information_bits']).toBeCloseTo(0.1187092, 6);
    expect(pair['determinism']).toBeCloseTo(0.1187092, 6);
    expect(pair['n']).toBe(20);
  });

  it('reports the determinism coefficient on every pair it keeps', () => {
    const dir = project();
    perfect(dir);
    const list = rows(asc(['stats', 'finding', '--assoc', '--json'], dir));
    // `definitional` alone would be enough to suppress with and not enough to argue with: a pair at
    // 0.49 and a pair at 0.05 are both "not definitional" and are not remotely the same finding.
    // `label` is constant here, so H = 0 and the ratio is 0/0 -- reported as 0, never NaN.
    for (const row of list) expect(typeof row['determinism']).toBe('number');
    expect(list.map((row) => row['determinism'])).toEqual([0, 0]);
  });

  it('flags a pair below MIN_N as a small group rather than refusing it', () => {
    const dir = project();
    // Ten entries, against a MIN_N of 20 (packages/analysis/src/proportion.ts). An anecdote is
    // still worth looking at; what must not happen is it being quoted as an estimate.
    record(
      dir,
      'finding',
      Array.from({ length: 10 }, (_, i) => ({
        topic: i % 2 === 0 ? 'alpha' : 'beta',
        stage: 'early',
        label: 'shared',
      })),
    );
    const list = rows(asc(['stats', 'finding', '--assoc', '--json'], dir));
    expect(list.every((row) => row['small_group'] === true)).toBe(true);
  });

  it('refuses a type without two categorical properties', () => {
    const dir = project();
    writeFileSync(
      join(dir, 'lonely.json'),
      JSON.stringify({ name: 'lonely', properties: [{ name: 'topic', type: 'string' }] }),
    );
    expect(asc(['types', 'define', join(dir, 'lonely.json')], dir).status).toBe(0);
    record(dir, 'lonely', [{ topic: 'a' }, { topic: 'b' }]);

    const run = asc(['stats', 'lonely', '--assoc'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'lonely' declares 1 categorical property (topic)");
  });
});

/**
 * The two controls on the surface the acceptance criterion's sentence sits in.
 *
 * `asc-jpka` was the same defect one bead over -- a capability met in the analysis layer and unmet
 * on the command that a reader actually runs -- so `asc-fwpe` reached the CLI deliberately rather
 * than shipping the library alone. That bead has now landed: `--permutations N` reaches
 * `permutationNull` from both `--assoc` and `--correlate`, which is why the shuffled control has a
 * describe block of its own below. These tests drive the real binary.
 *
 * THE FIXTURE IS THE CORPUS'S SHAPE, NOT A CONVENIENCE. Four days of unequal size (16, 14, 6, 4)
 * with `weekday` a strict function of `day` is the smallest thing that has both defects at once:
 * `day x weekday` is the tautology, and the uneven days are what a block permutation has to survive.
 * `kind` alternates globally, so it is independent of BOTH the day and the weekday -- every day and
 * every weekday is split evenly, which makes every observed chi-square exactly 0 by hand.
 */
describe('asc stats --assoc, with the tautology and block controls', () => {
  /** The 40-entry fixture above, recorded as `day`, `weekday` and a globally alternating `kind`. */
  function timed(dir: string): void {
    const plan: readonly (readonly [string, string, number])[] = [
      ['D1', 'Thu', 16],
      ['D2', 'Thu', 14],
      ['D3', 'Tue', 6],
      ['D4', 'Wed', 4],
    ];
    const entries: Record<string, unknown>[] = [];
    for (const [day, weekday, count] of plan) {
      for (let i = 0; i < count; i += 1) {
        entries.push({ day, weekday, kind: entries.length % 2 === 0 ? 'a' : 'b' });
      }
    }
    record(dir, 'timed', entries);
  }

  it('suppresses the pair that is one fact twice, and names it', () => {
    const dir = project();
    timed(dir);
    const run = asc(['stats', 'timed', '--assoc', '--json'], dir);
    const list = rows(run);

    // Every DAY maps to exactly one weekday, so knowing the day removes all of the weekday's
    // uncertainty and the coefficient is exactly 1 -- the day IS the weekday, restated. (The
    // reverse is not total here, because D1 and D2 share `Thu`; `determinism` is the stronger of the
    // two directions, which is the one that matters.) The pair is gone from the table.
    const names = list.map((row) => `${String(row['a'])}/${String(row['b'])}`);
    expect(names).not.toContain('day/weekday');

    // ...and named on stderr with its coefficient, so a reader can see what left and why.
    const said = flatten(run.stderr);
    expect(said).toContain('SUPPRESSED as DEFINITIONAL');
    expect(said).toContain('day x weekday at 1.000 (n=40)');
  });

  it('runs the block control on the temporal pairs and leaves the others alone', () => {
    const dir = project();
    timed(dir);
    const run = asc(
      ['stats', 'timed', '--assoc', '--temporal', 'weekday', '--blocks', 'day', '--json'],
      dir,
    );
    const list = rows(run);

    // `kind` alternates globally, so every weekday's `kind` split is even and the observed
    // chi-square is exactly 0 -- and so is every permuted one, because relabelling whole days
    // cannot change a split that is even in every day. p_blocked is therefore 1, which is the
    // finding: the weekday explains nothing that the day structure did not already explain.
    const temporalRow = list.find(
      (row) => String(row['a']) === 'kind' && String(row['b']) === 'weekday',
    );
    expect(temporalRow).toBeDefined();
    expect(temporalRow?.['p_blocked']).toBe(1);

    // THE OTHER ARM. A pair with no temporal column has no block structure to be tested against, and
    // the key is OMITTED rather than set to 0 or undefined -- "no control was run" and "the control
    // found nothing" are different facts and must not serialise alike (`exactOptionalPropertyTypes`).
    const otherRow = list.find((row) => String(row['a']) === 'day' && String(row['b']) === 'kind');
    expect(otherRow).toBeDefined();
    expect('p_blocked' in (otherRow as Row)).toBe(false);

    // The disclosure says what ran, over how many blocks, at how many iterations -- a control whose
    // own parameters are invisible is a number a reader cannot check.
    const said = flatten(run.stderr);
    expect(said).toContain('block control ran');
    expect(said).toContain('4 distinct blocks');
  });

  it('omits p_blocked entirely when no block control was asked for', () => {
    const dir = project();
    timed(dir);
    const list = rows(asc(['stats', 'timed', '--assoc', '--json'], dir));
    // Absent, not `null` and not `0`: a consumer that read a missing control as a zero would be
    // reading "the block structure explains nothing" out of a question nobody asked.
    for (const row of list) expect('p_blocked' in row).toBe(false);
  });

  it('refuses each flag without its partner rather than doing half the job', () => {
    const dir = project();
    timed(dir);

    const noTemporal = asc(['stats', 'timed', '--assoc', '--blocks', 'day'], dir);
    expect(noTemporal.status).toBe(2);
    expect(flatten(noTemporal.stderr)).toContain('--blocks was given without --temporal');

    const noBlocks = asc(['stats', 'timed', '--assoc', '--temporal', 'weekday'], dir);
    expect(noBlocks.status).toBe(2);
    expect(flatten(noBlocks.stderr)).toContain('--temporal was given without --blocks');
  });

  it('refuses a property the type does not declare, naming the ones it does', () => {
    const dir = project();
    timed(dir);
    const run = asc(
      ['stats', 'timed', '--assoc', '--temporal', 'weekday', '--blocks', 'session'],
      dir,
    );
    expect(run.status).toBe(1);
    // BOTH VOCABULARIES, because `--blocks` now takes a derivation as well as a name: the columns
    // `timed` has, and every `<clock>:<bucket>` its clock can produce. The example is spelled with
    // the flag the caller actually passed, so the fix is one substitution away.
    const said = flatten(run.stderr);
    expect(said).toContain("'session' is not a column of 'timed'");
    expect(said).toContain('day, kind, weekday, cwd, branch, repo');
    expect(said).toContain('recorded_at');
    expect(said).toContain('day, week, weekday');
    expect(said).toContain('--blocks recorded_at:weekday');
  });

  it('refuses an entry with no block rather than dropping it or inventing one', () => {
    const dir = project();
    // Four entries with a day and one without. Dropping the fifth would change the corpus being
    // tested; grouping it with another day would invent a block. Both are silent, so it refuses.
    record(dir, 'timed', [
      { day: 'D1', weekday: 'Thu', kind: 'a' },
      { day: 'D1', weekday: 'Thu', kind: 'b' },
      { day: 'D2', weekday: 'Thu', kind: 'a' },
      { day: 'D2', weekday: 'Thu', kind: 'b' },
      { weekday: 'Wed', kind: 'a' },
    ]);
    const run = asc(
      ['stats', 'timed', '--assoc', '--temporal', 'weekday', '--blocks', 'day', '--json'],
      dir,
    );
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("1 of 5 entries have no 'day'");
  });

  it('refuses the two flags with a mode that has no block structure to test against', () => {
    const dir = project();
    timed(dir);
    // A flag honoured by no output is the silently-ignored class this command refuses everywhere
    // else: `--changepoints` would have printed a table that quietly dropped the control.
    const run = asc(
      ['stats', 'timed', '--changepoints', '--temporal', 'weekday', '--blocks', 'day'],
      dir,
    );
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('only `--assoc` runs');
  });

  it('states in its help which question each flag answers', () => {
    const run = asc(['stats', '--help'], project());
    expect(run.status).toBe(0);
    const said = flatten(run.stdout);
    // The two questions are genuinely different and the help has to say so: the q-values ask
    // "could this be chance", the block control asks "is this the block structure instead".
    expect(said).toContain('came from a TIMESTAMP');
    expect(said).toContain('the day each entry belongs to');
    expect(said).toContain('--temporal weekday --blocks day');
  });

  it('runs the shuffled control when asked, and states the floor it can reach', () => {
    const dir = project();
    timed(dir);
    const run = asc(['stats', 'timed', '--assoc', '--permutations', '200', '--json'], dir);
    const list = rows(run);

    // `kind` alternates by global index and every day holds an even number of entries, so every day
    // AND every weekday splits 50/50 -- the observed chi-square is exactly 0 for both surviving
    // pairs. Every shuffle of one column against the other therefore ties it, `pValue` counts all
    // 200 permutations as at-least-as-extreme, and the +1 correction puts the answer at
    // (200+1)/(200+1) = 1 exactly. Neither number comes from running the command.
    expect(list).toHaveLength(2);
    for (const row of list) expect(row['p_permuted']).toBe(1);

    const said = flatten(run.stderr);
    expect(said).toContain('200 iterations');
    // THE FLOOR IS ARITHMETIC AND NOT A CONSTANT: 1/(200+1). A floor that does not move with its own
    // iteration count is the defect `dogfood/0066` records -- the evidence record states "a
    // 5,000-iteration floor of p=0.0025", and 0.0025 is 1/401, because the spike that produced every
    // shuffled p in that table ran 400 iterations. Printing the constant would propagate the error
    // to the surface this bead exists to fix.
    expect(said).toContain('0.004975');
  });

  it('omits p_permuted entirely when the control was not asked for', () => {
    const dir = project();
    timed(dir);
    const list = rows(asc(['stats', 'timed', '--assoc', '--json'], dir));

    // Omitted, never zeroed -- the rule `p_blocked` keeps one column over, and the reason is the
    // same: a p of 0 would say the marginals alone explain nothing, which is the opposite of what
    // "the control did not run" means. The control costs roughly a second per pair per thousand
    // iterations, measured (`spike/jpka-permutation-cost.mjs`), so it is off until asked for.
    for (const row of list) expect('p_permuted' in row).toBe(false);
  });

  it('moves no other number, because the empirical p sits beside the asymptotic one', () => {
    const dir = project();
    timed(dir);
    const plain = rows(asc(['stats', 'timed', '--assoc', '--json'], dir));
    const controlled = rows(
      asc(['stats', 'timed', '--assoc', '--permutations', '200', '--json'], dir),
    );
    const withoutPermuted = (list: readonly Row[]): readonly Row[] =>
      list.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'p_permuted')),
      );

    // `benjaminiHochberg` is fed the ASYMPTOTIC p, so the family size, the q-values, the determinism
    // and the row order are all untouched by this flag -- which is exactly what makes it safe to add
    // to a shipped surface. `asc-h7nq` changed what `--assoc` ranks; `asc-jpka` must not.
    expect(withoutPermuted(controlled)).toEqual(plain);
  });

  it('answers the same way twice, so the number is one a reader can check', () => {
    const dir = project();
    timed(dir);
    const args = ['stats', 'timed', '--assoc', '--permutations', '200', '--json'];
    // The module seeds its generator from `DEFAULT_SEED`, freshly per pair, so the empirical p is a
    // function of the columns and the count alone -- which is also why `spike/jpka-permutation-cost.mjs`
    // reproduces what the command prints from the same two arguments.
    expect(rows(asc(args, dir))).toEqual(rows(asc(args, dir)));
  });

  it('refuses an iteration count it cannot draw', () => {
    const dir = project();
    timed(dir);
    // The same refusal `--limit` and `--min-support` already give, because it is the same parser.
    for (const bad of ['0', 'abc', '1.5']) {
      const run = asc(['stats', 'timed', '--assoc', '--permutations', bad], dir);
      expect(run.status).toBe(2);
      expect(flatten(run.stderr)).toContain('--permutations must be a positive integer');
    }
  });

  it('refuses the flag with a mode that has no shuffled control', () => {
    const dir = project();
    timed(dir);
    // Honoured by no output is the silently-ignored class this command refuses everywhere else:
    // `--rules` would have printed a rule list with no sign that a control had been requested.
    // `--correlate` is NOT in this set -- it runs the same control on its one named pair.
    const run = asc(['stats', 'timed', '--rules', '--permutations', '200'], dir);
    expect(run.status).toBe(2);
    const said = flatten(run.stderr);
    expect(said).toContain('only `--assoc` and `--correlate` run');
  });
});

/**
 * Every mode-specific flag, with the modes it can reach and one value of the wrong type.
 *
 * The value is deliberately MALFORMED for the mode that owns it: `--threshold abc` is refused by
 * `--cluster` with "must be a number between 0 and 1", so a run that answers with the mode refusal
 * instead proves the gate fired before the value was ever parsed. That ordering is the whole
 * finding -- the flag was not merely ignored, it was never read.
 */
const UNREACHABLE: readonly (readonly [string, readonly string[], readonly string[]])[] = [
  ['--threshold', ['abc'], ['assoc', 'correlate', 'rules', 'changepoints', 'distinctive']],
  [
    '--linkage',
    ['single'],
    ['assoc', 'correlate', 'rules', 'changepoints', 'distinctive', 'duplicates'],
  ],
  ['--by', ['kind'], ['assoc', 'correlate', 'rules', 'cluster', 'duplicates']],
  [
    '--at',
    ['nosuchclock'],
    ['assoc', 'correlate', 'rules', 'distinctive', 'cluster', 'duplicates'],
  ],
  ['--period', ['week'], ['assoc', 'correlate', 'rules', 'distinctive', 'cluster', 'duplicates']],
  ['--method', ['cusum'], ['assoc', 'correlate', 'rules', 'distinctive', 'cluster', 'duplicates']],
  [
    '--min-support',
    ['abc'],
    ['assoc', 'correlate', 'changepoints', 'distinctive', 'cluster', 'duplicates'],
  ],
  ['--limit', ['1'], ['correlate']],
];

describe('asc stats refuses a flag the running mode cannot reach', () => {
  /** The 40-entry fixture the block-control tests use: `day`, `weekday` and an alternating `kind`. */
  function timed(dir: string): void {
    const plan: readonly (readonly [string, string, number])[] = [
      ['D1', 'Thu', 16],
      ['D2', 'Thu', 14],
      ['D3', 'Tue', 6],
      ['D4', 'Wed', 4],
    ];
    const entries: Record<string, unknown>[] = [];
    for (const [day, weekday, count] of plan) {
      for (let i = 0; i < count; i += 1) {
        entries.push({ day, weekday, kind: entries.length % 2 === 0 ? 'a' : 'b' });
      }
    }
    record(dir, 'timed', entries);
  }

  it('refuses the eight flags that had no gate, and names the modes that do run them', () => {
    const dir = project();
    timed(dir);
    // `--correlate` is a mode flag AND takes two values, so it cannot be spelled the way the single
    // mode flags are -- naming it bare would leave it with no pair and the command would refuse for
    // the wrong reason, which is exactly the kind of green test this table exists to avoid.
    const modeArgs = (mode: string): readonly string[] =>
      mode === 'correlate' ? ['--correlate', 'day', '--correlate', 'kind'] : [`--${mode}`];
    for (const [flag, value, wrongModes] of UNREACHABLE) {
      for (const mode of wrongModes) {
        const run = asc(['stats', 'timed', ...modeArgs(mode), flag, ...value], dir);
        expect(run.status, `--${mode} ${flag} ${value.join(' ')}`).toBe(2);
        const said = flatten(run.stderr);
        expect(said).toContain(`\`${flag}\``);
        // The refusal names the mode it WAS given, so a caller who typed two flags learns which one
        // is the problem rather than being told a flag is unsupported in general.
        expect(said).toContain(`\`--${mode}\` was given`);
      }
    }
  });

  it('refuses the value before it parses it, which is the difference the gate makes', () => {
    const dir = project();
    timed(dir);
    // `--threshold abc` is refused by its own mode, with its own message, one line down. Reaching
    // that message here would mean the value was parsed -- and on the ungated path it was not even
    // read, which is why `--assoc --threshold abc` exited 0 with a full table.
    const wrongMode = asc(['stats', 'timed', '--assoc', '--threshold', 'abc'], dir);
    expect(wrongMode.status).toBe(2);
    expect(flatten(wrongMode.stderr)).not.toContain('must be a number between 0 and 1');
    expect(flatten(wrongMode.stderr)).toContain('only `--cluster` and `--duplicates` run');

    const rightMode = asc(['stats', 'timed', '--cluster', '--threshold', 'abc'], dir);
    expect(rightMode.status).toBe(2);
    expect(flatten(rightMode.stderr)).toContain('must be a number between 0 and 1');
  });

  it('does not refuse a flag in the mode that runs it', () => {
    const dir = project();
    timed(dir);
    // The load-bearing half. A table that gates every flag everywhere would be a green test suite
    // and an unusable command, so each flag is run in a mode that reaches it and must NOT produce
    // the mode refusal -- whatever else it does.
    const reached: readonly (readonly string[])[] = [
      ['--assoc', '--limit', '1'],
      ['--rules', '--min-support', '1'],
      ['--changepoints', '--at', 'recorded_at'],
      ['--changepoints', '--period', 'week'],
      ['--changepoints', '--method', 'cusum'],
      ['--distinctive', '--by', 'kind'],
      ['--cluster', '--threshold', '0.9'],
      ['--cluster', '--linkage', 'single'],
      ['--duplicates', '--threshold', '0.9'],
      ['--assoc', '--temporal', 'weekday', '--blocks', 'day'],
      ['--correlate', 'day', '--correlate', 'kind', '--permutations', '50'],
      ['--correlate', 'day', '--correlate', 'kind'],
    ];
    for (const args of reached) {
      const run = asc(['stats', 'timed', ...args], dir);
      const said = flatten(run.stderr);
      // The sentinel is the gate's own closing clause and not "was given", which another refusal
      // ("--correlate names ONE pair and was given 1 value(s)") also prints -- a sentinel that
      // matches the wrong message is a test that passes for the wrong reason.
      expect(said, `asc stats timed ${args.join(' ')}`).not.toContain('never reached');
    }
  });

  it('reads an integer the way every other command reads it', () => {
    const dir = project();
    timed(dir);
    // `Number` reads every one of these as an integer -- 16, 1000, 5, 1, 1000 -- and `asc stats`
    // used to accept all five while `asc search --limit 0x10` exited 2. The sibling is the
    // specification, so the last assertion runs it.
    const lax = ['0x10', '1e3', '5.0', '+1', '1_000'];
    for (const value of lax) {
      // `--min-support` is gated to `--rules` and `--permutations` to `--assoc`/`--correlate`, so
      // each flag is driven in a mode that actually reaches its parser -- otherwise the mode gate
      // one level up would answer first and the assertion would pass without testing the parser.
      for (const [mode, flag] of [
        ['--assoc', '--limit'],
        ['--rules', '--limit'],
        ['--assoc', '--permutations'],
        ['--rules', '--min-support'],
      ] as readonly (readonly [string, string])[]) {
        const args = ['stats', 'timed', mode, flag, value];
        const run = asc(args, dir);
        expect(run.status, args.join(' ')).toBe(2);
        expect(flatten(run.stderr)).toContain(`must be a positive integer, and '${value}' is not`);
      }
      const sibling = asc(['search', 'day', '--limit', value], dir);
      expect(sibling.status, `search --limit ${value}`).toBe(2);
      expect(flatten(sibling.stderr), `search --limit ${value}`).toContain('Parsing --limit');
    }
  });

  it('still accepts the integers it always did', () => {
    const dir = project();
    timed(dir);
    // The other half of a tightened parser: `007` is a run of digits and stays legal, so the change
    // cannot be mistaken for "reject anything unusual".
    for (const ok of ['1', '20', '007']) {
      const run = asc(['stats', 'timed', '--assoc', '--limit', ok, '--json'], dir);
      expect(run.status, `--limit ${ok}`).toBe(0);
    }
  });
});

/**
 * The entry's own envelope, named on the surface a reader actually runs.
 *
 * `tool_denial` carries `branch` on all 774 entries of the live store and `--assoc` could not name
 * it, because the family was built from `categoricalProperties(spec)` alone and an envelope field is
 * not a declared property (`dogfood/0064`). The fix is not a schema field: `RecordedEntry` already
 * has the column, so the surface is what has to reach it.
 *
 * **THE FIXTURE VARIES `cwd` RATHER THAN `branch`, AND THAT IS THE ONLY LOCALITY THE BINARY CAN
 * WRITE.** `asc record` reads `cwd` from the process, project-relative (`record.ts:641-647`), so the
 * directory a batch is recorded FROM is the value that lands in the envelope -- `repo`, `git_sha`
 * and `branch` are deliberately not derived there at all (`record.ts:52-54`), and only
 * `asc ingest claude-code` fills those from a transcript. So the spawn directory is the lever, and
 * it exercises the same envelope branch of `valueColumn` that `branch` does on the real corpus.
 */
describe('asc stats --assoc over the entry envelope', () => {
  it('measures a locality column that varies, and suppresses the pair it defines', () => {
    const dir = project();
    // Two working directories, with a `topic` that is a function of which one -- so `cwd x topic`
    // is one fact stated twice, by construction rather than by inspection.
    mkdirSync(join(dir, 'one'), { recursive: true });
    mkdirSync(join(dir, 'two'), { recursive: true });
    record(join(dir, 'one'), 'finding', [
      { topic: 'alpha', stage: 'early', label: 'x' },
      { topic: 'alpha', stage: 'early', label: 'x' },
    ]);
    record(join(dir, 'two'), 'finding', [
      { topic: 'beta', stage: 'late', label: 'y' },
      { topic: 'beta', stage: 'late', label: 'y' },
    ]);

    const run = asc(['stats', 'finding', '--assoc', '--json'], dir);
    const list = rows(run);
    const said = flatten(run.stderr);

    // FOUR columns, by hand: the three declared categoricals (`label`, `stage`, `topic`, in
    // canonical order) plus `cwd`, which differs between `one` and `two`. `repo` and `branch` are
    // null on every entry -- `asc record` derives neither -- so the variance gate leaves them out,
    // and the family is 6 pairs over 4 columns rather than 15 over 6.
    expect(said).toContain('of 4 properties over 4 entries');
    expect(said).toContain('read from the entry ENVELOPE');
    expect(said).toContain('(cwd)');

    // `topic` and `cwd` are total on each other, so the coefficient is exactly 1 in both directions
    // and the pair is the same fact twice. Gone from the table, named on stderr -- in the family's
    // order, which is the declared properties first and the envelope columns after them, so the pair
    // reads `topic x cwd` rather than the other way round.
    expect(list.map((row) => `${String(row['a'])}/${String(row['b'])}`)).not.toContain('topic/cwd');
    expect(said).toContain('topic x cwd at 1.000 (n=4)');
  });

  it('leaves a locality column out of the family when it cannot vary', () => {
    const dir = project();
    // Recorded from the project root, so every entry's `cwd` is `'.'` -- one level, no contrast.
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', label: 'x' },
      { topic: 'beta', stage: 'late', label: 'y' },
    ]);
    const run = asc(['stats', 'finding', '--assoc', '--json'], dir);
    rows(run);

    // THREE, not six, and for the reason `chiSquare` already documents: there is no uncertainty
    // about a variable that does not vary, so a column with one level is not a column of a
    // ranking. The same gate is what keeps `repo` and `branch` out where nothing fills them.
    const said = flatten(run.stderr);
    expect(said).toContain('of 3 properties over 2 entries');
    expect(said).not.toContain('read from the entry ENVELOPE');
  });

  it('honours a locality column named explicitly, even one that cannot vary', () => {
    // The variance gate decides what the family carries BY DEFAULT. Naming one is a request, and a
    // request this command can answer: a crosstab of a constant column is degenerate, which is a
    // result rather than an error. Refusing it would be the tool deciding the question was not
    // worth asking, after the reader had asked it.
    const dir = project();
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', label: 'x' },
      { topic: 'beta', stage: 'late', label: 'y' },
    ]);
    const run = asc(
      ['stats', 'finding', '--correlate', 'topic', '--correlate', 'cwd', '--json'],
      dir,
    );
    const list = rows(run);
    // Both entries carry the same single level, `'.'`, and both rows are still printed with it.
    expect(new Set(list.map((row) => row['b_value']))).toEqual(new Set(['.']));
    expect(list.map((row) => row['a_value'])).toEqual(['alpha', 'beta']);
  });
});

describe('asc stats --temporal, deriving a column from a declared clock', () => {
  /**
   * Four consecutive days of EVEN size on `finding`'s own `at` clock, `topic` alternating globally.
   *
   * Even sizes are what make the block control's answer derivable on paper: `topic` alternates over
   * the whole corpus, so every day splits its topics evenly, and therefore so does every weekday --
   * whatever set of days a permutation hands it. Every observed and every permuted chi-square is
   * exactly 0, so the p-value is exactly 1. 2026-01-05 is a Monday.
   */
  function weekdays(dir: string): void {
    const plan: readonly (readonly [string, number])[] = [
      ['2026-01-05', 6],
      ['2026-01-06', 4],
      ['2026-01-07', 4],
      ['2026-01-08', 2],
    ];
    const entries: Record<string, unknown>[] = [];
    for (const [day, count] of plan) {
      for (let i = 0; i < count; i += 1) {
        entries.push({
          at: `${day}T12:00:00.000Z`,
          topic: entries.length % 2 === 0 ? 'alpha' : 'beta',
          stage: 'early',
          label: 'x',
        });
      }
    }
    record(dir, 'finding', entries);
  }

  it('derives the bucket, ranks it, and runs the block control on it', () => {
    const dir = project();
    weekdays(dir);
    const run = asc(
      ['stats', 'finding', '--assoc', '--temporal', 'at:weekday', '--blocks', 'at:day', '--json'],
      dir,
    );
    const list = rows(run);

    // FOUR columns by hand: the three declared categoricals plus the DERIVED `at:weekday`, under
    // exactly the name the caller typed -- so the warnings below quote a column the reader can
    // recognise instead of a name the command invented.
    expect(flatten(run.stderr)).toContain('of 4 properties over 16 entries');

    const temporalRow = list.find(
      (row) => String(row['a']) === 'topic' && String(row['b']) === 'at:weekday',
    );
    expect(temporalRow).toBeDefined();
    // Every day and every weekday splits its topics exactly evenly, so the observed chi-square is 0
    // and so is every permuted one: the weekday explains nothing the day structure did not already.
    expect(temporalRow?.['p_blocked']).toBe(1);

    // The disclosure names the BLOCK column by its derived name and counts the real blocks -- two
    // numbers a reader can check against the calendar rather than against the command's own output.
    const said = flatten(run.stderr);
    expect(said).toContain("'at:day'");
    expect(said).toContain('4 distinct blocks');
  });

  it('labels the weekday the way the evidence record does', () => {
    const dir = project();
    // `label` holds the weekday NAME as a string, so the derived column can be checked against a
    // DECLARED one rather than against itself -- and the check is real: were `weekdayOf` to spell
    // Monday `Monday`, or read `getUTCDay` with Sunday at 1 instead of 0, the two columns would
    // disagree, the coefficient would be 0, and the pair would NOT be suppressed. The suppression is
    // therefore the assertion, and the coefficient in the message is what makes a failure legible.
    const plan: readonly (readonly [string, string])[] = [
      ['2026-01-05', 'Mon'],
      ['2026-01-06', 'Tue'],
      ['2026-01-07', 'Wed'],
      ['2026-01-08', 'Thu'],
    ];
    const entries: Record<string, unknown>[] = [];
    for (const [day, weekday] of plan) {
      entries.push(
        { at: `${day}T12:00:00.000Z`, topic: 'alpha', stage: 'early', label: weekday },
        { at: `${day}T13:00:00.000Z`, topic: 'beta', stage: 'late', label: weekday },
      );
    }
    record(dir, 'finding', entries);

    const run = asc(
      ['stats', 'finding', '--assoc', '--temporal', 'at:weekday', '--blocks', 'at:day'],
      dir,
    );
    expect(run.status).toBe(0);
    // The labels here are the three-letter ones `EV-patterns`' own table uses, so the CLI and the
    // record name the same bucket -- which is what makes the Amendment's re-run comparable.
    expect(flatten(run.stderr)).toContain('label x at:weekday at 1.000 (n=8)');
  });

  it('refuses a bare clock, naming the bucket to derive from it', () => {
    const dir = project();
    weekdays(dir);
    // The acceptance's exact complaint: a timestamp property is not a column, and the caller who
    // names one has asked a question whose answer is one row per entry. The refusal says which
    // question WAS answerable rather than only that this one is not.
    const run = asc(['stats', 'finding', '--assoc', '--temporal', 'at', '--blocks', 'at:day'], dir);
    expect(run.status).toBe(1);
    const said = flatten(run.stderr);
    expect(said).toContain("'at' is a clock, not a column");
    expect(said).toContain('at:weekday');
  });

  it('refuses a bucket it cannot derive, naming the vocabulary', () => {
    const dir = project();
    weekdays(dir);
    const run = asc(
      ['stats', 'finding', '--assoc', '--temporal', 'at:fortnight', '--blocks', 'at:day'],
      dir,
    );
    expect(run.status).toBe(1);
    const said = flatten(run.stderr);
    expect(said).toContain("'fortnight' is not a bucket");
    expect(said).toContain('day, week, weekday');
  });

  it('refuses a clock the type does not record, naming the ones it does', () => {
    const dir = project();
    weekdays(dir);
    const run = asc(
      ['stats', 'finding', '--assoc', '--temporal', 'nope:day', '--blocks', 'at:day'],
      dir,
    );
    expect(run.status).toBe(1);
    const said = flatten(run.stderr);
    expect(said).toContain("'nope' is not a clock");
    expect(said).toContain('recorded_at, at');
  });

  it('refuses an unknown name, naming both the columns and the derivations', () => {
    const dir = project();
    weekdays(dir);
    // The distinction the acceptance asks for, in one message: this is not "the corpus has no
    // weekday", it is "you named something that is neither a column nor a derivation". Both
    // vocabularies are listed, so the reader can see the derivation they probably meant.
    const run = asc(
      ['stats', 'finding', '--assoc', '--temporal', 'nope', '--blocks', 'at:day'],
      dir,
    );
    expect(run.status).toBe(1);
    const said = flatten(run.stderr);
    expect(said).toContain("'nope' is not a column of 'finding'");
    expect(said).toContain('label, stage, topic, cwd, branch, repo');
    expect(said).toContain('at:weekday');
  });

  it('dates nothing it cannot date, and refuses a block it cannot place', () => {
    const dir = project();
    // One entry with no `at` at all. Dropping it would change the corpus being tested and inventing a
    // day would put it in a block it was never in, so the control refuses -- and the refusal names
    // the DERIVED block column, which is the thing the caller has to fix.
    record(dir, 'finding', [
      { at: '2026-01-05T12:00:00.000Z', topic: 'alpha', stage: 'early', label: 'x' },
      { at: '2026-01-06T12:00:00.000Z', topic: 'beta', stage: 'early', label: 'x' },
      { topic: 'alpha', stage: 'early', label: 'x' },
    ]);
    const run = asc(
      ['stats', 'finding', '--assoc', '--temporal', 'at:weekday', '--blocks', 'at:day'],
      dir,
    );
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("1 of 3 entries have no 'at:day'");
  });
});

describe('asc stats --correlate', () => {
  function twoCells(dir: string): void {
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      entries.push({ topic: 'alpha', stage: 'early' });
      entries.push({ topic: 'beta', stage: 'late' });
    }
    record(dir, 'finding', entries);
  }

  it('prints the combinations that occurred, with both marginals on each row', () => {
    const dir = project();
    twoCells(dir);
    const list = rows(
      asc(['stats', 'finding', '--correlate', 'topic', '--correlate', 'stage', '--json'], dir),
    );

    // The table is 2x2 and only its diagonal was observed, so two rows -- not four. The two empty
    // combinations are observed zeros and are left out; every level is still legible because the
    // marginals travel on the rows where it does appear.
    expect(list).toHaveLength(2);
    expect(
      list.map((row) => [
        row['a_value'],
        row['b_value'],
        row['count'],
        row['a_total'],
        row['b_total'],
      ]),
    ).toEqual([
      ['alpha', 'early', 10, 10, 10],
      ['beta', 'late', 10, 10, 10],
    ]);
  });

  it('refuses one property crosstabbed against itself', () => {
    const dir = project();
    twoCells(dir);
    const run = asc(['stats', 'finding', '--correlate', 'topic', '--correlate', 'topic'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain("--correlate was given 'topic' twice");
  });

  it('refuses a property that is not categorical, and lists the ones that are', () => {
    const dir = project();
    twoCells(dir);
    const run = asc(['stats', 'finding', '--correlate', 'at', '--correlate', 'topic'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'at' is not a `string` or `enum` property");
    // In canonical order, which is the order `asc types show` prints and the order the spec holds.
    expect(flatten(run.stderr)).toContain('label, stage, topic');
  });

  it('refuses one name, because a correlation needs a pair', () => {
    const dir = project();
    twoCells(dir);
    const run = asc(['stats', 'finding', '--correlate', 'topic'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--correlate names ONE pair and was given 1 value(s)');
  });

  it('reports the determinism coefficient, and says when a pair is one fact twice', () => {
    const dir = project();
    twoCells(dir);
    // `twoCells` puts alpha only with early and beta only with late, so each column fixes the other
    // completely and the coefficient is exactly 1 in both directions. `--assoc` suppresses this pair;
    // `--correlate` was asked about these two by name, so it answers and DISCLOSES instead of
    // dropping the answer.
    const defined = asc(['stats', 'finding', '--correlate', 'topic', '--correlate', 'stage'], dir);
    expect(defined.status).toBe(0);
    const said = flatten(defined.stderr);
    expect(said).toContain('determinism 1.000');
    expect(said).toContain('is DEFINITIONAL');
    expect(said).toContain('topic x stage');
  });

  it('leaves an independent pair alone, with its coefficient still printed', () => {
    const dir = project();
    // A 2x2 with one entry in each cell: `topic` is a, b, a, b and `label` is x, x, y, y, so the two
    // are exactly independent and the mutual information is exactly 0 bits by hand.
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', label: 'x' },
      { topic: 'beta', stage: 'early', label: 'x' },
      { topic: 'alpha', stage: 'early', label: 'y' },
      { topic: 'beta', stage: 'early', label: 'y' },
    ]);
    const run = asc(['stats', 'finding', '--correlate', 'topic', '--correlate', 'label'], dir);
    expect(run.status).toBe(0);
    const said = flatten(run.stderr);
    // The COEFFICIENT is printed either way; only the verdict is conditional. A pair at 0.49 and one
    // at 0.05 are both "not definitional", so the number is what a reader argues with.
    expect(said).toContain('determinism 0.000');
    expect(said).not.toContain('DEFINITIONAL');
  });

  it('runs the shuffled control on its one pair, and shows what the control cannot see', () => {
    const dir = project();
    twoCells(dir);

    // Two cells of ten, so the two columns fix each other exactly -- `determinism 1.000`, the pair
    // `--assoc` suppresses. Asked about BY NAME, `--correlate` answers and this is the answer the
    // bead's acceptance is about: the shuffled control returns a p at the floor, i.e. the STRONGEST
    // verdict it can give, for a pair that is not a finding at all. On paper the observed
    // chi-square is exactly n = 20, and reaching it under the null means drawing all ten `alpha`
    // rows as `early`, which happens with probability 2/C(20,10) = 1.08e-5 per shuffle.
    const run = asc(
      ['stats', 'finding', '--correlate', 'topic', '--correlate', 'stage', '--permutations', '200'],
      dir,
    );
    expect(run.status).toBe(0);
    const said = flatten(run.stderr);

    expect(said).toContain('is DEFINITIONAL');
    const empirical = Number(/shuffled p ([\d.]+)/.exec(said)?.[1]);
    expect(Number.isFinite(empirical)).toBe(true);
    // THE LIMITATION, on the surface rather than in a comment: the control catches marginal-driven
    // artifacts and cannot catch a tautology, because a tautology's chi-square is genuinely extreme
    // and shuffling destroys exactly the pairing that makes it so. `--assoc` needs the definitional
    // check for this pair; the shuffled p alone would report it as the strongest thing in the table.
    expect(empirical).toBeLessThan(0.05);
    // The floor, as arithmetic: 1/(200+1).
    expect(said).toContain('0.004975');

    // ...and with no flag there is no such number at all. `--correlate` has ONE pair and still
    // reports determinism, because that is a property of the columns; the empirical p is a property
    // of a control that has to be asked for.
    const plain = flatten(
      asc(['stats', 'finding', '--correlate', 'topic', '--correlate', 'stage'], dir).stderr,
    );
    expect(plain).not.toContain('shuffled p');
    expect(plain).toContain('determinism 1.000');
  });
});

describe('asc stats --changepoints', () => {
  /** Entries at a given ISO time, `count` of them. */
  function at(time: string, count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, () => ({ topic: 'alpha', stage: 'early', at: time }));
  }

  it('reads recorded_at by default, and names the declared clock when that collapses', () => {
    const dir = project();
    // Every entry in one `asc record` call shares one `recorded_at` -- which is exactly what an
    // `asc ingest` run does to a derived type, and why 1,702 of 1,797 entries in this project's own
    // store sit on a single instant (`dogfood/0006`).
    record(dir, 'finding', at('2026-01-01T00:00:00.000Z', 5));
    const run = asc(['stats', 'finding', '--changepoints'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("on the 'recorded_at' clock");
    expect(flatten(run.stderr)).toContain('try `--at at`');
  });

  it('refuses a clock the type does not declare', () => {
    const dir = project();
    record(dir, 'finding', at('2026-01-01T00:00:00.000Z', 5));
    const run = asc(['stats', 'finding', '--changepoints', '--at', 'topic'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'topic' is not a `timestamp` property");
    expect(flatten(run.stderr)).toContain('Available: recorded_at, at');
  });

  it('counts a period with no entries as a zero rather than leaving a gap', () => {
    const dir = project();
    record(dir, 'finding', [
      ...at('2026-01-01T09:00:00.000Z', 3),
      ...at('2026-01-02T09:00:00.000Z', 1),
      ...at('2026-01-10T09:00:00.000Z', 4),
    ]);
    const list = rows(asc(['stats', 'finding', '--changepoints', '--at', 'at', '--json'], dir));
    expect(list).toHaveLength(1);

    // 1 January to 10 January inclusive is ten days. Three of them have entries and seven do not,
    // and those seven are periods of zero -- a fortnight of silence is the shape of break this mode
    // exists to find, and left as absent labels it would be invisible.
    expect((list[0] as Row)['periods']).toBe(10);
    expect((list[0] as Row)['axis']).toBe('at');
  });

  it('counts by week when asked, with Monday as the start of the week', () => {
    const dir = project();
    // 2026-01-05, -12 and -19 are three consecutive Mondays; the 8th falls in the week of the 5th.
    record(dir, 'finding', [
      ...at('2026-01-05T09:00:00.000Z', 2),
      ...at('2026-01-08T09:00:00.000Z', 1),
      ...at('2026-01-12T09:00:00.000Z', 1),
      ...at('2026-01-19T09:00:00.000Z', 1),
    ]);
    const list = rows(
      asc(['stats', 'finding', '--changepoints', '--at', 'at', '--period', 'week', '--json'], dir),
    );
    expect((list[0] as Row)['periods']).toBe(3);
    // Three entries in the first week (two on the 5th, one on the 8th), one in each of the others.
    expect((list[0] as Row)['before_mean']).toBe(3);
  });

  it('puts the break at the last period before a step', () => {
    const dir = project();
    const days: Record<string, unknown>[] = [];
    // Six quiet days of one entry, then six busy days of six. Wherever the p-value lands, the only
    // split a rank test can prefer is the one between 6 January and 7 January.
    for (let day = 1; day <= 6; day += 1)
      days.push(...at(`2026-01-0${String(day)}T09:00:00.000Z`, 1));
    for (let day = 7; day <= 9; day += 1)
      days.push(...at(`2026-01-0${String(day)}T09:00:00.000Z`, 6));
    for (let day = 10; day <= 12; day += 1)
      days.push(...at(`2026-01-${String(day)}T09:00:00.000Z`, 6));
    record(dir, 'finding', days);

    const list = rows(asc(['stats', 'finding', '--changepoints', '--at', 'at', '--json'], dir));
    expect((list[0] as Row)['break_after']).toBe('2026-01-06');
    expect((list[0] as Row)['first_after']).toBe('2026-01-07');
    // One entry a day before, six a day after. Both are counts this test wrote, not outputs it read.
    expect((list[0] as Row)['before_mean']).toBe(1);
    expect((list[0] as Row)['after_mean']).toBe(6);
  });

  it('leaves an entry with no time off the timeline rather than dating it to now', () => {
    const dir = project();
    record(dir, 'finding', [
      ...at('2026-01-01T09:00:00.000Z', 2),
      ...at('2026-01-02T09:00:00.000Z', 2),
      ...at('2026-01-03T09:00:00.000Z', 2),
      { topic: 'alpha', stage: 'early' },
      { topic: 'beta', stage: 'late' },
    ]);
    const run = asc(['stats', 'finding', '--changepoints', '--at', 'at', '--json'], dir);
    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toContain("2 of 8 entries have no 'at'");
    const list = (JSON.parse(run.stdout) as { rows: Row[] }).rows;
    // Three days, not four: the undated pair did not become a period of their own.
    expect((list[0] as Row)['periods']).toBe(3);
  });
});

describe('asc stats: the prose surface', () => {
  it('refuses a text mode on a type that declares no `text` property', () => {
    const dir = project();
    record(dir, 'bare', [
      { topic: 'alpha', stage: 'early' },
      { topic: 'beta', stage: 'late' },
    ]);
    const run = asc(['stats', 'bare', '--duplicates'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'bare' declares no property of type `text`");
    // The refusal is the finding: an empty table would read as "no duplicates", which is a claim
    // about the corpus rather than about the instrument.
    expect(run.stdout).toBe('');
  });

  it('does not read a `string` property, however prose-shaped its values are', () => {
    const dir = project();
    // `label` is identical across all three entries and far longer than `body`. If the prose surface
    // were "every property holding a string", the three would be near-identical documents and
    // collapse into one group even at a high threshold. `body` is what decides, and the three
    // bodies share nothing.
    const shared =
      'this sentence is deliberately long and identical in every entry so that a text ' +
      'instrument reading it would find three documents that are almost entirely the same';
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', label: shared, body: 'kappa agreement raters variance' },
      { topic: 'beta', stage: 'late', label: shared, body: 'sqlite journal wal checkpoint' },
      { topic: 'alpha', stage: 'late', label: shared, body: 'oclif parser argv discovery' },
    ]);
    const list = rows(
      asc(['stats', 'finding', '--duplicates', '--threshold', '0.3', '--json'], dir),
    );
    expect(list).toEqual([]);
  });
});

describe('asc stats --cluster', () => {
  /** Three documents over one vocabulary and three over a disjoint one. */
  function twoTopics(dir: string): void {
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', body: 'aa bb cc dd' },
      { topic: 'alpha', stage: 'early', body: 'aa bb cc dd' },
      { topic: 'alpha', stage: 'early', body: 'aa bb cc dd' },
      { topic: 'beta', stage: 'late', body: 'ww xx yy zz' },
      { topic: 'beta', stage: 'late', body: 'ww xx yy zz' },
      { topic: 'beta', stage: 'late', body: 'ww xx yy zz' },
    ]);
  }

  it('requires a threshold, and says why it ships no default', () => {
    const dir = project();
    twoTopics(dir);
    const run = asc(['stats', 'finding', '--cluster'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('ships no default on purpose');
    expect(flatten(run.stderr)).toContain('flat curve');
  });

  it('separates two disjoint vocabularies exactly', () => {
    const dir = project();
    twoTopics(dir);
    const list = rows(asc(['stats', 'finding', '--cluster', '--threshold', '0.9', '--json'], dir));

    // Two documents sharing no term have a cosine of 0 and therefore a distance of 1, which is
    // above any cut below 1; two identical documents have a distance of 0. So the cut cannot fall
    // anywhere but between the groups, and each member is at distance 0 from its own cluster and 1
    // from the other -- a silhouette of (1 - 0) / max(0, 1) = 1 for every document.
    expect(list).toHaveLength(2);
    expect(list.map((row) => row['size'])).toEqual([3, 3]);
    expect(list.every((row) => row['silhouette'] === 1)).toBe(true);
    // Identical members: every pairwise cosine inside a cluster is 1.
    expect(list.every((row) => row['cohesion'] === 1)).toBe(true);
  });

  it('carries the member ids in --json without putting them in the table', () => {
    const dir = project();
    twoTopics(dir);
    const run = asc(['stats', 'finding', '--cluster', '--threshold', '0.9', '--json'], dir);
    const list = (JSON.parse(run.stdout) as { rows: Row[] }).rows;
    // Three ids per cluster for a script, and no id column for a terminal -- the split `entryRow`
    // makes for `properties`.
    expect((list[0] as Row)['members']).toHaveLength(3);
    const table = asc(['stats', 'finding', '--cluster', '--threshold', '0.9'], dir);
    expect(table.stdout).not.toContain('members');
  });
});

describe('asc stats --duplicates', () => {
  /**
   * Two documents at a Jaccard of exactly 0.8, and one unrelated.
   *
   * The shingles are triples of consecutive tokens. `a b c d e f` gives four: abc, bcd, cde, def.
   * Changing the last token to `g` gives abc, bcd, cdeg-less... -- stated exactly: `a b c d e g`
   * gives abc, bcd, cde, deg. The two sets share abc, bcd and cde and differ in one each, so the
   * union is five and the intersection three: Jaccard 3/5 = 0.6, which is below both thresholds
   * tested here. Extending both to `a b c d e f g h` and `a b c d e f g i` gives six shingles each
   * (abc, bcd, cde, def, efg, fgh / ...fgi), sharing five of a union of seven: 5/7 = 0.714.
   * Lengthening once more to nine tokens gives seven shingles each, sharing six of a union of
   * eight: 6/8 = 0.75. At ten tokens: eight each, seven shared, union nine, 7/9 = 0.777. At eleven:
   * nine each, eight shared, union ten, 8/10 = 0.80 exactly -- the pair used below.
   */
  const ELEVEN = 'aa bb cc dd ee ff gg hh ii jj';
  const A = `${ELEVEN} kk`;
  const B = `${ELEVEN} ll`;

  it('does not merge a pair at 0.80 under the default threshold', () => {
    const dir = project();
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', body: A },
      { topic: 'beta', stage: 'late', body: B },
    ]);
    // The default is 0.9, from EV-20: 0.8 measured a false-merge rate of 0.000930 on the one arm of
    // that record that produced merges to adjudicate, and 0.9 measured 0.000000. A pair sitting
    // exactly at 0.80 is therefore below the cut and must stay apart.
    expect(rows(asc(['stats', 'finding', '--duplicates', '--json'], dir))).toEqual([]);
  });

  it('merges the same pair when the threshold is lowered to 0.8', () => {
    const dir = project();
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', body: A },
      { topic: 'beta', stage: 'late', body: B },
    ]);
    const list = rows(
      asc(['stats', 'finding', '--duplicates', '--threshold', '0.8', '--json'], dir),
    );
    expect(list).toHaveLength(1);
    expect((list[0] as Row)['count']).toBe(2);
    // Eight shingles shared of a union of ten. The arithmetic is in the comment above this suite.
    expect((list[0] as Row)['min_similarity']).toBe(0.8);
    expect((list[0] as Row)['chained']).toBe(false);
  });
});

describe('asc stats --distinctive', () => {
  it('refuses to run without --by, because there is no one-group form', () => {
    const dir = project();
    record(dir, 'finding', [{ topic: 'alpha', stage: 'early', body: 'one two three' }]);
    const run = asc(['stats', 'finding', '--distinctive'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('pass --by <property>');
  });

  it('refuses a single group', () => {
    const dir = project();
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', body: 'one two three' },
      { topic: 'alpha', stage: 'late', body: 'four five six' },
    ]);
    const run = asc(['stats', 'finding', '--distinctive', '--by', 'topic'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'topic' takes 1 value(s)");
  });

  it('reports a term that occurs only in one group', () => {
    const dir = project();
    record(dir, 'finding', [
      { topic: 'alpha', stage: 'early', body: 'shared shared zebra zebra zebra' },
      { topic: 'alpha', stage: 'early', body: 'shared shared zebra zebra zebra' },
      { topic: 'beta', stage: 'late', body: 'shared shared walrus walrus walrus' },
      { topic: 'beta', stage: 'late', body: 'shared shared walrus walrus walrus' },
    ]);
    const list = rows(asc(['stats', 'finding', '--distinctive', '--by', 'topic', '--json'], dir));
    const zebra = list.find((row) => row['group'] === 'alpha' && row['term'] === 'zebra');
    expect(zebra).toBeDefined();
    // Six occurrences in alpha and none elsewhere, across the two alpha documents -- the counts
    // this test wrote into the fixture.
    expect((zebra as Row)['in_group']).toBe(6);
    expect((zebra as Row)['elsewhere']).toBe(0);
    expect((zebra as Row)['documents']).toBe(2);
    // `shared` appears equally in both and cannot distinguish either.
    const shared = list.find((row) => row['term'] === 'shared');
    expect(shared?.['log_odds']).toBe(0);
  });
});

describe('asc stats --rules', () => {
  it('mines name=value items, so two properties cannot share a value', () => {
    const dir = project();
    // Twenty alpha/early and four beta/late. Twenty is exactly MIN_N, the default minimum support,
    // so {topic=alpha, stage=early} is frequent and {topic=beta, stage=late} is not.
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i += 1) entries.push({ topic: 'alpha', stage: 'early' });
    for (let i = 0; i < 4; i += 1) entries.push({ topic: 'beta', stage: 'late' });
    record(dir, 'finding', entries);

    const list = rows(asc(['stats', 'finding', '--rules', '--json'], dir));
    const rule = list.find(
      (row) => row['antecedent'] === 'topic=alpha' && row['consequent'] === 'stage=early',
    );
    expect(rule).toBeDefined();
    // Twenty of the twenty-four entries are alpha, and all twenty of those are early.
    expect((rule as Row)['support']).toBe(20);
    expect((rule as Row)['antecedent_support']).toBe(20);
    expect((rule as Row)['confidence']).toBe(1);
    // The consequent's share of all transactions: 20 of 24.
    expect((rule as Row)['base_rate']).toBe(20 / 24);
  });

  it('honours --min-support, and reports the threshold it used', () => {
    const dir = project();
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i += 1) entries.push({ topic: 'alpha', stage: 'early' });
    record(dir, 'finding', entries);

    // Five entries is below the default minimum support of 20, so nothing is frequent...
    expect(rows(asc(['stats', 'finding', '--rules', '--json'], dir))).toEqual([]);
    // ...and lowering the floor makes the same itemset frequent. Nothing about the data changed.
    const list = rows(asc(['stats', 'finding', '--rules', '--min-support', '5', '--json'], dir));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((row) => row['small_group'] === true)).toBe(true);
  });

  it('refuses a non-integer minimum support', () => {
    const dir = project();
    record(dir, 'finding', [{ topic: 'alpha', stage: 'early' }]);
    const run = asc(['stats', 'finding', '--rules', '--min-support', '2.5'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain("--min-support must be a positive integer, and '2.5'");
  });
});

/**
 * The pseudoreplication check E7's third control requires (asc-qt6r), on the command surface.
 *
 * The check runs UNASKED, so every case here is about what plain `--assoc` says without a flag. The
 * three arms are the three states the corpus can be in: rows that repeat inside a session, rows that
 * do not, and a corpus with no sessions at all -- which is not the same as a clean one.
 */
describe('asc stats --assoc, and the pseudoreplication check', () => {
  /** Two sessions of six. `state` holds one value the whole way through each; `kind` alternates. */
  function sessions(dir: string): void {
    const entries: Record<string, unknown>[] = [];
    for (const [session, state] of [
      ['s1', 'x'],
      ['s2', 'y'],
    ] as const) {
      for (let i = 0; i < 6; i += 1) {
        entries.push({
          session_id: session,
          occurred_at: `2026-09-0${String(1 + i)}T00:00:00Z`,
          state,
          kind: i % 2 === 0 ? 'a' : 'b',
        });
      }
    }
    record(dir, 'sessions', entries);
  }

  it('warns, unasked, that a column repeating within a session is not a sample size', () => {
    const dir = project();
    sessions(dir);
    // No flag: this is the run a caller types by default, and the one the acceptance means by
    // "cannot SILENTLY produce dwell-weighted statistics".
    const said = flatten(asc(['stats', 'sessions', '--assoc', '--json'], dir).stderr);

    expect(said).toContain('STATE-LIKE');
    // Every number the verdict rests on, so a reader can disagree with it rather than take it.
    expect(said).toContain('state (12 rows carry 2 runs, 6.0 rows per run, longest run 6)');
  });

  it('leaves a column that never repeats out of the warning', () => {
    const dir = project();
    sessions(dir);
    const said = flatten(asc(['stats', 'sessions', '--assoc', '--json'], dir).stderr);

    // `kind` alternates within every session, so all 12 rows are their own observation and it is
    // exactly the case the check must not cry wolf on.
    expect(said).not.toContain('kind (');
  });

  it('says nothing about state-likeness when no column collapses at all', () => {
    const dir = project();
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 6; i += 1) {
      // One entry per session, so no two rows can be adjacent inside a partition.
      entries.push({
        session_id: `s${String(i)}`,
        occurred_at: `2026-09-0${String(1 + i)}T00:00:00Z`,
        label: `l${String(i % 2)}`,
        kind: i % 2 === 0 ? 'a' : 'b',
      });
    }
    record(dir, 'independent', entries);
    const said = flatten(asc(['stats', 'independent', '--assoc', '--json'], dir).stderr);

    expect(said).not.toContain('STATE-LIKE');
  });

  it('says the check does not apply, rather than passing in silence, when there are no sessions', () => {
    const dir = project();
    // `bare` declares no `session_id` at all -- the hand-recorded case, where nothing was derived
    // from a session and there is nothing for the check to say.
    record(dir, 'bare', [
      { topic: 'alpha', stage: 'early' },
      { topic: 'beta', stage: 'late' },
      { topic: 'alpha', stage: 'late' },
      { topic: 'beta', stage: 'early' },
    ]);
    const said = flatten(asc(['stats', 'bare', '--assoc', '--json'], dir).stderr);

    // "The check did not apply" and "the check ran and found nothing" are different facts, and a
    // reader who saw neither would have to assume the second.
    expect(said).toContain('does not apply');
    expect(said).toContain('session_id');
    expect(said).not.toContain('STATE-LIKE');
  });
});
