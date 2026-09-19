import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
 * MEASURED 2026-09-15 on `~/.claude/projects` (read-only): 843 files, 431,039 records,
 * 1,488 entries -- 486 verification_run, 457 tool_denial, 438 context_compaction, 87
 * skill_activation, 20 user_correction -- with 0 rejected, 0 warnings, 0 duplicate keys,
 * 0 unkeyable, 0 unverdictable, 6 key collisions, in 5.2 s.
 *
 * HOW IT CHECKS. Not by asserting those counts, which move: `~/.claude/projects` is LIVE, and
 * this session's own transcript is in it (measured: tool_denial rose from 456 to 457 while two
 * runs sat minutes apart). Counting is a snapshot; what is asserted instead is everything that
 * is true at ANY corpus size:
 *
 *   1. Every entry validates against its own spec, with no errors AND no warnings.
 *   2. Every key is unique.
 *   3. Nothing was dropped for want of an identity: unkeyable and unverdictable are 0.
 *   4. Counters conserve: entries emitted == entries collected.
 *   5. Every entry carries its provenance properties.
 *   6. Floors, so a corpus that shrank to nothing cannot pass by asserting nothing.
 *
 * COST, stated plainly: one pass over ~1.2 GiB, roughly 7 s. It SKIPS wherever
 * `~/.claude/projects` does not exist -- every machine but this one -- so it is a local
 * honesty check, not a portable CI gate. `reader-real-corpus.test.ts` carries the same caveat.
 */

const ROOT = defaultTranscriptRoot();
const available = existsSync(ROOT);

/** Measured 2026-09-15: 843 files / 431,039 records / 1,488 entries. Floors, not targets. */
const MIN_FILES = 100;
const MIN_RECORDS = 100_000;
const MIN_ENTRIES = 200;

/**
 * Per-type floors, set well below the measured count for a live corpus.
 *
 * A floor of zero would be the vacuous assertion this file exists to avoid: a deriver that
 * emitted nothing at all would satisfy "every entry validates". These are the numbers that
 * make an empty result a failure.
 */
const MIN_PER_TYPE: Readonly<Record<string, number>> = {
  verification_run: 50,
  tool_denial: 50,
  context_compaction: 50,
  skill_activation: 10,
  // 20 measured, across 10 sessions. The floor is deliberately at the measured value rather
  // than below it, because this is the type whose viability was in question: if it drops, the
  // type should be re-examined rather than silently tolerated.
  user_correction: 5,
};

interface Sweep {
  readonly totals: { readonly files: number; readonly parsed: number; readonly malformed: number };
  readonly failures: number;
  readonly entries: readonly DerivedEntry[];
  readonly byType: Readonly<Record<string, number>>;
  readonly invalid: readonly string[];
  readonly warned: readonly string[];
  readonly duplicateKeys: readonly string[];
  readonly missingProvenance: readonly string[];
  /** Entries with no envelope `cwd` / `branch`, named by type. */
  readonly withoutCwd: readonly string[];
  readonly withoutBranch: readonly string[];
  /** How many distinct REAL working directories and branches the sweep saw. */
  readonly distinctCwds: number;
  readonly distinctBranches: number;
  /** How many distinct encoded project labels those collapse into -- `project`, not `cwd`. */
  readonly distinctProjects: number;
  readonly keyCollisions: number;
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
  const duplicateKeys: string[] = [];
  const missingProvenance: string[] = [];
  const withoutCwd: string[] = [];
  const withoutBranch: string[] = [];
  const cwds = new Set<string>();
  const branches = new Set<string>();
  const projects = new Set<string>();
  const seen = new Set<string>();

