import { describe, expect, it } from 'vitest';
import type { RecordedEntry } from '@ascend/store';
import {
  CHUNK_EXTENSION,
  chunkName,
  DUMP_CONTRACT_VERSION,
  dumpFileRow,
  MANIFEST_NAME,
  planDump,
  type DumpChunk,
  type DumpManifest,
} from '../src/explore-dump.js';
import { CHARS_PER_TOKEN, estimateTokens } from '../src/budget.js';
import { entryRow } from '../src/output.js';

/**
 * `--dump` -- the index and the files, on their own.
 *
 * What can be wrong here is a NUMBER ON THE INDEX. Every figure in `manifest.json` is read by
 * someone deciding what to spend context on, days after the command that wrote it, with the files
 * in front of them and no way to re-derive it -- so a manifest that overstates or understates what
 * a file costs is a caller budgeting wrong in a way nothing corrects. That is the "reports success
 * wrongly" class, and this module is the one place the numbers are produced.
 *
 * The assertions below are therefore all of one shape: **the index is re-derived from the files it
 * describes** and compared. The count is the number of lines, the tokens are a measurement of the
 * bytes, and the totals are the sums of the rows -- each recomputed here by a different expression
 * than the one that produced it, which is the only way the check can fail.
 *
 * The fixture is synthetic and the entries are deliberately uneven, so that "the total is the sum"
 * is not satisfied by every file happening to hold the same thing.
 */

/** One entry. Only the fields `entryRow` reads and the range is computed over differ between them. */
function entry(id: string, recordedAt: string, evidenceText: string | null = null): RecordedEntry {
  return {
    id,
    typeName: 'verification_run',
    typeVersion: 1,
    typeHash: 'hash',
    recordedAt,
    source: 'self',
    properties: { verdict: 'passed' },
    na: [],
    states: {},
    runId: null,
    workflow: null,
    actor: null,
    cwd: null,
    repo: null,
    gitSha: null,
    branch: null,
    evidenceText,
    ascendVersion: '0.0.0',
    schemaVersion: 1,
  };
}

const FILTER = { type: 'verification_run', order: 'recorded_at,id' };

/** A chunk of `count` entries, timestamped by position so every chunk's range is its own. */
function chunk(count: number, from = 0): DumpChunk {
  return {
    entries: Array.from({ length: count }, (_, index) =>
      entry(
        `e${String(from + index)}`,
        `2026-09-0${String(1 + ((from + index) % 9))}T00:00:00.000Z`,
      ),
    ),
  };
}

