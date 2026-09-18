/**
 * `asc ingest claude-code` — read this machine's Claude Code transcripts, derive the events they
 * imply, and write them into the store.
 *
 * The point of the command is that the corpus a single user accumulates is already a record of
 * their workflow, sitting on disk, unqueried. Deriving from it means ascend has a corpus on day
 * one rather than after months of disciplined manual recording -- the failure this product
 * actually faces is an empty database, not a bad one.
 *
 * **IDEMPOTENT, AND THAT IS THE WHOLE DESIGN.** Every entry's id is a pure function of the
 * event it came from: `derived:claude-code:<type>:<key>`, where `key` is the deriver's stable
 * per-event identity (session + tool_use_id, or session + record uuid). A re-run therefore
 * proposes exactly the ids the first run wrote, the store's PRIMARY KEY refuses the second
 * write, and the command reports them as already present. Nothing is matched by content, by
 * timestamp, or by position, so nothing can drift: the same transcript yields the same id on any
 * machine, at any time, in any order.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   - **A re-run costs a full re-read.** Idempotency is enforced at the store, not by a
 *     checkpoint, so `--root` is walked again every time (~5 s for the measured corpus). That is
 *     deliberate: a checkpoint file would be a second source of truth about what has been
 *     ingested, and a checkpoint that disagrees with the store is worse than no checkpoint.
 *   - **The `#2` disambiguation suffix is content-sensitive.** The deriver appends `#2` when a
 *     transcript repeats a per-event key. If a still-growing transcript file gains a colliding
 *     record between two ingests, that entry's suffix shifts and the run writes one more entry
 *     rather than recognising it. Measured: 6 key collisions in the whole corpus, so this is a
 *     handful of rows. It is a real limit of keying on a derived identity, not a bug to be fixed
 *     here -- which is why the count is reported rather than absorbed.
 *
 * **ONE TRANSACTION, AND ALL-OR-NOTHING.** The writes go in a single `withTransaction`, matching
 * what `asc record` already promises for a batch. Measured twice on the real corpus with the same
 * probe (`/tmp/ycl/tx.mjs`, which derives once and replays the identical buffer through both
 * strategies, so the two arms cannot differ by input): 460 ms in one transaction against 678 ms
 * with a transaction per entry, then 240 ms against 356 ms on a re-run. The atomic choice is also
 * the faster one, on both runs, so there is no trade to make. A rejection part-way through
 * therefore leaves the store exactly as it was.
 *
 * **The entries are buffered before they are written**, because the corpus walk is async and
 * `withTransaction` takes a synchronous body. Measured: 1,489 entries for the corpus on this
 * machine, which is 1,488 plus this session's own transcript -- the corpus is live, so treat the
 * count as a dated measurement rather than a constant. A backfill across many projects
 * (`asc-sx7`) is the case where that stops being free, and it is the reason this is stated here
 * rather than left implicit.
 *
 * The reasoning behind all of the above, and the A/B that settled the transaction shape, is
 * `docs/evidence/EV-ingest.md` (EV-10).
 *
 * READ-ONLY ON THE TRANSCRIPTS. The adapter opens them, never writes: `reader-source.test.ts`
 * proves no file in that package can even import a write-capable `fs` binding.
 * `~/.claude/projects` is not ascend's data, and a stray write there destroys something the user
 * cannot regenerate.
 *
 * **THE SWEEP DOES NOT READ EPHEMERAL OS TEMP DIRECTORIES BY DEFAULT** (`asc-80m`). Some project
 * directories under the corpus root are OS temp directories a benchmark run created --
 * `ephemeral.ts`'s anchored prefix match against Claude Code's encoded label -- and a project
 * that can never recur is a permanent singleton stratum in exactly the project-keyed analysis
 * this tool exists to do. 5 of 879 files on the corpus measured 2026-09-18. They are still
 * COUNTED, never silently dropped, and `--include-ephemeral` reads them anyway: entries are
 * immutable and this ingest is idempotent by key, so a default that refused them outright would
 * leave a caller who wants them no route at all.
 */

