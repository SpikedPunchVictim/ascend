import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  scanTranscripts,
  streamCorpus,
  streamTranscript,
  type TranscriptRecord,
} from '../src/index.js';

/**
 * The I/O half of the reader, driven against a fixture corpus that reproduces
 * the real one's SHAPE: two projects, one main session per project, one nested
 * `subagents/` transcript, one path matching neither known shape, and one
 * non-JSONL file that must be ignored.
 *
 * The fixture's own numbers are asserted from the OS (`statSync`) rather than
 * from a constant this test also computes, so a change to the fixture files
 * cannot silently keep the test green.
 */

const CORPUS = fileURLToPath(new URL('./fixtures/corpus', import.meta.url));

const ALPHA = join(CORPUS, '-Users-me-projects-alpha');
const SESSION = join(ALPHA, '11111111-1111-4111-8111-111111111111.jsonl');
const SUBAGENT = join(
  ALPHA,
  '22222222-2222-4222-8222-222222222222',
  'subagents',
  'agent-aaaa.jsonl',
);
const BETA = join(CORPUS, '-Users-me-projects-beta', '33333333-3333-4333-8333-333333333333.jsonl');
const ODD = join(CORPUS, 'nested', 'odd', 'shape.jsonl');

const FIXTURES = [SESSION, SUBAGENT, BETA, ODD];
const NAMES = FIXTURES.map((path) => relative(CORPUS, path));
const fixtureBytes = (): number => FIXTURES.reduce((n, p) => n + statSync(p).size, 0);

const temp = (): string => mkdtempSync(join(tmpdir(), 'ascend-ct3-'));

/** A copy of the fixture corpus whose permissions this test is free to vandalize. */
const copy = (): string => {
  const dir = temp();
  cpSync(CORPUS, join(dir, 'corpus'), { recursive: true });
  return join(dir, 'corpus');
};

/**
 * A fixture path, re-rooted at a scratch copy.
 *
 * Every destructive test MUST go through this. An earlier version of this file
 * chmodded `BETA` directly -- the path inside the repository -- which left the
 * committed fixture unreadable, failed two unrelated tests in the same run, and
 * would have shipped a mode-000 file to every other machine. The paths are
 * derived from `CORPUS` precisely so that "which copy am I mutating" is never a
 * question this file answers by hand.
 */
const inRoot = (root: string, path: string): string => join(root, relative(CORPUS, path));

const scratch: string[] = [];
const scratchCopy = (): string => {
  const dir = copy();
  scratch.push(dir);
  return dir;
};

/**
 * Undo the permissions this file deliberately broke, so the scratch copy can
 * actually be deleted.
 *
 * `rmSync(recursive)` needs write+execute on a directory to descend it, so a
 * chmod-000 directory does not merely fail to delete -- it fails the afterAll,
 * which vitest reports as the whole file failing while all 18 tests pass.
 * Cleanup has to run in the reverse order of the damage.
 */
function unseal(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) unseal(path);
    else if (!entry.isSymbolicLink()) chmodSync(path, 0o600);
  }
}

