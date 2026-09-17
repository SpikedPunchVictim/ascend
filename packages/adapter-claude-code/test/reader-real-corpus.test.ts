import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyTranscript,
  defaultTranscriptRoot,
  scanTranscripts,
  streamCorpus,
  streamTranscript,
  type TranscriptFile,
} from '../src/index.js';

/**
 * The reader driven against the REAL corpus, read-only.
 *
 * This is the test that would have caught the terminator bug, and no synthetic
 * fixture could have: `node:readline` splits on U+2028 and U+2029, both legal
 * unescaped inside a JSON string. Measured 2026-09-15 across all 843 real files,
 * on identical bytes: readline invented 83 line breaks (50 U+2028 + 33 U+2029)
 * and called 117 lines malformed, while splitting on `\n` alone called ZERO
 * malformed. The damage lived in 9 of 843 files -- common enough to corrupt a
 * derived count, rare enough that reading a sample by hand would miss it.
 *
 * TASKS.md is explicit that this is the standard: "Run against real data: the
 * 829 real transcripts in `~/.claude/projects/` ... Not a fixture you control."
 *
 * HOW IT CHECKS, and why this shape. The first version of this file asserted a
 * loose malformed-rate and an RSS ceiling. Mutation testing killed neither one:
 * readline's 117 malformed lines sat comfortably under an allowance of one per
 * file, and a reader that buffered an entire 107.5 MB file was invisible to RSS
 * because the streaming reader's own footprint is larger. Both assertions passed
 * against a deliberately broken reader, which is a check that fires never.
 *
 * What replaced them is a CONSERVATION LAW computed from the bytes on disk,
 * independently of the splitter:
 *
 *     lines delivered by the reader  ==  count of 0x0a in the file
 *                                        + 1 if the file does not end in 0x0a
 *
 * A reader that splits on `\n` satisfies this by construction. readline does not:
 * it delivers 83 extra "lines" the bytes do not contain. The same census yields
 * the byte total, cross-checking `counters.bytes` against the OS.
 *
 * COST, stated plainly: two passes over ~1.1 GiB, roughly 10 s. It SKIPS wherever
 * `~/.claude/projects` does not exist -- every machine but this one -- so it is a
 * local honesty check, not a portable CI gate.
 */

const ROOT = defaultTranscriptRoot();
const available = existsSync(ROOT);

/** Measured 2026-09-15: 843 files / 1.19 GiB. Floors, so an empty root cannot pass. */
const MIN_FILES = 100;
const MIN_BYTES = 100 * 1024 * 1024;

/**
 * Only files untouched for this long are judged by the conservation law.
 *
 * `~/.claude/projects` is a LIVE directory: other Claude Code sessions append to
 * it while this runs, and the census and the reader are two separate reads of the
 * same path. A file written between them fails a law it never broke.
 *
 * The age test alone does not close that, and an earlier version of this file
 * said it did -- "a file quiet for a minute is not going to be written in the next
 * ten milliseconds". The judgement loop measured 29,037 ms in a passing full-suite
 * run, so the window is the whole loop rather than the instant after the filter,
 * and a file one millisecond past the boundary is exposed to all of it. The age
 * test narrows the population; `judgeQuiet` below is what brackets each file that
 * is in it.
 *
 * Files excluded this way -- too young, or written while being judged -- are
 * COUNTED and asserted against, not silently dropped. On this machine the active
 * session is usually one of them, and a filter that quietly excluded everything
 * would turn this test into the vacuous one it replaced.
 */
const QUIET_MS = 60_000;

/**
 * How much of the corpus the quiet filter must have selected.
 *
 * Checked BEFORE the loop, deliberately: this is the cheap statement that the
 * filter did not swallow the corpus, and the loop costs half a minute, so a
 * corpus that would never be judged should fail in milliseconds instead. How
 * much of it the law actually reached is a different question, and `judgedBytes`
 * is what answers that one.
 */
const MIN_JUDGED_FILES = 400;

const FIXTURE_CORPUS = fileURLToPath(new URL('./fixtures/corpus', import.meta.url));

interface Census {
  /** The number of `0x0a` bytes in the file. */
  readonly newlines: number;
  readonly bytes: number;
  readonly last: number;
}