import { resolve } from 'node:path';
import { Flags } from '@oclif/core';
import {
  DERIVED_SOURCE,
  DERIVED_TYPES,
  createDeriver,
  defaultTranscriptRoot,
  derivedType,
  streamCorpus,
  type CorpusTotals,
  type DeriveCounters,
  type DerivedEntry,
  type SkippedEntry,
} from '@ascend/adapter-claude-code';
import { canonicalJson, validateEntry } from '@ascend/core';
import {
  DuplicateEntryError,
  findEntry,
  recordEntry,
  withTransaction,
  type RecordedEntry,
  type Store,
} from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { refusal } from '../../errors.js';
import { registerDocument } from '../../register-document.js';

const ACTION = 'action';
const TARGET = 'target';
const OUTCOME = 'outcome';

/**
 * One entry's identity, and the whole of the idempotency mechanism.
 *
 * The source prefix is not decoration. It makes a derived id recognisable in raw SQL and
 * impossible to collide with an id `asc record` minted, which matters because the two writers
 * share one PRIMARY KEY -- and it means an operator reading `entries` can tell a machine's
 * reading from a model's self-report without a join.
 *
 * `key` is the deriver's own per-event identity, unique across the corpus by construction. Using
 * it rather than hashing the entry's properties is what makes the id stable when a rule changes:
 * `occurred_at` or `runner` can be rewritten by a later rule and the entry is still the same
 * event, so the re-run recognises it instead of writing a second copy.
 */
function idFor(entry: DerivedEntry): string {
  return `${DERIVED_SOURCE}:${entry.type}:${entry.key}`;
}

/**
 * The skipped entries that were excluded as ephemeral, separated from the ones that are damage.
 *
 * A symlink or an unreadable directory is something that HAPPENED to the walk; an ephemeral
 * project is a decision this command made (`asc-80m`). They share one array because both are
 * "a path the sweep deliberately did not read", and they must never share one count, because a
 * reader acts on them differently: one is worth investigating, the other is worth reversing with
 * a flag.
 */
function ephemeralSkips(skipped: readonly SkippedEntry[]): readonly SkippedEntry[] {
  return skipped.filter((entry) => entry.reason === 'ephemeral');
}

/**
 * The distinct project labels behind those skips, sorted.
 *
 * Deduplicated because the skip is counted per FILE and the fact a reader needs is per PROJECT:
 * a benchmark that left twenty transcripts in one temp directory is one thing to know about, not
 * twenty lines of the same thing. Sorted so two runs over an unchanged corpus print the same
 * sentence, which is the same reason `scanTranscripts` sorts its files.
 *
 * `project` is optional on `SkippedEntry` -- it is present only for `reason: 'ephemeral'` -- so
 * an entry without one contributes nothing rather than an empty string. That cannot happen for
 * the entries this is called with, and writing it as a filter rather than an assertion is the
 * cheaper way to be right if it ever does.
 */
function skippedLabels(entries: readonly SkippedEntry[]): readonly string[] {
  const labels = new Set<string>();
  for (const entry of entries) {
    if (entry.project !== undefined) labels.add(entry.project);
  }
  return [...labels].sort();
}

/** What one derived type's entries did on this run. */
interface TypeOutcome {
  readonly written: number;
  readonly present: number;
  /** Failed the type's own value constraints and was never offered to the store. */
  readonly rejected: number;
  /**
   * Proposed an id an entry with DIFFERENT content already occupies. Distinct from `present`,
   * which is the id proposing the SAME content again -- ordinary idempotency. See `asc-90h`.
   */
  readonly collided: number;
}

const ZERO_OUTCOME: TypeOutcome = { written: 0, present: 0, rejected: 0, collided: 0 };

/** The corpus read: what was there, and what could not be used. */
interface Sweep {
  readonly entries: readonly DerivedEntry[];
  readonly totals: CorpusTotals;
  readonly counters: DeriveCounters;
}

/** The writes, or what they would have been. */
interface Writes {
  readonly counts: ReadonlyMap<string, TypeOutcome>;
  readonly warnings: readonly string[];
  /** One line per rejected entry, naming the id, the field and why it failed. */
  readonly rejections: readonly string[];
  /** One line per cross-file id collision. See `asc-90h`. */
  readonly collisions: readonly string[];
}

