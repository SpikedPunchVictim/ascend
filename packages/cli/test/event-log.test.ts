import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_DERIVE_VERSION } from '@ascend/adapter-claude-code';
import { buildIndex, INDEX_FILE } from '@ascend/store';
import type { NormalizedEvent } from '@ascend/core';
import { openEventLog, readEventLog } from '../src/event-log.js';

/**
 * The event log (asc-igg8): the normalizer's output written down, so a handler count survives the
 * transcript it was replayed from.
 *
 * Two arms. The unit arm drives the module directly, because what it must refuse -- an id that
 * cannot name a directory, a line from another derive version, a line that is not JSON -- is not
 * reachable from a real transcript and would otherwise be untested code on the read path. The
 * end-to-end arm drives the real binary, because "the log is written by ingest" is a claim about
 * `ingest/claude-code.ts`'s wiring and only the real command can be wrong about it.
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

/**
 * Whether `chmod 000` actually denies this process the directory.
 *
 * Running as root, the mode bits are advisory and the fixture would read straight through the
 * locked directory -- so the test would pass while exercising nothing, which is worse than
 * skipping. Same guard, same reason, as `reader.test.ts:107`.
 */
const canVandalize = process.getuid === undefined || process.getuid() !== 0;

/** A bare tree, for the unit arm's own writes. */
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-events-'));
  dirs.push(dir);
  return join(dir, '.ascend');
}

function event(
  session: string,
  agent: string,
  seq: number,
  over: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    kind: 'prompt.submit',
    session_id: session,
    agent_id: agent,
    seq,
    call: 0,
    batch: 1,
    ts: '2026-01-02T03:04:05.000Z',
    derive_version: EVENT_DERIVE_VERSION,
    segment: 0,
    text: `prompt ${String(seq)}`,
    ...over,
  };
}

/** The lines of one log file, as parsed events. */
function lines(path: string): NormalizedEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as NormalizedEvent);
}

describe('the event log: writing', () => {
  it('writes one line per event, one directory per stream, and reads them back', () => {
    const dir = tree();
    const log = openEventLog(dir);
    log.accept(event('s-1', 'main', 0));
    log.accept(event('s-1', 'main', 1));
    log.accept(event('s-1', 'main', 2));

    const file = join(dir, 'events', 's-1', 'main', '0001.jsonl');
    expect(readdirSync(join(dir, 'events', 's-1', 'main'))).toEqual(['0001.jsonl']);
    expect(lines(file).map((one) => one.seq)).toEqual([0, 1, 2]);

    const read = readEventLog(dir);
    expect(read.files).toBe(1);
    expect(read.events.map((one) => one.seq)).toEqual([0, 1, 2]);
    expect(read.events[0]).toEqual(event('s-1', 'main', 0));
  });

  it('keeps a subagent in its own stream, under its parent session', () => {
    const dir = tree();
    const log = openEventLog(dir);
    log.accept(event('s-1', 'main', 0));
    log.accept(event('s-1', 'a1', 0));

    // Two files, not one: a subagent's transcript carries its parent's session id, so folding
    // `agent_id` into `session_id` would merge two conversations into one stream.
    const names = readdirSync(join(dir, 'events', 's-1')).sort();
    expect(names).toEqual(['a1', 'main']);
    expect(readEventLog(dir).events).toHaveLength(2);
  });

  it('refuses an id that cannot name a directory rather than sanitizing it', () => {
    const dir = tree();
    const log = openEventLog(dir);
    // Sanitizing `../x` to `x` and `..%2Fx` to the same thing would put two streams in one file,
    // and the count that moved would be a count of something that was never one stream.
    expect(() => {
      log.accept(event('../x', 'main', 0));
    }).toThrow(/session_id/u);
    expect(() => {
      log.accept(event('s-1', 'a/b', 0));
    }).toThrow(/agent_id/u);
    expect(existsSync(join(dir, 'events'))).toBe(false);
  });

  it('drops a repeated (session, agent, seq), keeping the first', () => {
    const dir = tree();
    // Two ingests reading one transcript at once is ordinary, and neither is wrong to append.
    openEventLog(dir).accept(event('s-1', 'main', 0, { text: 'first' }));
    openEventLog(dir).accept(event('s-1', 'main', 0, { text: 'second' }));

    const read = readEventLog(dir);
    expect(read.events).toHaveLength(1);
    expect(read.events[0]?.['text']).toBe('first');
  });
});