/** Count terminators and bytes straight off the disk, with no reader involved. */
async function census(path: string): Promise<Census> {
  let newlines = 0;
  let bytes = 0;
  let last = -1;

  const chunks: AsyncIterable<Buffer> = createReadStream(path);
  for await (const chunk of chunks) {
    bytes += chunk.length;
    // `indexOf` rather than a per-byte loop: 1.19 GiB of byte-at-a-time JS is
    // seconds of the budget for nothing, and this finds 429,783 terminators
    // instead of 1,275,740,293 bytes.
    let at = chunk.indexOf(0x0a);
    while (at !== -1) {
      newlines += 1;
      at = chunk.indexOf(0x0a, at + 1);
    }
    if (chunk.length > 0) last = chunk[chunk.length - 1] ?? -1;
  }

  return { newlines, bytes, last };
}

/** What the conservation law says the reader must deliver for this census. */
const expectedLines = (c: Census): number =>
  c.bytes === 0 ? 0 : c.newlines + (c.last === 0x0a ? 0 : 1);

/**
 * Every way the reader can disagree with the bytes, for one file.
 *
 * `quiet` says whether the file is known to be complete, and it decides one
 * check. The fixture corpus CONTAINS a deliberately truncated tail -- proving
 * the reader survives damage is the fixture's whole job -- so forbidding
 * malformed lines there would contradict the input rather than test the code.
 * A quiet file in the real corpus has nothing writing it and was measured at
 * zero malformed, so there the same check is the strongest statement available.
 *
 * `visit` is the reader's own per-line callback, passed straight through. The
 * real-corpus caller uses the default no-op; the bracket demonstration below
 * uses it to order a write into the reader's pass with no sleep and no race.
 */
async function disagreements(
  file: TranscriptFile,
  c: Census,
  quiet: boolean,
  visit: () => void = () => {},
): Promise<string[]> {
  const counters = await streamTranscript(file, visit);
  const problems: string[] = [];

  const expected = expectedLines(c);
  if (counters.lines !== expected) {
    problems.push(
      `${file.path}: lines ${String(counters.lines)} != ${String(expected)} in the bytes`,
    );
  }
  if (counters.bytes !== c.bytes) {
    problems.push(
      `${file.path}: bytes ${String(counters.bytes)} != ${String(c.bytes)} in the bytes`,
    );
  }
  // Counted, not skipped: a reader that dropped records would otherwise keep the
  // line count honest while losing the data behind it.
  if (counters.lines !== counters.parsed + counters.empty + counters.malformed) {
    problems.push(
      `${file.path}: ${String(counters.lines)} lines != ` +
        `${String(counters.parsed)}+${String(counters.empty)}+${String(counters.malformed)} counted`,
    );
  }

  // This is the check the line-count law cannot be. A reader that loses its
  // place mid-file -- the carry dropped at a chunk boundary is the case that
  // proved it -- corrupts line CONTENT while leaving the COUNT intact, because
  // the discarded fragment holds no terminator: the bytes would agree, the count
  // would agree, and every record spanning a boundary would be silently wrong.
  if (quiet && counters.malformed > 0) {
    problems.push(`${file.path}: ${String(counters.malformed)} malformed lines in a quiet file`);
  }

  return problems;
}

/**
 * A file's mtime, or `null` when it cannot be read.
 *
 * Both a `null` stat and a changed one mean the same thing to every caller here:
 * the file is in flight, and no law may be applied to the bytes under it.
 */
function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

interface Judged {
  readonly problems: readonly string[];
  /** What the law says the reader must deliver, from the census alone. */
  readonly lines: number;
  readonly bytes: number;
}

/**
 * Judge one quiet file, bracketed by a stat on each side of the pair.
 *
 * `null` means the file was written while it was being judged, so the caller
 * counts it as excluded rather than holding it to a law the bytes under it broke.
 *
 * The bracket spans BOTH passes -- `census` reads the file off the disk and the
 * reader inside `disagreements` reads it again -- because the phantom problem
 * needs only the write to land between them, and nothing narrower catches that.
 * A stat taken before the loop instead brackets nothing: the loop runs for tens
 * of seconds, and the age filter cannot speak for what happens during them.
 */
