/**
 * `asc ingest file-changed`, driven as the real binary against a real store and a real event log.
 *
 * A subprocess rather than a direct call, for the reason the other CLI suites give: what can be
 * wrong here is oclif's discovery of a two-word command id, the flag parser, the streams and the
 * exit code, and a direct call exercises none of them.
 *
 * **The event log is written by hand, and `HOME` is the scratch directory.** `HOME: cwd` makes
 * `homedir()` resolve INSIDE the fixture, so the home-level watched paths (`.claude/CLAUDE.md`,
 * `.claude/skills/**`) are the fixture's own -- the suite must never read, let alone touch, the
 * operator's real `~/.claude`. The same trick `ingest.test.ts` uses, for the same reason.
 *
 * **Every claim about what was written is read back out of SQLite**, not inferred from the
 * command's report: a command that printed the right table and wrote the wrong rows is exactly the
 * false green this suite exists to catch. The two are asserted separately.
 *
 * **`derive_version` comes off `EVENT_DERIVE_VERSION` rather than being spelled `12` here.** A
 * literal would make this suite stop testing the command and start testing the constant: the next
 * bump (`asc-09wx.8.4`, `asc-hvnx`) would turn every fixture line into a stale-stream refusal, and
 * the suite would go red for a reason having nothing to do with the command. The one test that
 * WANTS a stale stream asks for it by subtracting one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_DERIVE_VERSION } from '@ascend/adapter-claude-code';
import { buildIndex, INDEX_FILE, STORE_DIR } from '@ascend/store';

import { flatten } from './helpers.js';

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

/**
 * A directory holding an `.ascend/` store with nothing registered, and the index for it.
 *
 * **`realpathSync`, and it is not cosmetic.** `tmpdir()` is `/var/folders/...` on this machine and
 * `/var` is a symlink to `/private/var`, while `process.cwd()` inside the spawned binary is
 * already canonical -- Node's `getcwd` resolves symlinks. A fixture that kept the symlinked
 * spelling would build its watched set under `/private/var/...` and hand the command event paths
 * under `/var/...`, and every one of them would be counted `outside the watched set`. That looks
 * exactly like the command failing to match anything, and it is the fixture lying.
 *
 * The index is built here because `--dry-run` runs the real writers under a rollback and so needs
 * one to be there: a preview never builds, which is `previewProducedLines`' documented behaviour
 * and the reason `ingest.test.ts`'s own fixture builds one too.
 */
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-file-changed-')));
  dirs.push(dir);
  const tree = join(dir, STORE_DIR);
  mkdirSync(tree);
  buildIndex(tree, join(tree, INDEX_FILE), { now: new Date().toISOString() });
  // Watched by NAME rather than by discovery, so it needs no content -- but a fixture whose
  // `CLAUDE.md` does not exist would make the relative-path case below match nothing for the wrong
  // reason, so it is created.
  writeFileSync(join(dir, 'CLAUDE.md'), '# instructions\n');
  return dir;
}

const SESSION = 'sess-file-changed';
const AT = '2026-10-15T10:00:00.000Z';

interface EditOptions {
  readonly seq: number;
  readonly path: string;
  /** `null` omits the field, which is how an event that carried no timestamp is spelled. */
  readonly ts?: string | null;
  readonly toolId?: string;
  readonly session?: string;
  readonly agent?: string;
  readonly version?: number;
}

/** One `file.changed` event, with every field the adapter writes and no more. */
function changed(options: EditOptions): Record<string, unknown> {
  return {
    kind: 'file.changed',
    session_id: options.session ?? SESSION,
    agent_id: options.agent ?? 'main',
    seq: options.seq,
    call: 0,
    derive_version: options.version ?? EVENT_DERIVE_VERSION,
    ...(options.ts === null ? {} : { ts: options.ts ?? AT }),
    id: options.toolId ?? `call_${String(options.seq)}`,
    tool: 'Write',
    path: options.path,
    before: '',
    after: 'x\n',
  };
}

