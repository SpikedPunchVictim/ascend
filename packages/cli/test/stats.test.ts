import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

interface Spec {
  readonly name: string;
  readonly properties: readonly Record<string, unknown>[];
}

/** An initialised project with both specs registered and nothing recorded. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-stats-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  for (const spec of [SPEC, BARE] as readonly Spec[]) {
    const file = join(dir, `${spec.name}.json`);
    writeFileSync(file, JSON.stringify(spec));
    expect(asc(['types', 'define', file], dir).status).toBe(0);
  }
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
    const list = rows(asc(['stats', 'finding', '--assoc', '--json'], dir));

    // Three categorical properties -- topic, stage, label -- make C(3,2) = 3 pairs. `body` (text),
    // `at` (timestamp) and `size` (integer) contribute none: a crosstab of `size` against `topic`
    // would have one row per distinct size and report a Cramer's V near 1 that measured nothing.
    expect(list).toHaveLength(3);

    // Pair names are `label/...` and `stage/topic` rather than the order this file declared them in,
    // because `defineType` sorts a spec's properties by canonical name (`core/spec.ts`: "Property
    // order is an authoring artifact, not part of the definition"). The pairs are therefore
    // (label, stage), (label, topic), (stage, topic) -- the upper triangle of the SORTED list.
    const named = list.map((row) => `${String(row['a'])}/${String(row['b'])}`).sort();
    expect(named).toEqual(['label/stage', 'label/topic', 'stage/topic']);
  });

  it('measures exactly one bit between two properties that determine each other', () => {
    const dir = project();
    perfect(dir);
    const list = rows(asc(['stats', 'finding', '--assoc', '--json'], dir));
    // Found by the SET of names rather than by position: which of the two is `a` is decided by the
    // spec's canonical sort, and this test is about the bit between them, not about their order.
    const pair = list.find(
      (row) => [row['a'], row['b']].sort().join() === ['topic', 'stage'].sort().join(),
    );
    expect(pair).toBeDefined();

    // The hand computation above, to the bit.
    expect((pair as Row)['mutual_information_bits']).toBe(1);
    expect((pair as Row)['uncertainty']).toBe(1);
    expect((pair as Row)['n']).toBe(20);
    expect((pair as Row)['excluded']).toBe(0);
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