describe('the event log: reading', () => {
  it('reads nothing from a tree with no log', () => {
    // `unreadable: []` and not a failure. `asc init` does not create `events/` -- `openEventLog`
    // does, on the first append (`event-log.ts:156`) -- so a root that is not there is the ordinary
    // state of a project that never ran an ingest. `typed-handlers.ts:106-112` draws the same line
    // for a missing handlers directory, and counting this one as damage would print
    // `unreadable: 1` on every fresh project: a false report of exactly the class that jumps the
    // queue.
    expect(readEventLog(tree())).toEqual({ events: [], files: 0, unreadable: [] });
  });

  it('reports a directory it could not list, instead of counting it as an empty one', () => {
    // The defect this replaces: an EACCES on one session directory was indistinguishable from a
    // session that wrote nothing, so a replay silently reported a smaller handler count and no
    // part of the report said so. `scanTranscripts` records the same situation and continues the
    // walk (`reader.ts:253-257`); this is the log's walk holding to that, which is why the
    // readable stream below is still read.
    if (!canVandalize) return;
    const dir = tree();
    const log = openEventLog(dir);
    log.accept(event('s-1', 'main', 0));
    log.accept(event('s-2', 'main', 0));
    const locked = join(dir, 'events', 's-2');
    chmodSync(locked, 0o000);

    try {
      const read = readEventLog(dir);
      // Paths, not a bare count: a report saying "unreadable: 1" leaves the caller with nothing to
      // act on, and the path is the only part of this they can do anything about.
      expect(read.unreadable).toEqual([locked]);
      expect(read.files).toBe(1);
      expect(read.events.map((one) => one.seq)).toEqual([0]);
    } finally {
      // Restored before the suite tears down, and in a `finally` so a failed assertion above cannot
      // leave it locked: `rmSync(recursive)` cannot list a directory it may not read, and the
      // cleanup would fail with ENOTEMPTY and hide the assertion that actually failed.
      chmodSync(locked, 0o700);
    }
  });

  it('reports a stream path that is a file, not a directory, rather than a silent zero', () => {
    // ENOTDIR, and the case the ENOENT rule must NOT swallow: `events/s-1` exists and is not a
    // directory, so nothing under it was read and nothing is going to be. A missing root is
    // ordinary; a root that is the wrong KIND is a broken tree, and the two are told apart by the
    // error code rather than by the fact that `readdir` threw.
    const dir = tree();
    openEventLog(dir).accept(event('s-1', 'main', 0));
    rmSync(join(dir, 'events', 's-1'), { recursive: true, force: true });
    writeFileSync(join(dir, 'events', 's-1'), 'not a directory\n');

    const read = readEventLog(dir);
    expect(read.unreadable).toEqual([join(dir, 'events', 's-1')]);
    expect(read.files).toBe(0);
  });

  it('refuses a line derived at another version, naming both', () => {
    const dir = tree();
    openEventLog(dir).accept(event('s-1', 'main', 0, { derive_version: EVENT_DERIVE_VERSION - 1 }));

    // Refused rather than replayed: a count moves when the derive version moves, with no handler
    // changed, and a log is the one thing that cannot be re-derived to fix it.
    expect(() => readEventLog(dir)).toThrow(
      new RegExp(`version ${String(EVENT_DERIVE_VERSION - 1)}`, 'u'),
    );
    expect(() => readEventLog(dir)).toThrow(
      new RegExp(`derives ${String(EVENT_DERIVE_VERSION)}`, 'u'),
    );
  });

  it('refuses a line that is not JSON, naming where it is', () => {
    const dir = tree();
    const stream = join(dir, 'events', 's-1', 'main');
    mkdirSync(stream, { recursive: true });
    const path = join(stream, '0001.jsonl');
    writeFileSync(path, `${JSON.stringify(event('s-1', 'main', 0))}\nnot json\n`);

    // A log that cannot be read past a line must say which line, or the caller re-runs ingest
    // against a corpus that no longer holds the record.
    expect(() => readEventLog(dir)).toThrow(new RegExp(`${path}:2`, 'u'));
  });
});

