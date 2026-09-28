import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Typed handlers at ingest (asc-tuur.3): a `handlers/*.yaml` that declares `type:` has its rows
 * written as entries of that type, through the same validation and idempotency as every derived
 * entry. Driven as the real binary, HOME set to the scratch directory, exactly as `ingest.test.ts`
 * is -- this suite can never read the operator's own transcripts. The report text is synthetic.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');
/** The shipped handler, not a copy of it: the test is that THIS file captures a report. */
const HANDLER = join(root, 'handlers', 'review-finding-table.yaml');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function asc(args: readonly string[], cwd: string) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project with a store, and optionally the shipped typed handler in its `handlers/`. */
function project(withHandler = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-typed-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.ascend'));
  if (withHandler) addHandler(dir);
  return dir;
}

function addHandler(dir: string): void {
  mkdirSync(join(dir, 'handlers'), { recursive: true });
  copyFileSync(HANDLER, join(dir, 'handlers', 'review-finding-table.yaml'));
}

const AT = { cwd: '/Users/me/scratch', gitBranch: 'main' };

const REPORT = [
  '# Bug hunt: core',
  '',
  '## Issue Rating Table',
  '',
  '| # | Finding | Lens | Confidence | Urgency |',
  '|---|---------|------|-----------|---------|',
  '| 1 | src/state.ts:412 — the writer accepts a trailing separator | Write/Read | Confirmed | High |',
  '| 2 | `src/clock.ts:9` — a retry reads the wall clock | 6 | Traced | Low |',
  '| 3 | the retry budget is shared across tenants | Boundary | Confirmed | High |',
  '| 4 | src/a.ts:1 — a lens nobody named | Vibes | Suspected | Low |',
].join('\n');

/** A session whose reviewer wrote the report above, and nothing else. */
function reportSession(session: string, writeId = `toolu-write-${session}`) {
  return [
    {
      type: 'assistant',
      sessionId: session,
      uuid: `${session}-a1`,
      timestamp: '2026-09-27T10:00:00.000Z',
      ...AT,
      message: {
        id: `${session}-m1`,
        model: 'claude-test-1',
        content: [
          {
            type: 'tool_use',
            id: writeId,
            name: 'Write',
            input: { file_path: '.agents/research/2026-09-27-bug-hunt-core.md', content: REPORT },
          },
        ],
      },
    },
    {
      type: 'user',
      sessionId: session,
      uuid: `${session}-u1`,
      timestamp: '2026-09-27T10:00:01.000Z',
      ...AT,
      message: {
        content: [{ type: 'tool_result', tool_use_id: writeId, is_error: false, content: 'ok' }],
      },
    },
  ];
}

/** A ReportFindings call in `session`: the reported route. */
function reportedCall(session: string) {
  return {
    type: 'assistant',
    sessionId: session,
    uuid: `${session}-a2`,
    timestamp: '2026-09-27T10:00:02.000Z',
    ...AT,
    message: {
      id: `${session}-m2`,
      model: 'claude-test-1',
      content: [
        {
          type: 'tool_use',
          id: `toolu-report-${session}`,
          name: 'ReportFindings',
          input: {
            level: 'medium',
            findings: [
              {
                file: 'src/state.ts',
                line: 412,
                summary: 'the writer accepts a trailing separator',
                failure_scenario: 'writes "a/", reads it split',
                category: 'write_read_asymmetry',
                verdict: 'CONFIRMED',
              },
            ],
          },
        },
      ],
    },
  };
}

