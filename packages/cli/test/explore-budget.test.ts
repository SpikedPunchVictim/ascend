import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc explore --max-tokens` -- the flag, driven as the real binary.
 *
 * `budget.test.ts` covers the fit as a function. This file covers the thing a caller actually
 * reaches: the flag parser, the three modes that use it, the refusal exit codes, and the one claim
 * the whole feature rests on -- that the number printed on the report is the size of the bytes on
 * stdout, and that those bytes are within the budget.
 *
 * **The oracle here is deliberately a second implementation.** `countCodePoints` in `budget.ts` walks
 * UTF-16 units by hand, because the spread allocates an array the size of an output that can be
 * megabytes and the estimator runs on every step of a binary search. A test that reused that scan
 * would only prove it agrees with itself, so the measurement below is `Array.from(text).length`: the
 * same quantity, computed the obvious way, on small outputs where allocation is free. Two
 * implementations of one invariant, and the invariant is the one that matters.
 *
 * The fixture's row size is set by the length of one text property, so a budget can be chosen that
 * lands between "some rows" and "all rows" without anyone having to predict an exact byte count. The
 * assertions are about RELATIONSHIPS between runs -- reported versus measured, dropped versus the row
 * count delta, the walk's distinct ids versus the store's own count -- rather than about magic
 * numbers, so they say what the feature means and survive a change to the envelope.
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

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * stderr with its wrapping undone, so a substring assertion means what it reads like.
 *
 * No `›` gutter is stripped: ascend renders its own failures and warnings (`errors.ts`), so
 * stderr carries none -- and an assertion here is what fails if one comes back.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const SPEC = {
  name: 'attempt',
  properties: [
    { name: 'outcome', type: 'enum', enum_values: ['ok', 'bad'] },
    { name: 'note', type: 'text' },
  ],
};

/** Characters of filler in each entry's `note`, which is what sets a row's size. */
const NOTE = 120;

function emptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-budget-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
  expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);
  return dir;
}

/**
 * Record `count` entries of a fixed size and return their ids, in the order recorded.
 *
 * `outcome` alternates so the enum has two values, which gives stratified sampling two real strata
 * rather than one catch-all -- the strata sum is only a meaningful check if there is more than one.
 */
function record(dir: string, count: number): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const run = asc(
      [
        'record',
        SPEC.name,
        '--prop',
        `outcome=${i % 2 === 0 ? 'ok' : 'bad'}`,
        '--prop',
        `note=${String(i).padStart(4, '0')}${'n'.repeat(NOTE)}`,
        '--json',
      ],
      dir,
    );
    expect(run.status).toBe(0);
    const recorded = JSON.parse(run.stdout) as { rows: { id: string }[] };
    ids.push((recorded.rows[0] as { id: string }).id);
  }
  return ids;
}

interface Envelope {
  readonly rows: readonly Record<string, unknown>[];
  readonly row_count: number;
  readonly coverage?: { shown: number; total: number; has_more: boolean };
  readonly next_cursor?: string;
  readonly trim?: {
    max_tokens: number;
    estimated_tokens: number;
    dropped: number;
    chars_per_token: number;
    dropped_keys?: readonly string[];
  };
  readonly sample?: { strata: readonly { selected: number }[] };
}

const envelope = (stdout: string): Envelope => JSON.parse(stdout) as Envelope;

/**
 * The size of what was actually written, measured independently.
 *
 * `Array.from` rather than `[...text]`: both iterate the string's code points, and the spread trips
 * `@typescript-eslint/no-misused-spread`, whose point -- that code-point iteration is not
 * grapheme-cluster iteration -- is exactly right in general and exactly wrong here. The shipped
 * estimator counts code points, so a test that counted grapheme clusters would be measuring a
 * different quantity and would disagree with it on any ZWJ sequence. Code points are the unit the
 * ratio was measured in (EV-13), so code points are what this counts.
 *
 * `this.log(text)` appends one newline, so the one terminator is removed before measuring: the
 * report describes the rendering, not the line discipline of the writer.
 */
function measuredTokens(stdout: string): number {
  return Math.ceil(Array.from(stdout.replace(/\n$/, '')).length / 2);
}

/** The one assertion that is the feature: the report is the size of the bytes, inside the budget. */
function expectHonest(run: Run, budget: number): Envelope {
  expect(run.status).toBe(0);
  const parsed = envelope(run.stdout);
  expect(parsed.trim).toBeDefined();
  const measured = measuredTokens(run.stdout);
  expect(parsed.trim?.estimated_tokens).toBe(measured);
  expect(measured).toBeLessThanOrEqual(budget);
  return parsed;
}

/**
 * The measured size of a run under a budget nothing can exceed, so the tight budgets below are
 * derived from this fixture rather than guessed at.
 *
 * **This is a correction, not a convenience.** The first version of this file picked budgets by hand
 * -- 900 tokens for a five-entry page -- on an estimate of how large a row would be. The estimate was
 * wrong: a row of this fixture is about 60 tokens, so the whole nine-row map fits in 589 and every
 * "tight" budget was generous, which is why six assertions failed at once with `expected 0 to be
 * greater than 0` and `expected 4 to be less than 4`. A budget derived from the bytes on screen
 * cannot drift from them when the envelope or the fixture changes.
 *
 * `extra` carries the mode AND the format, because the format changes the size of everything here --
 * a JSON envelope repeats every column name on every row -- and mixing the two is not a small error.
 * A figure measured in one format and passed back in another is refused, which is exactly how this
 * helper came to take the format from its caller.
 */
function fullSize(dir: string, extra: readonly string[]): number {
  const run = asc(['explore', SPEC.name, ...extra, '--max-tokens', '1000000'], dir);
  expect(run.status).toBe(0);
  return measuredTokens(run.stdout);
}

/** The budget a refusal names as the smallest that fits, taken from the refusal itself. */
function namedMinimum(dir: string, extra: readonly string[]): number {
  const refused = asc(['explore', SPEC.name, ...extra, '--max-tokens', '1'], dir);
  expect(refused.status).toBe(2);
  const named = /is about (\d+) tokens/.exec(flatten(refused.stderr))?.[1];
  expect(named).toBeDefined();
  return Number(named);
}

/**
 * A budget that fits part of a mode's output and not all of it: the floor, plus a third of the way
 * to the full size.
 *
 * Derived rather than halved, because the two ends are not proportional. A table's per-output
 * overhead -- the header, the alignment, the coverage line -- is a large share of a small output, so
 * half of a four-row table can be less than one row of it, and a "tight" budget written that way is
 * simply below the floor. The range between the floor and the full size is the only region where a
 * budget both fits something and drops something.
 */
function partialBudget(dir: string, extra: readonly string[]): number {
  const floor = namedMinimum(dir, extra);
  const full = fullSize(dir, extra);
  expect(full).toBeGreaterThan(floor);
  return floor + Math.ceil((full - floor) / 3);
}

describe('asc explore --max-tokens: the flag is discoverable and refuses the impossible', () => {
  it('documents the flag in --help', () => {
    const dir = emptyProject();
    const run = asc(['explore', '--help'], dir);

    expect(run.status).toBe(0);
    // The flag exists to be reached for, so its presence in help is part of the feature rather than
    // a formality: an undocumented budget flag is one nobody sets.
    expect(run.stdout).toContain('--max-tokens');
    expect(flatten(run.stdout)).toContain('context budget');
  });

  it('refuses a budget that is not a positive whole number', () => {
    const dir = emptyProject();
    for (const value of ['0', '-5']) {
      const run = asc(['explore', SPEC.name, `--max-tokens=${value}`], dir);
      expect(run.status).toBe(2);
      expect(flatten(run.stderr)).toContain(`at least 1. Got ${value}`);
    }
  });

  it('refuses --max-tokens with --csv, because a CSV cannot record what it dropped', () => {
    const dir = emptyProject();
    record(dir, 3);
    const run = asc(['explore', SPEC.name, '--page', '--csv', '--max-tokens', '100'], dir);

    // A trimmed CSV is a file whose lost rows are invisible to whoever parses it, which is the one
    // outcome a subset must never have. Exit 2: this is about what the caller asked for.
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(flatten(run.stderr)).toContain('cannot be combined with --csv');
    expect(flatten(run.stderr)).toContain('--json or --table');
  });
});

describe('asc explore --max-tokens: the report is the size of what was written', () => {
  it('reports and honours the budget across a sweep, in every mode', () => {
    const dir = emptyProject();
    record(dir, 6);

    // The sweep is the point rather than a spot check: the fit is a binary search whose steps depend
    // on the row sizes, and a budget that lands near a boundary is where an off-by-one-token report
    // shows up. Every mode is swept because each has its own render -- the map's rows, the page's
    // cursor, the sample's strata. The range is derived from the full size and starts below it, so
    // the sweep crosses the boundary the feature exists for instead of sitting on one side of it.
    for (const mode of [[], ['--page'], ['--sample', 'stratified', '--by', 'outcome']]) {
      const extra = [...mode, '--json'];
      const full = fullSize(dir, extra);
      for (let step = 2; step <= 12; step += 1) {
        const budget = Math.ceil((full * step) / 8);
        const run = asc(['explore', SPEC.name, ...extra, '--max-tokens', String(budget)], dir);
        if (run.status === 2) {
          // Below the floor this mode has, which is a legitimate answer -- and must be the ONLY
          // reason a run in this sweep is refused.
          expect(flatten(run.stderr)).toContain('--max-tokens is too small');
          continue;
        }
        expectHonest(run, budget);
      }
    }
  });

  it('says nothing about a budget when none was set', () => {
    const dir = emptyProject();
    record(dir, 3);

    for (const extra of [[], ['--page'], ['--sample', 'stratified', '--by', 'outcome']]) {
      const run = asc(['explore', SPEC.name, ...extra, '--json'], dir);
      expect(run.status).toBe(0);
      // Absent, not zero: "no budget was in play" and "a budget was honoured in full" are different
      // facts, and a caller has no other way to tell them apart.
      expect(envelope(run.stdout).trim).toBeUndefined();
    }
  });

  it('states the fit in the table, where a person reads it', () => {
    const dir = emptyProject();
    record(dir, 6);

    // Table format -- no `--json` -- because the assertion is about the line a person reads, and
    // that line only exists in the format a person reads.
    const budget = partialBudget(dir, ['--page']);
    const tight = asc(['explore', SPEC.name, '--page', '--max-tokens', String(budget)], dir);
    expect(tight.status).toBe(0);
    // The table has no envelope, so the report is a line of prose -- and it has to name both the
    // count and the ratio, because the ratio is the assumption the number rests on.
    const last = tight.stdout.trimEnd().split('\n').at(-1) ?? '';
    expect(last).toContain(`to fit ${String(budget)} tokens`);
    expect(last).toContain('code points per token');

    const generous = asc(['explore', SPEC.name, '--page', '--max-tokens', '100000'], dir);
    expect(generous.status).toBe(0);
    const generousLast = generous.stdout.trimEnd().split('\n').at(-1) ?? '';
    expect(generousLast).toContain('within 100000 tokens');
    expect(generousLast).not.toContain('dropped');
  });
});

describe('asc explore --max-tokens: what it drops, it says it dropped', () => {
  it('counts the dropped rows and keeps the coverage true of the rows on screen', () => {
    const dir = emptyProject();
    record(dir, 6);

    const full = asc(['explore', SPEC.name, '--page', '--limit', '6', '--json'], dir);
    expect(full.status).toBe(0);
    expect(envelope(full.stdout).rows).toHaveLength(6);

    const extra = ['--page', '--limit', '6', '--json'];
    const budget = partialBudget(dir, extra);
    const tight = asc(['explore', SPEC.name, ...extra, '--max-tokens', String(budget)], dir);
    const parsed = expectHonest(tight, budget);

    expect(parsed.trim?.dropped).toBeGreaterThan(0);
    // The arithmetic a reader can check: what was asked for, minus what arrived.
    expect(parsed.trim?.dropped).toBe(6 - parsed.rows.length);
    // And the coverage must describe the rows that are actually here, not the page that was asked
    // for -- a coverage line counting rows nobody received is the same false green one level up.
    expect(parsed.coverage?.shown).toBe(parsed.rows.length);
    expect(parsed.coverage?.total).toBe(6);
  });

  it('names the map rows it could not afford, because five of them are the map', () => {
    const dir = emptyProject();
    record(dir, 3);

    const extra = ['--json'];
    // The smallest budget that fits anything at all: it keeps the five header rows and drops the
    // rest, which is the widest set of drops this fixture can produce.
    const budget = namedMinimum(dir, extra);
    const run = asc(['explore', SPEC.name, ...extra, '--max-tokens', String(budget)], dir);
    const parsed = expectHonest(run, budget);

    // The first five rows are the type, the count, the property count, the version count and
    // `invalidated` (`asc-k6p.1`: how much of the type has stopped counting, at the same standing
    // as `count` itself). A map that dropped one of those is not a smaller map, so the floor holds
    // -- and this is the test's whole point, unaffected by anything below: `asc-cbk` did not touch
    // what the map IS or how many of its rows are unconditionally kept.
    expect(parsed.rows.map((row) => row['field'])).toStrictEqual([
      'type',
      'count',
      'property_count',
      'version_count',
      'invalidated',
    ]);
    expect(parsed.trim?.dropped).toBeGreaterThan(0);
    // `asc-cbk` gave every property four state rows alongside its own summary row, and `asc-5x7`
    // then gave every `top`-summarised property one row per top value. This fixture's `outcome` is
    // an enum (`summary` = `top`) holding two distinct values across its three records, so it
    // contributes two such rows; `note` is `text` (`cardinality`) and contributes none. So the
    // fixture's two properties, plus its recorded-range pair, its one version and its (empty, so
    // zero-row) invalidated breakdown, now drop 15 rows at the floor: 5 header + 2 recorded_at + 1
    // version + 2*(1 summary + 4 state) + 2 top = 20 rows, minus the 5-row floor. `asc-k6p.1` added
    // one row to BOTH the numerator (the `invalidated` header row) and the floor it is measured
    // against, so the drop count this fixture demonstrates is unchanged from before that bead. That
    // is past `MAX_NAMED_DROPS`
    // (8, `budget.ts`), where the cap stops naming individual rows because the names would cost more
    // of the budget than the drop just saved. Below the cap, `dropped_keys` is undefined rather than
    // an empty array (`budget.ts`'s `dropped_keys.length < dropped` signal), and that is itself the
    // fact worth pinning here: this fixture used to demonstrate the NAMED side of that cap, and
    // `asc-cbk`'s added rows moved it to the other side. The cap's behaviour on both sides is
    // already pinned independently of any fixture in `budget.test.ts`, so this test's job is only
    // the floor's identity, asserted above -- not which side of the naming cap a particular type
    // profile happens to land on.
    expect(parsed.trim?.dropped).toBe(15);
    expect(parsed.trim?.dropped_keys).toBeUndefined();
  });

  it('keeps the sample report true when a tight budget re-draws the sample', () => {
    const dir = emptyProject();
    record(dir, 8);

    const extra = ['--sample', 'stratified', '--by', 'outcome', '--limit', '8', '--json'];
    const budget = partialBudget(dir, extra);
    const run = asc(['explore', SPEC.name, ...extra, '--max-tokens', String(budget)], dir);
    const parsed = expectHonest(run, budget);

    // The strata are recomputed for the smaller draw rather than sliced from the larger one, so the
    // report describes the rows on stdout. Slicing would leave the per-stratum counts describing a
    // sample that was never emitted -- a report true of nothing.
    const selected = parsed.sample?.strata.reduce((sum, stratum) => sum + stratum.selected, 0);
    expect(selected).toBe(parsed.rows.length);
    expect(parsed.trim?.dropped).toBeGreaterThan(0);
  });
});

describe('asc explore --max-tokens: a trimmed page leaves no hole', () => {
  /**
   * The failure this is here for is silent and it is the worst one available to this feature.
   *
   * Slicing a page down and printing the page's ORIGINAL cursor tells the caller to resume past the
   * rows that were cut, so those rows are shown to nobody -- a hole in the middle of a corpus, in
   * the one output whose contract is that it reports what it did not show. The store computes the
   * cursor for the boundary actually on screen instead, and the only way to see the difference is to
   * walk the whole type through budgeted pages and count what comes back.
   */
  it('walks every entry exactly once through pages too small for the limit', () => {
    const dir = emptyProject();
    const ids = record(dir, 12);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    // A budget that fits one or two of the four rows, so each page is genuinely below the limit --
    // the only condition under which a wrong cursor can skip anything.
    const extra = ['--page', '--limit', '4', '--json'];
    const budget = String(partialBudget(dir, extra));

    do {
      const args = ['explore', SPEC.name, ...extra, '--max-tokens', budget];
      if (cursor !== undefined) args.push('--cursor', cursor);
      const run = asc(args, dir);
      const parsed = expectHonest(run, Number(budget));

      // Each page is trimmed below its limit, which is what makes this a walk over the trimmed path
      // rather than a walk over `--limit 4` with a budget along for the ride.
      expect(parsed.rows.length).toBeLessThan(4);

      for (const row of parsed.rows) seen.push(String(row['id']));
      cursor = parsed.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(30);
    } while (cursor !== undefined);

    // Every entry, exactly once: no hole and no repeat. Compared against the ids the store handed
    // back at record time rather than against a count, so a page that returned one row twice cannot
    // pass by arithmetic.
    expect(seen).toHaveLength(ids.length);
    expect([...seen].sort()).toStrictEqual([...ids].sort());
  });
});

describe('asc explore --max-tokens: a budget it cannot meet is refused, and the fix works', () => {
  /**
   * The refusal has to be actionable, and "actionable" is a claim that can be tested rather than
   * asserted: the number in the message is the smallest budget at which the smallest output fits, so
   * passing it back must succeed.
   *
   * **That was false when this feature was written, and it is why this test exists.** The message
   * named the floor's size as measured at the caller's budget, but the report contains the budget --
   * so a bigger number is a wider report, and raising the flag to the figure the message named was
   * refused again by the message that named it. The figure is now the fixed point of "the smallest
   * budget at which this output fits", which is what makes the promise true.
   */
  it('names a minimum that is accepted when passed back, in every mode', () => {
    const dir = emptyProject();
    record(dir, 5);

    for (const mode of [[], ['--page'], ['--sample', 'stratified', '--by', 'outcome']]) {
      for (const format of [['--json'], []]) {
        const extra = [...mode, ...format];
        const refused = asc(['explore', SPEC.name, ...extra, '--max-tokens', '1'], dir);
        expect(refused.status).toBe(2);
        // A refusal writes nothing to stdout: a caller piping this must not receive a partial answer
        // alongside the error that says there is none.
        expect(refused.stdout).toBe('');
        expect(flatten(refused.stderr)).toContain('--max-tokens is too small for this output');
        expect(flatten(refused.stderr)).toContain('Raise --max-tokens to at least');
        // And it says which output the figure is the size OF, because the answer is not the same in
        // every format -- switching format after reading the number gets a second refusal otherwise.
        expect(flatten(refused.stderr)).toContain('in this output format');

        // The promise, kept or broken: set the flag to exactly what the refusal told you to.
        const named = namedMinimum(dir, extra);
        const accepted = asc(['explore', SPEC.name, ...extra, '--max-tokens', String(named)], dir);
        expect(accepted.status).toBe(0);
        // The table has no envelope to read, so the honest-report check runs on the JSON arm only.
        if (format.length > 0) {
          expectHonest(accepted, named);
          // And it fits because it kept the floor, not because it emitted almost nothing.
          expect(envelope(accepted.stdout).rows.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps the floor rather than dropping into an answer that is not the question', () => {
    const dir = emptyProject();
    record(dir, 5);

    const extra = ['--json'];
    const whole = asc(['explore', SPEC.name, ...extra], dir);
    expect(whole.status).toBe(0);
    const allRows = envelope(whole.stdout).rows.length;
    expect(allRows).toBeGreaterThan(5);

    // The smallest budget that fits anything: it must keep the five header rows (`asc-k6p.1` added
    // `invalidated` to the type, the count, the property count and the version count) and stop
    // there. A fit without a floor would go on down to one property row, which is not a smaller map
    // -- it is a property with no type name, no count and no denominator.
    const budget = namedMinimum(dir, extra);
    const parsed = expectHonest(
      asc(['explore', SPEC.name, ...extra, '--max-tokens', String(budget)], dir),
      budget,
    );
    expect(parsed.rows).toHaveLength(5);
    // And the count is the whole remainder, so nothing was dropped twice or quietly kept.
    expect(parsed.trim?.dropped).toBe(allRows - 5);
  });
});