/**
 * A fingerprint of everything about an entry that is NOT its id -- the content a re-ingest of
 * the same event must reproduce exactly.
 *
 * `entry.key` and hence `idFor(entry)` deliberately excludes the file path (`asc-90h`'s own
 * mechanism note: the per-file collision counter cannot see a cross-file reuse of a
 * `(session_id, uuid)` or `(session_id, tool_use_id)` pair). So the id alone cannot tell a
 * genuine re-run of the same event from two DIFFERENT events that happened to reuse that pair
 * across two transcript files. Comparing content is the cheapest thing that can: two files
 * describing the same event will always agree on it, and `properties_json`/`cwd`/`branch`/
 * `evidence_text` together are the entirety of what a derived entry says beyond its id.
 */
function fingerprint(entry: {
  readonly properties: Readonly<Record<string, unknown>>;
  // Optional rather than `| undefined`: a `DerivedEntry` OMITS a locality it does not have rather
  // than carrying it as undefined, and the two spellings are not assignable to one another. The
  // `?? null` below folds either into the one value the fingerprint compares.
  readonly cwd?: string | null;
  readonly branch?: string | null;
  readonly evidenceText?: string | null;
}): string {
  return canonicalJson({
    properties: entry.properties,
    cwd: entry.cwd ?? null,
    branch: entry.branch ?? null,
    evidenceText: entry.evidenceText ?? null,
  });
}