describe('the event log: written by ingest', () => {
  /** A project with a store, and a transcript under its own `~/.claude/projects`. */
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), 'asc-events-e2e-'));
    dirs.push(dir);
    const treeDir = join(dir, '.ascend');
    mkdirSync(treeDir);
    buildIndex(treeDir, join(treeDir, INDEX_FILE), { now: new Date().toISOString() });
    const corpus = join(dir, '.claude', 'projects', PROJECT_DIR);
    mkdirSync(corpus, { recursive: true });
    writeFileSync(
      join(corpus, 's-1.jsonl'),
      `${TRANSCRIPT.map((one) => JSON.stringify(one)).join('\n')}\n`,
    );
    return dir;
  }

  function asc(args: readonly string[], cwd: string) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('writes the normalized events', () => {
    const dir = project();
    const run = asc(['ingest', 'claude-code'], dir);
    expect(run.status, run.stderr).toBe(0);

    const stream = join(dir, '.ascend', 'events', 's-1', 'main');
    const written = lines(join(stream, '0001.jsonl'));
    expect(written.length).toBeGreaterThan(0);
    // Every line is a normalized event of THIS derive version: the log is not a transcript copy,
    // and a reader may replay it without the adapter that produced it.
    for (const one of written) {
      expect(one.derive_version).toBe(EVENT_DERIVE_VERSION);
      expect(one.session_id).toBe('s-1');
      expect(one.agent_id).toBe('main');
    }
    // The reader agrees with the writer, which is the property the replay will depend on.
    expect(readEventLog(join(dir, '.ascend')).events).toHaveLength(written.length);
    // A shell call was in the transcript, so its events are in the log -- the log is the
    // normalizer's output, not a summary of the file.
    expect(written.map((one) => one.kind)).toContain('command.run');
  });

  it('leaves no log behind on a dry run', () => {
    // A FRESH project, so the cursor holds nothing and the preview really sweeps. Reusing the one
    // above would let an unchanged-file skip hide a log that a preview wrote anyway.
    const dir = project();
    const preview = asc(['ingest', 'claude-code', '--dry-run'], dir);

    expect(preview.status, preview.stderr).toBe(0);
    // The preview really swept -- it reports the derived work it would do. Without this the arm
    // would also pass if the command had skipped the corpus entirely.
    expect(preview.stdout).toContain('tool_denial');
    // "Nothing was written" is a dry run's contract, and a log written by a preview would be the
    // one artifact it left that a caller has no reason to look for.
    expect(existsSync(join(dir, '.ascend', 'events'))).toBe(false);
  });

  it('reproduces a handler count after the transcript is deleted', () => {
    // THE BEAD'S OWN ACCEPTANCE (asc-igg8): "record events, then delete the transcript, then show
    // a handler count still reproduces." Everything above only proves the log is written; this is
    // the one arm that proves it is worth writing.
    const dir = project();
    const handler = join(dir, 'shell.yaml');
    writeFileSync(handler, HANDLER_YAML);

    const before = asc(['handlers', 'check', handler, '--project', PROJECT_DIR, '--json'], dir);
    expect(before.status, before.stderr).toBe(0);
    const counted = countedRows(before.stdout);
    // The fixture's own transcript triggers it, so a zero here would make the whole comparison
    // below pass while proving nothing.
    expect(counted.triggers).toBeGreaterThan(0);
    // No `source` row on a transcript replay: the row is added only for the log, so every existing
    // report keeps its exact bytes. The absence is the old shape, not a missing fact.
    expect(counted.source).toBeUndefined();

    const ingest = asc(['ingest', 'claude-code'], dir);
    expect(ingest.status, ingest.stderr).toBe(0);
    // Destroy the thing the count came from. This is the whole point: the log is what is left.
    rmSync(join(dir, '.claude'), { recursive: true, force: true });

    // The ordinary replay has nothing left to read -- otherwise the deletion did not happen and
    // the arm below would pass against the transcripts it was supposed to be independent of.
    const gone = asc(['handlers', 'check', handler, '--project', PROJECT_DIR, '--json'], dir);
    expect(gone.status).not.toBe(0);

    const after = asc(['handlers', 'check', handler, '--from-log', '--json'], dir);
    expect(after.status, after.stderr).toBe(0);
    const replayed = countedRows(after.stdout);
    expect(replayed.source).toBe('event log');
    // The same count, off a source that never read a transcript.
    expect(replayed.triggers).toBe(counted.triggers);
    expect(replayed.rows).toBe(counted.rows);
  });

  it('reports `unreadable` for the log source, which the transcript-only row list left out', () => {
    // `logRows` omitted this row for the log source and said why: the unreadable count described a
    // sweep of `~/.claude/projects`, and no sweep happened. That was true exactly while the log
    // source could not have one -- and false once an unlistable directory is recorded, because
    // `unreadable: 0` then means every directory this log holds was listed. Leaving the row out is
    // what would make the new count unreachable by any caller.
    const dir = project();
    const handler = join(dir, 'shell.yaml');
    writeFileSync(handler, HANDLER_YAML);

    const run = asc(['handlers', 'check', handler, '--from-log', '--json'], dir);
    expect(run.status, run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      rows: readonly { field: string; value: unknown }[];
    };
    // `0` rather than absent. A project with no log at all is the ENOENT case above: nothing was
    // meant to be there, so nothing failed.
    expect(parsed.rows.find((one) => one.field === 'unreadable')?.value).toBe(0);
  });

  it('refuses the transcript flags with --from-log rather than ignoring them', () => {
    const dir = project();
    const handler = join(dir, 'shell.yaml');
    writeFileSync(handler, HANDLER_YAML);

    // A flag silently doing nothing is the false-green class: the command would report a count
    // from a source the caller did not ask for, and nothing in the output would say so.
    const run = asc(['handlers', 'check', handler, '--from-log', '--project', 'x'], dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--project');
  });
});

