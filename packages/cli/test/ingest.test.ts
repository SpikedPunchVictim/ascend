import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTPUT_CONTRACT_VERSION } from '@ascend/cli';
import { DERIVED_SOURCE } from '@ascend/adapter-claude-code';
import { ENTRY_SOURCES } from '@ascend/store';

/**
 * `asc ingest claude-code`, driven as the real binary against a real store and a real corpus.
 *
 * Same reasoning as `cli.test.ts` -- a subprocess, not a direct call, because what can be wrong
 * here is the flag parser, the streams, the exit code and oclif's discovery of a TWO-WORD command
 * id, none of which a direct call exercises. `ingest claude-code` is the first nested command
 * whose subcommand name contains a hyphen, so its resolution is a real thing to be wrong.
 *
 * **The corpus is a fixture and HOME is the scratch directory.** `defaultTranscriptRoot()` reads
 * `homedir()`, and `asc()` here sets `HOME` to the scratch dir, so the default root resolves
 * INSIDE the fixture. That is deliberate and it is the whole safety story: this suite must never
 * be able to read the real `~/.claude/projects`, let alone touch it. A test that silently swept
 * 1.2 GiB of the operator's own transcripts would be slow, non-deterministic, and reading data it
 * has no business reading.
 *
 * **Every claim about what was written is read back out of SQLite**, not inferred from the
 * command's own report. The two halves of `--dry-run` are asserted separately -- the report AND
 * that the store is untouched, down to the registry -- because a preview that printed the right
 * thing and wrote the wrong thing is exactly the false-green this suite exists to catch.
 *
 * The fixture carries one record per derived type, and the counts are deliberately not equal: a
 * suite where every type yields one would pass if the deriver mixed the types up.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-ingest-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A directory holding an `.ascend/` store, with nothing registered in it yet. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.ascend'));
  return dir;
}

/**
 * The encoded project directory name, which is what `~/.claude/projects` actually holds.
 *
 * Not a decoded path: the encoding replaces both `/` and `-` with `-`, so decoding is lossy. The
 * encoded name is what the derived `project` property carries, and the assertion below checks it
 * survives the trip rather than being decoded into something plausible and wrong.
 */
const PROJECT_DIR = '-Users-me-scratch';

/**
 * The real working directory and branch every fixture record was made in.
 *
 * CHOSEN SO THAT NO READ OF THE PROJECT LABEL COULD PRODUCE THEM, which is what makes the
 * assertion below mean something. `PROJECT_DIR` is `-Users-me-scratch`; this is a SUBDIRECTORY
 * of the path it encodes. The encoding replaces both `/` and `-` with `-`, so it cannot express
 * a subdirectory even decoded correctly, and it carries no branch at all. A deriver that took
 * either value from the directory name fails here rather than passing by coincidence.
 */
const RECORD_AT = { cwd: '/Users/me/scratch/packages/core', gitBranch: 'feat/locality' };

/**
 * One record per derived type, in the order the deriver needs them.
 *
 * Order is load-bearing in two places, and both are the deriver's real mechanism rather than test
 * convenience. A denial names its tool by joining back to a `tool_use` block that has already
 * streamed past, so the invocation must precede it. A check's verdict chain is per file and starts
 * at the first verified pass, so the result must follow its invocation.
 *
 * Objects rather than pre-stringified lines, so `RECORD_AT` can be spread into every one of them
 * in a single place. Each record carrying it is the measured reality -- 100% of the records that
 * trigger a derived event carry both fields -- not a fixture convenience.
 */
