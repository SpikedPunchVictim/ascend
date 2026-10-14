/**
 * The size of a commit, and whether it sits in the top tenth of its own repository's recent
 * commits -- the numbers `asc ingest git` records (asc-09wx.9).
 *
 * **Why size and nothing else.** Top-decile added source lines is the one commit-time signal that
 * held everywhere it was tested: nx, n8n and PostHog against typed fixes, PostHog's agent-marked
 * commits taken alone, and our own repositories against rework (`EV-60`, `EV-63`, `EV-66`,
 * `EV-68`). Churn failed the bar on our repositories and on PostHog and is not computed here.
 * Removed source lines predicted a fix in the public repositories and nothing in ours (`EV-67`), so
 * they are measured and stored and nothing flags on them.
 *
 * **The definitions are the measured ones, copied, not rewritten.** What counts as a source file,
 * which commits are eligible, and how a threshold is taken are the definitions `EV-61` and `EV-63`
 * measured with. A recorder that used a near copy would be recording a signal nobody tested.
 *
 * Everything here is a pure function over text and plain values. The one `git` call lives in the
 * command, and `COMMIT_LOG_ARGS` is exported so the text this module parses and the command that
 * produces it cannot drift apart.
 */

/** Eligible commits in the window a threshold is taken over (`EV-61`). */
export const SIZE_WINDOW_DAYS = 180;

/** Fewer eligible commits than this before a commit and it has no threshold yet (`EV-61`). */
export const SIZE_MIN_COMMITS = 50;

/** A commit touching more files than this is not graded: it is a sweep, not a change (`EV-57`). */
export const SIZE_MAX_FILES = 30;

const DAY_SECONDS = 86_400;
const RECORD = '\u001e';
const FIELD = '\u001f';

/**
 * The `git log` arguments whose output `parseCommitLog` reads.
 *
 * `-z` ends every path with a NUL, so a path is never quoted or escaped. Merges are left out
 * because a merge has no diff of its own to size.
 *
 * **`--no-renames` is the measured definition, not a convenience.** With it a moved file counts as
 * its whole length added, which is how the log behind `EV-63` was taken. Replayed over that log's
 * 367 commits, this module gives the same added source lines on all 367 with the flag and on 365
 * without it; the two that differ are the two commits that move a file.
 */
export const COMMIT_LOG_ARGS: readonly string[] = [
  'log',
  '--no-merges',
  '--no-renames',
  '-z',
  '--numstat',
  `--format=%x1e%H%x1f%ct%x1f`,
];

/**
 * Lockfiles, manifests, changelogs, docs, data and images, and anything under the two stores this
 * project writes into. The pattern is `EV-63`'s, character for character.
 */
const NOT_SOURCE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|\/)\.(ascend|beads)\//i;

/** Whether a path counts toward a commit's size. */
export function isSource(path: string): boolean {
  return !NOT_SOURCE.test(path);
}

/** One file a commit changed. A binary file has no line counts, and that is not a zero. */
export interface CommitFile {
  readonly path: string;
  readonly added: number | undefined;
  readonly removed: number | undefined;
}