/** A handler that fires once per shell segment, so the fixture has something to count. */
const HANDLER_YAML = [
  'on: command.run',
  'description: Every shell segment.',
  'emit:',
  "  head: '${head}'",
  '',
].join('\n');

/** The handler's own count and the horizon's `source`, out of a `--json` replay report. */
function countedRows(stdout: string): {
  triggers: number;
  rows: number;
  source: string | undefined;
} {
  const parsed = JSON.parse(stdout) as {
    rows: readonly { field: string; value: unknown }[];
  };
  const value = (field: string): unknown => parsed.rows.find((row) => row.field === field)?.value;
  const source = value('source');
  return {
    triggers: Number(value('triggers')),
    rows: Number(value('rows')),
    source: typeof source === 'string' ? source : undefined,
  };
}

/** The encoded transcript directory name, as `~/.claude/projects` spells it. */
const PROJECT_DIR = '-Users-me-scratch';

const AT = { cwd: '/Users/me/scratch', gitBranch: 'main' };

/** A Bash call and its result: enough to emit `tool.use.start`, `command.run` and `tool.use.end`. */
const TRANSCRIPT: readonly Record<string, unknown>[] = [
  {
    type: 'assistant',
    sessionId: 's-1',
    uuid: 'u-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    ...AT,
    message: {
      id: 'm-1',
      model: 'claude-test-1',
      content: [
        { type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: 'pnpm test' } },
      ],
    },
  },
  {
    type: 'user',
    sessionId: 's-1',
    uuid: 'u-2',
    timestamp: '2026-01-02T03:04:06.000Z',
    ...AT,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-bash', is_error: false }] },
  },
];
