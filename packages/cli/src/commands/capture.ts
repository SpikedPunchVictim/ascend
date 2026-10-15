/**
 * `asc capture` -- hash the files a session is shaped by, and write one `intervention` row for
 * whatever moved since the last look (asc-09wx.8.2).
 *
 * **The row this writes is the unexplained one, and that is the point of it.** `EV-16` measured 0 of
 * 15 sessions running `asc record` in any form, so a ledger whose rows depend on somebody choosing
 * to write one depends on a mechanism measured not to fire. This command writes the row nobody
 * chose: `status: applied`, a date, a before/after hash per file, and **no `reason`** -- with no
 * reason it does not claim to know why, and with no `metric` it is a capture rather than a proposal
 * (`intervention`'s `rule` is required only beside a `metric`, the condition `asc-09wx.8.1`
 * settled). A person who knows why can write a better row by hand; this one exists so that a change
 * with nobody watching is still not nothing.
 *
 * **It is a top-level command and not `asc ingest capture`, deliberately.** The second capture source
 * -- `file.changed` events, which date a change to the tool call rather than to the next session
 * start -- belongs under `ingest`, and this one does not read transcripts or a commit log at all.
 * Folding the two together under one verb would have made "capture" mean two different observations.
 *
 * **Time is the session start, which is an UPPER BOUND on when the change was made, and the row says
 * so.** Nothing was watching at the moment of the edit; the honest statement is "these files differed
 * at this time, and by these hashes", which is exactly what `applied_at` plus `digest` carries. A
 * later reader who needs to know *when* can bound it from the previous row's date.
 *
 * **Entries first, the baseline second, and the order is what makes a crash safe.** The reverse
 * order loses a row forever: the baseline would have advanced past a change no entry describes. This
 * order costs one re-observation at worst, and it costs nothing at all because an entry's id is
 * derived from the transition it describes -- so the re-observation is a `DuplicateEntryError` that
 * this command reads as `present` rather than as a failure. That same key is what makes two
 * concurrent `SessionStart` hooks (`/clear` fires the event a second time) write one row between
 * them rather than two identical ones. `ingest/claude-code.ts` writes its cursor after its entries
 * for the same reason, in its own direction.
 *
 * **`source: 'observed:capture'`.** Settled in `asc-09wx.8.7`, and the value this command was
 * written with (`'self'`) was deliberately provisional until that bead decided. `self` is a claim
 * about who is SPEAKING -- every other row carrying it was written by the model about itself
 * through `asc record` -- and nobody wrote this one. Filing these rows under `self` would have made
 * the count of "the model chose to record" and the count of "a machine recorded for it" the same
 * query, and inflated the first with the second: `EV-16` measured 0 of 15 sessions running
 * `asc record`, so a re-measurement against this ledger would have read the capture's rows as the
 * mechanism firing when they are the mechanism not firing. The suffix names the subsystem, matching
 * `derived:claude-code` (the adapter) and `derived:git` (the ingester) -- so `asc-09wx.8.6`'s
 * `file.changed` source spells itself `observed:file-changed` and a change seen by both mechanisms
 * is two rows a reader can tell apart. See `ENTRY_SOURCES` (`recorder.ts`) for the whole rule.
 */

import { homedir } from 'node:os';
import { Flags } from '@oclif/core';
import { canonicalJson, sha256Hex } from '@ascend/core';
import {
  DuplicateEntryError,
  findEntry,
  readWatchedHashes,
  writeProducedLines,
  writeWatchedHashes,
  type Producers,
  type SqlDatabase,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal } from '../errors.js';
import { storePaths } from '../project.js';
import { registerDocumentVia } from '../register-document.js';
import { STARTER_TYPES } from '../starters.js';
import {
  hashWatched,
  watchIdentity,
  watchedChanges,
  watchedPaths,
  type WatchedChange,
} from '../watched.js';

const TYPE_NAME = 'intervention';
const SOURCE = 'observed:capture';

/**
 * What one run did, in the terms a reader of the output cares about.
 *
 * Four outcomes, because this command reports ONE observation and not a batch -- unlike
 * `asc ingest git`, whose table tallies every commit it was given. The fifth state the mechanism has,
 * a watched file that is there and cannot be read, never reaches this: it is a refusal, so it arrives
 * as an exit code and a sentence on stderr rather than as a row that succeeded at something.
 *
 * `baselined` is the first run, and it is not a failure or a silence. It is the observation that there
 * was nothing to compare against -- which a `digest` cannot record, since an entry carrying an empty
 * digest would be a claim that nothing changed.
 */
type Outcome = 'recorded' | 'present' | 'unchanged' | 'baselined';

export default class Capture extends BaseCommand {
  static override description =
    'Hash the files a session is shaped by -- CLAUDE.md, the Claude Code settings, the hook scripts ' +
    'and the installed skills -- and record one `intervention` row for whatever changed since the ' +
    'last run. Writes nothing when nothing moved, and nothing on the first run.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ];

