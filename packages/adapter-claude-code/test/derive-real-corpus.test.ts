import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateEntry } from '@ascend/core';
import {
  DERIVED_SOURCE,
  DERIVED_TYPES,
  createDeriver,
  defaultTranscriptRoot,
  streamCorpus,
  type DerivedEntry,
} from '../src/index.js';

/**
 * The deriver driven against the REAL corpus, read-only.
 *
 * `derive.test.ts` proves the RULES. This proves the rules and the DEFINITIONS agree on data
 * nobody chose -- which is a different claim and the one that matters, because the two are
 * written in separate files and the failure mode of a disagreement is an entry that fails
 * validation at ingest, after a sweep has already reported success.
 *
 * MEASURED 2026-09-15 (843 files, 431,039 records, 1,488 entries -- 486 verification_run, 457
 * tool_denial, 438 context_compaction, 87 skill_activation, 20 user_correction -- with 0
 * rejected, 0 warnings, 0 duplicate keys, 0 unkeyable, 0 unverdictable, 6 key collisions, in
 * 5.2 s) and RE-MEASURED 2026-10-14 on `~/.claude/projects` (read-only): 2,262 files,
 * 1,122,135 records, 3,323 entries -- 1490 verification_run, 1147 context_compaction, 504
 * tool_denial, 138 skill_activation, 36 review_finding, 8 user_correction -- with 0 rejected, 0
 * warnings, 0 repeats of a key within one file, 0 unkeyable, 0 unverdictable, and 4 keys
 * repeated across two files each. The second reading is where `review_finding` first appeared at
 * all, and both are already stale: they are readings of a LIVE corpus, which is why no count
 * below is asserted.
 *
 * HOW IT CHECKS. Not by asserting those counts, which move: `~/.claude/projects` is LIVE, and
 * this session's own transcript is in it (measured 2026-10-14: `tool_denial` rose from 504 to
 * 505 between two sweeps taken minutes apart while this line was being written). Counting is a
 * snapshot; what is asserted instead is everything that is true at ANY corpus size:
 *
 *   1. Every entry validates against its own spec, with no errors AND no warnings.
 *   2. Every key is unique.
 *   3. Nothing was dropped for want of an identity: unkeyable and unverdictable are 0.
 *   4. Counters conserve: entries emitted == entries collected.
 *   5. Every entry carries its provenance properties.
 *   6. Floors, so a corpus that shrank to nothing cannot pass by asserting nothing.
 *
 * COST, stated plainly and RE-MEASURED 2026-10-13: the corpus is 3.8 GiB (`du -sh
 * ~/.claude/projects`) and one pass over it costs 69,451 ms on an otherwise idle machine
 * (loadavg 30 on 12 cores). The date matters, because this line used to read *"~1.2 GiB,
 * roughly 7 s"* and that was true when it was written: the corpus is LIVE and grew 3.2x in
 * bytes between the 2026-09-15 measurement above and this one, which took one pass from
 * 5.2 s to 69.5 s. Under the full suite the same pass measured 169 s, because every other
 * file's real-process work competes for the same cores. `SWEEP_BUDGET_MS` below is priced
 * against that worst case and carries the reason.
 *
 * It SKIPS wherever `~/.claude/projects` does not exist -- every machine but this one -- so
 * it is a local honesty check, not a portable CI gate. `reader-real-corpus.test.ts` carries
 * the same caveat.
 */

const ROOT = defaultTranscriptRoot();
const available = existsSync(ROOT);

/** Measured 2026-10-14: 2,262 files / 1,122,135 records / 3,323 entries. Floors, not targets. */
const MIN_FILES = 100;
const MIN_RECORDS = 100_000;
const MIN_ENTRIES = 200;

/**
 * Per-type floors, set well below the measured count for a live corpus.
 *
 * A floor of zero would be the vacuous assertion this file exists to avoid: a deriver that
 * emitted nothing at all would satisfy "every entry validates". These are the numbers that
 * make an empty result a failure.
 *
 * A floor is a claim about a POPULATION, so each type is read against two measured numbers
 * rather than one: how many entries the corpus derives, and how many sessions they came from. A
 * count from a single session cannot hold a floor against a corpus of forty-four, and writing
 * the pair down is what makes that visible instead of implied. RE-MEASURED 2026-10-14, entries
 * and sessions: verification_run 1490/24, context_compaction 1147/33, tool_denial 504/44,
 * skill_activation 138/32, review_finding 36/1, user_correction 8/5. Only `user_correction`
 * moved since: 3 on 2026-10-26, and its floor carries the reconciliation (`asc-kmb6`).
 */
