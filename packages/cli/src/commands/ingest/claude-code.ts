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
 */

import { Flags } from '@oclif/core';
import {
  DERIVED_SOURCE,
  DERIVED_TYPES,
  createDeriver,
  defaultTranscriptRoot,
  streamCorpus,
  type CorpusTotals,
  type DeriveCounters,
  type DerivedEntry,
} from '@ascend/adapter-claude-code';
import {
  DuplicateEntryError,
  findEntry,
  recordEntry,
  withTransaction,
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

/** What one derived type's entries did on this run. */
interface TypeOutcome {
  readonly written: number;
  readonly present: number;
}

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
        'where Claude Code writes them.',
    }),
    'dry-run': Flags.boolean({
      description:
        'Read the transcripts and report what would be written, then write nothing at all.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(IngestClaudeCode);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const root = this.optionalFlag(flags.root) ?? defaultTranscriptRoot();

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

      const sweep = await this.sweep(root);
      const writes = this.write(project.store, sweep.entries, dryRun);

      for (const spec of DERIVED_TYPES) {
        rows.push({
          [ACTION]: 'entry',
          [TARGET]: spec.name,
          [OUTCOME]: describe(writes.counts.get(spec.name) ?? { written: 0, present: 0 }),
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
  private async sweep(root: string): Promise<Sweep> {
    const deriver = createDeriver();
    const entries: DerivedEntry[] = [];

    const totals = await streamCorpus(
      (record, file) => {
        for (const entry of deriver.accept(record, file)) entries.push(entry);
      },
      { root },
    );

    // Flushed after the walk, never during: the deriver holds one run open until a different
    // skill or session appears, so draining early would drop the last event of every file.
    for (const entry of deriver.drain()) entries.push(entry);

    if (totals.files === 0) {
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

    const tally = (type: string, wrote: boolean): void => {
      const current = counts.get(type) ?? { written: 0, present: 0 };
      counts.set(type, {
        written: current.written + (wrote ? 1 : 0),
        present: current.present + (wrote ? 0 : 1),
      });
    };

    if (dryRun) {
      for (const entry of entries) {
        tally(entry.type, findEntry(store.db, idFor(entry)) === undefined);
      }
      return { counts, warnings };
    }

    withTransaction(store.db, () => {
      for (const entry of entries) {
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
          tally(entry.type, true);
          for (const issue of issues) {
            warnings.push(`${entry.type} ${idFor(entry)}: ${issue.field}: ${issue.problem}`);
          }
        } catch (error) {
          // The second run's normal path, not a failure: the id is already in the store, which is
          // exactly what this command promises. Every other error is rethrown, so a real problem
          // cannot be mistaken for idempotency working.
          if (error instanceof DuplicateEntryError) {
            tally(entry.type, false);
            continue;
          }
          throw error;
        }
      }
    });

    return { counts, warnings };
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

    if (totals.skipped.length > 0) {
      this.warn(
        `${String(totals.skipped.length)} directory or symlink was not descended into, so it is ` +
          `not in these totals.`,
      );
    }

    // All three counters exist so a dropped event cannot be a silence.
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
    if (counters.keyCollisions > 0) {
      this.warn(
        `${String(counters.keyCollisions)} event key(s) repeated within a transcript and were ` +
          `disambiguated with a "#2" suffix. If a transcript is still growing, one of these may ` +
          `be written again as a new entry on a later run.`,
      );
    }

    for (const warning of writes.warnings) this.warn(warning);
  }
}

/**
 * One row's outcome, in the words a reader acts on.
 *
 * `already present` is spelled out rather than left as a bare zero, because on a re-run every row
 * says it and the reader's question is "did this work?" -- which a row of zeroes answers
 * ambiguously. `none` is a third state, not a flavour of the first two: it means the deriver found
 * nothing of this type at all, which is a fact about the corpus rather than about the store.
 */
function describe(counts: TypeOutcome): string {
  if (counts.written === 0 && counts.present === 0) return 'none';
  if (counts.written === 0) return `${String(counts.present)} already present`;
  if (counts.present === 0) return `${String(counts.written)} new`;
  return `${String(counts.written)} new, ${String(counts.present)} already present`;
}
