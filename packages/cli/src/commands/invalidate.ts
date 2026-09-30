/**
 * `asc invalidate <entry-id...> --label <label> --reason <text>` -- strike entries the corpus
 * later learned measured the wrong thing.
 *
 * `ARCHITECTURE.md:219` and `:568`: entries are immutable by database trigger, so there is no edit
 * or delete path for a row that turns out wrong. The only honest remedy is an annotation under the
 * reserved scheme `invalidation`, recording that the entry stopped counting and why. Generated
 * per-type views expose the latest label as an `invalidated` column, and analysis excludes struck
 * entries with `WHERE invalidated IS NULL` -- nothing is silently dropped, and a reader auditing the
 * remainder can always see why.
 *
 * This command is the CLI half of that: `@ascend/store`'s `recordInvalidation` already validates
 * everything (the closed label vocabulary, a non-empty reason, `supersededBy` required iff
 * `superseded` and refused otherwise, both ids existing) and writes the row. Nothing here
 * re-validates or rewrites those messages -- they reach the caller exactly as the store phrased
 * them, so there is one place that explains the rule instead of two that might drift apart.
 *
 * **A batch is one transaction.** `--label wrong_value` applied to a bad ingest run is the common
 * case, and a half-applied correction -- three entries struck, a fourth silently left standing
 * because it happened to come last -- is worse than refusing the whole batch: it leaves the corpus
 * carrying a correction with no record of what the correction was supposed to cover. So every id is
 * invalidated inside one `withTransaction`, sharing one `createdAt` taken once at the start, and a
 * failure on any id rolls back everything the batch had already written.
 *
 * **`--dry-run` reuses the exact same write path, inside `withRollback` instead of
 * `withTransaction`.** That is not a second implementation of validation asked to preview itself --
 * it is the real `recordInvalidation`, run for real against the real store, inside a transaction
 * that is always rolled back. The preview a caller sees is therefore never allowed to disagree with
 * what the real run would do, because it is not a guess about what the real run would do.
 * `types/import.ts`'s `--dry-run` is the precedent for this shape.
 *
 * **`created: false` is reported, not swallowed.** `recordInvalidation` treats the byte-identical
 * invalidation of an entry as a no-op (the same precedent `asc ingest claude-code`'s second run
 * sets), which is correct for the store but would be a silent lie from a command that told the
 * caller it just struck an entry it did not touch. Each row's `outcome` says `wrote` or `already`
 * so a caller can tell "I just invalidated this" from "this was already invalidated, exactly like
 * this".
 *
 * **`asc invalidate --list [<entry-id>]` is the other half of a durable record.** Filing the
 * correction is not enough if there is no way to read it back short of hand-written SQL against
 * `annotations`; this reports `listInvalidations`, newest first. `--list` reads and the other flags
 * write, so the two are refused together rather than one silently winning.
 *
 * **A mistake cannot be withdrawn, by decision (asc-k6p.2).** There is no `--uninvalidate`, no
 * retraction annotation and no edit path back: `asc invalidate --help` and `asc --help` each contain
 * zero occurrences of retract, withdraw, undo or reinstate (measured 2026-09-28). The owner decided
 * on the same date to keep it that way until a real mistaken invalidation exists -- the test that
 * admitted only three labels, applied to a mechanism instead of a word. The two shapes of mistake
 * are not equally stuck, and the difference is what a later design has to answer for:
 *
 *   - **A wrong label** on an entry that really did stop counting has a remedy today. Invalidating
 *     again with a truer label writes a second row, and the view's `invalidated` column takes the
 *     later claim -- struck `wrong_subject` then `wrong_value`, the view reads `wrong_value`
 *     (measured 2026-09-28), while `--list` still returns both.
 *   - **A wrong entry** -- one that should never have been struck -- has none. Every label in the
 *     vocabulary strikes, so no second invalidation can un-strike, and the entry is excluded from
 *     analysis for good.
 *
 * **The second shape is the trigger, and it arrives as a report rather than as a search.** That is
 * why the `description` below says so: the person who has just realised the mistake is the one
 * reading this command's help, and nothing else would tell them that saying so reopens the question.
 */

