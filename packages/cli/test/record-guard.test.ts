import { describe, expect, it } from 'vitest';
import { guardRecords, scanRecordFile, type Baseline } from '../src/record-guard.js';

/**
 * The pure half of `asc store verify`: text in, refusals out. No git, no filesystem.
 *
 * The load-bearing case is `rb0` -- `docs/evidence/EV-31.md` measured that a one-side merge
 * resolution leaves WELL-FORMED JSONL (every line parses, no markers, no duplicate ids) with the
 * other side's record silently gone. A syntax check passes that; only the id comparison refuses it,
 * which is why the lost-id tests below are the ones that matter.
 */

const ENTRY = (id: string): string =>
  `{"kind":"entry","id":"${id}","type_name":"note","type_version":1,"type_hash":"h",` +
  `"recorded_at":"2026-10-02T00:00:00.000Z","source":"hand"}`;

const ANNOTATION = (id: string): string =>
  `{"kind":"annotation","id":"${id}","entry_id":"e1","scheme":"s","scheme_version":1,` +
  `"label":"l","created_at":"2026-10-02T00:00:00.000Z"}`;

const TYPE_LINE = '{"kind":"type","document":{"name":"note","version":1}}';

function idsOf(...texts: string[]): readonly Baseline[] {
  return [{ label: 'HEAD', ids: new Set(texts) }];
}

describe('scanRecordFile', () => {
  it('collects entry and annotation ids and ignores id-less lines', () => {
    const scan = scanRecordFile([TYPE_LINE, ENTRY('a'), ANNOTATION('b')].join('\n') + '\n', 'f');
    expect(scan.ids).toEqual(['a', 'b']);
    expect(scan.bad).toEqual([]);
  });

  it('names each of git’s conflict markers, including the diff3 base', () => {
    const text = [
      '<<<<<<< HEAD',
      ENTRY('a'),
      '||||||| base',
      '=======',
      ENTRY('b'),
      '>>>>>>> other',
    ].join('\n');
    const scan = scanRecordFile(text, 'f');
    expect(scan.ids).toEqual(['a', 'b']);
    expect(scan.bad.map((entry) => entry.line)).toEqual([1, 3, 4, 6]);
    expect(scan.bad.every((entry) => entry.problem.includes('conflict marker'))).toBe(true);
  });

  it('flags a line that is not JSON, and one that is JSON but not a record line', () => {
    const scan = scanRecordFile(
      ['not json at all', '{"unterminated":', '{"no":"kind"}', '[1,2]'].join('\n'),
      'f',
    );
    expect(scan.bad.map((entry) => entry.problem)).toEqual([
      'not valid JSON',
      'not valid JSON',
      'not a record line (no "kind")',
      'not a record line (JSON that is not an object)',
    ]);
  });

  /**
   * The diagnosis names the field that is actually wrong (bug-hunt #14).
   *
   * `{"kind":"entry","id":7}` has a perfectly well-known `kind`; what it lacks is a usable `id`.
   * Reporting it as `unknown "kind"` sent the reader to the wrong field, in the one string this
   * module exists to produce -- the docblock says a caller fixes a tree from it.
   */
  it('says the id is wrong when the kind is known, rather than blaming the kind', () => {
    const scan = scanRecordFile(
      [
        '{"kind":"entry","id":7}',
        '{"kind":"annotation"}',
        '{"kind":"entry","id":"ok"}',
        '{"kind":"type","name":"note"}',
      ].join('\n'),
      'f',
    );
    expect(scan.bad.map((entry) => entry.problem)).toEqual([
      'not a record line ("entry" with no string "id")',
      'not a record line ("annotation" with no string "id")',
    ]);
    // The two legitimate lines are not flagged at all: an entry with a string id, and a type line,
    // which carries no id by design.
    expect(scan.ids).toEqual(['ok']);
  });

  it('does not mistake record content for a marker', () => {
    const line = `{"kind":"entry","id":"a","note":"======= a row of equals inside a value"}`;
    const scan = scanRecordFile(line, 'f');
    expect(scan.bad).toEqual([]);
    expect(scan.ids).toEqual(['a']);
  });

  it('skips blank lines rather than refusing the file for its trailing newline', () => {
    const scan = scanRecordFile(ENTRY('a') + '\n\n', 'f');
    expect(scan.bad).toEqual([]);
    expect(scan.ids).toEqual(['a']);
  });

  it('carries no record content in a refusal, only a coordinate and a phrase', () => {
    const secret = '{"kind":"entry","id":"a","token":"sk-ant-abcdefghijklmnopqrstuvwx"}';
    const scan = scanRecordFile(`<<<<<<< HEAD\n${secret}`, 'f');
    expect(JSON.stringify(scan.bad)).not.toContain('sk-ant');
  });
});

describe('guardRecords', () => {
  it('passes when the candidate is a superset of the baseline', () => {
    const scans = [scanRecordFile([ENTRY('a'), ENTRY('b'), ENTRY('c')].join('\n'), 'f')];
    const report = guardRecords(scans, idsOf('a', 'b'));
    expect(report.ok).toBe(true);
    expect(report.ids).toBe(3);
    expect(report.lost).toEqual([]);
  });

  it('refuses a well-formed tree that dropped a record — the case EV-31 measured', () => {
    // Every line parses, no markers, no duplicates: a syntax check sees nothing wrong.
    const scans = [scanRecordFile([ENTRY('ra0'), ENTRY('r0')].join('\n'), 'f')];
    const report = guardRecords(scans, idsOf('r0', 'ra0', 'rb0'));
    expect(report.ok).toBe(false);
    expect(report.badLines).toEqual([]);
    expect(report.lost).toEqual([{ id: 'rb0', baseline: 'HEAD' }]);
  });

  it('names the baseline an id survives in, and reports a two-baseline loss once', () => {
    const scans = [scanRecordFile(ENTRY('a'), 'f')];
    const report = guardRecords(scans, [
      { label: 'HEAD', ids: new Set(['a', 'gone', 'both']) },
      { label: 'MERGE_HEAD', ids: new Set(['a', 'both']) },
    ]);
    expect(report.lost).toEqual([
      { id: 'gone', baseline: 'HEAD' },
      { id: 'both', baseline: 'HEAD' },
    ]);
  });

  it('surfaces bad lines with their file coordinate', () => {
    const scans = [
      scanRecordFile('<<<<<<< HEAD', 'a/0001.jsonl'),
      scanRecordFile('nope', 'b/0001.jsonl'),
    ];
    const report = guardRecords(scans, idsOf());
    expect(report.ok).toBe(false);
    expect(report.badLines).toEqual([
      { where: 'a/0001.jsonl', line: 1, problem: 'a git conflict marker left by a merge' },
      { where: 'b/0001.jsonl', line: 1, problem: 'not valid JSON' },
    ]);
  });

  it('an empty candidate against a non-empty baseline loses everything, not nothing', () => {
    const report = guardRecords([scanRecordFile('', 'f')], idsOf('a', 'b'));
    expect(report.ok).toBe(false);
    expect(report.lost.map((loss) => loss.id)).toEqual(['a', 'b']);
  });
});
