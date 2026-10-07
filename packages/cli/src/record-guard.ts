/**
 * The pure half of `asc store verify` -- decide, from text alone, whether a record tree is safe to
 * commit. No git, no filesystem: the caller hands in each record file's text and each baseline's id
 * set, and this returns the refusals.
 *
 * ## What it refuses, and why the id half is the load-bearing one
 *
 * `asc-98e1`, on the measurement in `docs/evidence/EV-31.md` and `spike/git-layout/FINDINGS.md` W3.
 * Records are append-only JSONL under `.ascend/` with `*.jsonl merge=union`, and the failure mode
 * everything here exists for is that **a conflict resolution reports success and loses a record**.
 * Measured: a resolution that picks one side of an append-only conflict leaves WELL-FORMED JSONL --
 * every line parses, no markers, no duplicate ids -- with the other side's appends silently gone (5
 * records expected, 4 present, `rb0` absent, 0 unparseable lines). So a markers-and-parse check alone
 * passes exactly the case that loses the record. The comparison that catches it is the id set, and
 * that is why this module is mostly about ids and only incidentally about syntax.
 *
 * The three refusals, in the order the report lists them:
 *
 * 1. **A git conflict marker.** `git pull --rebase --autostash` exited 0 with three conflict-marker
 *    lines left inside a record file and the local records sitting in the stash (W3), so the next
 *    `git add -A && git commit` commits a corrupted file with nobody told.
 * 2. **A line the reader would refuse.** A corrupt line is refused here rather than left for
 *    `parseCorpus` to find on the next read, so the commit is blocked by the thing that made it.
 * 3. **An id present in a baseline and absent from the candidate.** The half that matters.
 *
 * ## What it does NOT do, stated rather than implied
 *
 * - **Type lines and scheme lines carry no id and are therefore not covered by the superset check.**
 *   Dropping one is caught elsewhere and loudly: an entry states its `type_hash` and its scheme, so a
 *   record whose registration vanished is a dangling reference the reader refuses. The check here is
 *   for what has no such backstop -- bare record ids.
 * - **It does not compare content, only presence.** One id with two different contents is
 *   `asc-2ezs`'s shape, refused at read (`onePerIdentity`, `jsonl-files.ts`), not here. A merge that
 *   keeps both sides' *records* passes this guard by design; keeping both *contents of one id* is a
 *   different question with a different answer.
 * - **No line's TEXT is carried in the report.** A coordinate and a phrase are what a caller fixes a
 *   tree from, and echoing a line would put record content -- which can be anything, including
 *   secret-shaped material `asc-4a6` makes the export boundary refuse -- into an error message. The
 *   same reason `scanSecrets` reports counts and locations and never the match.
 */

/** A line that stops the tree being safe to commit, named by coordinate and never by content. */
export interface BadLine {
  /** 1-based, so it matches what an editor and `git diff` call it. */
  readonly line: number;
  /** A phrase naming the problem. Safe to print: it carries no record content. */
  readonly problem: string;
}

/** One record file, after being read: its ids, and anything in it that stops a commit. */
export interface RecordFileScan {
  readonly where: string;
  readonly ids: readonly string[];
  readonly bad: readonly BadLine[];
}

/** A set of ids a candidate must not lose, and the name to report it under. */
export interface Baseline {
  readonly label: string;
  readonly ids: ReadonlySet<string>;
}

/** An id the candidate dropped, and the baseline that still holds it. */
export interface LostId {
  readonly id: string;
  readonly baseline: string;
}

/** The whole answer, which is `ok` exactly when nothing was refused. */
export interface GuardReport {
  readonly files: number;
  readonly ids: number;
  readonly badLines: readonly {
    readonly where: string;
    readonly line: number;
    readonly problem: string;
  }[];
  readonly lost: readonly LostId[];
  readonly ok: boolean;
}

/**
 * Git's conflict markers, which are exactly seven identical characters at the start of a line.
 *
 * `=======` needs no disambiguation from data: a JSONL record line starts with `{`, so no
 * legitimate line begins with seven `=`. The diff3 `|||||||` base marker is included because
 * `git checkout --conflict=diff3` writes it, and it is a marker left by a merge either way.
 */
