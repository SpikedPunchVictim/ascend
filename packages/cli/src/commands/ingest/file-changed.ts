/**
 * `asc ingest file-changed` -- one `intervention` row for every edit of a watched file, dated to
 * the tool call that made it (asc-09wx.8.6).
 *
 * **The second observer, and why there are two rather than one twice.** `asc capture` hashes the
 * watched set at SessionStart (`asc-09wx.8.2`). That dates a change to the session AFTER the one
 * that made it, and it cannot see an edit made and reverted inside one session at all. This reads
 * `file.changed` events out of the event log -- which the adapter already writes, one per `Write`,
 * `Edit`, `MultiEdit` and `NotebookEdit` tool result -- so each edit arrives carrying the tool
 * call's own timestamp. The two write under different `source` values (`observed:capture`,
 * `observed:file-changed`), which is what lets a change BOTH mechanisms saw be read as two rows
 * about one edit rather than as one unexplained duplicate.
 *
 * **Neither source reads the other, and neither reads the store.** The sweep diffs `watched-hashes`
 * against the filesystem; this reads the log. A change seen by both is two rows, and a reader tells
 * them apart by `source` plus `applied_at` -- the sweep's date is the session start after the edit,
 * this one's is the edit. They are kept distinguishable rather than deduplicated because the two
 * dates bound the change from opposite ends, and picking one would throw the other away.
 *
 * **One row per change, keyed on the event.** Every edit of a watched path is its own row, because
 * the property this source exists to fill is `applied_at`, and one row per session would have to
 * pick a single instant to stand for a sessionful of edits. The id is the event's own stream
 * identity, `(session_id, agent_id, seq)` -- see `idFor` for why it is the event and not the
 * content.
 *
 * **`digest` is absent on these rows, and that is the honest value rather than a gap.** The property
 * is documented as "one object per file the change touched: `path`, `before_sha256`,
 * `after_sha256`", and `file.changed` carries the edit's own `old_string`/`new_string`, not the
 * file's bytes before and after. Hashing the file NOW would be a number dated to the ingest wearing
 * a field whose other writer dates it to the observation -- one property meaning two different
 * things depending on which source wrote the row. So the row omits it, and `status: applied` plus
 * `applied_at` is the whole of what this observer actually saw.
 *
 * **A path outside the watched set is not a row.** The set is `watchedPaths` -- the instruction
 * files, the Claude Code settings, the hook scripts and the installed skills -- and it is
 * deliberately small, because an `intervention` row is about a change to how work is done and a
 * `src/foo.ts` edit is not one. Events naming anything else are counted and reported on stderr, so
 * the scope of a run is a number a reader can check rather than an absence they have to trust.
 * The log also holds the events of OTHER projects (one `~/.claude/projects` corpus feeds every
 * store), and home-level watched paths are watched here for exactly that reason -- an edit to
 * `~/.claude/CLAUDE.md` from any session shapes this project too.
 *
 * **`cwd` is omitted, where `asc capture` fills it.** A capture hashed this project's files and can
 * say where; an event carries no directory (the envelope has no such field), so the only value
 * available here is the directory this command was run in -- which for an event from another
 * project would be a claimed provenance that is simply false. Omitted reads as "not said", which
 * is the true one.
 *
 * **The log is read WHOLE, and a tree holding streams from an older derive version refuses.** This
 * uses `readEventLog`, the same reader `asc handlers check --source log` replays through, and it
 * gates every line on `EVENT_DERIVE_VERSION` -- refused rather than replayed, because a count moves
 * when the derive version moves with no handler changed. Measured 2026-10-15 on this checkout's own
 * log, `du -sh` and a read of every stream file's first line: 6,145 stream files, 9.1 GiB, of which
 * 2,605 are version 11, 3,465 version 12 and 75 version 13, and 19 hold two versions at once -- the
 * 11/12 pairs being what the PREVIOUS bump left. So on this checkout the command refuses, and it has
 * refused since the version moved 11 -> 12.
 *
 * **And a `--full` run does not clear it**, which is what the refusal's own message tells a reader to
 * expect. The log's writer only appends, and the module that owns the log has no capability to
 * delete or truncate one -- so a re-derive writes the new version's lines BESIDE the stale ones and
 * the next read refuses at the same file and the same line (`dogfood/0114`, `asc-qdkv`). What clears
 * it is removing the stale stream files and re-deriving in the same step; removing them without
 * re-deriving is worse than leaving them, because a reader over an absent log answers zero events
 * rather than refusing.
 *
 * The staleness itself is a property of the log and of the cursor (which skips a transcript whose
 * mtime and size are unchanged, so a version bump leaves it stale until a `--full` run), not of this
 * command, and deviating from it here would make two readers of one log disagree about what it
 * holds. The whole-log read is also the expensive one: the log stores each Write's `after` text,
 * which is the whole file.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { canonicalJson, sha256Hex, validateEntry, type NormalizedEvent } from '@ascend/core';
import {
  DuplicateEntryError,
  findEntry,
  previewProducedLines,
  writeProducedLines,
  type Producers,
  type SqlDatabase,
} from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { readEventLog } from '../../event-log.js';
import { storePaths } from '../../project.js';
import { registerDocumentVia } from '../../register-document.js';
import { STARTER_TYPES } from '../../starters.js';
import { watchedPaths } from '../../watched.js';

const TYPE_NAME = 'intervention';
const SOURCE = 'observed:file-changed';

const OUTCOMES = ['written', 'present', 'changed'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** One edit of a watched file, resolved to the display spelling an entry carries. */
interface Change {
  readonly id: string;
  readonly display: string;
  /** The event's timestamp, or `undefined` when it carried none. */
  readonly ts: string | undefined;
}