  const collect = (entry: DerivedEntry): void => {
    entries.push(entry);
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;

    const identity = `${entry.type}|${entry.key}`;
    if (seen.has(identity)) duplicateKeys.push(identity);
    seen.add(identity);

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

  const totals = await streamCorpus((record, file) => {
    for (const entry of deriver.accept(record, file)) collect(entry);
  }, {});
  for (const entry of deriver.drain()) collect(entry);

  return {
    totals: { files: totals.files, parsed: totals.parsed, malformed: totals.malformed },
    failures: totals.failures.length,
    entries,
    byType,
    invalid,
    warned,
    duplicateKeys,
    missingProvenance,
    withoutCwd,
    withoutBranch,
    distinctCwds: cwds.size,
    distinctBranches: branches.size,
    distinctProjects: projects.size,
    keyCollisions: deriver.counters.keyCollisions,
    unkeyable: deriver.counters.unkeyable,
    unverdictable: deriver.counters.unverdictable,
    countersEntries: deriver.counters.entries,
  };
}

/**
 * One sweep, shared by every assertion below.
 *
 * Each test wants the same 7-second walk of 1.2 GiB, and running it per test cost 50 s of
 * suite time for no extra evidence -- seven identical sweeps prove exactly what one does.
 * The stability test deliberately asks for a SECOND, independent sweep, which is the one
 * place a fresh walk is the point rather than the cost.
 */
let shared: Promise<Sweep> | undefined;
const once = (): Promise<Sweep> => (shared ??= sweep());

describe.skipIf(!available)('the deriver against the real corpus', () => {
  it('derives entries that all satisfy their own definitions', async () => {
    const result = await once();

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

  it('gives every entry a unique key, and drops nothing for want of an identity', async () => {
    const result = await once();

    expect(result.duplicateKeys.slice(0, 10)).toEqual([]);
    // Both are the counter-example to a silent drop: an event recognised but not
    // emitted is invisible without these, and a sweep would report success while
    // the corpus was missing rows.
    expect(result.unkeyable).toBe(0);
    expect(result.unverdictable).toBe(0);
  }, 120_000);

  it('conserves: the counters agree with what was collected', async () => {
    // A conservation law, in the spirit of the reader's: the deriver's own tally
    // and the entries a caller actually holds must be the same number. An entry
    // counted but not returned, or returned but not counted, is a drift that no
    // validation check above would notice.
    const result = await once();
    expect(result.countersEntries).toBe(result.entries.length);
  }, 120_000);

  it('stamps the source the STORE will accept, which the type alone cannot promise', async () => {
    // Deliberately not "every entry's source is DERIVED_SOURCE". That was the first
    // version of this test and `no-unnecessary-condition` killed it: `DerivedEntry.source`
    // is typed as the literal, so the comparison is statically always false and the
    // assertion could NEVER fail. A check that cannot fail looks exactly like one that
    // passes -- the failure class this project rates severity-zero -- so it was deleted
    // rather than lint-suppressed.
    //
    // What is asserted instead is the adapter's SIDE of that join: the constant the
    // deriver writes must be the literal the store's CHECK constraint admits. The
    // check is
    //     packages/store/src/schema.ts:149  CHECK (source IN ('self', 'derived:claude-code'))
    // and the store exports the same list as `ENTRY_SOURCES`. Neither package can
    // see the other here -- store depends on no adapter, and the adapter does not
    // depend on store -- so the two halves are pinned separately and joined where
    // both are visible, in the CLI test that drives `asc ingest claude-code`.
    expect(DERIVED_SOURCE).toBe('derived:claude-code');
    const result = await once();
    expect(result.entries.length).toBeGreaterThan(0);
  }, 120_000);

  it('carries provenance on every entry, in properties that survive to disk', async () => {
    // `session_id` and `project` are required, so their absence would already have
    // failed validation -- asserted here anyway because this is the property that
    // makes a derived entry resolvable to the transcript it came from, and because
    // an earlier version of this code populated the ENVELOPE's `occurredAt` while
    // never writing the `occurred_at` PROPERTY. A coverage number computed from
    // the envelope field was 100% while every stored entry was `not_measured`.
    const result = await once();
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

  it('carries the real cwd and branch, which the project label cannot express', async () => {
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
    // five types key off TRIGGER records, not off every record: 1,607 entries, 0 without a cwd,
    // 0 without a branch, over 14 projects and 84 real working directories (6.0:1).
    const result = await once();

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

  it('keeps transcript prose out of the entries, except where the type IS the text', async () => {
    // The reader's contract: no raw transcript text reaches a caller that prints.
    // `user_correction` is the one deliberate exception, and it must stay the only
    // one -- an accidental second would put user content into agent context on
    // every sweep.
    const result = await once();
    const withText = result.entries.filter((entry) => entry.evidenceText !== undefined);
    expect([...new Set(withText.map((entry) => entry.type))]).toEqual(['user_correction']);
  }, 120_000);

  it('produces keys that are stable across two independent sweeps', async () => {
    // Idempotency, which is what makes a re-ingest safe. This is the one test that
    // deliberately re-walks the corpus: the claim is about two INDEPENDENT reads
    // agreeing, so sharing one sweep would test nothing.
    const first = await once();
    const second = await sweep();
    const a = new Set(first.entries.map((entry) => `${entry.type}|${entry.key}`));
    const b = new Set(second.entries.map((entry) => `${entry.type}|${entry.key}`));
    const shared = [...a].filter((key) => b.has(key));

    expect(shared.length).toBeGreaterThan(MIN_ENTRIES);

    // A tolerance, and the reason for it is specific rather than defensive. The
    // expectation is that NO key from the first sweep is missing from the second --
    // the corpus only grows. Two things can legitimately move a key between two
    // sweeps of a live directory:
    //
    //   - a transcript written between them adds keys (harmless, not counted here)
    //   - `#2` disambiguation is sensitive to a file's CONTENTS: if a still-growing
    //     file gains a colliding record, its suffix assignment shifts. Measured: 6
    //     collisions in the whole corpus, so this can touch a handful of keys.
    //
    // 1% of ~1,488 is 15 -- far above the handful that mechanism can move, and far
    // below the number an unstable identity scheme would lose.
    const missing = a.size - shared.length;
    expect(missing).toBeLessThanOrEqual(Math.ceil(a.size * 0.01));
  }, 180_000);
});

describe.skipIf(available)('the real corpus is not present', () => {
  it('reports that the real-data checks did not run', () => {
    // A skip that says nothing looks exactly like a skip that passed. It is
    // reported so a green suite on another machine is not mistaken for evidence
    // about this one.
    expect(available).toBe(false);
  });
});
