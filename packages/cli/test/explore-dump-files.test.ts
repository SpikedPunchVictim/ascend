import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc explore --dump <dir>` -- the flag, driven as the real binary.
 *
 * `explore-dump.test.ts` covers the planner as a function. This file covers the thing a caller
 * actually reaches: the flag parser, the refusals, the order of the writes, and the claim the whole
 * feature rests on -- **that `manifest.json` is a measurement of the files sitting beside it.**
 *
 * **That claim is why every check below re-derives the index rather than restating it.** A manifest
 * is read days after the command that wrote it, by someone holding the files and nothing else --
 * there is no second source of truth to check it against, and a caller budgeting context on a figure
 * that overstates or understates a file has no way to find out. So the counts here come from counting
 * LINES in the files, the token figures from measuring the file TEXT by code points, and the totals
 * from summing the rows: each recomputed by a different expression than the one that produced it.
 *
 * **Two defects were found by driving this command rather than by reading it, and both have a test
 * below that fails without its fix.** A budgeted dump printed a coverage block claiming completeness
 * beside a trim block reporting dropped rows; and a budget the command REFUSED still wrote a complete
 * dump to disk. Neither is visible in the planner, and neither is visible in a unit test of it.
 *
 * The fixture is small -- five short entries -- so a whole dump is a couple of hundred tokens and a
 * budget can be chosen that fits part of the index. Every budget below is derived from a measurement
 * of this fixture (the refusal's own figure, or a full-size run) rather than picked by hand, because
 * a hand-picked budget silently stops being tight the moment a row's size changes.
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

/** stderr with oclif's wrap decoration removed, so a substring assertion means what it reads like. */
function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SPEC = {
  name: 'note_entry',
  properties: [
    { name: 'outcome', type: 'enum', enum_values: ['ok', 'bad'] },
    { name: 'note', type: 'text' },
  ],
};

/** A type with no entries at all, which is the empty-dump case the index has to state. */
const EMPTY_SPEC = { name: 'hollow', properties: [{ name: 'note', type: 'text' }] };

function emptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-dump-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  for (const spec of [SPEC, EMPTY_SPEC]) {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
    expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);
  }
  return dir;
}

/** Record `count` entries and return their ids, in the order recorded. */
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
        `note=n${String(i)}`,
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

interface Coverage {
  readonly shown: number;
  readonly total: number;
  readonly has_more: boolean;
  readonly percent?: number;
}

interface Trim {
  readonly max_tokens: number;
  readonly estimated_tokens: number;
  readonly dropped: number;
  readonly chars_per_token: number;
  readonly dropped_keys?: readonly string[];
}

interface DumpRow {
  readonly file: string;
  readonly count: number;
  readonly tokens: number;
  readonly dry_run: boolean;
  readonly recorded_at_min?: string;
  readonly recorded_at_max?: string;
}

interface DumpEnvelope {
  readonly ascend_output?: number;
  readonly rows: readonly DumpRow[];
  readonly row_count: number;
  readonly coverage?: Coverage;
  readonly trim?: Trim;
}

/** One file, as `manifest.json` describes it. No `dry_run`: the manifest is not a preview. */
interface ManifestFile {
  readonly file: string;
  readonly count: number;
  readonly tokens: number;
  readonly recorded_at_min?: string;
  readonly recorded_at_max?: string;
}

interface Manifest {
  readonly ascend_dump: number;
  readonly filter: { readonly type: string; readonly order: string };
  readonly count: number;
  readonly file_tokens: number;
  readonly chars_per_token: number;
  readonly files: readonly ManifestFile[];
}

const envelope = (stdout: string): DumpEnvelope => JSON.parse(stdout) as DumpEnvelope;

/**
 * The size of a file or an output, measured independently of the estimator that reported it.
 *
 * `Array.from` rather than `[...text]`, for the reason `explore-budget.test.ts` states at length: the
 * shipped estimator counts code points, and the spread trips a lint rule whose point -- that code-point
 * iteration is not grapheme-cluster iteration -- is right in general and wrong here.
 */
function codePointTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 2);
}

/** Every file in a directory with its exact bytes, sorted by name so two runs can be compared. */
function snapshot(dir: string): readonly (readonly [string, string])[] {
  return readdirSync(dir)
    .sort()
    .map((name) => [name, readFileSync(join(dir, name), 'utf8')] as const);
}

const manifestOf = (dir: string, into: string): Manifest =>
  JSON.parse(readFileSync(join(dir, into, 'manifest.json'), 'utf8')) as Manifest;

/** One file's lines, with the empty tail a trailing newline leaves behind removed. */
function linesOf(text: string): readonly string[] {
  return text.split('\n').filter((line) => line !== '');
}

const idsOf = (text: string): readonly string[] =>
  linesOf(text).map((line) => (JSON.parse(line) as { id: string }).id);

describe('asc explore --dump: the flag, and what it refuses', () => {
  it('documents all three flags in --help', () => {
    const dir = emptyProject();
    const run = asc(['explore', '--help'], dir);

    expect(run.status).toBe(0);
    // A dump is the one mode that writes files, so the flags that preview it and unlock a
    // non-empty directory have to be reachable from the same place.
    for (const flag of ['--dump', '--dry-run', '--force']) expect(run.stdout).toContain(flag);
    expect(flatten(run.stdout)).toContain('manifest.json');
  });

  it('names a stray --dry-run or --force rather than ignoring it', () => {
    const dir = emptyProject();
    record(dir, 2);

    for (const stray of ['--dry-run', '--force']) {
      const run = asc(['explore', SPEC.name, stray, '--json'], dir);
      // Refused, not ignored: a caller who typed --dry-run and got ordinary output would conclude
      // the preview was broken, when the truth is that it was never read.
      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(flatten(run.stderr)).toContain(`${stray} only applies to --dump`);
    }
  });

  it('refuses a dump combined with a page or a sample', () => {
    const dir = emptyProject();
    record(dir, 2);

    for (const other of [['--page'], ['--cursor', 'x'], ['--sample', 'random']]) {
      const run = asc(['explore', SPEC.name, '--dump', 'out', ...other], dir);
      // A dump writes the WHOLE type. Silently honouring a window would put files on disk that a
      // caller reads as the whole corpus -- and a dump outlives the command that wrote it, so
      // nothing later corrects the reading.
      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(flatten(run.stderr)).toContain(
        '--dump cannot be combined with --page, --cursor or --sample',
      );
    }
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('refuses --limit below one, because a chunk is what --limit means here', () => {
    const dir = emptyProject();
    record(dir, 2);

    const run = asc(['explore', SPEC.name, '--dump', 'out', '--limit', '0'], dir);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    // The dump-specific sentence, not the paging one: the same flag answers a different question in
    // this mode, and a message about page size would send the caller to the wrong fix.
    expect(flatten(run.stderr)).toContain('how many entries go in each dumped file');
    expect(flatten(run.stderr)).toContain('Got 0');
  });

  it('refuses a type that does not exist, and writes no directory', () => {
    const dir = emptyProject();
    const run = asc(['explore', 'nope', '--dump', 'out'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("There is no entry type named 'nope'");
    // The refusal has to precede the write, or a typo leaves an empty directory behind for every
    // attempt -- which is the kind of debris that makes a later dump refuse as "occupied".
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
});

describe('asc explore --dump: the manifest measures the files beside it', () => {
  it('re-derives every figure from the bytes, and totals what it lists', () => {
    const dir = emptyProject();
    const ids = record(dir, 5);
    const run = asc(['explore', SPEC.name, '--dump', 'out', '--limit', '2', '--json'], dir);
    expect(run.status).toBe(0);

    const manifest = manifestOf(dir, 'out');
    const listing = readdirSync(join(dir, 'out')).sort();

    // The three chunks of five entries at a limit of two: 2, 2, 1. Asserted as counts so the
    // per-file figures below are checked against a shape, not only against each other.
    expect(manifest.files.map((file) => file.count)).toStrictEqual([2, 2, 1]);
    expect(listing).toStrictEqual(['1.jsonl', '2.jsonl', '3.jsonl', 'manifest.json']);

    let summedCount = 0;
    let summedTokens = 0;
    const dumpedIds: string[] = [];

    for (const listed of manifest.files) {
      const text = readFileSync(join(dir, 'out', listed.file), 'utf8');

      // COUNT: the number of lines in the file, not the number the index claims.
      expect(linesOf(text)).toHaveLength(listed.count);
      // TOKENS: a measurement of the bytes on disk. The trailing newline is included on both sides,
      // which is what makes these the same quantity rather than two nearly-equal ones.
      expect(listed.tokens).toBe(codePointTokens(text));
      // And every line parses, so a file that is the right SIZE but not valid JSONL fails here.
      for (const line of linesOf(text)) expect(() => JSON.parse(line) as unknown).not.toThrow();

      summedCount += linesOf(text).length;
      summedTokens += codePointTokens(text);
      dumpedIds.push(...idsOf(text));
    }

    expect(manifest.count).toBe(summedCount);
    expect(manifest.count).toBe(ids.length);
    // `file_tokens` is the sum of the rows, and also the sum of independent measurements of the
    // bytes. Both, because either alone could be satisfied by an index that agreed with itself.
    expect(manifest.file_tokens).toBe(summedTokens);
    expect(manifest.file_tokens).toBe(manifest.files.reduce((sum, file) => sum + file.tokens, 0));
    // What it is NOT is the index's own size, and that is a property with no assertion attached --
    // there is no relation between the two to hold. Measured here: 367 tokens of files beside a
    // 361-token index, because five entries cannot amortise a per-file block. At corpus scale the
    // separation is the whole argument for chunking -- 93,435 tokens of files under a 460-token
    // index (`EV-14`), against 34,840 for one file per entry. Asserting `<` on this fixture would
    // have been a claim that is false here and true there, which is not a property of the code.

    // The entries themselves: every one, exactly once, in the order the store pages them.
    expect(dumpedIds).toStrictEqual(ids);
  });

  it('carries what the dump was a dump of, and the ratio its figures rest on', () => {
    const dir = emptyProject();
    record(dir, 3);
    expect(asc(['explore', SPEC.name, '--dump', 'out', '--json'], dir).status).toBe(0);

    const manifest = manifestOf(dir, 'out');
    // A directory of files outlives the command that wrote it, so the index states its own filter.
    expect(manifest.filter).toStrictEqual({ type: SPEC.name, order: 'recorded_at,id' });
    // The ratio rides along for the reason EV-13 decided: it is calibrated on ascend's output and is
    // not a ceiling for the content ascend stores, so a caller with non-Latin evidence can argue.
    expect(manifest.chars_per_token).toBe(2);
    expect(manifest.ascend_dump).toBe(1);
  });

  it('writes the index LAST, so a failed write leaves nothing to read', () => {
    const dir = emptyProject();
    record(dir, 5);

    // A directory cannot be opened for writing, so the first chunk write fails and the run aborts
    // part-way through the files. `--force` because the target is deliberately non-empty.
    mkdirSync(join(dir, 'blocked', '1.jsonl'), { recursive: true });
    const run = asc(['explore', SPEC.name, '--dump', 'blocked', '--force', '--limit', '1'], dir);

    expect(run.status).not.toBe(0);
    // THE ASSERTION: an index naming files that were never written is the one failure of this
    // feature a reader cannot detect for themselves -- so the index must not exist yet. The reverse
    // failure, data with no index, is self-announcing: there is nothing to read.
    expect(existsSync(join(dir, 'blocked', 'manifest.json'))).toBe(false);
  });

  it('is the same entries in the same order a page returns them', () => {
    const dir = emptyProject();
    const ids = record(dir, 7);

    const page = asc(['explore', SPEC.name, '--page', '--limit', '1000', '--json'], dir);
    expect(page.status).toBe(0);
    // A page's rows are entries, not file listings -- a different shape from the dump envelope this
    // file otherwise parses, so it is read with its own type rather than forced through that one.
    const paged = (JSON.parse(page.stdout) as { rows: readonly { id: string }[] }).rows.map(
      (row) => row.id,
    );
    expect(paged).toHaveLength(ids.length);

    expect(asc(['explore', SPEC.name, '--dump', 'out', '--limit', '3', '--json'], dir).status).toBe(
      0,
    );
    const dumped = manifestOf(dir, 'out').files.flatMap((file) =>
      idsOf(readFileSync(join(dir, 'out', file.file), 'utf8')),
    );

    // Exact order, not just the same set: the chunk boundaries are only meaningful as contiguous
    // spans of the paging order, and a dump ordered differently would make the per-file time ranges
    // describe a sequence no caller can resume.
    expect(dumped).toStrictEqual(paged);
  });
});

describe('asc explore --dump: --dry-run writes nothing and reports the same dump', () => {
  it('leaves the directory uncreated and previews the real numbers', () => {
    const dir = emptyProject();
    record(dir, 5);

    const preview = asc(
      ['explore', SPEC.name, '--dump', 'dry', '--dry-run', '--limit', '2', '--json'],
      dir,
    );
    expect(preview.status).toBe(0);
    expect(existsSync(join(dir, 'dry'))).toBe(false);

    const real = asc(['explore', SPEC.name, '--dump', 'wet', '--limit', '2', '--json'], dir);
    expect(real.status).toBe(0);

    const previewRows = envelope(preview.stdout).rows;
    const realRows = envelope(real.stdout).rows;

    // THE ASSERTION: the preview IS the dump, with one field flipped. A preview sized by a different
    // path would be a preview of a dump nobody was going to get, and its whole job is to be the one
    // you would get.
    expect(previewRows.map((row) => ({ ...row, dry_run: false }))).toStrictEqual([...realRows]);
    expect(previewRows.every((row) => row.dry_run)).toBe(true);
    expect(realRows.every((row) => !row.dry_run)).toBe(true);

    // And the preview's figures are the real files' figures, since the real ones now exist.
    const manifest = manifestOf(dir, 'wet');
    for (const listed of manifest.files) {
      const text = readFileSync(join(dir, 'wet', listed.file), 'utf8');
      expect(listed.tokens).toBe(codePointTokens(text));
    }
  });
});

describe('asc explore --dump: --max-tokens fits the index and cannot touch the disk', () => {
  /** The figure the refusal names, which is a measurement of this fixture's index in this format. */
  function namedMinimum(dir: string, args: readonly string[]): number {
    const refused = asc([...args, '--max-tokens', '1'], dir);
    expect(refused.status).toBe(2);
    expect(flatten(refused.stderr)).toContain('--max-tokens is too small for this output');
    const named = /is about (\d+) tokens/.exec(flatten(refused.stderr))?.[1];
    expect(named).toBeDefined();
    return Number(named);
  }

  it('refuses a budget it cannot meet and leaves no dump behind', () => {
    const dir = emptyProject();
    record(dir, 5);
    const args = ['explore', SPEC.name, '--dump', 'out', '--limit', '1', '--json'];

    namedMinimum(dir, args);

    // THE ASSERTION, and it is a regression test. The first version of this mode fitted the index
    // AFTER writing the files, so this run exited 2 with a message about the budget and left a
    // complete six-file dump behind it. A command that declines to answer the caller's question and
    // changes their filesystem anyway is the "reports success wrongly" class one step further out.
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('keeps the coverage true of the rows on screen while the whole dump lands on disk', () => {
    const dir = emptyProject();
    record(dir, 5);
    const args = ['explore', SPEC.name, '--dump', 'out', '--limit', '1', '--json'];

    const budget = namedMinimum(dir, args);
    const run = asc([...args, '--max-tokens', String(budget)], dir);
    expect(run.status).toBe(0);

    const parsed = envelope(run.stdout);
    expect(parsed.trim).toBeDefined();
    // The report is the size of the bytes, inside the budget -- the same contract every other mode
    // of this command keeps.
    expect(parsed.trim?.estimated_tokens).toBe(codePointTokens(run.stdout.replace(/\n$/, '')));
    expect(parsed.trim?.estimated_tokens).toBeLessThanOrEqual(budget);

    // THE ASSERTION, and this one is a regression test too. Without the coverage guard the block
    // defaulted to "complete", so this output printed `showing 1 of 1` beside a trim block saying it
    // had dropped four rows -- and `coverage` is precisely the field a consumer reads to decide how
    // much of the dump it is looking at.
    expect(parsed.coverage?.shown).toBe(parsed.rows.length);
    expect(parsed.coverage?.total).toBe(5);
    expect(parsed.coverage?.has_more).toBe(true);
    expect(parsed.trim?.dropped).toBe(5 - parsed.rows.length);
    expect(parsed.trim?.dropped_keys).toStrictEqual(['2.jsonl', '3.jsonl', '4.jsonl', '5.jsonl']);

    // And the budget reached the index only: every file and the on-disk manifest are complete.
    expect(manifestOf(dir, 'out').files).toHaveLength(5);
    expect(manifestOf(dir, 'out').count).toBe(5);
  });

  it('writes byte-identical files with and without a budget', () => {
    const dir = emptyProject();
    record(dir, 5);

    expect(
      asc(['explore', SPEC.name, '--dump', 'plain', '--limit', '2', '--json'], dir).status,
    ).toBe(0);
    const args = ['explore', SPEC.name, '--dump', 'trimmed', '--limit', '2', '--json'];
    const budget = namedMinimum(dir, args);
    expect(asc([...args, '--max-tokens', String(budget)], dir).status).toBe(0);

    // THE ASSERTION: same names, same bytes. A truncated manifest on disk would be a permanent lie
    // about what the directory holds, read later by someone with no way to tell it was trimmed --
    // which is why the fit is applied to stdout and to nothing else.
    expect(snapshot(join(dir, 'trimmed'))).toStrictEqual(snapshot(join(dir, 'plain')));
  });
});

describe('asc explore --dump: the directory it is pointed at', () => {
  it('refuses a non-empty directory that was not forced', () => {
    const dir = emptyProject();
    record(dir, 3);
    expect(asc(['explore', SPEC.name, '--dump', 'out', '--json'], dir).status).toBe(0);
    const before = snapshot(join(dir, 'out'));

    const run = asc(['explore', SPEC.name, '--dump', 'out', '--json'], dir);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(flatten(run.stderr)).toContain('already holds 2 files');
    expect(flatten(run.stderr)).toContain('Pass --force');
    // Refused before the first write, so the existing dump is untouched rather than half-replaced.
    expect(snapshot(join(dir, 'out'))).toStrictEqual(before);
  });

  it('names the files --force would leave behind, and the manifest stays the authority', () => {
    const dir = emptyProject();
    record(dir, 5);

    // A five-file dump, then a one-file dump over it. `--force` overwrites the names it writes and
    // nothing else, so the four chunks of the larger dump survive.
    expect(asc(['explore', SPEC.name, '--dump', 'out', '--limit', '1', '--json'], dir).status).toBe(
      0,
    );
    const run = asc(
      ['explore', SPEC.name, '--dump', 'out', '--force', '--limit', '5', '--json'],
      dir,
    );
    expect(run.status).toBe(0);

    // THE ASSERTION: the leftovers are named, because someone globbing the directory would otherwise
    // read them as part of this dump. The index is what says which files belong, and a person who
    // never opens it has no other way to know.
    const warning = flatten(run.stderr);
    expect(warning).toContain('holds 4 files this dump does not write');
    for (const stale of ['2.jsonl', '3.jsonl', '4.jsonl', '5.jsonl']) {
      expect(warning).toContain(stale);
    }
    expect(warning).toContain('manifest.json lists the files this dump wrote');

    // And the index is exactly the dump: one file, five entries, however many files are lying around.
    const manifest = manifestOf(dir, 'out');
    expect(manifest.files.map((file) => file.file)).toStrictEqual(['1.jsonl']);
    expect(manifest.count).toBe(5);
    expect(envelope(run.stdout).coverage?.total).toBe(1);
    // The stale files are still there -- stated, not cleaned up. Deleting files this command did not
    // write is a larger power than a dump flag should have.
    expect(readdirSync(join(dir, 'out')).sort()).toStrictEqual([
      '1.jsonl',
      '2.jsonl',
      '3.jsonl',
      '4.jsonl',
      '5.jsonl',
      'manifest.json',
    ]);
  });
});

describe('asc explore --dump: a type with no entries', () => {
  it('writes an index of nothing, and no files', () => {
    const dir = emptyProject();
    const run = asc(['explore', EMPTY_SPEC.name, '--dump', 'out', '--json'], dir);

    expect(run.status).toBe(0);
    expect(envelope(run.stdout).rows).toStrictEqual([]);
    // The index exists and says zero, rather than the directory being absent: "this type is empty"
    // and "no dump was ever attempted" are different facts and a caller has the index to tell them.
    expect(manifestOf(dir, 'out')).toStrictEqual({
      ascend_dump: 1,
      filter: { type: EMPTY_SPEC.name, order: 'recorded_at,id' },
      count: 0,
      file_tokens: 0,
      chars_per_token: 2,
      files: [],
    });
    expect(readdirSync(join(dir, 'out'))).toStrictEqual(['manifest.json']);
  });

  it('refuses a budget without claiming a file that does not exist', () => {
    const dir = emptyProject();
    const run = asc(
      ['explore', EMPTY_SPEC.name, '--dump', 'out', '--max-tokens', '1', '--json'],
      dir,
    );

    expect(run.status).toBe(2);
    // The floor is zero for an empty dump, and the difference is the message: a floor of one would
    // describe this index as reaching "the smallest possible ... 1 file", which is a refusal
    // overstating what exists -- the same class of claim as a report that does.
    expect(flatten(run.stderr)).toContain('-- 0 files --');
    // Still nothing written, so the refusal is honest about the directory as well as the budget.
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
});