/**
 * What a pass over the log selected, and what it left out.
 *
 * The three `skipped` counts are separated rather than summed because a reader acts on them
 * differently: a path outside the set is the policy working, a non-absolute path is the log
 * disagreeing with its own contract, and a path that could not be read is damage. Folding them
 * into one number would make the first, which is deliberate, look like the third.
 */
interface Selection {
  readonly changes: readonly Change[];
  readonly changesSeen: number;
  readonly outsideWatched: number;
  readonly notAbsolute: number;
}

export default class IngestFileChanged extends BaseCommand {
  static override description =
    'Record one `intervention` row for every change a tool call made to a watched file -- the ' +
    'instructions, settings, hook scripts and skills a session is shaped by -- dated to the call ' +
    'that made it. Re-running creates no duplicates: every entry is keyed on its event.';

  static override examples = [
    '<%= config.bin %> <%= config.bin %>',
    '<%= config.bin %> <%= config.bin %> --json',
    '<%= config.bin %> <%= config.bin %> --dry-run',
  ];

  static override flags = {
    'dry-run': Flags.boolean({
      description: 'Report what would be recorded, and write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(IngestFileChanged);
    const format = this.resolveFormat(flags);
    const dryRun = flags['dry-run'];

    await this.withProjectRoot((projectRoot) => {
      const { tree, index } = storePaths(projectRoot);
      const log = readEventLog(tree);
      const selection = selectChanges(log.events, projectRoot);

      this.report(tree, log.files, log.events.length, log.unreadable.length, selection, dryRun);

      const spec = interventionSpec();
      const recordedAt = this.now();
      const ascendVersion = this.ascendVersion();

      // Validation happens before the write, on every row, and a row the type refuses is counted
      // and skipped rather than allowed to reach the transaction -- `asc ingest claude-code`'s
      // rule, and its reason: the entries land in ONE `BEGIN IMMEDIATE`, so a single rejection
      // thrown inside it would unwind every row the run had proposed.
      const rejections: string[] = [];
      const valid: Change[] = [];
      for (const change of selection.changes) {
        const properties = changeProperties(change);
        const checked = validateEntry(spec, { properties });
        if (checked.ok) {
          valid.push(change);
          continue;
        }
        for (const issue of checked.errors) {
          rejections.push(`${change.id}: ${issue.field}: ${issue.problem} (${issue.fix})`);
        }
      }
      for (const rejection of rejections) this.warn(rejection);

      const tally: Record<Outcome, number> = { written: 0, present: 0, changed: 0 };
      const recordAll = (produce: Producers, db: SqlDatabase): void => {
        registerDocumentVia(produce, db, spec, { registeredAt: recordedAt });
        for (const change of valid) {
          const properties = changeProperties(change);
          try {
            produce.entry(
              { type: TYPE_NAME, properties },
              { id: change.id, recordedAt, ascendVersion, source: SOURCE },
            );
            tally.written += 1;
          } catch (error) {
            if (!(error instanceof DuplicateEntryError)) throw error;
            // A duplicate id is ordinary idempotency only when it is a re-proposal of the SAME
            // content. The display path is part of the content and comes from a POLICY -- a
            // watched set that has since widened spells a path it did not spell before -- so the
            // two cases are told apart by reading the stored row back rather than by assuming a
            // re-run, which is `asc ingest git`'s rule and its reason: entries are immutable, and
            // the stored row is the answer.
            const existing = findEntry(db, change.id);
            if (existing === undefined) throw error;
            const same = canonicalJson(existing.properties) === canonicalJson(properties);
            tally[same ? 'present' : 'changed'] += 1;
          }
        }
      };

      // The preview runs the REAL writers under a rollback rather than a second classification
      // path, so the counts it prints are the counts a run would produce by construction -- and a
      // project whose index is stale is refused with `asc index build` named, which is the remedy
      // a preview can offer where a write would have silently rebuilt (`previewProducedLines`).
      if (dryRun) previewProducedLines(tree, index, recordAll);
      else writeProducedLines(tree, index, { now: recordedAt }, recordAll);

      this.emit(format, {
        columns: ['outcome', 'entries'],
        rows: OUTCOMES.map((outcome) => ({ outcome, entries: tally[outcome] })),
      });
    });
  }

  /**
   * Everything that is not a row: how much log was read to produce the table above, and what the
   * watched set left out.
   *
   * On stderr, because it describes the INPUT. stdout is the data contract, and how much was read
   * to produce it must not share a shape that pretends to be part of it.
   */
  private report(
    tree: string,
    files: number,
    events: number,
    unreadable: number,
    selection: Selection,
    dryRun: boolean,
  ): void {
    this.logToStderr(
      `read ${String(files)} log file(s) from ${tree}: ${String(events)} event(s), ` +
        `${String(selection.changesSeen)} file.changed, ` +
        `${String(selection.changes.length)} naming a watched path`,
    );

    if (dryRun) this.warn('dry run: nothing was written.');

    if (unreadable > 0) {
      this.warn(
        `${String(unreadable)} directory in the log could not be listed, so nothing under it was ` +
          `read. The events it holds are not in the store; re-run once it is readable.`,
      );
    }

    if (selection.outsideWatched > 0) {
      this.logToStderr(
        `${String(selection.outsideWatched)} file.changed event(s) named a path outside the ` +
          `watched set, so no row was written for them. The set is a policy -- the instructions, ` +
          `settings, hook scripts and skills a session is shaped by -- and a change inside a ` +
          `repository's own source is not in it.`,
      );
    }

    // A path that is not absolute is the log contradicting the field's own documented contract
    // (`core/event.ts`), and it is named rather than resolved: `resolve` would compare it against
    // this process's working directory, which would silently match a different file or nothing.
    if (selection.notAbsolute > 0) {
      this.warn(
        `${String(selection.notAbsolute)} file.changed event(s) carried a path that is not ` +
          `absolute. They were skipped rather than resolved against this process's working ` +
          `directory, which is not where the event happened.`,
      );
    }
  }
}

/**
 * Every `file.changed` event naming a watched path, resolved to that path's display spelling.
 *
 * The match is by RESOLVED ABSOLUTE PATH, because `watchedPaths` already carries both spellings
 * side by side for exactly this join -- `{display, absolute}` -- and a second resolver here would
 * be a second answer to "how is this path spelled in an entry".
 *
 * **Not `realpath`, deliberately, on either side.** A symlinked spelling of a watched file would
 * then fail to match, and the failure is in the direction `asc-09wx.8.2` chose when it wrote that a
 * missed row is recoverable and a spurious row is not: nothing is written, the run reports how many
 * events it left out, and the next one still has the event.
 */
function selectChanges(events: readonly NormalizedEvent[], projectRoot: string): Selection {
  const watched = new Map(
    watchedPaths(projectRoot, homedir()).map((path) => [path.absolute, path.display]),
  );

  const changes: Change[] = [];
  let changesSeen = 0;
  let outsideWatched = 0;
  let notAbsolute = 0;

  for (const event of events) {
    if (event.kind !== 'file.changed') continue;
    changesSeen += 1;
    const path = event['path'];
    if (typeof path !== 'string' || !isAbsolute(path)) {
      notAbsolute += 1;
      continue;
    }
    const display = watched.get(resolve(path));
    if (display === undefined) {
      outsideWatched += 1;
      continue;
    }
    const ts = event['ts'];
    changes.push({
      id: idFor(event),
      display,
      ts: typeof ts === 'string' ? ts : undefined,
    });
  }

  return { changes, changesSeen, outsideWatched, notAbsolute };
}

/**
 * The entry's id: the EVENT it was read from, hashed.
 *
 * Keyed on `(session_id, agent_id, seq)` -- the log's own stream identity, which `readEventLog` has
 * already deduplicated -- and deliberately NOT on the properties it derives. That is
 * `derived:claude-code`'s rule, and it buys the same thing here: `display` is read off a POLICY
 * (`watchedPaths`), so a watch list that has since changed spells a path differently without
 * changing which edit the row is about. The re-run then reports `changed` against the stored row
 * instead of writing a second permanent row about one edit.
 *
 * `observed:capture` hashes its CONTENT instead, and the difference is not an inconsistency: a
 * SessionStart sweep has no event to key on, only a transition it computed, so the transition's own
 * hash is the only stable name available to it. Here there is an event, and an event's name is more
 * durable than anything derived from it.
 */
function idFor(event: NormalizedEvent): string {
  const key = canonicalJson({
    session: event.session_id,
    agent: event.agent_id,
    seq: event.seq,
  });
  return `${SOURCE}:${TYPE_NAME}:${sha256Hex(key)}`;
}

/**
 * The entry's properties, and nothing that is not an observation.
 *
 * `change` is the path and nothing else -- "the name a person would use, not a description of the
 * effect". `reason`, `metric`, `rule` and `prediction` are absent for the same reason they are
 * absent on a capture row: this mechanism watched a file move and did not watch anything decide.
 *
 * `applied_at` is the tool call's own timestamp, which is the whole point of this source over the
 * sweep's, and it is omitted when the event carried none rather than filled with the ingest's own
 * clock -- a row claiming an edit time it does not know is the fabrication this ledger exists to
 * prevent. An event's spelling is whatever the harness wrote, so a timestamp the store's own
 * validation refuses is caught by the caller and named there, rather than guessed at here.
 */
function changeProperties(change: Change): Readonly<Record<string, unknown>> {
  return {
    change: `\`${change.display}\``,
    status: 'applied',
    ...(change.ts === undefined ? {} : { applied_at: change.ts }),
  };
}

/**
 * `intervention`'s definition, out of the starter set this CLI ships.
 *
 * Registered here rather than assumed, for the reason `asc capture` gives: a store created by an
 * ascend that did not have this type would refuse every entry with `UnknownTypeError` and report
 * that on every run, and `registerType` reports `unchanged` for a shape it already knows, so the
 * call is idempotent. Reaching into `STARTER_TYPES` rather than holding a second copy of the spec,
 * because a copy is the second place a property gets added.
 */
function interventionSpec(): (typeof STARTER_TYPES)[number] {
  const spec = STARTER_TYPES.find((candidate) => candidate.name === TYPE_NAME);
  if (spec === undefined) {
    throw new Error(
      `this ascend ships no '${TYPE_NAME}' starter type, so 'asc ingest file-changed' has nothing ` +
        `to record into. This is a problem with the asc installation rather than with your input.`,
    );
  }
  return spec;
}