async function judgeQuiet(
  file: TranscriptFile,
  visit: () => void = () => {},
): Promise<Judged | null> {
  const before = mtimeMs(file.path);
  const c = await census(file.path);
  const problems = await disagreements(file, c, true, visit);
  const after = mtimeMs(file.path);

  if (before === null || after === null || before !== after) return null;
  return { problems, lines: expectedLines(c), bytes: c.bytes };
}

describe('the conservation law itself', () => {
  it('agrees with the fixture corpus, whose numbers are known', async () => {
    // Testing the test. The law is the thing doing the work in the real-corpus
    // check below, so it is validated where the answer is already pinned: the
    // fixture corpus is 9 physical lines across 4 files, and `reader.test.ts`
    // asserts that from the reader's side. The census must arrive at 9 from the
    // bytes alone, or the law is wrong rather than the reader.
    const scan = await scanTranscripts(FIXTURE_CORPUS);
    let total = 0;
    let malformed = 0;
    for (const file of scan.files) {
      const c = await census(file.path);
      total += expectedLines(c);
      // `quiet: false` -- the fixture's truncated tail is deliberate.
      expect(await disagreements(file, c, false)).toEqual([]);
      malformed += (await streamTranscript(file, () => {})).malformed;
    }

    expect(total).toBe(9);
    // And the harness is not blind to damage: the fixture's one truncated tail
    // must still be counted, or `malformed` is a number nothing can move.
    expect(malformed).toBe(1);
  });

  it('would fire on a reader that splits on more than \\n', () => {
    // The law is only worth stating if a wrong reader violates it. This builds a
    // file whose bytes hold one terminator but two readline lines, and shows the
    // census disagrees with readline's count while agreeing with `\n`'s. The
    // character is built from char codes -- a literal U+2028 is invisible here,
    // in the diff, and in every editor.
    const LS = String.fromCharCode(0x2028);
    const line = `${JSON.stringify({ type: 'user', text: `a${LS}b` })}\n`;
    const c: Census = { newlines: 1, bytes: Buffer.byteLength(line, 'utf8'), last: 0x0a };

    expect(expectedLines(c)).toBe(1);
    expect(line.split(LS).length - 1).toBe(1); // readline's view: two lines
  });
});

