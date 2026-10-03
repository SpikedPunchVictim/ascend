/**
 * `asc store verify` -- refuse a commit that would lose a record, or that would land a corrupted
 * record tree. `asc-98e1`.
 *
 * ## Why a command and not an installed hook
 *
 * `core.hooksPath` is a single value, and beads already claims it in this repository (see
 * `.beads/hooks/pre-commit` and `scripts/install-hooks.mjs`), so ascend installing its own git hook
 * would either silence beads' five hooks or be silently shadowed by them. A command is the shape a
 * pre-commit hook, CI, and a human can all call, and it is the shape the guard's own tests need --
 * `EV-31` asks for "fixtures for each refusal, plus a clean union merge passes", which is a suite.
 *
 * Wire it as a pre-commit hook by adding `asc store verify --staged` to one, or run it in CI as
 * `asc store verify --staged --against origin/main`. Both compare id sets; either catches the
 * resolution that reports success and drops a record.
 *
 * ## What each mode compares
 *
 * - **Default**: the tree at `HEAD` against each of `HEAD`'s parents. This is the after-the-fact
 *   question -- "did that merge, which just landed, lose a record?" -- and it is what CI runs.
 * - **`--staged`**: the INDEX -- what the next commit would contain -- against `HEAD` and
 *   `MERGE_HEAD`. This is the pre-commit question, and `MERGE_HEAD` exists exactly while a
 *   conflicted merge is being committed, which is the moment a one-side resolution goes wrong.
 * - **`--against <ref>`** replaces that baseline, repeatably, so `--staged --against origin/main`
 *   asks whether a branch's staged tree holds every record `origin/main` does.
 *
 * Read-only: it reads git objects and writes nothing, to the store or to git.
 */

import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { STORE_DIR } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { refusal } from '../../errors.js';
import {
  gitRoot,
  mergeHead,
  parentsOf,
  recordFilesAt,
  resolveRef,
  stagedRecordFiles,
  storePathspec,
  GitError,
} from '../../git-records.js';
import {
  guardRecords,
  scanRecordFile,
  type Baseline,
  type GuardReport,
  type RecordFileScan,
} from '../../record-guard.js';

/** How many problems the stderr message names before it says "and N more". */
const NAMED_IN_MESSAGE = 5;

interface BaselineRef {
  readonly ref: string;
  readonly label: string;
}