describe('dump: a file holds entries in a line format, and the index measures it', () => {
  it('writes one JSON object per line, and the count is the number of them', () => {
    const plan = planDump([chunk(3), chunk(2, 3), chunk(1, 5)], FILTER);

    for (const file of plan.files) {
      const lines = file.text.split('\n').filter((line) => line !== '');
      // Recomputed from the text rather than taken from the plan, so a `count` that disagreed with
      // the bytes would fail here instead of being restated.
      expect(lines).toHaveLength(file.count);
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(plan.files.map((file) => file.count)).toStrictEqual([3, 2, 1]);
  });

  it('ends every file with a newline, because that newline is part of the bytes it measured', () => {
    const plan = planDump([chunk(2)], FILTER);
    const file = plan.files[0];
    expect(file?.text.endsWith('\n')).toBe(true);
    // The measurement includes the terminator, so a caller comparing it against their own tokenizer
    // on the real file is comparing the same bytes. Removing the newline would shrink the file and
    // leave the reported figure describing a file nobody has.
    expect(file?.tokens).toBe(estimateTokens(file?.text ?? ''));
  });

  it('reports a token count that is a measurement of the bytes it will write', () => {
    const plan = planDump([chunk(4), chunk(1, 4)], FILTER);
    for (const file of plan.files) {
      const lines = file.text.split('\n').filter((line) => line !== '');
      // An INDEPENDENT measurement: the module's own `estimateTokens` is what the plan used, so this
      // recomputes the quantity from the emitted text by a different route.
      const measured = Math.ceil(Array.from(file.text).length / CHARS_PER_TOKEN);
      expect(file.tokens).toBe(measured);
      expect(lines).toHaveLength(file.count);
    }
  });

  it('uses the same row projection the paged output does', () => {
    const one = entry('e1', '2026-09-01T00:00:00.000Z', 'the evidence');
    const plan = planDump([{ entries: [one] }], FILTER);
    // A dumped line and a row of `asc explore --page --json` are the same object, so an agent that
    // dumped a corpus and then paged it does not meet two shapes for one entry.
    expect(JSON.parse(plan.files[0]?.text ?? '')).toStrictEqual(entryRow(one));
  });

  it('omits evidence_text rather than writing an empty one', () => {
    const plan = planDump([{ entries: [entry('e1', '2026-09-01T00:00:00.000Z')] }], FILTER);
    const line = JSON.parse(plan.files[0]?.text ?? '') as Record<string, unknown>;
    // `TASKS.md` #7: an empty evidence field and a missing one are different facts, and a JSONL
    // line is read by a consumer that has no schema to tell it which this is.
    expect('evidence_text' in line).toBe(false);
  });
});

describe('dump: names sort in the order the chunks were written', () => {
  it('pads to the width of the largest index, so lexical order is chunk order', () => {
    expect(chunkName(0, 9)).toBe(`1${CHUNK_EXTENSION}`);
    expect(chunkName(8, 9)).toBe(`9${CHUNK_EXTENSION}`);
    expect(chunkName(0, 10)).toBe(`01${CHUNK_EXTENSION}`);
    expect(chunkName(9, 10)).toBe(`10${CHUNK_EXTENSION}`);
  });

  it('sorts a two-digit run the way it was written', () => {
    // The failure this prevents: `10.jsonl` sorting before `9.jsonl`. Asserted by sorting the names
    // as a directory listing would and comparing against the order they were generated in.
    const names = Array.from({ length: 12 }, (_, index) => chunkName(index, 12));
    expect([...names].sort()).toStrictEqual(names);
  });

  it('keeps that order at a width the padding itself has to grow into', () => {
    // Padding to a fixed four digits would pass the assertion above and fail here, at the corpus
    // size where it starts to matter.
    const names = Array.from({ length: 120 }, (_, index) => chunkName(index, 120));
    expect([...names].sort()).toStrictEqual(names);
  });
});

describe('dump: the index totals what it lists', () => {
  it('counts every entry, across every file', () => {
    const plan = planDump([chunk(3), chunk(2, 3), chunk(1, 5)], FILTER);
    expect(plan.manifest.count).toBe(6);
    expect(plan.manifest.files.reduce((total, file) => total + file.count, 0)).toBe(6);
  });

  it('reports file_tokens as the sum of the files, not as the size of anything else', () => {
    const plan = planDump([chunk(3), chunk(2, 3)], FILTER);
    const summed = plan.manifest.files.reduce((total, file) => total + file.tokens, 0);
    expect(plan.manifest.file_tokens).toBe(summed);
    // And it is the sum of MEASUREMENTS, so it is also the cost of reading the files.
    const measured = plan.files.reduce(
      (total, file) => total + Math.ceil(Array.from(file.text).length / CHARS_PER_TOKEN),
      0,
    );
    expect(plan.manifest.file_tokens).toBe(measured);
  });

  it('names each file in the manifest exactly as the plan writes it', () => {
    const plan = planDump([chunk(1), chunk(1, 1), chunk(1, 2)], FILTER);
    expect(plan.manifest.files.map((file) => file.file)).toStrictEqual(
      plan.files.map((file) => file.name),
    );
  });

  it('carries the ratio every token figure came from, and the filter it was a dump of', () => {
    const plan = planDump([chunk(1)], FILTER);
    // `EV-13` decided this rides on every report: the ratio is calibrated on ascend's OUTPUT and is
    // not a ceiling for the content it stores, so a caller whose evidence is not Latin has the
    // number to argue with rather than a figure with no stated assumption behind it.
    expect(plan.manifest.chars_per_token).toBe(CHARS_PER_TOKEN);
    expect(plan.manifest.filter).toStrictEqual(FILTER);
    expect(plan.manifest.ascend_dump).toBe(DUMP_CONTRACT_VERSION);
  });

  it('says nothing at all about an empty dump, rather than zeroes', () => {
    const plan = planDump([], FILTER);
    expect(plan.files).toStrictEqual([]);
    expect(plan.manifest.files).toStrictEqual([]);
    expect(plan.manifest.count).toBe(0);
    expect(plan.manifest.file_tokens).toBe(0);
  });

  it('is the manifest.json it will write, parsed', () => {
    const plan = planDump([chunk(2), chunk(1, 2)], FILTER);
    // The bytes written to the directory and the object the stdout rows were built from are one
    // value rendered twice, so a caller who reads the file and a caller who read stdout agree.
    const parsed = JSON.parse(plan.manifestText) as DumpManifest;
    expect(parsed).toStrictEqual(plan.manifest);
    expect(plan.manifestText.endsWith('\n')).toBe(true);
    expect(MANIFEST_NAME).toBe('manifest.json');
  });
});

describe('dump: a chunk states the range of time it holds', () => {
  it('folds over every entry rather than reading the first and the last', () => {
    // Deliberately NOT in order. The chunk is in order today, and a range that silently depended on
    // that would be wrong the moment the order changed -- while looking exactly as right.
    const outOfOrder: DumpChunk = {
      entries: [
        entry('b', '2026-09-05T00:00:00.000Z'),
        entry('a', '2026-09-01T00:00:00.000Z'),
        entry('c', '2026-09-09T00:00:00.000Z'),
      ],
    };
    const plan = planDump([outOfOrder], FILTER);
    expect(plan.manifest.files[0]?.recorded_at_min).toBe('2026-09-01T00:00:00.000Z');
    expect(plan.manifest.files[0]?.recorded_at_max).toBe('2026-09-09T00:00:00.000Z');
  });

  it('gives each chunk its own range, not the first chunk repeated', () => {
    const plan = planDump([chunk(1, 0), chunk(1, 5)], FILTER);
    const [first, second] = plan.manifest.files;
    expect(first?.recorded_at_min).toBe('2026-09-01T00:00:00.000Z');
    expect(second?.recorded_at_min).toBe('2026-09-06T00:00:00.000Z');
    expect(first?.recorded_at_min).not.toBe(second?.recorded_at_min);
  });

  it('omits the range for a chunk holding nothing', () => {
    // Never reached by the command, which chunks a non-empty id list. Asserted because the
    // alternative -- a pair of nulls, or a zero-width range at the epoch -- is a fabricated
    // timestamp in the field a caller uses to decide whether to read the file (`TASKS.md` #7).
    const plan = planDump([{ entries: [] }], FILTER);
    const file = plan.manifest.files[0];
    expect(file).toBeDefined();
    expect('recorded_at_min' in (file ?? {})).toBe(false);
    expect('recorded_at_max' in (file ?? {})).toBe(false);
  });
});

describe('dump: the row on stdout says whether anything was written', () => {
  const listed = {
    file: '01.jsonl',
    count: 40,
    tokens: 7825,
    recorded_at_min: '2026-09-01T00:00:00.000Z',
    recorded_at_max: '2026-09-09T00:00:00.000Z',
  };

  it('carries dry_run on the row itself, both ways round', () => {
    // On the row rather than on one flag row at the end, following `record.ts`: a caller reading
    // stdout alone has to be able to tell a preview from a dump, and a single marker row is one a
    // reader scanning a list can miss.
    expect(dumpFileRow(listed, true)).toMatchObject({ dry_run: true });
    expect(dumpFileRow(listed, false)).toMatchObject({ dry_run: false });
    // Stated both ways, not only when true: an absent field cannot be told apart from a command
    // that does not report dry runs at all (`output.ts`'s note on the same trap).
    expect('dry_run' in dumpFileRow(listed, false)).toBe(true);
  });

  it('omits the range when the file has none, rather than writing nulls beside it', () => {
    const bare = dumpFileRow({ file: '01.jsonl', count: 0, tokens: 0 }, false);
    expect('recorded_at_min' in bare).toBe(false);
    expect('recorded_at_max' in bare).toBe(false);
  });

  it('carries the same numbers the manifest does', () => {
    const plan = planDump([chunk(2), chunk(1, 2)], FILTER);
    const rows = plan.manifest.files.map((file) => dumpFileRow(file, false));
    expect(rows.map((row) => row['tokens'])).toStrictEqual(
      plan.manifest.files.map((file) => file.tokens),
    );
  });
});