afterAll(() => {
  for (const dir of scratch) {
    unseal(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** chmod 000 does not restrict root, so these tests cannot mean anything as root. */
const canVandalize = process.getuid === undefined || process.getuid() !== 0;

const collect = async (root: string): Promise<TranscriptRecord[]> => {
  const records: TranscriptRecord[] = [];
  await streamCorpus((record) => records.push(record), { root });
  return records;
};

describe('scanTranscripts: finding the corpus', () => {
  it('finds every .jsonl recursively and ignores everything else', async () => {
    const scan = await scanTranscripts(CORPUS);
    expect(scan.files.map((f) => f.path)).toEqual(FIXTURES);
    expect(scan.skipped).toEqual([]);
  });

  it('classifies every file it returns', async () => {
    const scan = await scanTranscripts(CORPUS);
    const byPath = new Map(scan.files.map((f) => [f.path, f]));
    expect(byPath.get(SESSION)?.kind).toBe('session');
    expect(byPath.get(SUBAGENT)?.kind).toBe('subagent');
    expect(byPath.get(SUBAGENT)?.project).toBe('-Users-me-projects-alpha');
    expect(byPath.get(ODD)?.kind).toBe('unclassified');
  });

  it('sorts by path so two sweeps of an unchanged corpus agree exactly', async () => {
    // Compared with `<`/`>`, not `localeCompare`: an ingest whose order varies
    // with the user's LANG is not reproducible, and this is where that is decided.
    const first = await scanTranscripts(CORPUS);
    const second = await scanTranscripts(CORPUS);
    expect(first.files.map((f) => f.path)).toEqual(second.files.map((f) => f.path));
    const sorted = [...first.files.map((f) => f.path)].sort();
    expect(first.files.map((f) => f.path)).toEqual(sorted);
  });

  it('reports an unreadable directory instead of aborting the walk', async () => {
    // One directory the user cannot read must not cost them the other 843 files.
    if (!canVandalize) return;
    const root = scratchCopy();
    chmodSync(join(root, 'nested'), 0o000);

    const scan = await scanTranscripts(root);
    expect(scan.skipped).toEqual([{ path: join(root, 'nested'), reason: 'unreadable' }]);
    expect(scan.files.map((f) => relative(root, f.path))).toEqual(
      NAMES.filter((name) => !name.startsWith('nested/')),
    );
  });

  it('does not follow a symlink, and says so', async () => {
    const root = scratchCopy();
    const link = join(root, 'linked.jsonl');
    symlinkSync(SESSION, link);

    const scan = await scanTranscripts(root);
    expect(scan.skipped).toEqual([{ path: link, reason: 'symlink' }]);
    expect(scan.files.map((f) => f.path)).not.toContain(link);
  });
});

describe('streamTranscript: counting what it read', () => {
  it('separates parsed, blank and malformed lines', async () => {
    const file = (await scanTranscripts(CORPUS)).files.find((f) => f.path === SESSION);
    const counters = await streamTranscript(file!, () => {});

    // 5 physical lines: 3 records, 1 blank, 1 truncated tail.
    expect(counters.lines).toBe(5);
    expect(counters.parsed).toBe(3);
    expect(counters.empty).toBe(1);
    expect(counters.malformed).toBe(1);
    expect(counters.incomplete).toBe(false);
    expect(counters.reason).toBeNull();
  });

  it('counts bytes exactly, agreeing with the operating system', async () => {
    const file = (await scanTranscripts(CORPUS)).files.find((f) => f.path === SESSION);
    const counters = await streamTranscript(file!, () => {});
    expect(counters.bytes).toBe(statSync(SESSION).size);
  });

  it('does NOT reproduce the spike byte-counter error', async () => {
    // The spike summed `line.length + 1`. `length` is UTF-16 code units, not
    // bytes, so that undercounts every non-ASCII line. This fixture contains
    // CJK precisely so the two numbers must differ -- if they ever agree, the
    // byte counter has regressed to arithmetic that cannot see the difference.
    const raw = readFileSync(SESSION, 'utf8');
    const yielded = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
    const spikeArithmetic = yielded.reduce((n, line) => n + line.length + 1, 0);

    const file = (await scanTranscripts(CORPUS)).files.find((f) => f.path === SESSION);
    const counters = await streamTranscript(file!, () => {});

    expect(counters.bytes).toBe(statSync(SESSION).size);
    expect(spikeArithmetic).not.toBe(counters.bytes);
  });

  it('hands each record its file context and its 1-based PHYSICAL line number', async () => {
    // Physical, blank lines included, because the number is for finding the line
    // again in an editor: "line 2 of that file is blank" beats a count that
    // silently skips it.
    const file = (await scanTranscripts(CORPUS)).files.find((f) => f.path === SESSION);
    const seen: Array<{ line: number; type: unknown; project: string }> = [];
    await streamTranscript(file!, (record, context, line) => {
      seen.push({ line, type: record['type'], project: context.project });
    });

    expect(seen.map((s) => s.line)).toEqual([1, 3, 4]);
    expect(seen.map((s) => s.type)).toEqual(['user', 'assistant', 'system']);
    expect(seen.every((s) => s.project === '-Users-me-projects-alpha')).toBe(true);
  });

  it('still delivers the records before a truncated tail', async () => {
    // The realistic damage: a process killed mid-write. Everything already
    // flushed is good data and throwing it away would lose a whole session to
    // its last byte.
    const records = await collect(CORPUS);
    expect(records.some((r) => r['type'] === 'system')).toBe(true);
  });

  it('reports a missing file as incomplete with a reason, without throwing', async () => {
    const counters = await streamTranscript(
      { path: join(CORPUS, 'gone.jsonl'), project: 'p', session: null, kind: 'session' },
      () => {},
    );
    expect(counters.incomplete).toBe(true);
    expect(counters.reason).toBe('ENOENT');
    expect(counters.parsed).toBe(0);
    expect(counters.bytes).toBe(0);
  });
});

describe('the reader splits on \\n and on nothing else', () => {
  const file = (path: string, kind: 'session' | 'subagent' | 'unclassified' = 'session') => ({
    path,
    project: 'p',
    session: 's',
    kind,
  });

  it('delivers a record holding U+2028 or U+2029 as ONE record', async () => {
    // Both are legal UNESCAPED inside a JSON string, and `node:readline` treats
    // both as line terminators. A reader built on readline therefore cuts a
    // perfectly valid record into fragments, which are then not-valid-JSON and
    // get counted as damage. This is not hypothetical: measured on the live
    // corpus, 843 files reported 98 malformed lines that splitting the same
    // bytes on `\n` alone showed did not exist.
    const dir = temp();
    scratch.push(dir);
    const path = join(dir, 'separators.jsonl');

    // Built from char codes, never pasted. A literal would be invisible in this
    // file, in the diff, and in any editor -- the probe would become its own
    // subject.
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const texts = [`before${LS}after`, `before${PS}after`, 'plain'];
    const types = ['user', 'assistant', 'system'];
    writeFileSync(
      path,
      `${types.map((type, i) => JSON.stringify({ type, text: texts[i] })).join('\n')}\n`,
    );

    // Anti-vacuity: the test means nothing unless the separators are really in
    // the bytes. `JSON.stringify` leaves them unescaped (ES2019 escaped lone
    // surrogates only), which is exactly why the corpus contains them raw.
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain(LS);
    expect(raw).toContain(PS);

    const seen: string[] = [];
    const observed: string[] = [];
    const counters = await streamTranscript(file(path), (record) => {
      seen.push(String(record['type']));
      observed.push(String(record['text']));
    });

    expect(counters.lines).toBe(3);
    expect(counters.parsed).toBe(3);
    expect(counters.malformed).toBe(0);
    expect(seen).toEqual(types);
    // Content, not just count: a reader that reassembled the fragments would
    // still be handing back records, and they would be the wrong records.
    expect(observed).toEqual(texts);
  });

  it('carries a record larger than one chunk across the chunk boundary', async () => {
    // Every other fixture here fits inside a single 64 KB chunk, so without this
    // the carry-and-resume path is never entered -- it could be entirely broken
    // and the rest of the file would stay green.
    const dir = temp();
    scratch.push(dir);
    const path = join(dir, 'large.jsonl');
    const padding = 'x'.repeat(300_000);
    writeFileSync(path, `${JSON.stringify({ type: 'user', padding })}\n`);

    const observed: string[] = [];
    const counters = await streamTranscript(file(path), (record) => {
      observed.push(String(record['padding']));
    });

    expect(counters.lines).toBe(1);
    expect(counters.parsed).toBe(1);
    expect(counters.malformed).toBe(0);
    expect(observed[0]).toHaveLength(300_000);
    // Exact against the OS, so a dropped or double-counted chunk cannot hide.
    expect(counters.bytes).toBe(statSync(path).size);
  });

  it('reassembles a multi-byte character split across a chunk boundary', async () => {
    // A 3-byte character does not divide the chunk size, so padding with CJK
    // guarantees that at least one character straddles a boundary. Decoding each
    // chunk independently would corrupt it into U+FFFD -- and the record would
    // still PARSE, so a count assertion would not notice. The assertion is on
    // the text.
    const dir = temp();
    scratch.push(dir);
    const path = join(dir, 'multibyte.jsonl');
    const text = '多'.repeat(50_000); // 150,000 bytes, several chunks
    writeFileSync(path, `${JSON.stringify({ type: 'user', text })}\n`);

    const observed: string[] = [];
    const counters = await streamTranscript(file(path), (record) => {
      observed.push(String(record['text']));
    });

    expect(counters.parsed).toBe(1);
    expect(counters.bytes).toBe(statSync(path).size);
    expect(observed[0]).toBe(text);
    expect(observed[0]?.includes('�')).toBe(false);
  });

  it('does not emit a phantom line when the file ends in a terminator', async () => {
    // The boundary between the carry and EOF: one trailing `\n` ends the last
    // record, it does not begin an empty one. Without the guard a file whose
    // last line is blank would report an extra `empty` line -- and every real
    // transcript ends in `\n`.
    const dir = temp();
    scratch.push(dir);
    const path = join(dir, 'trailing.jsonl');
    writeFileSync(path, '{"type":"user"}\n');

    const counters = await streamTranscript(file(path), () => {});
    expect(counters.lines).toBe(1);

    // A file with no terminator at all still has that final line.
    const unterminated = join(dir, 'unterminated.jsonl');
    writeFileSync(unterminated, '{"type":"user"}');
    const other = await streamTranscript(file(unterminated), () => {});
    expect(other.lines).toBe(1);
    expect(other.parsed).toBe(1);

    // And a genuinely blank last line IS a line.
    const blank = join(dir, 'blank.jsonl');
    writeFileSync(blank, '{"type":"user"}\n\n');
    const third = await streamTranscript(file(blank), () => {});
    expect(third.lines).toBe(2);
    expect(third.empty).toBe(1);
  });
});

describe('streamCorpus: totals and tolerance', () => {
  it('totals the fixture exactly', async () => {
    const totals = await streamCorpus(() => {}, { root: CORPUS });
    expect(totals.files).toBe(4);
    expect(totals.lines).toBe(9);
    expect(totals.parsed).toBe(7);
    expect(totals.empty).toBe(1);
    expect(totals.malformed).toBe(1);
    expect(totals.bytes).toBe(fixtureBytes());
    expect(totals.failures).toEqual([]);
    expect(totals.skipped).toEqual([]);
    expect(totals.aborted).toBe(false);
  });

  it('accounts for every line it counted', async () => {
    // parsed + empty + malformed === lines is the invariant that makes the
    // counters readable as a whole: any line that went missing from the tally
    // would be a line the reader silently dropped.
    const totals = await streamCorpus(() => {}, { root: CORPUS });
    expect(totals.parsed + totals.empty + totals.malformed).toBe(totals.lines);
  });

  it('reads the other files when one cannot be opened', async () => {
    // The self-healing headline. A single unreadable file must cost the sweep
    // that file, and nothing else.
    if (!canVandalize) return;
    const root = scratchCopy();
    chmodSync(inRoot(root, BETA), 0o000);

    const records = await collect(root);
    const totals = await streamCorpus(() => {}, { root });

    expect(totals.files).toBe(4);
    expect(totals.failures).toHaveLength(1);
    expect(totals.failures[0]?.path).toBe(inRoot(root, BETA));
    expect(totals.failures[0]?.reason).toBe('EACCES');
    expect(totals.parsed).toBe(6);
    expect(records).toHaveLength(6);
  });

  it('stops on an abort and reports partial totals rather than a failure', async () => {
    const controller = new AbortController();
    const totals = await streamCorpus(
      () => {
        controller.abort();
      },
      { root: CORPUS, signal: controller.signal },
    );

    expect(totals.aborted).toBe(true);
    expect(totals.parsed).toBe(1);
    expect(totals.files).toBe(4);
    // An abort is the caller's instruction, not damage: it must not be filed as
    // a transcript failure, or every Ctrl-C would look like a corrupt corpus.
    expect(totals.failures).toEqual([]);
  });
});

describe('the reader distinguishes a broken consumer from a broken transcript', () => {
  it('lets an exception from the visitor escape', async () => {
    // The one non-tolerant path, and the asymmetry is the point. A transcript
    // problem is counted and survived; a consumer problem is a bug in OUR code,
    // and swallowing it would report a small clean corpus where the truth is a
    // large broken one -- a false green.
    await expect(
      streamCorpus(
        () => {
          throw new Error('consumer bug');
        },
        { root: CORPUS },
      ),
    ).rejects.toThrow('consumer bug');
  });

  it('while the same sweep survives a transcript problem without throwing', async () => {
    // The contrast, in one place: damaged input resolves, a damaged consumer
    // rejects. Both halves are needed -- either alone would look the same as a
    // reader that never fails at all.
    await expect(
      streamTranscript(
        { path: join(CORPUS, 'gone.jsonl'), project: 'p', session: null, kind: 'unclassified' },
        () => {},
      ),
    ).resolves.toBeDefined();
  });
});

describe('scanTranscripts / streamCorpus: ephemeral OS temp projects (asc-80m)', () => {
  const EPHEMERAL_PROJECT = '-private-var-folders-41-fixt-T-ev18-arm-b-Zz11';
  const REAL_TEMP_PROJECT = '-Users-me-temp-realproject';

  /**
   * A fresh root holding one ephemeral-looking project, and one sibling that merely lives under a
   * path containing "temp" -- the counter-example the DECISION on `asc-80m` names, reproduced
   * here rather than only in `ephemeral.test.ts`, because this is the layer where it would
   * actually cost someone their data if the two were confused.
   */
  const buildRoot = (): string => {
    const dir = temp();
    scratch.push(dir);
    const ephemeralDir = join(dir, EPHEMERAL_PROJECT);
    const realDir = join(dir, REAL_TEMP_PROJECT);
    mkdirSync(ephemeralDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(ephemeralDir, '44444444-4444-4444-8444-444444444444.jsonl'),
      `${JSON.stringify({ type: 'user', text: 'from a benchmark tmpdir' })}\n`,
    );
    writeFileSync(
      join(realDir, '55555555-5555-4555-8555-555555555555.jsonl'),
      `${JSON.stringify({ type: 'user', text: 'a real project under a temp-ish path' })}\n`,
    );
    return dir;
  };

  it('skips the ephemeral project by default, reporting it rather than dropping it silently', async () => {
    const root = buildRoot();
    const scan = await scanTranscripts(root);

    expect(scan.files.some((f) => f.project === EPHEMERAL_PROJECT)).toBe(false);
    const skippedEphemeral = scan.skipped.filter((entry) => entry.reason === 'ephemeral');
    expect(skippedEphemeral).toHaveLength(1);
    expect(skippedEphemeral[0]?.project).toBe(EPHEMERAL_PROJECT);

    // The real project is never skipped: this is the counter-example the rule must not catch.
    expect(scan.files.some((f) => f.project === REAL_TEMP_PROJECT)).toBe(true);
    expect(scan.skipped.some((entry) => entry.project === REAL_TEMP_PROJECT)).toBe(false);
  });

  it('reads the ephemeral project when includeEphemeral is true, and it is no longer skipped', async () => {
    const root = buildRoot();
    const scan = await scanTranscripts(root, { includeEphemeral: true });

    expect(scan.files.some((f) => f.project === EPHEMERAL_PROJECT)).toBe(true);
    expect(scan.skipped.some((entry) => entry.reason === 'ephemeral')).toBe(false);

    // Still never skipped, in either mode.
    expect(scan.files.some((f) => f.project === REAL_TEMP_PROJECT)).toBe(true);
    expect(scan.skipped.some((entry) => entry.project === REAL_TEMP_PROJECT)).toBe(false);
  });

  it('streamCorpus propagates the option: the ephemeral file’s records are absent by default', async () => {
    const root = buildRoot();
    const records = await collect(root);
    expect(records.some((r) => r['text'] === 'from a benchmark tmpdir')).toBe(false);
    expect(records.some((r) => r['text'] === 'a real project under a temp-ish path')).toBe(true);
  });

  it('streamCorpus propagates the option: present with includeEphemeral: true', async () => {
    const root = buildRoot();
    const records: TranscriptRecord[] = [];
    await streamCorpus((record) => records.push(record), { root, includeEphemeral: true });
    expect(records.some((r) => r['text'] === 'from a benchmark tmpdir')).toBe(true);
  });
});

describe('the reader releases what it opens', () => {
  it('returns the descriptor count to baseline across many files', async () => {
    // Measured, not assumed: on an early exit a readline interface does not
    // destroy the stream it was handed, and the fd survives until GC. A sweep
    // that leaks one fd per file hits EMFILE partway through a real corpus.
    if (!existsSync('/dev/fd')) return;

    const dir = temp();
    scratch.push(dir);
    const many = join(dir, 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 300; i += 1) {
      writeFileSync(join(many, `${String(i).padStart(4, '0')}.jsonl`), '{"type":"user"}\n');
    }

    const before = readdirSync('/dev/fd').length;
    const totals = await streamCorpus(() => {}, { root: many });
    const after = readdirSync('/dev/fd').length;

    expect(totals.files).toBe(300);
    expect(totals.parsed).toBe(300);
    expect(after).toBeLessThanOrEqual(before);
  });
});