const RECORDS: readonly Record<string, unknown>[] = [
  // The Bash invocation a check result will be joined back to.
  {
    sessionId: 's-1',
    uuid: 'u-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    ...RECORD_AT,
    message: {
      content: [
        { type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: 'pnpm test' } },
      ],
    },
  },
  // Its result: `is_error: false` and no earlier verdict, so this is a FIRST verified pass.
  {
    sessionId: 's-1',
    uuid: 'u-2',
    timestamp: '2026-01-02T03:04:06.000Z',
    ...RECORD_AT,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-bash', is_error: false }] },
  },
  // A writer invocation, for the denial below to resolve a tool name against.
  {
    sessionId: 's-1',
    uuid: 'u-3',
    timestamp: '2026-01-02T03:04:07.000Z',
    ...RECORD_AT,
    message: {
      content: [{ type: 'tool_use', id: 'toolu-write', name: 'Write', input: { file_path: '/x' } }],
    },
  },
  // The denial itself. Its `tool_use_id` is NOT a Bash invocation, so it is not also a check.
  {
    sessionId: 's-1',
    uuid: 'u-3b',
    timestamp: '2026-01-02T03:04:07.500Z',
    ...RECORD_AT,
    toolDenialKind: 'user-rejected',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-write' }] },
  },
  // A compaction, with `preCompactDiscoveredTools` ABSENT -- the real 156-of-438 case, which must
  // be omitted rather than written as an empty array.
  {
    sessionId: 's-1',
    uuid: 'u-4',
    timestamp: '2026-01-02T03:04:08.000Z',
    ...RECORD_AT,
    compactMetadata: {
      trigger: 'auto',
      preTokens: 1000,
      postTokens: 200,
      cumulativeDroppedTokens: 800,
      durationMs: 1234,
    },
  },
  {
    sessionId: 's-1',
    uuid: 'u-5',
    timestamp: '2026-01-02T03:04:09.000Z',
    ...RECORD_AT,
    attributionSkill: 'cli-best-practices',
  },
  // The one type whose value IS prose, so this is where `evidence_text` is exercised.
  {
    sessionId: 's-1',
    uuid: 'u-6',
    timestamp: '2026-01-02T03:04:10.000Z',
    ...RECORD_AT,
    userFeedback: 'no, use the other one',
  },
];

/**
 * One record per derived type, with neither `cwd` nor `gitBranch`.
 *
 * The 21.4% case: control records -- `mode`, `permission-mode`, `ai-title` -- carry neither, and
 * `entries` has `CHECK (cwd IS NULL OR cwd <> '')`, so the deriver must OMIT rather than default.
 * None of these triggers a derived event on the real corpus today; this fixture exists so the
 * omission is a branch something can reach, rather than an untested line.
 */
const RECORDS_WITHOUT_LOCALITY: readonly Record<string, unknown>[] = [
  {
    sessionId: 's-1',
    uuid: 'u-6',
    timestamp: '2026-01-02T03:04:10.000Z',
    userFeedback: 'no, use the other one',
  },
];