export default class StoreVerify extends BaseCommand {
  static override description =
    'Refuse a record tree a commit would corrupt or shrink: git conflict markers, lines the reader ' +
    'would reject, or a record id present in a parent commit and absent from the candidate.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --staged',
    '<%= config.bin %> <%= command.id %> --staged --against origin/main --json',
  ];

  static override flags = {
    staged: Flags.boolean({
      description:
        'Check the INDEX -- what the next commit would contain -- instead of HEAD. For a ' +
        'pre-commit hook. The baseline is HEAD and MERGE_HEAD (when a merge is in progress).',
    }),
    against: Flags.string({
      description:
        'A commit a record id must not disappear relative to. Repeatable. Replaces the default ' +
        'baseline, so CI runs `--staged --against origin/main`.',
      multiple: true,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(StoreVerify);
    const format = this.resolveFormat(flags);

    const repositoryRoot = gitRoot(process.cwd());
    if (repositoryRoot === undefined) {
      throw refusal(
        `asc store verify compares a record tree against a parent COMMIT, so it needs a git ` +
          `repository, and ${process.cwd()} is not inside one. Run it from the checkout that holds ` +
          `the store, or drop it from the hook/CI step that called it.`,
      );
    }

    await this.withProjectRoot((root) => {
      const pathspec = storePathspec(repositoryRoot, join(root, STORE_DIR));
      const staged = this.flagValue(flags.staged);
      const against = this.optionalFlag(flags.against) ?? [];

      const candidate = staged
        ? stagedRecordFiles(repositoryRoot, pathspec)
        : recordFilesAt(repositoryRoot, 'HEAD', pathspec);

      const scans: RecordFileScan[] = [...candidate].map(([where, text]) =>
        scanRecordFile(text, where),
      );

      const baselines = this.readBaselines(repositoryRoot, pathspec, staged, against);
      const report = guardRecords(scans, baselines);

      this.emit(format, {
        columns: ['problem', 'where', 'detail'],
        rows: [
          ...report.badLines.map((bad) => ({
            problem: 'unreadable-line',
            where: `${bad.where}:${String(bad.line)}`,
            detail: bad.problem,
          })),
          ...report.lost.map((loss) => ({
            problem: 'lost-id',
            where: loss.id,
            detail: `present in ${loss.baseline}, absent from the tree being checked`,
          })),
        ],
      });

      if (!report.ok) {
        throw refusal(this.explain(report, staged, baselines));
      }

      // Nothing to report on stdout; the note says WHAT was checked, because a guard that examined
      // zero files and a guard that examined thousands and found nothing must not read the same.
      this.emitStderr(
        'Note',
        `${String(report.files)} record file(s), ${String(report.ids)} record id(s), ` +
          `${String(baselines.length)} baseline(s) — no conflict markers, no unreadable lines, ` +
          `no lost record ids.`,
      );
    });
  }

  /**
   * The baselines to check against, read into id sets.
   *
   * A `--against` ref that does not resolve is a refusal, because the caller named it and a silently
   * empty baseline would make the check pass for the wrong reason. A default `HEAD` that does not
   * resolve is NOT -- an initial commit has no parent, and there is genuinely nothing to compare.
   */
  private readBaselines(
    repositoryRoot: string,
    pathspec: string,
    staged: boolean,
    against: readonly string[],
  ): readonly Baseline[] {
    const refs = this.baselineRefs(repositoryRoot, staged, against);
    return refs.map(({ ref, label }) => {
      const ids = new Set<string>();
      for (const text of recordFilesAt(repositoryRoot, ref, pathspec).values()) {
        for (const id of scanRecordFile(text, ref).ids) ids.add(id);
      }
      return { label, ids };
    });
  }

  private baselineRefs(
    repositoryRoot: string,
    staged: boolean,
    against: readonly string[],
  ): readonly BaselineRef[] {
    if (against.length > 0) {
      return against.map((ref) => ({
        ref: this.mustResolve(repositoryRoot, ref),
        label: ref,
      }));
    }

    if (staged) {
      const refs: BaselineRef[] = [];
      const head = this.tryResolve(repositoryRoot, 'HEAD');
      if (head !== undefined) refs.push({ ref: head, label: 'HEAD' });
      const merge = mergeHead(repositoryRoot);
      if (merge !== undefined) refs.push({ ref: merge, label: 'MERGE_HEAD' });
      return refs;
    }

    const head = this.tryResolve(repositoryRoot, 'HEAD');
    if (head === undefined) return [];
    return parentsOf(repositoryRoot, head).map((sha) => ({ ref: sha, label: sha.slice(0, 12) }));
  }

  private mustResolve(repositoryRoot: string, ref: string): string {
    try {
      return resolveRef(repositoryRoot, ref);
    } catch (error) {
      if (error instanceof GitError) {
        throw refusal(
          `--against ${ref} does not name a commit in this repository, so there is nothing to ` +
            `compare against. Check the ref name, or fetch the branch it refers to.`,
        );
      }
      throw error;
    }
  }

  private tryResolve(repositoryRoot: string, ref: string): string | undefined {
    try {
      return resolveRef(repositoryRoot, ref);
    } catch {
      return undefined;
    }
  }

  /** The human explanation, on stderr: context, then the problems, then the fix. */
  private explain(report: GuardReport, staged: boolean, baselines: readonly Baseline[]): string {
    const subject = staged ? 'The index' : 'HEAD';
    const baselineNames = baselines.map((baseline) => baseline.label).join(', ');
    const lines: string[] = [];

    const total = report.badLines.length + report.lost.length;
    lines.push(
      `${subject} is not safe to commit: ${String(total)} problem(s) across ` +
        `${String(report.files)} record file(s), checked against ${baselineNames || 'no baseline'}.`,
    );

    const named = [
      ...report.badLines.map((bad) => `  ${bad.where}:${String(bad.line)} — ${bad.problem}`),
      ...report.lost.map(
        (loss) =>
          `  record ${loss.id} — present in ${loss.baseline}, absent from the tree being checked`,
      ),
    ].slice(0, NAMED_IN_MESSAGE);
    lines.push(...named);
    const remaining = total - named.length;
    if (remaining > 0)
      lines.push(`  ...and ${String(remaining)} more (the table on stdout lists all).`);

    lines.push(
      report.lost.length > 0
        ? 'A merge resolution that keeps only one side produces well-formed JSONL with the other ' +
            "side's records gone (EV-31). Re-resolve the merge so BOTH sides' records are present, " +
            'then re-run this check.'
        : 'A conflict marker or an unreadable line reached the record tree, usually from a ' +
            '`git pull --rebase --autostash` that exited 0 (spike/git-layout FINDINGS W3). Fix the ' +
            'file by hand, then re-run this check.',
    );

    return lines.join('\n');
  }
}