import { Args, Flags } from '@oclif/core';
import {
  INVALIDATION_LABELS,
  listInvalidations,
  previewProducedLines,
  writeProducedLines,
  type InvalidationLabel,
  type Producers,
  type RecordedInvalidation,
  type SqlDatabase,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { usageError } from '../errors.js';
import { storePaths } from '../project.js';

/**
 * The handle this command reads `annotations.created_at` back through.
 *
 * The store's port, named directly, like `query.ts`'s `Handle`. Both were `Store['db']` until E12.3
 * gave the type a name that is not the driver's -- that file records why naming `node:sqlite` was
 * itself the violation.
 */
type Handle = SqlDatabase;

/**
 * The row's actual stored `created_at`, read back rather than assumed.
 *
 * `recordInvalidation`'s id no longer folds in `createdAt` -- identity is the claim (entryId,
 * label, reason, supersededBy, createdBy), not the moment -- so a `created: false` result means a
 * row that already existed under an EARLIER timestamp than this invocation's own clock reading.
 * Reporting `this.now()` for that row would be inventing a number the store never recorded
 * (`cli-best-practices`: never invent a number); the row's id is content-derived and therefore
 * unique, so there is exactly one row to read back by it.
 */
function storedCreatedAt(db: Handle, id: string): string {
  const row = db.prepare('SELECT created_at FROM annotations WHERE id = ?').get(id) as
    { created_at: string } | undefined;
  if (row === undefined) {
    throw new Error(
      `invalidation '${id}' was just recorded (or confirmed to already exist) but cannot be read ` +
        'back by its own id. This is a bug in ascend, not a problem with your input.',
    );
  }
  return row.created_at;
}

/**
 * The label the caller typed, as a member of the closed vocabulary.
 *
 * oclif has already refused anything outside `INVALIDATION_LABELS` by the time this runs (the flag
 * declares `options: INVALIDATION_LABELS`), so the search below cannot fail in practice -- the throw
 * is what makes that a check rather than an assumption, on the one boundary where a string becomes a
 * decision. Same shape as `explore.ts`'s `sampleMode`.
 */
function invalidationLabel(typed: string | undefined): InvalidationLabel | undefined {
  if (typed === undefined) return undefined;
  const label = INVALIDATION_LABELS.find((candidate) => candidate === typed);
  if (label === undefined) {
    throw usageError(`--label must be one of: ${INVALIDATION_LABELS.join(', ')}.`);
  }
  return label;
}

/** One invalidation written (or previewed), plus the id of the entry it struck. */
interface WrittenInvalidation extends RecordedInvalidation {
  readonly entryId: string;
  /** The row's actual `created_at` -- see `storedCreatedAt`. */
  readonly createdAt: string;
}

export default class Invalidate extends BaseCommand {
  static override description =
    'Strike entries under the reserved invalidation scheme, recording why they stopped counting. ' +
    'Entries are immutable and are never edited or deleted. A strike recorded in error cannot be ' +
    'withdrawn either -- retraction is deliberately unbuilt (asc-k6p.2), and reporting one is what ' +
    'reopens that decision.';

  static override examples = [
    // `--superseded-by` is REFUSED for any label but `superseded` (the store enforces it, and the
    // refusal explains that the flag carries a replacement claim `wrong_value` does not make).
    // This example paired it with `wrong_value` until asc-y7p, so the command's own documentation
    // printed an invocation that exits non-zero -- found by running it, not by reading it.
    '<%= config.bin %> <%= command.id %> e12 --label superseded --reason "unit mismatch, fixed in e19" --superseded-by e19',
    '<%= config.bin %> <%= command.id %> e12 e13 e14 --label wrong_subject --reason "measured the wrong endpoint"',
    '<%= config.bin %> <%= command.id %> e12 --label wrong_value --reason "..." --dry-run',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> --list e12',
  ];

  static override args = {
    // `ignoreStdin`: this arg is optional (`--list` alone takes none), and a command that filled it
    // from stdin when none was given on the command line would look like it was waiting for a
    // keypress rather than for input -- the same reasoning `query.ts`'s `sql` arg gives.
    entryIds: Args.string({
      description:
        'Entry id(s) to invalidate. With --list, at most one id, to filter the listing by.',
      required: false,
      multiple: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    label: Flags.string({
      options: INVALIDATION_LABELS,
      description:
        'Why the entry stopped counting. Required unless --list. The vocabulary is closed.',
    }),
    reason: Flags.string({
      description:
        'Free text: the durable record of why. Required unless --list, and never re-derived.',
    }),
    'superseded-by': Flags.string({
      description:
        "The replacing entry id. Required when --label is 'superseded', refused for any other " +
        'label -- the store enforces this and its message reaches you as-is.',
    }),
    actor: Flags.string({
      description:
        'Who or what struck the entry(ies). Stored as created_by; omitted rather than passed as ' +
        "''.",
    }),
    'dry-run': Flags.boolean({
      description: 'Validate the whole batch and report what would be written, then write nothing.',
    }),
    list: Flags.boolean({
      description:
        'List recorded invalidations, newest first, instead of writing one. Mutually exclusive ' +
        'with --label, --reason, --superseded-by, --actor and --dry-run.',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Invalidate);
    const format = this.resolveFormat(flags);
    const entryIds = args.entryIds ?? [];
    const list = this.flagValue(flags.list);
    const dryRun = this.flagValue(flags['dry-run']);
    const label = invalidationLabel(flags.label);
    const reason = this.optionalFlag(flags.reason);
    const supersededBy = this.optionalFlag(flags['superseded-by']);
    const actor = this.optionalFlag(flags.actor);

    if (list) {
      const conflicts: string[] = [];
      if (label !== undefined) conflicts.push('--label');
      if (reason !== undefined) conflicts.push('--reason');
      if (supersededBy !== undefined) conflicts.push('--superseded-by');
      if (actor !== undefined) conflicts.push('--actor');
      if (dryRun) conflicts.push('--dry-run');
      if (conflicts.length > 0) {
        throw usageError(
          `--list cannot be combined with ${conflicts.join(', ')}: --list reads recorded ` +
            'invalidations back, and those flags only mean something when writing one. Run the ' +
            'read and the write as separate commands.',
        );
      }
      if (entryIds.length > 1) {
        throw usageError(
          `--list takes at most one entry id to filter by; ${String(entryIds.length)} were given ` +
            `(${entryIds.join(', ')}). Run --list once per id, or drop --list to invalidate ` +
            'several at once.',
        );
      }

      await this.withProject(({ store }) => {
        const found = listInvalidations(store.db, entryIds[0]);
        this.emit(format, {
          columns: ['entry_id', 'label', 'reason', 'superseded_by', 'actor', 'created_at'],
          rows: found.map((row) => ({
            entry_id: row.entryId,
            label: row.label,
            reason: row.reason,
            superseded_by: row.supersededBy,
            actor: row.createdBy,
            created_at: row.createdAt,
          })),
        });
      });
      return;
    }

    if (entryIds.length === 0) {
      throw usageError(
        'give at least one entry id to invalidate, or --list to read recorded invalidations back.',
      );
    }
    if (label === undefined) {
      throw usageError(
        `--label is required: one of ${INVALIDATION_LABELS.map((one) => `'${one}'`).join(', ')}.`,
      );
    }
    if (reason === undefined) {
      throw usageError('--reason is required: say why the entry stopped counting.');
    }

    // Taken once, so a whole batch shares one invalidation event even though it strikes several
    // entries -- see the file comment. This is the timestamp OFFERED to `recordInvalidation`; it
    // is stored only when the claim is new. `storedCreatedAt` below reports what actually landed.
    const createdAt = this.now();

    await this.withProjectRoot((root) => {
      // Read through the TRANSACTION's handle, not one opened on the way in: the handle a command
      // holds before the write is read-only after the flip, and `storedCreatedAt` is a read of what
      // the write above just did -- which only exists inside this lock.
      const strike = (produce: Producers, db: SqlDatabase): readonly WrittenInvalidation[] =>
        entryIds.map((entryId) => {
          const recorded = produce.invalidation({
            entryId,
            label,
            reason,
            ...(supersededBy === undefined ? {} : { supersededBy }),
            ...(actor === undefined ? {} : { createdBy: actor }),
            createdAt,
          });
          return { entryId, ...recorded, createdAt: storedCreatedAt(db, recorded.id) };
        });

      // A batch of strikes is ONE fused write, which is what makes the reserved scheme's own line
      // appear once rather than once per claim: each production sees the one before it, because the
      // whole sequence runs inside the same rollback (`line-producers.ts` measured the alternative --
      // `expected [ 2, 2 ] to deeply equal [ 2, 1 ]`, a duplicate in a `merge=union` file).
      const { tree, index: indexFile } = storePaths(root);
      const written = dryRun
        ? previewProducedLines(tree, indexFile, strike)
        : writeProducedLines(tree, indexFile, { now: createdAt }, strike).result;

      if (dryRun) this.warn('dry run: nothing was written.');

      this.emit(format, {
        columns: ['entry_id', 'label', 'outcome', 'reason', 'superseded_by', 'actor', 'created_at'],
        rows: written.map((entry) => ({
          entry_id: entry.entryId,
          label: entry.label,
          // `wrote` / `already` is `RecordedInvalidation.created`, said in words: `created: false`
          // means this exact invalidation already existed and this call changed nothing, which a
          // caller must be able to tell apart from having just acted. The `would-` prefix carries
          // the same distinction through a preview that wrote nothing at all.
          outcome: dryRun
            ? entry.created
              ? 'would-write'
              : 'would-already'
            : entry.created
              ? 'wrote'
              : 'already',
          reason,
          superseded_by: supersededBy ?? null,
          actor: actor ?? null,
          // The row's actual stored value -- for `already`, this is when the claim was FIRST
          // made, not this invocation's clock reading. See `storedCreatedAt`.
          created_at: entry.createdAt,
          // JSON-only: `columns` is a projection for --table/--csv, not a filter on the row
          // (`output.ts`), and the content-derived id is the citation for this exact invalidation.
          id: entry.id,
          dry_run: dryRun,
        })),
      });
    });
  }
}