  static override flags = {
    'dry-run': Flags.boolean({
      description: 'Report what would be recorded, and write neither the entry nor the baseline.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Capture);
    const format = this.resolveFormat(flags);
    const dryRun = flags['dry-run'];

    await this.withProjectRoot((projectRoot) => {
      const { tree, index } = storePaths(projectRoot);
      const paths = watchedPaths(projectRoot, homedir());
      const identity = watchIdentity(paths);
      const observation = hashWatched(paths);

      // The third state, and the one that must not be rounded to either neighbour. A watched path
      // that is there and cannot be read leaves the observation unable to say what changed; writing
      // a row from it would claim a change nobody measured, and writing the baseline would advance
      // past a change nobody saw. So: nothing written, the path named, and a non-zero exit -- which
      // is the only channel from a SessionStart hook to the model, where exit-0 stderr is discarded.
      if (observation.kind === 'incomplete') {
        throw refusal(
          `could not read the watched file ${observation.path} in ${projectRoot}: ` +
            `${observation.detail}. Nothing was recorded and the previous baseline is unchanged, ` +
            `so this change is still visible once the file can be read.`,
        );
      }

      const baseline = readWatchedHashes(tree);
      // A corrupt or unreadable baseline is repaired rather than reported as a failure: it is one
      // machine-local file, the next run re-baselines from here, and a change missed in between is
      // recoverable where a spuriously claimed one would not be. On stderr for the person running it
      // by hand, and deliberately exit 0 so the hook does not turn a self-repairing file into a nag.
      const comparable = baseline.kind === 'ok' && baseline.state.watch === identity;
      if (baseline.kind === 'unusable') {
        this.emitStderr(
          'Warning',
          `${baseline.path} could not be read (${baseline.detail}), so there is nothing to compare ` +
            `against. No row was written; a fresh baseline is recorded from here.`,
        );
      } else if (baseline.kind === 'ok' && !comparable) {
        this.emitStderr(
          'Note',
          `the watched set has changed since the last run, so the previous baseline is not ` +
            `comparable to this one. No row was written; a fresh baseline is recorded from here.`,
        );
      }

      const changes = comparable ? watchedChanges(baseline.state.files, observation.files) : [];
      const recordedAt = this.now();
      const report: { outcome: Outcome; files: number } = {
        outcome: !comparable ? 'baselined' : changes.length === 0 ? 'unchanged' : 'recorded',
        files: 0,
      };

      if (!dryRun && report.outcome === 'recorded') {
        const ascendVersion = this.ascendVersion();
        const properties = captureProperties(changes, recordedAt);
        const id = idFor(changes);
        report.files = changes.length;
        const record = (produce: Producers, db: SqlDatabase): void => {
          registerDocumentVia(produce, db, interventionSpec(), { registeredAt: recordedAt });
          try {
            produce.entry(
              { type: TYPE_NAME, properties },
              { id, recordedAt, ascendVersion, source: SOURCE, cwd: projectRoot },
            );
          } catch (error) {
            if (!(error instanceof DuplicateEntryError)) throw error;
            // The transition was already recorded -- by a concurrent session, or by an earlier run
            // whose baseline write did not survive. Entries are immutable and this one describes the
            // same before/after, so the stored row is the answer and the later date is discarded for
            // the earlier one, which is the tighter bound on when the change happened.
            if (findEntry(db, id) === undefined) throw error;
            report.outcome = 'present';
          }
        };
        writeProducedLines(tree, index, { now: recordedAt }, record);
      }

      if (!dryRun) writeWatchedHashes(tree, { watch: identity, files: observation.files });

      this.emit(format, { columns: ['outcome', 'files'], rows: [report] });
    });
  }
}

/**
 * The entry's properties, and nothing that is not an observation.
 *
 * `change` is the changed paths and nothing else -- "the name a person would use, not a description
 * of the effect". `reason`, `metric`, `rule` and `prediction` are all absent on purpose and for the
 * same reason: this mechanism watched files move and did not watch anything decide.
 */
function captureProperties(
  changes: readonly WatchedChange[],
  recordedAt: string,
): Readonly<Record<string, unknown>> {
  return {
    change: changes.map((change) => `\`${change.path}\``).join(', '),
    status: 'applied',
    applied_at: recordedAt,
    digest: changes,
  };
}

/**
 * The entry's id: the transition it describes, hashed.
 *
 * Keyed on the content and not on the time, so that the same change observed twice is one row --
 * which is what makes writing the baseline after the entry safe, and what keeps two concurrent
 * SessionStart hooks from filing the same observation twice.
 */
function idFor(changes: readonly WatchedChange[]): string {
  return `${SOURCE}:${TYPE_NAME}:${sha256Hex(canonicalJson(changes))}`;
}

/**
 * `intervention`'s definition, out of the starter set this CLI ships.
 *
 * **Registered here rather than assumed.** `asc init` registers the starter types, but a store
 * created by an ascend that did not have this one would refuse the entry with `UnknownTypeError`,
 * and the hook would report that every session. `registerType` reports `unchanged` for a shape it
 * already knows, so this is idempotent -- the same call `ingest/git.ts` makes for its own type.
 *
 * Reaching into `STARTER_TYPES` rather than holding a second copy of the spec: the array is the
 * definition, and a copy here would be the second place a property is added.
 */
function interventionSpec(): (typeof STARTER_TYPES)[number] {
  const spec = STARTER_TYPES.find((candidate) => candidate.name === TYPE_NAME);
  if (spec === undefined) {
    throw new Error(
      `this ascend ships no '${TYPE_NAME}' starter type, so 'asc capture' has nothing to record ` +
        `into. This is a problem with the asc installation rather than with your input.`,
    );
  }
  return spec;
}
