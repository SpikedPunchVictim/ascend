import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeProjectDir } from '../src/handler-replay.js';

/**
 * `asc types capture` and the capture line `asc types define` prints (asc-tuur.5), driven as the
 * real binary with HOME set to the scratch project, so only the synthetic transcript is read.
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

const TYPE = {
  name: 'incident',
  properties: [
    { name: 'service', type: 'string', required: true, description: 'The service that failed.' },
    { name: 'summary', type: 'text', required: true, description: 'What the outage did.' },
    { name: 'owner', type: 'string', description: 'Who was paged first.' },
    { name: 'tool_use_id', type: 'ref', required: true, description: 'The Write it came from.' },
  ],
};

const TABLE = [
  '| Service | Outage |',
  '|---|---|',
  '| billing | invoices stalled |',
  '| search | slow queries |',
].join('\n');

/** A project with a store, and one session whose Write holds the table (when `withTable`). */
function project(withTable = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-capture-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  if (asc(['init'], dir).status !== 0) throw new Error('asc init failed');
  writeFileSync(join(dir, 'incident.json'), JSON.stringify(TYPE));
  const corpus = join(dir, '.claude', 'projects', encodeProjectDir(dir));
  mkdirSync(corpus, { recursive: true });
  const content = withTable ? TABLE : '# notes, no table';
  const records = [
    {
      type: 'assistant',
      sessionId: 's-1',
      message: {
        id: 'm1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_w1',
            name: 'Write',
            input: { file_path: 'pm.md', content },
          },
        ],
      },
    },
    {
      type: 'user',
      sessionId: 's-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'ok' }] },
    },
  ];
  writeFileSync(join(corpus, 's-1.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return dir;
}

const value = (stdout: string, signal: string, field: string): unknown =>
  (JSON.parse(stdout) as { rows: { signal: string; field: string; value: unknown }[] }).rows.find(
    (row) => row.signal === signal && row.field === field,
  )?.value;

/**
 * Whether `chmod 000` actually denies this process the file.
 *
 * Running as root the mode bits are advisory and the fixture would read straight through the
 * locked file, so the test would pass while exercising nothing -- worse than skipping. Same guard,
 * same reason, as `reader.test.ts:107`.
 */
const canVandalize = process.getuid === undefined || process.getuid() !== 0;

/** The fixture's transcript path, discovered by the walk but unopenable once locked. */
const transcriptPath = (dir: string): string =>
  join(dir, '.claude', 'projects', encodeProjectDir(dir), 's-1.jsonl');

describe('asc types define: the capture line', () => {
  it('says the type can be captured from a table sessions already write, with the count', () => {
    const dir = project();
    const run = asc(['types', 'define', 'incident.json'], dir);
    expect(run.status, run.stderr).toBe(0);
    const text = run.stderr.replace(/\s+/g, ' ');
    expect(text).toMatch(
      /ascend can capture incident .* columns service, outage in 1 session\(s\)/,
    );
    expect(text).toMatch(/would write 2 entries and the type would refuse 0/);
    // The negative of the unreadable warning: everything above is over a corpus the sweep DID
    // read, so the warning below is conditional on a real failure rather than always-on.
    expect(text).not.toMatch(/could not be read/);
  });

  it('says a transcript could not be read, rather than that nothing reads as the type', () => {
    // `files` counts DISCOVERED transcripts, so the `files === 0` return does not fire over a
    // corpus nothing could be opened from -- and without this warning the verdict below would be
    // "nothing in this project's transcripts reads as incident yet" about files never read. `asc
    // ingest` reports the same failures (`claude-code.ts:908`); two readers of one corpus must not
    // disagree about whether anything was left out (asc-86a8).
    if (!canVandalize) return;
    const dir = project(false);
    const locked = transcriptPath(dir);
    chmodSync(locked, 0o000);

    try {
      const run = asc(['types', 'define', 'incident.json'], dir);
      const text = run.stderr.replace(/\s+/g, ' ');
      expect(text).toMatch(/1 transcript path\(s\) could not be read/);
      // The verdict is still printed, and is now accompanied by the fact that qualifies it.
      expect(text).toMatch(/nothing in this project's transcripts reads as incident yet/);
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it('says so when nothing reads as the type yet', () => {
    const dir = project(false);
    const run = asc(['types', 'define', 'incident.json'], dir);
    expect(run.stderr.replace(/\s+/g, ' ')).toMatch(
      /nothing in this project's transcripts reads as incident yet/,
    );
  });

  it('skips the look with --no-capture', () => {
    const dir = project();
    const run = asc(['types', 'define', 'incident.json', '--no-capture'], dir);
    expect(run.status).toBe(0);
    expect(run.stderr).not.toMatch(/capture incident/);
  });
});

describe('asc types capture', () => {
  it('reports the table, the draft, and what the draft would write', () => {
    const dir = project();
    asc(['types', 'define', 'incident.json', '--no-capture'], dir);
    const run = asc(['types', 'capture', 'incident', '--json'], dir);
    expect(run.status, run.stderr).toBe(0);
    expect(value(run.stdout, 'table[0]', 'columns')).toBe('service->service, outage->summary');
    expect(value(run.stdout, 'draft', 'would_write')).toBe(2);
    expect(String(value(run.stdout, 'draft', 'table_handler'))).toContain('type: incident');
  });

  it('writes nothing without --write, and saves the draft with it, never over a file', () => {
    const dir = project();
    asc(['types', 'define', 'incident.json', '--no-capture'], dir);
    const saved = join(dir, 'handlers', 'incident-table.yaml');
    asc(['types', 'capture', 'incident'], dir);
    expect(existsSync(saved)).toBe(false);

    expect(asc(['types', 'capture', 'incident', '--write'], dir).status).toBe(0);
    const text = readFileSync(saved, 'utf8');
    const again = asc(['types', 'capture', 'incident', '--write'], dir);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already exists/);
    expect(readFileSync(saved, 'utf8')).toBe(text);
  });

  it('the saved draft is a typed handler that ingest runs', () => {
    const dir = project();
    asc(['types', 'define', 'incident.json', '--no-capture'], dir);
    asc(['types', 'capture', 'incident', '--write'], dir);
    const run = asc(['ingest', 'claude-code', '--include-ephemeral', '--json'], dir);
    const rows = (
      JSON.parse(run.stdout) as { rows: { action: string; target: string; outcome: string }[] }
    ).rows;
    expect(rows.find((row) => row.action === 'entry' && row.target === 'incident')?.outcome).toBe(
      '2 new',
    );
  });

  it('says a transcript could not be read, rather than that nothing reads as the type', () => {
    // The `scanned === 0` refusal is over DISCOVERED files, so a corpus where the file exists but
    // cannot be opened passes it and would otherwise conclude "nothing reads as incident yet" --
    // the absence claim asserted over a corpus that was never read (asc-86a8).
    if (!canVandalize) return;
    const dir = project();
    asc(['types', 'define', 'incident.json', '--no-capture'], dir);
    const locked = transcriptPath(dir);
    chmodSync(locked, 0o000);

    try {
      const run = asc(['types', 'capture', 'incident'], dir);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr.replace(/\s+/g, ' ')).toMatch(/1 transcript path\(s\) could not be read/);
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it('does not count a symlink as unreadable, because not following one is the decision made', () => {
    // `reader.ts:263` skips a symlink deliberately -- following one could leave the root or loop
    // forever -- so a corpus holding one is not a corpus that could not be read. Counting it would
    // put a permanent warning on a healthy project, which is the false report the same rule avoids
    // in `handler-replay.ts:239-243`.
    const dir = project();
    asc(['types', 'define', 'incident.json', '--no-capture'], dir);
    symlinkSync(
      transcriptPath(dir),
      join(dir, '.claude', 'projects', encodeProjectDir(dir), 'l.jsonl'),
    );

    const run = asc(['types', 'capture', 'incident'], dir);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/could not be read/);
  });
});