export default class IngestClaudeCode extends BaseCommand {
  static override description =
    'Derive entries from the Claude Code transcripts in ~/.claude/projects into this project’s ' +
    'store. Re-running creates no duplicates: every entry is keyed on the event it came from.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --root /path/to/projects --json',
  ];

  static override flags = {
    root: Flags.string({
      description:
        'The directory holding transcript projects. Defaults to ~/.claude/projects, which is ' +
        'where Claude Code writes them. Resolved to an absolute, normalized path before use, ' +
        'so `./corpus` and `/abs/path/corpus` name the same run.',
    }),
    'dry-run': Flags.boolean({
      description:
        'Read the transcripts and report what would be written, then write nothing at all.',
    }),
    'include-ephemeral': Flags.boolean({
      description:
        'Also read project directories under a known OS temp root (e.g. a benchmark run’s own ' +
        'os.tmpdir()). Skipped by default: those projects can never recur, so they can never ' +
        'reach MIN_N, and they would otherwise sit in the store as permanent singleton strata ' +
        'in project-keyed analysis.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(IngestClaudeCode);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const includeEphemeral = this.flagValue(flags['include-ephemeral']);
    // CANONICALIZED, not refused (`asc-c8g`). `--root ./corpus` or `--root a/../corpus` is an
    // entirely ordinary thing to type, and `resolve` (pure, lexical, no filesystem access) turns
    // either into the exact absolute path `scanTranscripts` will walk and `classifyTranscript`
    // will compare against -- so the two can no longer disagree about what is "under" it. Before
    // this, a non-canonical `--root` was passed through verbatim: `segmentsUnder`'s prefix
    // comparison folded separators but never collapsed a `./` or `..` segment, so the SAME
    // directory reached through `path.join` (already normalized) compared unequal to it, every
    // file read as "not under this root", and the fallback branch fabricated a project label
    // from the root's own basename for the whole corpus -- unrepairable afterward, because entry
    // ids are keyed on `session_id`, not on `project`, so a corrected re-run reports the
    // mislabelled rows `already present` and leaves them exactly as they are.
    const root = resolve(this.optionalFlag(flags.root) ?? defaultTranscriptRoot());

    await this.withProject(async (project) => {
      const rows: Record<string, unknown>[] = [];

      // Definitions first, because `recordEntry` refuses an entry whose type is not registered --
      // and because the entries below carry no `version`, so they resolve to this run's
      // registration. `registerDocument` is the same path `asc types define` takes, so these five
      // are ordinary types: they version, export and diff like anything a user writes, and a
      // second run reports `unchanged` rather than rewriting them.
      for (const spec of DERIVED_TYPES) {
        const registration = registerDocument(project.store, spec, {
          registeredAt: this.now(),
          dryRun,
        });
        rows.push({ [ACTION]: 'type', [TARGET]: spec.name, [OUTCOME]: registration.outcome });
      }

      const sweep = await this.sweep(root, includeEphemeral);
      const writes = this.write(project.store, sweep.entries, dryRun);

      for (const spec of DERIVED_TYPES) {
        rows.push({
          [ACTION]: 'entry',
          [TARGET]: spec.name,
          [OUTCOME]: describe(writes.counts.get(spec.name) ?? ZERO_OUTCOME),
        });
      }

      this.emit(format, { columns: [ACTION, TARGET, OUTCOME], rows });
      this.report(root, sweep, writes, dryRun);
    });
  }

  /**
   * Read the corpus and derive, in one walk.
   *
   * The totals and counters travel back with the entries because "read nothing" and "read
   * everything and derived nothing" are different facts, and only the caller can tell them apart.
   */
  private async sweep(root: string, includeEphemeral: boolean): Promise<Sweep> {
    const deriver = createDeriver();
    const entries: DerivedEntry[] = [];

    const totals = await streamCorpus(
      (record, file) => {
        for (const entry of deriver.accept(record, file)) entries.push(entry);
      },
      { root, includeEphemeral },
    );

    // Flushed after the walk, never during: the deriver holds one run open until a different
    // skill or session appears, so draining early would drop the last event of every file.
    for (const entry of deriver.drain()) entries.push(entry);

    if (totals.files === 0) {
      const ephemeral = ephemeralSkips(totals.skipped);
      if (ephemeral.length > 0) {
        // The plain "no transcripts found" message would be FALSE here: transcripts were found,
        // every one of them was a known OS temp root (`asc-80m`), and `--include-ephemeral` is
        // the caller's way to read them. Naming the distinct labels (sorted, deduplicated) rather
        // than the message above is what makes this refusal actionable instead of merely correct.
        const labels = skippedLabels(ephemeral);
        throw refusal(
          `No transcripts found under ${root} other than ${String(ephemeral.length)} skipped ` +
            `as ephemeral OS temp project(s): ${labels.join(', ')}. These can never recur, so ` +
            `they are excluded by default. Pass --include-ephemeral to read them anyway.`,
        );
      }
      // Refused rather than reported as a successful no-op. Zero files means the root is wrong,
      // or empty, or holds no transcripts -- and a command that exits 0 having ingested nothing
      // is the false success this project treats as worse than a failure. `--dry-run` included:
      // a preview of nothing reads exactly like a preview of a clean re-run.
      throw refusal(
        `No transcripts found under ${root}. ascend looks for *.jsonl files in the project ` +
          `directories Claude Code writes there. Pass --root to point at a different tree.`,
      );
    }

    return { entries, totals, counters: deriver.counters };
  }

  /**
   * Write the derived entries, or report what writing them would do.
   *
   * A dry run asks the store the same question the real run does -- `findEntry` on the exact id
   * the real run would use -- so the two cannot report different outcomes. It is not a second
   * implementation of the decision, because a preview computed by a copy of the logic is a
   * preview of the copy.
   */
  private write(store: Store, entries: readonly DerivedEntry[], dryRun: boolean): Writes {
    const counts = new Map<string, TypeOutcome>();
    const warnings: string[] = [];

    // ONE clock reading for the whole run, as `asc record` does for a batch: `recorded_at` is
    // when ascend ingested these, and letting it drift per entry would order a backfill by
    // validation time rather than by anything that happened. The transcript's own time is the
    // entry's `occurred_at` property, which the deriver already set.
    const recordedAt = this.now();
    const ascendVersion = this.ascendVersion();

    const tally = (type: string, outcome: keyof TypeOutcome): void => {
      const current = counts.get(type) ?? ZERO_OUTCOME;
      counts.set(type, { ...current, [outcome]: current[outcome] + 1 });
    };

    /**
     * Enforce the value constraints the derived types declare, on EVERY entry, before either
     * branch below sees one -- `asc-vaw`.
     *
     * `derive.ts` narrows fields by JS type only (a number, a non-empty string); the range and
     * format constraints (a nonnegative duration, an offset timestamp) live solely in the type's
     * own spec, by that file's own design -- the deriver must not invent a property the spec
     * does not declare, and `validateEntry` is what proves the two agree
     * (`derive-real-corpus.test.ts` runs exactly this check over the live corpus).
     *
     * Before this, the only place that ran `validateEntry` was `recordEntry`, deep inside the
     * one transaction the whole sweep shares. A single out-of-range value threw
     * `EntryRejectedError` -- deliberately NOT in the set `errors.ts` handles -- which unwound
     * the transaction and rolled back every entry from every project in the corpus. Filtering
     * here means a bad value is skipped and counted exactly like a malformed line
     * (`index.ts`'s own contract: "a malformed line is counted and skipped, never fatal"),
     * and it never reaches the transaction at all -- so the existing one-transaction-per-sweep
     * shape stays safe without having to be narrowed to per-file or per-project.
     *
     * Run before the `dryRun` branch too, which is the other half of the same bug: a preview
     * that only asked `findEntry(...) === undefined` cannot see a rejection the real run would
     * hit, so `--dry-run` reported a corpus as clean that the real run then died on.
     */
    const rejections: string[] = [];
    const collisions: string[] = [];
    const valid: DerivedEntry[] = [];
    for (const entry of entries) {
      const spec = derivedType(entry.type);
      if (spec === undefined) {
        // Not a transcript problem: every `entry.type` the deriver emits names one of the five
        // types declared in `derived-types.ts`, so this would mean the two had drifted apart.
        tally(entry.type, 'rejected');
        rejections.push(
          `${entry.type} ${idFor(entry)}: type: no definition named '${entry.type}' is ` +
            `registered by this adapter -- this is an adapter bug, not a transcript problem.`,
        );
        continue;
      }
      const validated = validateEntry(spec, { properties: entry.properties });
      if (!validated.ok) {
        tally(entry.type, 'rejected');
        for (const issue of validated.errors) {
          rejections.push(
            `${entry.type} ${idFor(entry)}: ${issue.field}: ${issue.problem} (${issue.fix})`,
          );
        }
        continue;
      }
      valid.push(entry);
    }

    if (dryRun) {
      for (const entry of valid) {
        // Same content check as the real run's `DuplicateEntryError` branch (`asc-90h`), so a
        // preview cannot describe a collision as an ordinary "already present" the real run
        // would not agree with.
        const existing: RecordedEntry | undefined = findEntry(store.db, idFor(entry));
        if (existing === undefined) {
          tally(entry.type, 'written');
        } else if (fingerprint(existing) === fingerprint(entry)) {
          tally(entry.type, 'present');
        } else {
          tally(entry.type, 'collided');
          collisions.push(
            `${entry.type} ${idFor(entry)}: this id already holds a DIFFERENT entry. Two ` +
              `transcript files reused the same (session, record) identity for different ` +
              `content, so the second one would be refused rather than silently dropped.`,
          );
        }
      }
      return { counts, warnings, rejections, collisions };
    }

    withTransaction(store.db, () => {
      for (const entry of valid) {
        try {
          const { warnings: issues } = recordEntry(
            store.db,
            { type: entry.type, properties: entry.properties },
            {
              id: idFor(entry),
              recordedAt,
              ascendVersion,
              source: DERIVED_SOURCE,
              // The real place and branch the EVENT happened in, read off the transcript's own
              // record -- not `process.cwd()`, which here is wherever the operator ran the
              // ingest, and not the `project` property, which is the lossy encoded directory
              // name (re-measured 2026-09-16: 20 labels over 301 real working directories,
              // 15.1:1, largest collapse 123:1).
              //
              // OMITTED when the transcript's record carries neither. `entries` refuses `''`
              // and reads NULL as "not said", so a defaulted value would be a fabrication --
              // and on this corpus 100% of trigger records carry both, so the omission is a
              // real branch only for a future derived type keyed off a control record.
              ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
              ...(entry.branch === undefined ? {} : { branch: entry.branch }),
              // The one type whose value IS prose. Every other derived entry carries none, so the
              // reader's contract -- no raw transcript text reaches a caller that prints -- holds
              // through the whole sweep.
              ...(entry.evidenceText === undefined ? {} : { evidenceText: entry.evidenceText }),
            },
          );
          tally(entry.type, 'written');
          for (const issue of issues) {
            warnings.push(`${entry.type} ${idFor(entry)}: ${issue.field}: ${issue.problem}`);
          }
        } catch (error) {
          // The second run's normal path, not a failure: the id is already in the store, which is
          // exactly what this command promises. Every other error is rethrown, so a real problem
          // cannot be mistaken for idempotency working.
          if (error instanceof DuplicateEntryError) {
            // `asc-90h`: a duplicate id is ordinary idempotency ONLY when it is a re-proposal of
            // the SAME content. `derive.ts`'s id has no file component, so two files that reuse a
            // `(session_id, uuid)` or `(session_id, tool_use_id)` pair for DIFFERENT events
            // collide on id -- and the per-file `keyCollisions` counter cannot see it, because it
            // resets on every file change. Reading the existing row back and comparing content is
            // what tells the two cases apart; skipping the comparison is exactly how this bug
            // stayed invisible.
            const existing: RecordedEntry | undefined = findEntry(store.db, idFor(entry));
            const sameContent =
              existing !== undefined && fingerprint(existing) === fingerprint(entry);
            if (sameContent) {
              tally(entry.type, 'present');
            } else {
              tally(entry.type, 'collided');
              collisions.push(
                `${entry.type} ${idFor(entry)}: this id already holds a DIFFERENT entry. Two ` +
                  `transcript files reused the same (session, record) identity for different ` +
                  `content, so the second one was refused rather than silently dropped. This ` +
                  `event is not recoverable without a key that also names the file it came from.`,
              );
            }
            continue;
          }
          throw error;
        }
      }
    });

    return { counts, warnings, rejections, collisions };
  }

  /**
   * Everything that is not a row: the scan's own totals, and every count that exists because the
   * alternative to a number is a silence.
   *
   * On stderr, because it describes the INPUT rather than the store. stdout is the data contract;
   * how much was read to produce it is a diagnostic, and the two should not share a shape that
   * pretends otherwise.
   */
  private report(root: string, sweep: Sweep, writes: Writes, dryRun: boolean): void {
    const { totals, counters } = sweep;

    this.logToStderr(
      `read ${String(totals.files)} transcript file(s) from ${root}: ` +
        `${String(totals.parsed)} records, ${String(totals.malformed)} malformed line(s), ` +
        `${String(totals.failures.length)} unreadable file(s)`,
    );

    if (dryRun) this.warn('dry run: nothing was written.');

    // Partial data is still real data, so an aborted sweep is reported as a shorter corpus rather
    // than a clean one. `streamCorpus` takes a signal this command never passes, so this is
    // unreachable today -- and it is here because "unreachable" is a claim about today's caller,
    // and a sweep that stopped early must not be reported as a complete one.
    if (totals.aborted) {
      this.warn(
        'the transcript sweep stopped early, so these totals are PARTIAL. Re-run to read the rest.',
      );
    }

    if (totals.failures.length > 0) {
      this.warn(
        `${String(totals.failures.length)} transcript file(s) could not be read to the end and ` +
          `were skipped. The entries they hold are not in the store; re-run once they are readable.`,
      );
    }

    // Split by reason: a directory or symlink not descended into is a different fact from a
    // project excluded on purpose, and folding them into one count would make the ephemeral
    // exclusion (`asc-80m`) look like damage to the walk rather than a decision this command made.
    const nonEphemeralSkipped = totals.skipped.filter((entry) => entry.reason !== 'ephemeral');
    if (nonEphemeralSkipped.length > 0) {
      this.warn(
        `${String(nonEphemeralSkipped.length)} directory or symlink was not descended into, so ` +
          `it is not in these totals.`,
      );
    }

    // `derive.ts`'s own rule (`derive.ts:30-31`): "A silently dropped record is the failure this
    // module is most able to cause." An ephemeral project is excluded on purpose, but "on
    // purpose" is not the same as "invisible" -- the count and the distinct labels are what make
    // this a decision a reader can see and reverse, rather than a filter nobody can see.
    const ephemeralSkipped = ephemeralSkips(totals.skipped);
    if (ephemeralSkipped.length > 0) {
      const labels = skippedLabels(ephemeralSkipped);
      this.warn(
        `${String(ephemeralSkipped.length)} transcript file(s) under known OS temp project(s) ` +
          `(${labels.join(', ')}) were skipped: these projects can never recur, so they are ` +
          `excluded by default. Pass --include-ephemeral to read them anyway.`,
      );
    }

    // All four counters exist so a dropped event -- or a withheld part of one -- cannot be a
    // silence. `unquotable` is the odd one out and is worded to say so: its entries WERE written.
    if (counters.unkeyable > 0) {
      this.warn(
        `${String(counters.unkeyable)} event(s) had no stable identity and were not written. ` +
          `They cannot be recovered by re-running: the transcript does not carry what keys them.`,
      );
    }
    if (counters.unverdictable > 0) {
      this.warn(
        `${String(counters.unverdictable)} check run(s) carried no readable pass/fail result ` +
          `and were not written. The transcript's shape changed; re-running will not recover ` +
          `them unless the source transcript is regenerated.`,
      );
    }
    if (counters.unquotable > 0) {
      this.warn(
        `${String(counters.unquotable)} user correction(s) were written WITHOUT evidence text: ` +
          `the transcript recorded the question-clarification form, which carries the harness's ` +
          `preamble and the questions Claude asked, and none of the user's own words. The ` +
          `entries are real and are counted in these totals; only their prose is absent, and ` +
          `re-running cannot recover it because the transcript never held it.`,
      );
    }
    if (counters.keyCollisions > 0) {
      this.warn(
        `${String(counters.keyCollisions)} event key(s) repeated within a transcript and were ` +
          `disambiguated with a "#2" suffix. If a transcript is still growing, one of these may ` +
          `be written again as a new entry on a later run.`,
      );
    }

    // A rejected entry is a real event the transcript held that failed one of its own type's
    // value constraints (`asc-vaw`) -- reported the same way as `unkeyable` and
    // `unverdictable` above, rather than aborting the run: one bad value must not cost the
    // corpus every valid entry from every other project. `--dry-run` reaches this too, since
    // the check runs before either branch, so the two can no longer disagree about which
    // entries would land.
    const rejected = [...writes.counts.values()].reduce((sum, one) => sum + one.rejected, 0);
    if (rejected > 0) {
      this.warn(
        `${String(rejected)} derived entr${rejected === 1 ? 'y' : 'ies'} failed validation ` +
          `against ${rejected === 1 ? 'its' : 'their'} own type definition and ` +
          `${rejected === 1 ? 'was' : 'were'} not written. They are not recoverable by ` +
          `re-running unless the source transcript changes: see the line(s) below for what ` +
          `failed and why.`,
      );
    }
    for (const rejection of writes.rejections) this.warn(rejection);

    // A cross-file id collision (`asc-90h`): two transcripts reused the same per-event identity
    // for different content. The second one cannot be recorded -- entries are immutable and this
    // id is taken -- so, like a rejection, it must be a visible count rather than folded into the
    // "already present" that ordinary idempotency produces.
    const collided = [...writes.counts.values()].reduce((sum, one) => sum + one.collided, 0);
    if (collided > 0) {
      this.warn(
        `${String(collided)} derived entr${collided === 1 ? 'y' : 'ies'} collided with a ` +
          `DIFFERENT entry already recorded under the same id, and ` +
          `${collided === 1 ? 'was' : 'were'} not written. See the line(s) below; recovering ` +
          `${collided === 1 ? 'it' : 'them'} needs a re-ingest under a key that also names the ` +
          `file it came from.`,
      );
    }
    for (const collision of writes.collisions) this.warn(collision);

    for (const warning of writes.warnings) this.warn(warning);
  }
}

/**
 * One row's outcome, in the words a reader acts on.
 *
 * `already present` is spelled out rather than left as a bare zero, because on a re-run every row
 * says it and the reader's question is "did this work?" -- which a row of zeroes answers
 * ambiguously. `none` is a fifth state, not a flavour of the other four: it means the deriver
 * found nothing of this type at all, which is a fact about the corpus rather than about the store.
 * `rejected` (`asc-vaw`) and `collided` (`asc-90h`) are each reported alongside the others rather
 * than folded into one of them, because neither is written AND neither is ordinary idempotency --
 * each is a real event the store refused, for a different reason.
 */
function describe(counts: TypeOutcome): string {
  const parts: string[] = [];
  if (counts.written > 0) parts.push(`${String(counts.written)} new`);
  if (counts.present > 0) parts.push(`${String(counts.present)} already present`);
  if (counts.rejected > 0) parts.push(`${String(counts.rejected)} rejected`);
  if (counts.collided > 0) parts.push(`${String(counts.collided)} collided`);
  return parts.length === 0 ? 'none' : parts.join(', ');
}