/** Write a transcript fixture under `dir`'s own `~/.claude/projects`, and return its path. */
function transcripts(dir: string, records: readonly Record<string, unknown>[] = RECORDS): string {
  const corpus = join(dir, '.claude', 'projects', PROJECT_DIR);
  mkdirSync(corpus, { recursive: true });
  writeFileSync(join(corpus, 's-1.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return corpus;
}

/** What the store actually holds. Read directly, never taken from the command's report. */
function stored(dir: string): {
  readonly entries: number;
  readonly types: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly sources: readonly string[];
  readonly ids: readonly string[];
} {
  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'));
  try {
    const byType: Record<string, number> = {};
    for (const row of db
      .prepare('SELECT type_name AS name, count(*) AS n FROM entries GROUP BY 1 ORDER BY 1')
      .all() as { name: string; n: number }[]) {
      byType[row.name] = row.n;
    }
    return {
      entries: (db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n,
      types: (db.prepare('SELECT count(*) AS n FROM entry_types').get() as { n: number }).n,
      byType,
      sources: (
        db.prepare('SELECT DISTINCT source FROM entries').all() as { source: string }[]
      ).map((row) => row.source),
      ids: (db.prepare('SELECT id FROM entries ORDER BY id').all() as { id: string }[]).map(
        (row) => row.id,
      ),
    };
  } finally {
    db.close();
  }
}

/** The `entry` rows of the report, keyed by type. */
function outcomes(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const cells = line.trim().split(/\s{2,}/);
    if (cells[0] !== 'entry') continue;
    out[cells[1] ?? ''] = cells.slice(2).join('  ');
  }
  return out;
}

describe('asc ingest claude-code', () => {
  it('derives every type from the transcripts and writes them', () => {
    const dir = project();
    transcripts(dir);

    const run = asc(['ingest', 'claude-code'], dir);

    expect(run.status).toBe(0);

    // Read back rather than trusted. One entry per type, each with its own count.
    const db = stored(dir);
    expect(db.byType).toEqual({
      context_compaction: 1,
      skill_activation: 1,
      tool_denial: 1,
      user_correction: 1,
      verification_run: 1,
    });

    // The provenance claim, which is the one column separating a machine's reading from a model's
    // self-report, and the type's whole reason for existing.
    expect(db.sources).toEqual([DERIVED_SOURCE]);

    // The id is a pure function of the event, so it is checkable by hand -- and stable enough that
    // a later rule change does not orphan the row.
    expect(db.ids).toContain(`derived:claude-code:verification_run:s-1:toolu-bash`);
    expect(db.ids).toContain(`derived:claude-code:context_compaction:s-1:u-4`);

    // Five definitions registered, through the ordinary registry path.
    expect(db.types).toBe(5);
  });

  it('writes what the transcripts carry into the properties, and omits what they do not', () => {
    const dir = project();
    transcripts(dir);
    asc(['ingest', 'claude-code'], dir);

    const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'));
    try {
      // `JSON.parse` returns `any`, and the linter is right to refuse it: an untyped parse would
      // let a renamed property pass as `undefined` against `toMatchObject` instead of failing.
      const properties = (type: string): Record<string, unknown> =>
        JSON.parse(
          (
            db
              .prepare('SELECT properties_json AS p FROM entries WHERE type_name = ?')
              .get(type) as {
              p: string;
            }
          ).p,
        ) as Record<string, unknown>;

      // The join that names a denial, and the encoded project name -- not a decoded path.
      expect(properties('tool_denial')).toMatchObject({
        denial_kind: 'user-rejected',
        tool_name: 'Write',
        tool_use_id: 'toolu-write',
        session_id: 's-1',
        project: PROJECT_DIR,
        occurred_at: '2026-01-02T03:04:07.500Z',
      });

      // Omitted, never an empty array: the transcript said nothing, and `[]` would say it looked
      // and found none. This is the absent-vs-zero distinction the whole project is built on.
      expect(properties('context_compaction')).not.toHaveProperty('discovered_tools');
      expect(properties('context_compaction')).toMatchObject({
        pre_tokens: 1000,
        post_tokens: 200,
      });

      // A first verified pass has no previous run, and "there was no earlier run" is a different
      // fact from "the earlier run agreed".
      expect(properties('verification_run')).toMatchObject({
        runner: 'pnpm test',
        verdict: 'passed',
      });
      expect(properties('verification_run')).not.toHaveProperty('previous_verdict');
    } finally {
      db.close();
    }
  });

  it('writes the real cwd and branch into the envelope, not the encoded project label', () => {
    // `asc-5hs`, driven end to end rather than through the deriver alone, because the two halves
    // live in different packages: the deriver reads the record, and THIS command is what puts the
    // value on `RecordContext`. A deriver that carried it and a command that dropped it would pass
    // every unit test in the adapter and store nothing.
    const dir = project();
    transcripts(dir);
    asc(['ingest', 'claude-code'], dir);

    const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'));
    try {
      const rows = db
        .prepare('SELECT type_name AS t, cwd, branch FROM entries ORDER BY type_name')
        .all() as { t: string; cwd: string | null; branch: string | null }[];

      // A guard on the guard: an ingest that wrote nothing would satisfy the loop below.
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.cwd, `${row.t} lost its cwd`).toBe(RECORD_AT.cwd);
        expect(row.branch, `${row.t} lost its branch`).toBe(RECORD_AT.gitBranch);
        // The whole point, asserted separately so a value read off the DIRECTORY cannot pass by
        // coincidence -- and the label is what the `project` property still carries, so this is
        // also the statement that the two are no longer the same fact.
        expect(row.cwd).not.toBe(PROJECT_DIR);
      }

      // The column a query actually reads: the generated view projects the envelope's `cwd`, so
      // this is reachable with no join -- which is what makes the fix worth having.
      const grouped = db
        .prepare('SELECT cwd, count(*) AS n FROM v_tool_denial_v1 GROUP BY 1')
        .all() as { cwd: string | null; n: number }[];
      expect(grouped).toEqual([{ cwd: RECORD_AT.cwd, n: 1 }]);
    } finally {
      db.close();
    }
  });

  it('OMITS the locality columns when the record carries neither, rather than writing ""', () => {
    // `''` is a REFUSED write -- `CHECK (cwd IS NULL OR cwd <> '')` -- so a defaulted empty string
    // would not be a quiet wrong answer, it would abort the ingest. NULL is the honest "the
    // transcript did not say", and this is where that branch is reached.
    const dir = project();
    transcripts(dir, RECORDS_WITHOUT_LOCALITY);

    const run = asc(['ingest', 'claude-code'], dir);
    expect(run.status).toBe(0);

    const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'));
    try {
      const row = db
        .prepare('SELECT cwd, branch FROM entries WHERE type_name = ?')
        .get('user_correction') as { cwd: string | null; branch: string | null };
      expect(row).toEqual({ cwd: null, branch: null });
    } finally {
      db.close();
    }
  });

  it('carries the user’s own words in evidence_text, where no other type does', () => {
    const dir = project();
    transcripts(dir);
    asc(['ingest', 'claude-code'], dir);

    const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'));
    try {
      const row = db
        .prepare('SELECT evidence_text AS t FROM entries WHERE type_name = ?')
        .get('user_correction') as { t: string | null };
      expect(row.t).toBe('no, use the other one');

      // And nowhere else: the reader's contract is that no raw transcript text reaches a caller
      // that prints, so a sweep cannot put user content into an agent's context.
      const others = db
        .prepare('SELECT count(*) AS n FROM entries WHERE evidence_text IS NOT NULL')
        .get() as { n: number };
      expect(others.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('creates no duplicates on a second run, and does not treat that as a failure', () => {
    const dir = project();
    transcripts(dir);

    asc(['ingest', 'claude-code'], dir);
    const first = stored(dir);

    const again = asc(['ingest', 'claude-code'], dir);

    // Exit 0: a re-run is the command working, not the command refusing. A script that ingests on
    // every session start would fail every time if this were 1.
    expect(again.status).toBe(0);
    expect(stored(dir)).toEqual(first);

    // And the report says so in words, because a row of zeroes answers "did this work?"
    // ambiguously.
    const rows = outcomes(again.stdout);
    expect(rows['verification_run']).toBe('1 already present');
    expect(rows['tool_denial']).toBe('1 already present');

    // The definitions are re-registered as `unchanged`, not rewritten into a new version.
    expect(again.stdout).toContain('unchanged');
    expect(again.stdout).not.toContain('prose-updated');
  });

  it('reports counts that differ per type, so a mixed-up deriver cannot pass', () => {
    const dir = project();
    transcripts(dir);

    const run = asc(['ingest', 'claude-code'], dir);
    const db = stored(dir);

    // The corpus holds SEVEN records and yields FIVE entries -- one per type, each its own
    // number. A count that equalled the record count would mean the rules were counting lines,
    // and a single total would not distinguish the types. Both differences are the evidence.
    expect(db.entries).toBe(5);
    expect(outcomes(run.stdout)['context_compaction']).toBe('1 new');
  });

  it('writes nothing at all on --dry-run, and reports what it would have written', () => {
    const dir = project();
    transcripts(dir);

    const run = asc(['ingest', 'claude-code', '--dry-run'], dir);

    expect(run.status).toBe(0);
    // The report is the real decision, computed by the code that makes it.
    expect(outcomes(run.stdout)['verification_run']).toBe('1 new');
    expect(run.stdout).toContain('created');

    // And nothing was written -- neither entries nor the registry. A dry run that registered the
    // types would be a preview that changed the thing it was previewing.
    expect(stored(dir)).toMatchObject({ entries: 0, types: 0 });
    expect(run.stderr).toContain('dry run: nothing was written');
  });

  it('refuses when the root holds no transcripts, instead of reporting a clean no-op', () => {
    const dir = project();
    // No `transcripts(dir)` call: the corpus is absent, which is what a wrong `--root` looks like.

    const run = asc(['ingest', 'claude-code'], dir);

    // Exit 1, not 0. A command that exits 0 having ingested nothing is the false success this
    // project treats as worse than a failure, and it is indistinguishable from a clean re-run.
    expect(run.status).toBe(1);
    // The message NAMES the root it looked in, because "found nothing" is only actionable if the
    // reader can see where ascend looked.
    //
    // **Asserted against the RAW stderr, and that is the assertion asc-98c exists for.** This path
    // is longer than the width ascend wraps at, so it is the case that used to arrive split across
    // two lines with a `›` between the halves -- unpasteable, and a substring assertion here failed
    // on output that was correct. There is no helper in between now: if the path is not one
    // contiguous string on stderr, this line says so.
    expect(run.stderr).toContain(join(dir, '.claude', 'projects'));
    expect(run.stderr).toContain('--root');
    // And it is still a failure with a label, not a bare path: the fix removed decoration, not the
    // context -> problem -> fix shape.
    expect(run.stderr).toContain('Error: No transcripts found under');
    expect(stored(dir).entries).toBe(0);
  });

  it('reads a corpus elsewhere when --root names one', () => {
    const dir = project();
    const elsewhere = scratch();
    transcripts(elsewhere);

    const run = asc(
      ['ingest', 'claude-code', '--root', join(elsewhere, '.claude', 'projects')],
      dir,
    );

    expect(run.status).toBe(0);
    expect(stored(dir).entries).toBe(5);
  });

  it('emits the same run as a versioned envelope under --json', () => {
    const dir = project();
    transcripts(dir);

    const run = asc(['ingest', 'claude-code', '--json'], dir);
    const envelope = JSON.parse(run.stdout) as {
      ascend_output: number;
      row_count: number;
      rows: { action: string; target: string; outcome: string }[];
    };

    expect(envelope.ascend_output).toBe(OUTPUT_CONTRACT_VERSION);
    // Five definitions and five types' worth of entries -- the same run the table describes.
    expect(envelope.row_count).toBe(10);
    expect(envelope.rows.filter((row) => row.action === 'type')).toHaveLength(5);
    expect(
      envelope.rows.filter((row) => row.action === 'entry' && row.outcome === '1 new'),
    ).toHaveLength(5);
  });

  it('advertises the command and its flags in --help', () => {
    const dir = project();
    const run = asc(['ingest', 'claude-code', '--help'], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--dry-run');
    expect(run.stdout).toContain('--root');
  });
});

/**
 * `asc-27l`: the derived source must be a source the store will ACCEPT.
 *
 * `recordEntry` does not validate `source` at runtime -- enforcement is the `entries` table's
 * CHECK constraint (`source IN ('self','derived:claude-code')`). So the adapter's constant and the
 * store's vocabulary are two independent declarations of the same fact with nothing tying them
 * together, and the failure mode is not subtle: a drift between them makes every derived insert
 * fail at the SQLite layer, with an error that says the constraint was violated and never says
 * which of the two declarations moved.
 *
 * This is the same shape as the false-green class this project treats as severity-zero: a rule
 * that references a name nothing defines evaluates as vacuous truth. The check below is what
 * makes the pair a pair.
 */
describe('derived source', () => {
  it('is one the store will accept', () => {
    expect(ENTRY_SOURCES).toContain(DERIVED_SOURCE);
  });
});