/** Write one stream segment: `events/<session>/<agent>/<segment>.jsonl`. */
function logEvents(
  dir: string,
  events: readonly Record<string, unknown>[],
  where: { readonly session?: string; readonly agent?: string; readonly segment?: string } = {},
): void {
  const stream = join(dir, STORE_DIR, 'events', where.session ?? SESSION, where.agent ?? 'main');
  mkdirSync(stream, { recursive: true });
  writeFileSync(
    join(stream, `${where.segment ?? '0001'}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

/** Every row the store holds, read back out of the index rather than from the command's report. */
function rows(
  dir: string,
): readonly { readonly id: string; readonly source: string; readonly properties: unknown }[] {
  const db = new DatabaseSync(join(dir, STORE_DIR, INDEX_FILE));
  try {
    const found = db
      .prepare('SELECT id, source, properties_json FROM entries ORDER BY recorded_at, id')
      .all() as { id: string; source: string; properties_json: string }[];
    return found.map((row) => ({
      id: row.id,
      source: row.source,
      properties: JSON.parse(row.properties_json) as unknown,
    }));
  } finally {
    db.close();
  }
}

/** The command's own table, as a map from outcome to count, off `--json`. */
function tally(run: Run): Readonly<Record<string, number>> {
  const parsed = JSON.parse(run.stdout) as {
    readonly rows: readonly { readonly outcome: string; readonly entries: number }[];
  };
  return Object.fromEntries(parsed.rows.map((row) => [row.outcome, row.entries]));
}

describe('asc ingest file-changed', () => {
  it('writes one row per change, dated to the tool call that made it', () => {
    // The whole reason this source exists beside the SessionStart sweep: the sweep can only date a
    // change to the session AFTER the edit, and these two rows carry the two calls' own times.
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, path: join(dir, 'CLAUDE.md'), ts: '2026-10-15T10:00:00.000Z' }),
      changed({ seq: 2, path: join(dir, 'CLAUDE.md'), ts: '2026-10-15T11:30:00.000Z' }),
    ]);

    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(run.status).toBe(0);
    expect(tally(run)).toEqual({ written: 2, present: 0, changed: 0 });
    // Keyed by `applied_at` rather than by row order, deliberately: both rows share one
    // `recorded_at` (the run's own clock, which is the same instant for every row a run writes), so
    // the store's `(recorded_at, id)` order falls through to a hash. An order-dependent assertion
    // here would be a coin flip that passes until the ids change.
    const stored = new Map(
      rows(dir).map((row) => [
        (row.properties as { applied_at: string }).applied_at,
        row.properties as { change: string; status: string },
      ]),
    );
    expect([...stored.keys()].sort()).toEqual([
      '2026-10-15T10:00:00.000Z',
      '2026-10-15T11:30:00.000Z',
    ]);
    expect(stored.get('2026-10-15T10:00:00.000Z')?.change).toBe('`CLAUDE.md`');
    expect(stored.get('2026-10-15T11:30:00.000Z')?.change).toBe('`CLAUDE.md`');
    expect(stored.get('2026-10-15T10:00:00.000Z')?.status).toBe('applied');
    expect(rows(dir).map((row) => row.source)).toEqual([
      'observed:file-changed',
      'observed:file-changed',
    ]);
  });

  it('omits `digest`, which it cannot fill honestly', () => {
    // `digest` is documented as `path` + `before_sha256` + `after_sha256` per file, and a
    // `file.changed` event carries the edit's own old/new strings instead. Hashing the file at
    // ingest time would be a number dated to the ingest wearing a field the sweep dates to the
    // observation -- one property meaning two things. Absent is the honest value.
    const dir = project();
    logEvents(dir, [changed({ seq: 1, path: join(dir, 'CLAUDE.md') })]);

    expect(asc(['ingest', 'file-changed'], dir).status).toBe(0);

    const properties = rows(dir)[0]?.properties as Record<string, unknown>;
    expect(properties['digest']).toBeUndefined();
    expect(Object.keys(properties).sort()).toEqual(['applied_at', 'change', 'status']);
  });

  it('is idempotent: a second run writes nothing new and reports the rows as present', () => {
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, path: join(dir, 'CLAUDE.md') }),
      changed({ seq: 2, path: join(dir, 'MEMORY.md') }),
    ]);
    asc(['ingest', 'file-changed'], dir);

    const second = asc(['ingest', 'file-changed', '--json'], dir);

    expect(second.status).toBe(0);
    expect(tally(second)).toEqual({ written: 0, present: 2, changed: 0 });
    expect(rows(dir)).toHaveLength(2);
  });

  it('counts the events it left out, so the watched set is a number rather than an absence', () => {
    // A change inside a repository's own source is not a change to how work is done, so it is not
    // a row -- and the count is what keeps that decision visible instead of silent.
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, path: join(dir, 'CLAUDE.md') }),
      changed({ seq: 2, path: join(dir, 'src', 'foo.ts') }),
      changed({ seq: 3, path: join(dir, 'packages', 'core', 'src', 'spec.ts') }),
    ]);

    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(run.status).toBe(0);
    expect(tally(run)).toEqual({ written: 1, present: 0, changed: 0 });
    expect(rows(dir)).toHaveLength(1);
    expect(flatten(run.stderr)).toContain(
      '2 file.changed event(s) named a path outside the watched set',
    );
  });

  it('does not resolve a relative path against the working directory', () => {
    // DECISIVE, and it is why this fixture creates a `CLAUDE.md`: `process.cwd()` IS the fixture,
    // so a `resolve` of the relative `CLAUDE.md` lands exactly on a watched path. An implementation
    // that skipped `isAbsolute` would write a row here and look correct on any path that happened
    // to resolve into nothing -- which is every other relative path. The event's `path` is
    // documented ABSOLUTE (`core/event.ts`), so a relative one is the log contradicting itself.
    const dir = project();
    logEvents(dir, [changed({ seq: 1, path: 'CLAUDE.md' })]);

    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(run.status).toBe(0);
    expect(tally(run)).toEqual({ written: 0, present: 0, changed: 0 });
    expect(rows(dir)).toEqual([]);
    expect(flatten(run.stderr)).toContain(
      '1 file.changed event(s) carried a path that is not absolute',
    );
  });

  it('writes a row with no `applied_at` when the event carried no timestamp', () => {
    // Not `this.now()`. A row claiming an edit time it does not know is the fabrication the ledger
    // exists to prevent, and the ingest's own clock is a time the EDIT did not happen.
    const dir = project();
    logEvents(dir, [changed({ seq: 1, path: join(dir, 'CLAUDE.md'), ts: null })]);

    expect(asc(['ingest', 'file-changed'], dir).status).toBe(0);

    const properties = rows(dir)[0]?.properties as Record<string, unknown>;
    expect(properties['applied_at']).toBeUndefined();
    expect(properties['status']).toBe('applied');
  });

  it('writes one row per EDIT, so a MultiEdit’s edits are not one row', () => {
    // A MultiEdit emits one `file.changed` per edit, all sharing the tool call's `id` and differing
    // only in `seq`. An id keyed on the call would collapse three edits of three files into one
    // row; the id is the stream identity `(session, agent, seq)` for exactly this reason.
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, toolId: 'call_one', path: join(dir, 'CLAUDE.md') }),
      changed({ seq: 2, toolId: 'call_one', path: join(dir, 'MEMORY.md') }),
      changed({ seq: 3, toolId: 'call_one', path: join(dir, '.claude', 'settings.json') }),
    ]);

    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(tally(run)).toEqual({ written: 3, present: 0, changed: 0 });
    expect(rows(dir)).toHaveLength(3);
    expect(new Set(rows(dir).map((row) => row.id)).size).toBe(3);
  });

  it('writes one row when the same event is logged twice, in two streams', () => {
    // Two ingests reading one transcript at once both append, and neither is wrong to: `readEventLog`
    // drops a repeat of `(session_id, agent_id, seq)` keeping the first, and the id is that same
    // identity -- so the duplicate is not merely skipped in the sweep, it could not be a second row.
    const dir = project();
    const event = changed({ seq: 7, path: join(dir, 'CLAUDE.md') });
    logEvents(dir, [event], { agent: 'main' });
    logEvents(dir, [event], { agent: 'main', segment: '0002' });

    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(tally(run)).toEqual({ written: 1, present: 0, changed: 0 });
    expect(rows(dir)).toHaveLength(1);
  });

  it('previews the counts a run would produce, and writes nothing', () => {
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, path: join(dir, 'CLAUDE.md') }),
      changed({ seq: 2, path: join(dir, 'MEMORY.md') }),
    ]);
    asc(['ingest', 'file-changed'], dir);
    // A SECOND segment, not a rewrite of the first: `0001.jsonl` is where the two events above
    // live, and writing this one there would replace them rather than add to them.
    logEvents(dir, [changed({ seq: 3, path: join(dir, '.claude', 'settings.json') })], {
      segment: '0002',
    });

    const preview = asc(['ingest', 'file-changed', '--dry-run', '--json'], dir);

    expect(preview.status).toBe(0);
    // Two rows already there, one new: the preview asks the store, so it does not report
    // `written 3` for a run that would write one row -- which is the over-count `ingest
    // claude-code`'s preview keeps a map to avoid.
    expect(tally(preview)).toEqual({ written: 1, present: 2, changed: 0 });
    // And it wrote none of them: the store still holds the first run's two rows.
    expect(rows(dir)).toHaveLength(2);
    expect(flatten(preview.stderr)).toContain('dry run: nothing was written.');
  });

  it('refuses a log holding a stream from an older derive version, and names the remedy', () => {
    // Inherited from `readEventLog` rather than chosen here, and pinned because it is the state of
    // this checkout's OWN log -- 2,474 of its 6,011 stream files still carry version 11 -- so it is
    // the answer a reader is most likely to meet first. Refused rather than replayed: a count moves
    // when the derive version moves with no handler changed.
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, path: join(dir, 'CLAUDE.md'), version: EVENT_DERIVE_VERSION - 1 }),
    ]);

    const run = asc(['ingest', 'file-changed'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('was derived at version');
    expect(flatten(run.stderr)).toContain('Re-run `asc ingest claude-code` to rewrite the log.');
    expect(rows(dir)).toEqual([]);
  });

  it('reports `changed` when a stored row about the same event says something else', () => {
    // Entries are immutable, so a re-proposal of one id with different content is reported and the
    // stored row is left exactly as it was. The fixture reaches this by REWRITING the stream so the
    // same `(session, agent, seq)` -- and therefore the same id -- resolves to a different watched
    // path, which is what a property-set change between ascend versions looks like from here. Both
    // paths are in the set by name, so neither file has to exist.
    const dir = project();
    logEvents(dir, [changed({ seq: 1, path: join(dir, 'CLAUDE.md') })]);
    asc(['ingest', 'file-changed'], dir);
    const before = rows(dir);

    logEvents(dir, [changed({ seq: 1, path: join(dir, '.claude', 'CLAUDE.md') })]);
    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(run.status).toBe(0);
    expect(tally(run)).toEqual({ written: 0, present: 0, changed: 1 });
    expect(rows(dir)).toEqual(before);
  });

  it('refuses a row whose `applied_at` is not a timestamp, rather than writing it', () => {
    // A tool result carries whatever the harness wrote, and `applied_at` is declared `timestamp`, so
    // this is the input that reaches the store's own validation. `asc ingest claude-code`'s rule and
    // its reason: one `BEGIN IMMEDIATE` covers every row a run proposes, so a rejection thrown
    // inside it would unwind the whole run rather than the one bad row. Validated before the write,
    // named on stderr, counted and skipped -- and the exit code stays 0, because a log holding one
    // unreadable timestamp is not a failed run.
    const dir = project();
    logEvents(dir, [
      changed({ seq: 1, path: join(dir, 'CLAUDE.md'), ts: '2026-10-15 09:00:00' }),
      changed({ seq: 2, path: join(dir, 'CLAUDE.md'), ts: '2026-10-15T11:30:00.000Z' }),
    ]);

    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(run.status).toBe(0);
    expect(tally(run)).toEqual({ written: 1, present: 0, changed: 0 });
    expect(rows(dir)).toHaveLength(1);
    expect(flatten(run.stderr)).toContain('applied_at');
  });

  it('reads the events a real `asc ingest claude-code` wrote, in the layout it writes them in', () => {
    // The two halves joined, driven end to end: this suite's own hand-written fixtures could agree
    // with the command and disagree with the log, and only a real writer can tell.
    const dir = project();
    // `type` is what the normalizer dispatches on -- `assistant` for tool_use, `user` for
    // tool_result -- so a record without it is read for its timestamps and nothing else. The
    // `message.role` beside it is real but not what routes here.
    const records = [
      {
        type: 'assistant',
        sessionId: SESSION,
        uuid: 'u-1',
        timestamp: '2026-10-15T09:00:00.000Z',
        cwd: dir,
        gitBranch: 'main',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_real',
              name: 'Write',
              input: { file_path: join(dir, 'CLAUDE.md'), content: '# edited\n' },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId: SESSION,
        uuid: 'u-2',
        timestamp: '2026-10-15T09:00:01.000Z',
        cwd: dir,
        gitBranch: 'main',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_real', content: 'ok' }],
        },
      },
    ];
    const transcripts = join(dir, '.claude', 'projects', '-fixture');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, `${SESSION}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const derive = asc(['ingest', 'claude-code'], dir);
    expect(derive.status).toBe(0);
    const run = asc(['ingest', 'file-changed', '--json'], dir);

    expect(run.status).toBe(0);
    expect(tally(run)).toEqual({ written: 1, present: 0, changed: 0 });
    const properties = rows(dir)[0]?.properties as Record<string, unknown>;
    expect(properties['change']).toBe('`CLAUDE.md`');
    // The RESULT record's timestamp, not the tool_use's -- which is what this run measured rather
    // than what it assumed. `normalize.ts` emits `file.changed` from the record carrying the
    // `tool_result`, so that record's `ts` is the one the event carries. The two are the same
    // turn either way, which is the whole claim: this is not the next SessionStart.
    expect(properties['applied_at']).toBe('2026-10-15T09:00:01.000Z');
    // And the OTHER source is not among these rows: this command writes only its own.
    expect(rows(dir).map((row) => row.source)).toEqual(['observed:file-changed']);
  });
});