function transcript(dir: string, name: string, records: readonly unknown[]): void {
  const corpus = join(dir, '.claude', 'projects', '-Users-me-scratch');
  mkdirSync(corpus, { recursive: true });
  writeFileSync(
    join(corpus, `${name}.jsonl`),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

function findings(dir: string) {
  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'));
  try {
    return db
      .prepare(
        'SELECT id, class, file, line, summary, verdict, captured_by, reviewer_model, tool_use_id, ' +
          'session_id FROM v_review_finding_v1 ORDER BY id',
      )
      .all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const outcome = (stdout: string, action: string, target: string): string | undefined =>
  (JSON.parse(stdout) as { rows: { action: string; target: string; outcome: string }[] }).rows.find(
    (row) => row.action === action && row.target === target,
  )?.outcome;

describe('asc ingest claude-code with a typed handler (asc-tuur.3)', () => {
  it('writes one review_finding per table row the type accepts, marked as parsed', () => {
    const dir = project();
    transcript(dir, 's-1', reportSession('s-1'));
    const run = asc(['ingest', 'claude-code', '--json'], dir);
    expect(run.status, run.stderr).toBe(0);

    const rows = findings(dir);
    expect(rows.map((row) => row['class'])).toEqual(['write_read_asymmetry', 'time_concurrency']);
    expect(rows[0]).toMatchObject({
      file: 'src/state.ts',
      line: 412,
      summary: 'src/state.ts:412 — the writer accepts a trailing separator',
      verdict: 'Confirmed',
      captured_by: 'parsed',
      reviewer_model: 'claude-test-1',
      tool_use_id: 'toolu-write-s-1',
      session_id: 's-1',
    });
    // Keyed on the handler, the Write, and the row's position.
    expect(String(rows[0]?.['id'])).toMatch(
      /^derived:claude-code:review_finding:review-finding-table@[0-9a-f]{12}:s-1:toolu-write-s-1:0$/,
    );
  });

  it('refuses and COUNTS the rows the type cannot accept, rather than writing a guess', () => {
    const dir = project();
    transcript(dir, 's-1', reportSession('s-1'));
    const run = asc(['ingest', 'claude-code', '--json'], dir);
    // Row 3 names no file, row 4 a lens the map does not know: both are refused by the type.
    expect(outcome(run.stdout, 'entry', 'review_finding')).toBe('2 new, 2 rejected');
    expect(outcome(run.stdout, 'handler', 'review-finding-table')).toBe(
      '4 row(s) as review_finding',
    );
  });

  it('says a refused row is the handler’s to fix, not a command to record by hand', () => {
    // asc-tuur.7: the hint was `asc record review_finding --na file`, advice for a hand record.
    const dir = project();
    transcript(dir, 's-1', reportSession('s-1'));
    const stderr = asc(['ingest', 'claude-code'], dir).stderr.replace(/\s+/g, ' ');
    expect(stderr).toMatch(/the handler review-finding-table did not supply a value/);
    expect(stderr).not.toMatch(/asc record review_finding/);
  });

  it('is idempotent: a second run proposes the same ids and writes nothing', () => {
    const dir = project();
    transcript(dir, 's-1', reportSession('s-1'));
    asc(['ingest', 'claude-code'], dir);
    const again = asc(['ingest', 'claude-code', '--full', '--json'], dir);
    expect(outcome(again.stdout, 'entry', 'review_finding')).toBe('2 already present, 2 rejected');
    expect(findings(dir)).toHaveLength(2);
  });

  it('reads every transcript the first time a handler runs, so it fills BACKWARD too', () => {
    const dir = project(false);
    transcript(dir, 's-1', reportSession('s-1'));
    // Ingested before the handler existed: the cursor now knows the file.
    asc(['ingest', 'claude-code'], dir);
    expect(findings(dir)).toEqual([]);

    addHandler(dir);
    const run = asc(['ingest', 'claude-code'], dir);
    expect(run.stderr).toMatch(/reading every transcript: review-finding-table has not been run/);
    expect(findings(dir)).toHaveLength(2);

    // Once applied, the cursor is trusted again.
    const third = asc(['ingest', 'claude-code'], dir);
    expect(third.stderr).not.toMatch(/reading every transcript/);
  });

  it('leaves a --dry-run without trace, so the next real run still reads everything', () => {
    const dir = project(false);
    transcript(dir, 's-1', reportSession('s-1'));
    asc(['ingest', 'claude-code'], dir);
    addHandler(dir);
    asc(['ingest', 'claude-code', '--dry-run'], dir);
    expect(findings(dir)).toEqual([]);
    const run = asc(['ingest', 'claude-code'], dir);
    expect(run.stderr).toMatch(/reading every transcript/);
    expect(findings(dir)).toHaveLength(2);
  });

  it('leaves a session the reviewer REPORTED to the reported route, so nothing counts twice', () => {
    const dir = project();
    transcript(dir, 's-1', [...reportSession('s-1'), reportedCall('s-1')]);
    transcript(dir, 's-2', reportSession('s-2'));
    const run = asc(['ingest', 'claude-code', '--json'], dir);
    const rows = findings(dir);
    expect(
      rows.filter((row) => row['session_id'] === 's-1').map((row) => row['captured_by']),
    ).toEqual(['reported']);
    expect(rows.filter((row) => row['session_id'] === 's-2')).toHaveLength(2);
    expect(outcome(run.stdout, 'handler', 'review-finding-table')).toBe(
      '8 row(s) as review_finding, 4 left to the reported route in the same session',
    );
  });

  it('skips a handler that does not load, with a warning, and still writes everything else', () => {
    const dir = project(false);
    mkdirSync(join(dir, 'handlers'));
    writeFileSync(
      join(dir, 'handlers', 'broken.yaml'),
      'type: review_finding\non: nope\nemit: {a: b}\n',
    );
    transcript(dir, 's-1', [...reportSession('s-1'), reportedCall('s-1')]);
    const run = asc(['ingest', 'claude-code'], dir);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/handler handlers\/broken\.yaml was not run: on: "nope"/);
    expect(findings(dir).map((row) => row['captured_by'])).toEqual(['reported']);
  });

  it('names the entries an edited handler left open, until each is retired (asc-w8tx)', () => {
    const dir = project();
    transcript(dir, 's-1', reportSession('s-1'));
    asc(['ingest', 'claude-code'], dir);
    const before = findings(dir).map((row) => String(row['id']));

    // Any change to the parsed YAML is a new version, and writes new keys beside the old ones.
    const edited = join(dir, 'handlers', 'review-finding-table.yaml');
    writeFileSync(
      edited,
      readFileSync(edited, 'utf8').replace(/^description: .*$/m, 'description: edited'),
    );
    const run = asc(['ingest', 'claude-code', '--full'], dir);
    const warning = run.stderr.replace(/\s+/g, ' ');
    expect(warning).toMatch(
      /2 review_finding entries from an earlier version of handler review-finding-table \(@[0-9a-f]{12}\) are still counted/,
    );
    expect(findings(dir)).toHaveLength(4);

    const after = findings(dir)
      .map((row) => String(row['id']))
      .filter((id) => !before.includes(id));
    before.forEach((old, i) => {
      const retired = asc(
        [
          'invalidate',
          old,
          '--label',
          'superseded',
          '--superseded-by',
          String(after[i]),
          '--reason',
          'handler edited',
          '--actor',
          'test',
        ],
        dir,
      );
      expect(retired.status, retired.stderr).toBe(0);
    });
    const again = asc(['ingest', 'claude-code'], dir);
    expect(again.stderr).not.toMatch(/from an earlier version/);
  });

  it('names the handler when it writes a type this project never defined', () => {
    const dir = project(false);
    mkdirSync(join(dir, 'handlers'));
    writeFileSync(
      join(dir, 'handlers', 'orphan.yaml'),
      "type: no_such_type\non: file.changed\nemit: {path: '${path}'}\n",
    );
    transcript(dir, 's-1', reportSession('s-1'));
    const run = asc(['ingest', 'claude-code'], dir);
    expect(run.stderr).toMatch(/a handler in handlers\/ writes 'no_such_type'/);
  });
});
