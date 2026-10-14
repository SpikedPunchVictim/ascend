/**
 * `asc ingest git` -- one `commit_size` entry for every non-merge commit reachable from HEAD
 * (asc-09wx.9).
 *
 * **What is measured is `commit-size.ts`, and this file only reads the log and writes.** The one
 * `git` call takes its arguments from `COMMIT_LOG_ARGS`, so the text the parser reads and the
 * command that produces it cannot drift apart.
 *
 * **Re-running adds nothing.** Every entry's id is the commit's sha, so a commit already recorded
 * is a `DuplicateEntryError`, read here as `present` when the stored content is what this run
 * measured. A stored entry whose content differs is `changed` and left as it is: entries are
 * immutable, and a threshold can move when a merge brings in commits older than ones already
 * graded. The entry records the threshold the commit was read against when it was first recorded.
 *
 * **One fused write.** The type registers and every entry lands in one transaction, so a run that
 * fails part way leaves the store as it was.
 */
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '@ascend/core';
import {
  DuplicateEntryError,
  findEntry,
  writeProducedLines,
  type Producers,
  type SqlDatabase,
} from '@ascend/store';
import { BaseCommand } from '../../base.js';
import {
  COMMIT_LOG_ARGS,
  COMMIT_SIZE_TYPE,
  commitSizeProperties,
  measureCommits,
  parseCommitLog,
} from '../../commit-size.js';
import { refusal } from '../../errors.js';
import { gitRoot } from '../../git-records.js';
import { storePaths } from '../../project.js';
import { registerDocumentVia } from '../../register-document.js';

const SOURCE = 'derived:git';
const OUTCOMES = ['written', 'present', 'changed'] as const;
type Outcome = (typeof OUTCOMES)[number];

function idFor(sha: string): string {
  return `${SOURCE}:${COMMIT_SIZE_TYPE.name}:${sha}`;
}

/** The output of `git log` over every commit reachable from HEAD, or a refusal naming why not. */
function commitLog(repository: string): string {
  try {
    return execFileSync('git', [...COMMIT_LOG_ARGS, 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : String(error);
    throw refusal(`could not read the commit log of ${repository}: ${detail}`);
  }
}

export default class IngestGit extends BaseCommand {
  static override description =
    'Record the size of every non-merge commit reachable from HEAD, and whether it sits in the ' +
    'top tenth of its repository’s recent commits. Re-running creates no duplicates: every entry ' +
    'is keyed on its commit.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(IngestGit);
    const format = this.resolveFormat(flags);

    await this.withProjectRoot((projectRoot) => {
      const repository = gitRoot(projectRoot);
      if (repository === undefined) {
        throw refusal(
          `${projectRoot} is not in a git repository, so there are no commits to measure.`,
        );
      }
      const sizes = measureCommits(parseCommitLog(commitLog(repository)));

      const tally: Record<Outcome, number> = { written: 0, present: 0, changed: 0 };
      const recordedAt = this.now();
      const ascendVersion = this.ascendVersion();
      const recordAll = (produce: Producers, db: SqlDatabase): void => {
        registerDocumentVia(produce, db, COMMIT_SIZE_TYPE, { registeredAt: recordedAt });
        for (const size of sizes) {
          const properties = commitSizeProperties(size);
          try {
            produce.entry(
              { type: COMMIT_SIZE_TYPE.name, properties },
              { id: idFor(size.sha), recordedAt, ascendVersion, source: SOURCE, gitSha: size.sha },
            );
            tally.written += 1;
          } catch (error) {
            if (!(error instanceof DuplicateEntryError)) throw error;
            const existing = findEntry(db, idFor(size.sha));
            if (existing === undefined) throw error;
            const same = canonicalJson(existing.properties) === canonicalJson(properties);
            tally[same ? 'present' : 'changed'] += 1;
          }
        }
      };

      const { tree, index } = storePaths(projectRoot);
      writeProducedLines(tree, index, { now: recordedAt }, recordAll);

      this.emit(format, {
        columns: ['outcome', 'commits'],
        rows: OUTCOMES.map((outcome) => ({ outcome, commits: tally[outcome] })),
      });
    });
  }
}