describe('the quiet-window bracket', () => {
  /**
   * A transcript of `n` well-formed lines.
   *
   * The reader and the census are the REAL ones here; only the bytes are made
   * up. `~/.claude/projects` is read-only, and the hazard cannot be demonstrated
   * against it without writing to it -- so the corpus is a scratch copy of the
   * shape, which is the part that matters, rather than the real thing.
   */
  const lines = (n: number): string =>
    `${Array.from({ length: n }, (_unused, i) => JSON.stringify({ type: 'user', text: `line ${String(i)}` })).join('\n')}\n`;

  it('discards a judgement made across a write, and reports one unbracketed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ascend-dh0-2-'));
    try {
      const project = join(root, '-tmp-project');
      mkdirSync(project, { recursive: true });
      const path = join(project, 'session.jsonl');
      writeFileSync(path, lines(3), 'utf8');
      const file = classifyTranscript(root, path);

      // THE LOSING ARM. The same census/reader pair with no stat on either side
      // -- which is what this file did before the bracket existed. The write is
      // ORDERED between the two passes rather than raced into them, so this is
      // the hazard itself and not a coin flip. If it ever stops disagreeing, the
      // bracket below is guarding against nothing and this test should say so.
      const c = await census(path);
      appendFileSync(path, lines(1), 'utf8');
      expect(await disagreements(file, c, true)).not.toEqual([]);

      // THE SHIPPED BRACKET, over the same scenario. Its write is triggered from
      // the reader's own per-line callback, so it lands inside the pair without a
      // sleep and without depending on how the kernel schedules an append against
      // a read. Written once: the point is one write inside the window, not a
      // file that grows while it is being read.
      let wrote = false;
      const judged = await judgeQuiet(file, () => {
        if (wrote) return;
        wrote = true;
        appendFileSync(path, lines(1), 'utf8');
      });

      expect(wrote).toBe(true); // the bracket was actually exercised
      expect(judged).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!available)('the reader against the real corpus', () => {
  it('delivers exactly the lines the bytes contain, for every quiet file', async () => {
    const scan = await scanTranscripts(ROOT);
    const cutoff = Date.now() - QUIET_MS;

    const quiet: TranscriptFile[] = [];
    const active: string[] = [];
    for (const file of scan.files) {
      // An unreadable `stat` means the file left between the walk and here; that
      // is the same in-flight traffic the quiet window exists to exclude.
      const mtime = mtimeMs(file.path);
      if (mtime === null) active.push(file.path);
      else if (mtime < cutoff) quiet.push(file);
      else active.push(file.path);
    }

    expect(scan.skipped).toEqual([]);
    expect(quiet.length).toBeGreaterThanOrEqual(MIN_JUDGED_FILES);

    const problems: string[] = [];
    const moved: string[] = [];
    let judgedFiles = 0;
    let judgedLines = 0;
    let judgedBytes = 0;
    for (const file of quiet) {
      const judged = await judgeQuiet(file);
      if (judged === null) {
        // Written while this loop was running. Counted, and counted as NOT
        // judged: no law was applied to it, so it must not pad the totals below.
        moved.push(file.path);
        continue;
      }
      problems.push(...judged.problems);
      judgedFiles += 1;
      judgedLines += judged.lines;
      judgedBytes += judged.bytes;
      if (problems.length > 20) break; // enough to diagnose; not 843 lines of it
    }

    // readline scored 9 failures here out of 843 files.
    expect(problems).toEqual([]);
    expect(judgedBytes).toBeGreaterThanOrEqual(MIN_BYTES);
    expect(judgedLines).toBeGreaterThan(0);
    // Every quiet file is accounted for -- judged, or written while the loop ran.
    // Stated only when the loop reached the end, because an early break is
    // already reported by `problems` above and would otherwise fail here too,
    // with a message that says less about what went wrong.
    if (problems.length === 0) {
      expect(judgedFiles + moved.length).toBe(quiet.length);
    }
    // The excluded files are reported, so a filter that swallowed the corpus
    // cannot read as a clean pass.
    expect(active.length + quiet.length).toBe(scan.files.length);
  }, 300_000);

  it('holds the corpus in memory only as PATHS, not as bytes', async () => {
    // WHAT THIS CATCHES: a reader that keeps the corpus. That is the failure that
    // makes the tool unusable -- roughly 1,190% of input, or an OOM on a bigger
    // one. Measured 2026-09-15: peak RSS 234.0 MB against a 46.3 MB baseline, a
    // 15.4% delta. 40% sits far below the failure and far above the measurement.
    //
    // WHAT IT DOES NOT CATCH, said plainly because a threshold that overclaims is
    // worse than no threshold: holding ONE file (the largest is 107.5 MB, 8.8% of
    // input) is invisible here and would measure LOWER than the streaming
    // reader's own 15.4%. Measured: a buffer-the-whole-file mutation PASSES this
    // assertion. It is kept because it is the only check on the corpus-scale
    // bound, not because it is sufficient.
    const before = process.memoryUsage.rss();
    let peak = before;
    const sample = setInterval(() => {
      const rss = process.memoryUsage.rss();
      if (rss > peak) peak = rss;
    }, 100);

    const totals = await streamCorpus(() => {}, { root: ROOT });
    clearInterval(sample);

    expect(totals.files).toBeGreaterThanOrEqual(MIN_FILES);
    expect(totals.bytes).toBeGreaterThanOrEqual(MIN_BYTES);
    expect(totals.failures).toEqual([]);
    expect(totals.aborted).toBe(false);
    expect((peak - before) / totals.bytes).toBeLessThan(0.4);
  }, 300_000);
});

describe.skipIf(available)('the real corpus is not present', () => {
  it('reports that the real-data checks did not run', () => {
    // A skip that says nothing reads as a pass. Where the corpus is absent --
    // every machine but the one this was built on -- the real-data checks above
    // do not run, and `TASKS.md` requires that limitation be stated rather than
    // implied. Vitest has no warning channel, so this test exists to put the
    // limitation in the summary and to pin that the branch is real. It is a
    // NOTICE, not a check, and it asserts nothing about the reader.
    expect(available).toBe(false);
  });
});