const MIN_PER_TYPE: Readonly<Record<string, number>> = {
  verification_run: 50,
  tool_denial: 50,
  context_compaction: 50,
  skill_activation: 10,
  // RE-MEASURED 2026-10-26: 3 entries, down from 8 on 2026-10-14, and the floor moves 5 -> 1
  // because the drop is the CORPUS, not the deriver (`asc-kmb6`, `dogfood/0123`).
  //
  // The corpus is a WINDOW, not an archive: Claude Code reaps transcripts older than about
  // thirty days, and the oldest surviving one is 2026-09-23. An instrumented pass reports the
  // same 3 and names a file still on disk for each (occurred_at 2026-09-27, 2026-10-09,
  // 2026-10-22), so 8 - 3 = 5 corrections left with no file left to read. The reconciliation is
  // exact, which is the only reason that is a mechanism rather than a guess -- a drop that did
  // not add up would be a deriver defect wearing the same message.
  //
  // SO THE FLOOR IS 1, not a number a little below 3. A floor above a retention-bounded ceiling
  // is a floor that expires by calendar, and any absolute value here is a prediction about the
  // next thirty days of one person's behaviour. What a floor can still assert for a type this
  // rare is that it derives at all; catching a deriver that emits nothing is carried by the four
  // types that derive in the hundreds, and by MIN_ENTRIES.
  user_correction: 1,
  // `review_finding` is deliberately ABSENT, and the REASON has changed since this omission was
  // written. It used to be that the corpus derived zero of it -- no `ReportFindings` call in
  // 1,236 transcript files (`asc-gtnu`, re-measured 2026-09-26) -- so a floor here would have had
  // to be 0, which is the vacuous assertion the note above refuses, while 1 would have made this
  // file red on every machine until the first reviewer reported. The type is no longer
  // unexercised: the corpus derives 36, measured 2026-10-14, and the sentence that said
  // otherwise is now simply false. THE OMISSION STANDS ON A DIFFERENT FACT. All 36 come from one
  // session, and it is the session that took the measurement, so there is no population to floor
  // -- n=1 is an anecdote by this repository's own `MIN_N` rule, and a floor of 36 would be a
  // floor on one reviewer's single sitting, which is the same gate-teaching disease in a new
  // costume. What would change it is a second and third session reporting findings, and until
  // then the honest place for "36, from one session" is `derived-types.ts`'s count table while
  // the honest place for the rule itself stays `asc-gtnu.3`'s fixture test.
};

interface Sweep {
  readonly totals: { readonly files: number; readonly parsed: number; readonly malformed: number };
  readonly failures: number;
  readonly entries: readonly DerivedEntry[];
  readonly byType: Readonly<Record<string, number>>;
  readonly invalid: readonly string[];
  readonly warned: readonly string[];
  /**
   * One item per raw-key group this sweep emitted more than once, carrying how many FILES held it.
   * A duplicate that spans one file would be a genuine deriver defect; the measured corpus has none
   * (`asc-hbxl`), so this is what the uniqueness test asserts instead of "no duplicate ever".
   */
  readonly duplicateGroups: readonly { readonly files: number }[];
  readonly missingProvenance: readonly string[];
  /** Entries with no envelope `cwd` / `branch`, named by type. */
  readonly withoutCwd: readonly string[];
  readonly withoutBranch: readonly string[];
  /** How many distinct REAL working directories and branches the sweep saw. */
  readonly distinctCwds: number;
  readonly distinctBranches: number;
  /** How many distinct encoded project labels those collapse into -- `project`, not `cwd`. */
  readonly distinctProjects: number;
  readonly repeatedKeys: number;
  readonly unkeyable: number;
  readonly unverdictable: number;
  readonly countersEntries: number;
}