export interface CommitStat {
  readonly sha: string;
  /** Committer time, in seconds since the epoch. */
  readonly committedAt: number;
  readonly files: readonly CommitFile[];
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

function count(text: string | undefined): number | undefined {
  return text === undefined || text === '-' ? undefined : Number(text);
}

function parseFiles(sha: string, body: string): CommitFile[] {
  // git writes `\0\n` between the format line and the first numstat field, so a field can open
  // with a newline that belongs to no path.
  const fields = body.split('\0').map((field) => field.replace(/^\n+/, ''));
  const files: CommitFile[] = [];
  for (const field of fields) {
    if (field === '') continue;
    const match = NUMSTAT.exec(field);
    if (match === null) {
      throw new Error(`commit ${sha}: not a numstat field: ${JSON.stringify(field)}`);
    }
    const path = match[3] ?? '';
    // Counts standing alone are how `-z` opens a rename, and `--no-renames` asks for none.
    if (path === '') throw new Error(`commit ${sha}: a numstat field with no path`);
    files.push({ path, added: count(match[1]), removed: count(match[2]) });
  }
  return files;
}

/** Parse the output of `git log` run with `COMMIT_LOG_ARGS`. */
export function parseCommitLog(text: string): CommitStat[] {
  const commits: CommitStat[] = [];
  for (const record of text.split(RECORD)) {
    if (record.trim() === '') continue;
    const [sha = '', at = '', ...rest] = record.split(FIELD);
    const committedAt = Number(at);
    if (sha === '' || at === '' || !Number.isInteger(committedAt)) {
      throw new Error(`commit ${sha}: commit time is not a number: ${JSON.stringify(at)}`);
    }
    commits.push({ sha, committedAt, files: parseFiles(sha, rest.join(FIELD)) });
  }
  return commits;
}

/** The threshold a commit was graded against, and how many commits it was taken over. */
export interface SizeThreshold {
  readonly p90AddedSourceLines: number;
  readonly commits: number;
}

export interface CommitSize {
  readonly sha: string;
  readonly committedAt: number;
  /** Every file the commit changed, source or not, binary or not. */
  readonly files: number;
  readonly sourceFiles: number;
  readonly addedSourceLines: number;
  readonly removedSourceLines: number;
  /** At least one source file with an added line, and no more than `SIZE_MAX_FILES` files. */
  readonly eligible: boolean;
  /** Absent when the commit is not eligible or too few eligible commits precede it. */
  readonly threshold?: SizeThreshold;
  /** Absent exactly when `threshold` is: an ungraded commit is not a small one. */
  readonly sizeTopDecile?: boolean;
}

interface Sized {
  readonly stat: CommitStat;
  readonly files: number;
  readonly sourceFiles: number;
  readonly added: number;
  readonly removed: number;
  readonly eligible: boolean;
}

function size(stat: CommitStat): Sized {
  const source = stat.files.filter((file) => file.added !== undefined && isSource(file.path));
  const added = source.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = source.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  return {
    stat,
    files: stat.files.length,
    sourceFiles: source.length,
    added,
    removed,
    eligible: source.some((file) => (file.added ?? 0) > 0) && stat.files.length <= SIZE_MAX_FILES,
  };
}

/**
 * Measure every commit, grading each eligible one against the eligible commits of the
 * `SIZE_WINDOW_DAYS` before it.
 *
 * The threshold is `sorted[floor(0.9 * n)]` and a commit is flagged when it is strictly above it,
 * as `EV-61` computed it. A commit never counts toward its own threshold, and commits sharing its
 * commit time do not either, so the answer does not depend on the order the log listed them in.
 * The result is in commit-time order, oldest first.
 */
export function measureCommits(stats: readonly CommitStat[]): CommitSize[] {
  const sized = stats
    .map(size)
    .sort(
      (a, b) => a.stat.committedAt - b.stat.committedAt || a.stat.sha.localeCompare(b.stat.sha),
    );
  const eligible = sized.filter((one) => one.eligible);
  return sized.map((one) => {
    const base = {
      sha: one.stat.sha,
      committedAt: one.stat.committedAt,
      files: one.files,
      sourceFiles: one.sourceFiles,
      addedSourceLines: one.added,
      removedSourceLines: one.removed,
      eligible: one.eligible,
    };
    if (!one.eligible) return base;
    const at = one.stat.committedAt;
    const before = eligible
      .filter(
        (other) =>
          other.stat.committedAt < at &&
          other.stat.committedAt >= at - SIZE_WINDOW_DAYS * DAY_SECONDS,
      )
      .map((other) => other.added)
      .sort((a, b) => a - b);
    if (before.length < SIZE_MIN_COMMITS) return base;
    const p90 = before[Math.floor(0.9 * before.length)] ?? 0;
    return {
      ...base,
      threshold: { p90AddedSourceLines: p90, commits: before.length },
      sizeTopDecile: one.added > p90,
    };
  });
}
