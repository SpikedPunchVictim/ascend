import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc search <type> "<text>"` -- the command, driven as the real binary.
 *
 * `search-assist.test.ts` covers the assist as a function. This file covers what a caller reaches:
 * the argument parser, the refusals and their exit codes, the JSON contract, and the two claims the
 * command rests on -- **that a zero result explains itself**, and **that a limited result does not
 * claim to be the whole answer**.
 *
 * **The second claim is the severity-zero one, and it has a test below that fails without its fix.**
 * `Output.coverage` defaults to `complete(rows)`, which asserts the rows shown are the whole result.
 * A search capped by `--limit` breaks that: measured on the frozen corpus, `the` against
 * `user_correction` matches 17 entries and at `--limit 1` the row list holds one -- so the default
 * would report `{"shown":1,"total":1,"has_more":false}`, a search that found 17 things claiming it
 * found exactly one. Nothing in the row list can tell the two apart, which is why the total is
 * counted rather than inferred.
 *
 * **The fixture is built to have the shape the real corpus has, in miniature**: one type whose
 * entries carry evidence text and are searchable, one whose entries carry none and are not, and one
 * with no entries at all. Those are the three reasons a search can find nothing, and a fixture that
 * only had the first would leave the assist's whole decision untested.
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

/**
 * The searchable type. `runner` is the property that is the point: it holds values a query misses.
 *
 * **One of those values holds an underscore, and that is load-bearing rather than decorative.** The
 * escape test below asserts that a query of `___` suggests nothing -- and against a vocabulary of
 * `cargo test` and `pnpm build` it passes whether or not the SQL escapes anything, because no value
 * contains an underscore for the wildcard to over-match. The mutation survived the first version of
 * this fixture: `LIKE '%___%'` with the ESCAPE clause deleted still returned zero rows, so the test
 * was asserting the absence of a hazard it could not produce. `npm_run_build` is the value that
 * makes the two implementations differ.
 */
const SEARCHABLE = {
  name: 'run_note',
  properties: [
    { name: 'runner', type: 'enum', enum_values: ['cargo test', 'pnpm build', 'npm_run_build'] },
    { name: 'note', type: 'text' },
  ],
};

/** Entries, but no evidence text on any of them -- the dead-end type. */
const UNINDEXED = {
  name: 'bare_note',
  properties: [{ name: 'runner', type: 'enum', enum_values: ['cargo test', 'pnpm build'] }],
};

/** No entries at all. */
const EMPTY = { name: 'hollow', properties: [{ name: 'note', type: 'text' }] };

const SPECS = [SEARCHABLE, UNINDEXED, EMPTY];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-search-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  for (const spec of SPECS) {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
    expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);
  }
  return dir;
}

interface Envelope {
  readonly rows: readonly {
    readonly id: string;
    readonly score: number;
    readonly snippet: string;
  }[];
  readonly row_count: number;
  readonly coverage: { readonly shown: number; readonly total: number; readonly has_more: boolean };
  readonly assist?: {
    readonly reason: string;
    readonly entries: number;
    readonly indexed: number;
    readonly values: readonly {
      readonly property: string;
      readonly value: string;
      readonly entries: number;
    }[];
  };
}

/**
 * A project with `SEARCHABLE` holding `count` indexed entries and `UNINDEXED` holding one unindexed
 * one, which is the smallest fixture in which every reason the assist names is reachable.
 */
function fixture(count: number): string {
  const dir = project();
  for (let i = 0; i < count; i += 1) {
    // Cycled through all three enum values rather than alternated between two, so that a fixture
    // of three entries holds one of each -- which is what lets the underscore test assert a real
    // match count instead of a value that no entry carries.
    const runners = ['cargo test', 'pnpm build', 'npm_run_build'] as const;
    const run = asc(
      [
        'record',
        SEARCHABLE.name,
        '--prop',
        `runner=${runners[i % runners.length] as string}`,
        '--prop',
        `note=n${String(i)}`,
        // The word 'deployment' is on every entry, 'disk' on every second one, so a query can be
        // chosen that matches all of them, half of them, or one.
        '--evidence',
        i % 2 === 0 ? `deployment failed disk ${String(i)}` : `deployment failed ${String(i)}`,
        '--json',
      ],
      dir,
    );
    expect(run.status).toBe(0);
  }

  const bare = asc(['record', UNINDEXED.name, '--prop', 'runner=cargo test', '--json'], dir);
  expect(bare.status).toBe(0);

  return dir;
}

function search(dir: string, type: string, text: string, ...flags: readonly string[]): Envelope {
  const run = asc(['search', type, text, '--json', ...flags], dir);
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as Envelope;
}

describe('asc search -- the ranked result', () => {
  it('returns the entries whose evidence holds the term', () => {
    const dir = fixture(4);
    const result = search(dir, SEARCHABLE.name, 'deployment');
    expect(result.row_count).toBe(4);
  });

  it('carries an assist even when it found something, and names the rows case', () => {
    // THE REGRESSION, and it is the one this block was rebuilt for. The assist used to be absent
    // here, and absence was the signal a consumer read as "this search succeeded". Measured on a
    // corpus earned from live workflows, every search that returned rows in the one type that can
    // exhibit the case withheld a property match the corpus held -- 7 of 7, no exceptions
    // (`docs/evidence/EV-17.md`). A caller who got rows is not looking for a reason to doubt the
    // answer, which makes this the worse case, not the milder one.
    const dir = fixture(4);
    const assist = search(dir, SEARCHABLE.name, 'deployment').assist;
    expect(assist?.reason).toBe('rows-returned');
    expect(assist?.entries).toBe(4);
    expect(assist?.indexed).toBe(4);
  });

  it('says the terms are found nowhere else when no property holds them', () => {
    // The reassuring half. Without it a caller cannot tell "nothing is withheld" from "nothing was
    // looked for" -- the same silence the zero-result path was built to break.
    const dir = fixture(4);
    const assist = search(dir, SEARCHABLE.name, 'deployment').assist;
    expect(assist?.values).toEqual([]);
  });

  it('marks the matched term in the snippet', () => {
    const dir = fixture(2);
    const row = search(dir, SEARCHABLE.name, 'disk').rows[0];
    expect(row?.snippet).toContain('**disk**');
  });

  it('ranks best-first, so the score is ascending', () => {
    // `bm25()` is negative and lower is better, which is inverted from every intuition a caller
    // brings -- so the ORDER is the thing a caller relies on and the thing worth pinning.
    const dir = fixture(4);
    const scores = search(dir, SEARCHABLE.name, 'deployment').rows.map((row) => row.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });

  it('answers identically twice, so a result is reproducible', () => {
    const dir = fixture(4);
    const first = asc(['search', SEARCHABLE.name, 'deployment', '--json'], dir).stdout;
    const second = asc(['search', SEARCHABLE.name, 'deployment', '--json'], dir).stdout;
    expect(second).toBe(first);
  });
});

describe('asc search -- the coverage a limit owes the caller', () => {
  it('counts the matches the limit withheld, rather than reporting the rows as the whole', () => {
    // THE REGRESSION. Without `countSearchMatches` this reads {"shown":1,"total":1,"has_more":false}
    // -- a claim that the corpus mentions the term once, when it mentions it four times.
    const dir = fixture(4);
    const result = search(dir, SEARCHABLE.name, 'deployment', '--limit', '1');
    expect(result.row_count).toBe(1);
    expect(result.coverage).toEqual({ shown: 1, total: 4, has_more: true, percent: 25 });
  });

  it('reports full coverage when the limit withholds nothing', () => {
    const dir = fixture(2);
    const result = search(dir, SEARCHABLE.name, 'deployment', '--limit', '50');
    expect(result.coverage).toEqual({ shown: 2, total: 2, has_more: false, percent: 100 });
  });

  it('prints the coverage line in the table, so a terminal reader is told too', () => {
    const dir = fixture(4);
    const run = asc(['search', SEARCHABLE.name, 'deployment', '--limit', '2'], dir);
    expect(run.stdout).toContain('showing 2 of 4');
  });
});

describe('asc search -- the zero-result assist', () => {
  it('names the unindexed type as unindexed, and says retrying will not help', () => {
    const dir = fixture(2);
    const assist = search(dir, UNINDEXED.name, 'deployment').assist;
    expect(assist?.reason).toBe('nothing-indexed');
    expect(assist?.entries).toBe(1);
    expect(assist?.indexed).toBe(0);
  });

  it('names an empty type as empty rather than as unindexed', () => {
    // The two conditions overlap -- 0 entries implies 0 indexed -- so this is the case where a
    // wrong test ORDER in `assistReason` produces a plausible, wrong explanation.
    const dir = fixture(2);
    const assist = search(dir, EMPTY.name, 'deployment').assist;
    expect(assist?.reason).toBe('type-empty');
    expect(assist?.entries).toBe(0);
    expect(assist?.indexed).toBe(0);
  });

  it('names a plain miss on a searchable type as a plain miss', () => {
    const dir = fixture(2);
    const assist = search(dir, SEARCHABLE.name, 'zzzqqq').assist;
    expect(assist?.reason).toBe('no-match');
    expect(assist?.entries).toBe(2);
    expect(assist?.indexed).toBe(2);
  });

  it('offers the property values that actually occur, with their counts', () => {
    // The headline case, and the one the real corpus makes routine: a term can miss the index
    // entirely and still be a property value the type holds hundreds of.
    const dir = fixture(2);
    const assist = search(dir, UNINDEXED.name, 'cargo').assist;
    expect(assist?.values).toEqual([{ property: 'runner', value: 'cargo test', entries: 1 }]);
  });

  it('offers nothing when the term occurs nowhere at all', () => {
    const dir = fixture(2);
    expect(search(dir, SEARCHABLE.name, 'zzzqqq').assist?.values).toEqual([]);
  });

  it('offers the property values a RESULT SET does not cover', () => {
    // The defect, end to end and through the real binary. Two entries of the same type, both
    // searchable, both carrying `cargo test` in `runner`; only one mentions cargo in its evidence.
    // The search returns one row -- and before this was fixed it said nothing at all about the
    // other entry, which holds the query term in a property and is unreachable by the query that
    // should find it. `asc-nai`'s own constructed case, reproduced in a fixture.
    const dir = project();
    const record = (note: string, evidence: string): void => {
      const run = asc(
        [
          'record',
          SEARCHABLE.name,
          '--prop',
          'runner=cargo test',
          '--prop',
          `note=${note}`,
          '--evidence',
          evidence,
          '--json',
        ],
        dir,
      );
      expect(run.status).toBe(0);
    };
    record('a', 'cargo build failed');
    record('b', 'nothing relevant here');

    const result = search(dir, SEARCHABLE.name, 'cargo');
    // The premise: rows came back, so the old gate would have withheld the property pass entirely.
    expect(result.row_count).toBe(1);
    expect(result.assist?.reason).toBe('rows-returned');
    expect(result.assist?.values).toEqual([
      { property: 'runner', value: 'cargo test', entries: 2 },
    ]);
  });

  it('does not treat an underscore term as a wildcard', () => {
    // THE ESCAPE. `LIKE '%___%'` matches any value holding three consecutive characters, so without
    // the ESCAPE clause the assist reports `npm_run_build` -- and every other value in the type --
    // as a place a nonsense query occurs. Verified by mutation: deleting `ESCAPE '\'` from the SQL
    // makes this test fail, and it does not fail against this fixture if the underscore-bearing
    // value is removed.
    const dir = fixture(2);
    expect(search(dir, SEARCHABLE.name, '___').assist?.values).toEqual([]);
  });

  it('still matches a real underscore term, so the escape does not disable the feature', () => {
    // The other half of the escape: escaping `_` must not stop a query that legitimately contains
    // one from matching the value it is part of. A fix that escaped the character by making it
    // unmatchable would pass the test above and break the feature.
    // Three entries, because the value is third in the cycle -- at two, nothing carries it and the
    // assertion below would be about an empty list rather than about a match.
    const dir = fixture(3);
    expect(search(dir, SEARCHABLE.name, 'npm_run_build').assist?.values).toEqual([
      { property: 'runner', value: 'npm_run_build', entries: 1 },
    ]);
  });

  it('cannot receive a percent sign at all, because it is not a term character', () => {
    // Written after checking the mechanism rather than assuming it. `%` is absent from the term
    // pattern `[\p{L}\p{N}_]+`, so `%zz%` tokenizes to `zz` -- two code points, below the three the
    // index can match -- and the query is refused before any SQL runs. The escape clause is
    // therefore unreachable for `%` by a stronger route than escaping: the character never becomes
    // part of a pattern. Asserting the refusal rather than an empty suggestion list is the
    // difference between pinning the guarantee and pinning a coincidence.
    const dir = fixture(2);
    const run = asc(['search', SEARCHABLE.name, '%zz%'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('no searchable term');
  });

  it('writes the explanation to stdout in the table, where a piped reader finds it', () => {
    const dir = fixture(2);
    const run = asc(['search', UNINDEXED.name, 'cargo'], dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('no matches');
    expect(run.stdout).toContain('index holds none');
    expect(run.stdout).toContain('runner = "cargo test"');
  });
});

describe('asc search -- refusals', () => {
  it('refuses a type nobody registered, and names the ones that exist', () => {
    const dir = fixture(1);
    const run = asc(['search', 'nosuch', 'deployment'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('no entry type named');
    expect(flatten(run.stderr)).toContain(SEARCHABLE.name);
  });

  it('refuses a query with no searchable term rather than reporting it as no match', () => {
    // The distinction is the command's: the empty array `searchEntries` would return is a fact
    // about the tokenizer, not about the corpus, and a caller who reads it as "the corpus lacks
    // this" has been told something false by a command that exited 0.
    const dir = fixture(2);
    const run = asc(['search', SEARCHABLE.name, 'ab'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('no searchable term');
  });

  it('refuses a short term even when the type is empty, where the answer would look harmless', () => {
    // A no-match explanation would be a true-sounding answer to a question that was never asked.
    const dir = fixture(2);
    expect(asc(['search', EMPTY.name, 'ab'], dir).status).toBe(2);
  });

  it('rejects a limit that is not a positive whole number', () => {
    const dir = fixture(2);
    expect(asc(['search', SEARCHABLE.name, 'deployment', '--limit', '0'], dir).status).toBe(2);
    expect(asc(['search', SEARCHABLE.name, 'deployment', '--limit', '1.5'], dir).status).toBe(2);
  });
});

describe('asc search -- the surface', () => {
  it('documents itself', () => {
    const dir = fixture(1);
    const run = asc(['search', '--help'], dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('USAGE');
    expect(run.stdout).toContain('--limit');
  });

  it('renders CSV with one record per row and no assist prose in it', () => {
    // CSV has nowhere to put an explanation, and a consumer parsing it would read the prose as a
    // malformed record. The table carries the assist; CSV carries the rows.
    const dir = fixture(2);
    const run = asc(['search', SEARCHABLE.name, 'deployment', '--csv'], dir);
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines[0]).toBe('id,score,snippet');
    expect(lines).toHaveLength(3);
  });
});