const specs = new Map(DERIVED_TYPES.map((spec) => [spec.name, spec]));

async function sweep(): Promise<Sweep> {
  const deriver = createDeriver();
  const entries: DerivedEntry[] = [];
  const byType: Record<string, number> = {};
  const invalid: string[] = [];
  const warned: string[] = [];
  const missingProvenance: string[] = [];
  const withoutCwd: string[] = [];
  const withoutBranch: string[] = [];
  const cwds = new Set<string>();
  const branches = new Set<string>();
  const projects = new Set<string>();
  // identity -> the FILES it was emitted from, and how many times. A repeat that stayed inside one
  // file would be a deriver defect; a repeat across files is the corpus carrying one event twice
  // (`asc-hbxl`). Tracking the file set is what lets a test tell the two apart.
  const identities = new Map<string, { readonly files: Set<string>; n: number }>();

  const collect = (entry: DerivedEntry, filePath: string): void => {
    entries.push(entry);
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;

    const identity = `${entry.type}|${entry.key}`;
    const group = identities.get(identity);
    if (group === undefined) {
      identities.set(identity, { files: new Set([filePath]), n: 1 });
    } else {
      group.files.add(filePath);
      group.n += 1;
    }

    for (const name of ['session_id', 'project']) {
      if (!Object.hasOwn(entry.properties, name)) missingProvenance.push(`${entry.type}.${name}`);
    }

    if (entry.cwd === undefined) withoutCwd.push(entry.type);
    else cwds.add(entry.cwd);
    if (entry.branch === undefined) withoutBranch.push(entry.type);
    else branches.add(entry.branch);
    const project = entry.properties['project'];
    if (typeof project === 'string') projects.add(project);

    const spec = specs.get(entry.type);
    if (spec === undefined) {
      invalid.push(`${entry.type}: no definition exists for this type`);
      return;
    }
    const result = validateEntry(spec, { properties: entry.properties });
    for (const issue of result.errors) {
      invalid.push(`${entry.type}.${issue.field}: ${issue.problem}`);
    }
    for (const issue of result.warnings) {
      warned.push(`${entry.type}.${issue.field}: ${issue.problem}`);
    }
  };

  let lastFile = '';
  const totals = await streamCorpus((record, file) => {
    lastFile = file.path;
    for (const entry of deriver.accept(record, file)) collect(entry, file.path);
  }, {});
  // `drain` flushes what the FINAL file left pending, so its entries came from `lastFile` too.
  for (const entry of deriver.drain()) collect(entry, lastFile);

  return {
    totals: { files: totals.files, parsed: totals.parsed, malformed: totals.malformed },
    failures: totals.failures.length,
    entries,
    byType,
    invalid,
    warned,
    duplicateGroups: [...identities.values()]
      .filter((group) => group.n > 1)
      .map((group) => ({ files: group.files.size })),
    missingProvenance,
    withoutCwd,
    withoutBranch,
    distinctCwds: cwds.size,
    distinctBranches: branches.size,
    distinctProjects: projects.size,
    repeatedKeys: deriver.counters.repeatedKeys,
    unkeyable: deriver.counters.unkeyable,
    unverdictable: deriver.counters.unverdictable,
    countersEntries: deriver.counters.entries,
  };
}

/**
 * The budget ONE full sweep is given, derived from measurement rather than chosen by feel.
 *
 * MEASURED 2026-10-13 against the corpus as it stood (3.8 GiB): one sweep cost 69,451 ms on
 * an otherwise idle machine (loadavg 30.14 on 12 cores) and 169 s inside the full suite,
 * where all 144 files are competing for the same cores. 300,000 ms is ~1.8x the worst
 * measured sweep and ~4.3x the quiet one.
 *
 * IT IS NOT PERMANENT, AND THIS COMMENT IS THE REASON IT WILL BE RE-PRICED RATHER THAN
 * EDITED. The corpus is live: it grew from ~1.2 GiB to 3.8 GiB between 2026-09-15 and
 * 2026-10-13 and one pass went from 5.2 s to 69.5 s. `dogfood/0007` priced 5x headroom on
 * this same walk once and recorded that the budget would come back; `dogfood/0085` and
 * `asc-9pto` are the return. When a sweep approaches this bound, MEASURE AGAIN -- the two
 * numbers above are how, and `test-failures.log` carries the loadavg of any red -- and
 * re-price it. Raising it until the red stops is how a bound becomes a number people edit
 * instead of a claim about the work.
 *
 * The same budget covers the file's ONE deliberate second sweep, in `produces keys that are
 * stable across two independent sweeps`. Before this constant the two sweeps were bounded
 * differently in the same file -- 120 s for whichever test paid the shared walk, 180 s for
 * the independent one -- which is the inconsistency that reddened first.
 */