const CONFLICT_MARKER = /^(<{7}|={7}|\|{7}|>{7})(\s|$)/;

/** The two line kinds that carry an id. A type or scheme line's identity is its name and version. */
const ID_BEARING_KINDS = new Set(['entry', 'annotation']);

function idOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['kind'] !== 'string' || !ID_BEARING_KINDS.has(record['kind'])) return undefined;
  return typeof record['id'] === 'string' ? record['id'] : undefined;
}

/**
 * Read one record file's text and report its ids and its bad lines.
 *
 * Blank lines are skipped rather than refused: a trailing newline is the normal shape, and a blank
 * line carries no record to lose. Everything else either yields an id or is a refusal.
 */
export function scanRecordFile(text: string, where: string): RecordFileScan {
  const ids: string[] = [];
  const bad: BadLine[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');
    if (line.trim() === '') continue;
    const coordinate = index + 1;

    if (CONFLICT_MARKER.test(line.trim())) {
      bad.push({ line: coordinate, problem: 'a git conflict marker left by a merge' });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad.push({ line: coordinate, problem: 'not valid JSON' });
      continue;
    }

    const id = idOf(parsed);
    if (id !== undefined) {
      ids.push(id);
      continue;
    }

    // Parsed, but not a line this store's reader would accept. Caught here so the commit that made
    // it is the commit that is refused, rather than the next read.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      bad.push({ line: coordinate, problem: 'not a record line (JSON that is not an object)' });
    } else if (!('kind' in parsed)) {
      bad.push({ line: coordinate, problem: 'not a record line (no "kind")' });
    } else {
      // Two ways to be a parsed object that is not a record line, and they are told apart because
      // the `problem` string is what a caller fixes a tree from. Either the kind IS id-bearing and
      // the `id` was unusable (`idOf` refused it above -- absent, or not a string), or the kind is
      // one this store does not know. Naming `kind` for the first case sends the reader to the
      // wrong field: the kind is perfectly well known and the id is what is missing.
      const kind = (parsed as { kind?: unknown }).kind;
      if (typeof kind === 'string' && ID_BEARING_KINDS.has(kind)) {
        bad.push({
          line: coordinate,
          problem: `not a record line ("${kind}" with no string "id")`,
        });
      } else if (kind !== 'type' && kind !== 'scheme') {
        // A type/scheme line is a legitimate record line carrying no id, so it falls through both.
        bad.push({ line: coordinate, problem: 'not a record line (unknown "kind")' });
      }
    }
  }

  return { where, ids, bad };
}

/**
 * Decide whether a candidate is safe against every baseline.
 *
 * The candidate is a set of files, so an id can be counted once even though a rolled-over store may
 * hold it in one file and a merge may move it to another. The comparison is deliberately over the
 * whole store, not per file: a `merge=union` merge plus a rollover can legitimately move a record
 * between files, and a per-file rule would refuse that as a loss.
 */
export function guardRecords(
  scans: readonly RecordFileScan[],
  baselines: readonly Baseline[],
): GuardReport {
  const present = new Set<string>();
  for (const scan of scans) for (const id of scan.ids) present.add(id);

  const badLines = scans.flatMap((scan) =>
    scan.bad.map((entry) => ({ where: scan.where, line: entry.line, problem: entry.problem })),
  );

  const lost: LostId[] = [];
  const seen = new Set<string>();
  for (const baseline of baselines) {
    for (const id of baseline.ids) {
      if (present.has(id)) continue;
      // An id missing from two baselines is one loss, reported against the first baseline that has
      // it -- a duplicate line would overstate how many records are gone.
      if (seen.has(id)) continue;
      seen.add(id);
      lost.push({ id, baseline: baseline.label });
    }
  }

  return {
    files: scans.length,
    ids: present.size,
    badLines,
    lost,
    ok: badLines.length === 0 && lost.length === 0,
  };
}