const SWEEP_BUDGET_MS = 300_000;

describe.skipIf(!available)('the deriver against the real corpus', () => {
  /**
   * The one sweep every test below reads, PAID FOR HERE.
   *
   * This used to be a lazy module-level memo that the first test in the file triggered, which
   * made whichever test happened to run first the one charged for the walk. That is a
   * REPORTING defect rather than a cost one, and it is what `asc-9pto` / `dogfood/0085`
   * records: when the sweep outran that test's own 120 s bound, the red named a test that had
   * done nothing but await, and the NEXT test inherited the remainder of the same in-flight
   * promise and reported that remainder as its own duration. Measured 2026-10-13 in one gate
   * run: the payer timed out at 120,033 ms and the next test reported 48,743 ms for a body
   * whose only statement is `await once()`. A sweep paid in `beforeAll` sits under
   * `SWEEP_BUDGET_MS`, is attributed to the FILE when it is slow, and leaves every test body
   * with nothing to time.
   */
  let swept: Sweep | undefined;

  beforeAll(async () => {
    swept = await sweep();
  }, SWEEP_BUDGET_MS);

  /** The shared sweep, which the `beforeAll` above has already paid for. */
  const once = (): Sweep => {
    if (swept === undefined) {
      throw new Error('the shared sweep did not run -- beforeAll did not reach its assignment');
    }
    return swept;
  };

  it('derives entries that all satisfy their own definitions', () => {
    const result = once();

    // The headline claim, and the one that would be false if the specs and the
    // deriver ever drifted apart. Both lists are printed rather than counted, so
    // a failure names the property and the problem instead of a number.
    expect(result.invalid.slice(0, 20)).toEqual([]);
    expect(result.warned.slice(0, 20)).toEqual([]);

    expect(result.totals.files).toBeGreaterThan(MIN_FILES);
    expect(result.totals.parsed).toBeGreaterThan(MIN_RECORDS);
    expect(result.entries.length).toBeGreaterThan(MIN_ENTRIES);
    expect(result.failures).toBe(0);

    for (const [type, floor] of Object.entries(MIN_PER_TYPE)) {
      expect(result.byType[type] ?? 0, `${type} fell below its floor`).toBeGreaterThanOrEqual(
        floor,
      );
    }
  }, 120_000);

  it('repeats a key only across FILES, and drops nothing for want of an identity', () => {
    const result = once();

    // A key is a pure function of the event now (`asc-hbxl`), so the SAME key legitimately appears
    // more than once when one event is carried by two transcript files -- that is how the store
    // recognises the second copy. What must NEVER happen is a repeat inside a single file: one
    // transcript does not carry its own record uuid twice, so that would be a deriver defect, and
    // this asserts the measured 0 directly rather than asserting the weaker "no duplicate ever".
    const withinOneFile = result.duplicateGroups.filter((group) => group.files === 1);
    expect(withinOneFile).toEqual([]);

    // Both are the counter-example to a silent drop: an event recognised but not
    // emitted is invisible without these, and a sweep would report success while
    // the corpus was missing rows.
    expect(result.unkeyable).toBe(0);
    expect(result.unverdictable).toBe(0);
  }, 120_000);

  it('conserves: the counters agree with what was collected', () => {
    // A conservation law, in the spirit of the reader's: the deriver's own tally
    // and the entries a caller actually holds must be the same number. An entry
    // counted but not returned, or returned but not counted, is a drift that no
    // validation check above would notice.
    const result = once();
    expect(result.countersEntries).toBe(result.entries.length);
  }, 120_000);

  it('stamps the source the STORE will accept, which the type alone cannot promise', () => {
    // Deliberately not "every entry's source is DERIVED_SOURCE". That was the first
    // version of this test and `no-unnecessary-condition` killed it: `DerivedEntry.source`
    // is typed as the literal, so the comparison is statically always false and the
    // assertion could NEVER fail. A check that cannot fail looks exactly like one that
    // passes -- the failure class this project rates severity-zero -- so it was deleted
    // rather than lint-suppressed.
    //
    // What is asserted instead is the adapter's SIDE of that join: the constant the
    // deriver writes must be the literal the store's CHECK constraint admits. That
    // constraint is spelled ONCE, in `packages/store/src/schema.ts` -- look it up there
    // rather than here. This comment used to quote it, and a copy of a value list in a
    // comment is a SECOND declaration of the same fact with nothing tying the two
    // together: this one was written by the feature that added `derived:git`, so it was
    // correct the day it was written and a value short the next day, when
    // `observed:capture` landed (dogfood/0110).
    // and the store exports the same list as `ENTRY_SOURCES`. Neither package can
    // see the other here -- store depends on no adapter, and the adapter does not
    // depend on store -- so the two halves are pinned separately and joined where
    // both are visible, in the CLI test that drives `asc ingest claude-code`.
    expect(DERIVED_SOURCE).toBe('derived:claude-code');
    const result = once();
    expect(result.entries.length).toBeGreaterThan(0);
  }, 120_000);

  it('carries provenance on every entry, in properties that survive to disk', () => {
    // `session_id` and `project` are required, so their absence would already have
    // failed validation -- asserted here anyway because this is the property that
    // makes a derived entry resolvable to the transcript it came from, and because
    // an earlier version of this code populated the ENVELOPE's `occurredAt` while
    // never writing the `occurred_at` PROPERTY. A coverage number computed from
    // the envelope field was 100% while every stored entry was `not_measured`.
    const result = once();
    expect(result.missingProvenance.slice(0, 10)).toEqual([]);

    const withoutTime = result.entries.filter(
      (entry) => !Object.hasOwn(entry.properties, 'occurred_at'),
    );
    // Not `required` in the spec -- a transcript with no timestamp is a real
    // state -- so this asserts the MEASURED fact instead: every entry on this
    // corpus has one, and the day that stops being true this test says so rather
    // than the number quietly falling.
    expect(withoutTime.length).toBe(0);
  }, 120_000);

  it('carries the real cwd and branch, which the project label cannot express', () => {
    // `asc-5hs`. The measurement behind it: `project` is the ENCODED directory name, one per
    // project, and an agent works in subdirectories and worktrees under one -- so the labels
    // collapse. RE-MEASURED 2026-09-16 across every record, because the corpus is live and the
    // bead's own numbers are a date, not a constant:
    //
    //   records              459,399    of which 356,331 (77.6%) carry a `cwd`
    //   gitBranch            356,331    the SAME records -- the two co-occur exactly
    //   encoded projects          20    holding 301 distinct real working directories (15.1:1)
    //   worst collapse           123    123 distinct real working directories under ONE label
    //
    // The label's name is deliberately not quoted: this repository is public and the label is an
    // encoded absolute path, i.e. somebody's private project. The number is the evidence; the
    // name is not, and the assertion below never reads one.
    //
    // The bead measured 15 / 282 / 115 on 2026-09-15. Every one of those moved, in the same
    // direction, for the obvious reason: the corpus grew.
    //
    // The entries-only figures are smaller and are what the assertions below use, because the
    // five types that derive today key off TRIGGER records, not off every record: 1,607
    // entries, 0 without a cwd, 0 without a branch, over 14 projects and 84 real working
    // directories (6.0:1). Still five and still 1,607: the sixth type derives nothing, so it
    // neither adds an entry nor moves this denominator.
    const result = once();

    expect(result.withoutCwd.slice(0, 20)).toEqual([]);
    expect(result.withoutBranch.slice(0, 20)).toEqual([]);

    // THE ASSERTION THAT WOULD FAIL IF THE VALUE CAME FROM THE DIRECTORY NAME. A deriver reading
    // the label produces exactly one cwd per project, so this ratio would be 1:1 and the
    // assertion -- whose floor of 2 is deliberately far below the measured 6.0 -- goes red. It is
    // the check the emptiness assertions above cannot be, because "every entry has a cwd" is
    // satisfied by the label too: the label is never absent.
    expect(result.distinctProjects).toBeGreaterThan(1);
    expect(result.distinctCwds).toBeGreaterThan(result.distinctProjects * 2);

    // The second discarded dimension: 10 distinct branches measured, including `HEAD` and real
    // feature branches (`fix/search-scope`, `align/fixes-2026-08-20`), so "before or after the
    // branch moved" is answerable from here and was not before.
    expect(result.distinctBranches).toBeGreaterThan(1);

    // `asc-tlc`, folded into this sweep rather than a second one: every `cwd` this deriver
    // produces is now made relative to ITS OWN project's root by `projectRelativeCwd`, so none
    // of them may still start with `/` -- the check that the whole change actually works against
    // real transcripts, not only against the fixtures in `derive.test.ts`.
    const absolute = result.entries.filter((entry) => entry.cwd?.startsWith('/') === true);
    expect(absolute.length, 'entries whose cwd is still an absolute path').toBe(0);
  }, 120_000);

  it('keeps transcript prose out of the entries, except where the type IS the text', () => {
    // The reader's contract: no raw transcript text reaches a caller that prints.
    // `user_correction` is the one deliberate exception, and it must stay the only
    // one -- an accidental second would put user content into agent context on
    // every sweep.
    //
    // "ONLY", NOT "AT LEAST ONE", AND THE DIFFERENCE IS A RETENTION WINDOW (`asc-kmb6`,
    // `dogfood/0123`). On 2026-10-29 no surviving correction was of the shape that carries the
    // user's words: both were `AskUserQuestion` answers, which the deriver deliberately leaves
    // textless because the only prose there is the HARNESS's question (`derive.ts`,
    // `derive.test.ts` pins both shapes). A test that required the type to appear would go red on
    // a corpus behaving exactly as designed. What a live sweep can still assert is that no OTHER
    // type carries prose -- the safety property, true at any corpus size -- while "the words ARE
    // carried when a correction has words" stays where it is deterministic, in the fixtures.
    const result = once();
    const withText = result.entries.filter((entry) => entry.evidenceText !== undefined);
    const others = [...new Set(withText.map((entry) => entry.type))].filter(
      (type) => type !== 'user_correction',
    );
    expect(others).toEqual([]);
  }, 120_000);

  it(
    'produces keys that are stable across two independent sweeps',
    async () => {
      // Idempotency, which is what makes a re-ingest safe. This is the one test that
      // deliberately re-walks the corpus: the claim is about two INDEPENDENT reads
      // agreeing, so sharing one sweep would test nothing.
      const first = once();
      const second = await sweep();
      const a = new Set(first.entries.map((entry) => `${entry.type}|${entry.key}`));
      const b = new Set(second.entries.map((entry) => `${entry.type}|${entry.key}`));
      const shared = [...a].filter((key) => b.has(key));

      expect(shared.length).toBeGreaterThan(MIN_ENTRIES);

      // No tolerance any more, and the removal is the point (`asc-hbxl`). A key is a pure function of
      // the event, so two sweeps of a growing directory must agree on EVERY key the first one minted:
      // the corpus only grows, and a new transcript adds keys rather than moving any.
      //
      // Until `asc-hbxl` this allowed up to 1%, because `#2` disambiguation was sensitive to a file's
      // CONTENTS -- a still-growing file gaining a colliding record could shift a suffix and move an
      // id. That mechanism is retired: a repeat is counted, not suffixed, and the key no longer depends
      // on what else the sweep read. So the tolerance is dropped to `0`, which is the assertion the
      // defect could not survive.
      const missing = a.size - shared.length;
      expect(missing).toBe(0);
    },
    SWEEP_BUDGET_MS,
  );
});

describe.skipIf(available)('the real corpus is not present', () => {
  it('reports that the real-data checks did not run', () => {
    // A skip that says nothing looks exactly like a skip that passed. It is
    // reported so a green suite on another machine is not mistaken for evidence
    // about this one.
    expect(available).toBe(false);
  });
});
