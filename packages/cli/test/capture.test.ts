import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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

/**
 * `asc capture`, driven as the real binary (`asc-09wx.8.2`).
 *
 * **Every claim about what was written is read back out of the TREE, not inferred from the report.**
 * The report is a one-row table, and a version of this command that printed `recorded` while writing
 * nothing -- or writing a row with no `digest`, or a `reason` it invented -- would pass any test that
 * only read stdout. So the entry is parsed off disk, and so is the baseline beside it.
 *
 * **What is NOT here.** The hashing policy and the diff get their own file (`watched.test.ts`), and
 * the baseline file format gets its own in the store (`watched-hashes.test.ts`). This file is the one
 * place the whole path runs: a real project, a real store, a real edit, and the entry that lands.
 *
 * **`HOME` is the project directory**, which is what `record.test.ts`'s `project()` does and what
 * makes the run hermetic -- `watchedPaths` reaches for the home directory, so a test that left `HOME`
 * alone would watch the machine's real `~/.claude/CLAUDE.md` and write a row about the developer.
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
  const dir = mkdtempSync(join(tmpdir(), 'asc-capture-'));
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

/** A project with the starter types installed, exactly as `asc init` leaves one. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);
  return dir;
}

function write(dir: string, display: string, text: string): void {
  const path = join(dir, display);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function outcome(run: Run): string {
  const rows = (JSON.parse(run.stdout) as { rows: Record<string, unknown>[] }).rows;
  return String(rows[0]?.['outcome']);
}

/** Every `intervention` entry in the tree, as parsed JSONL. None is written before one is due. */
function entries(dir: string): readonly Record<string, unknown>[] {
  const entriesDir = join(dir, '.ascend', 'entries');
  const found: Record<string, unknown>[] = [];
  if (!existsSync(entriesDir)) return found;
  for (const folder of readdirSync(entriesDir)) {
    for (const file of readdirSync(join(entriesDir, folder))) {
      const text = readFileSync(join(entriesDir, folder, file), 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const parsed = JSON.parse(line) as { kind?: string; type_name?: string };
        if (parsed.kind === 'entry' && parsed.type_name === 'intervention') {
          found.push(parsed);
        }
      }
    }
  }
  return found;
}

const propertiesOf = (entry: Record<string, unknown>): Record<string, unknown> =>
  entry['properties'] as Record<string, unknown>;

const baselinePath = (dir: string): string => join(dir, '.ascend', 'watched-hashes.json');

describe('asc capture: the row nobody chose to write', () => {
  it('records a dated row with both hashes and no reason, for an edit nobody recorded', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'first\n');
    asc(['capture'], dir);
    const before = sha256('first\n');

    write(dir, 'CLAUDE.md', 'second\n');
    const run = asc(['capture', '--json'], dir);
    expect(run.status).toBe(0);
    expect(outcome(run)).toBe('recorded');

    const written = entries(dir);
    expect(written).toHaveLength(1);
    const properties = propertiesOf(written[0] as Record<string, unknown>);

    expect(properties['change']).toBe('`CLAUDE.md`');
    expect(properties['status']).toBe('applied');
    expect(properties['digest']).toEqual([
      { path: 'CLAUDE.md', before_sha256: before, after_sha256: sha256('second\n') },
    ]);
    // "no reason" is the whole point of the row: this mechanism watched files move and did not
    // watch anything decide. A reason here would be a claim nobody made.
    expect(properties).not.toHaveProperty('reason');
    // And no metric, so no rule -- `intervention`'s conditional, settled in asc-09wx.8.1.
    expect(properties).not.toHaveProperty('metric');
    expect(properties).not.toHaveProperty('rule');
  });

  it("sources the row observed:capture, so nobody's self-report is counted as the machine's", () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'first\n');
    asc(['capture'], dir);
    write(dir, 'CLAUDE.md', 'second\n');
    asc(['capture'], dir);

    // **The assertion is what the value is NOT, as much as what it is.** `self` is every row the
    // MODEL wrote about itself through `asc record`, and this row was written by nobody. The
    // question the ledger has to be able to answer is `EV-16`'s -- 0 of 15 sessions ran `asc record`
    // -- and with these rows filed under `self` a re-measurement would count them as the mechanism
    // firing when they are the mechanism NOT firing. Entries are immutable, so that false green
    // would have outlived any later correction. Settled in `asc-09wx.8.7`.
    const written = entries(dir)[0] as Record<string, unknown>;
    expect(written['source']).toBe('observed:capture');
    expect(written['source']).not.toBe('self');
  });

  it('dates the row, and the date is the session start rather than the edit', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    write(dir, 'CLAUDE.md', 'b\n');
    asc(['capture'], dir);

    const properties = propertiesOf(entries(dir)[0] as Record<string, unknown>);
    const applied = String(properties['applied_at']);
    expect(applied).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    // The entry carries the same instant as its own `recorded_at`: there is one clock reading in the
    // run, and an `applied_at` that disagreed with it would be a second answer to when this happened.
    expect(applied).toBe((entries(dir)[0] as Record<string, unknown>)['recorded_at']);
  });

  it('carries every changed file in one digest, in path order', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    write(dir, '.claude/settings.json', '{}\n');
    asc(['capture'], dir);

    write(dir, 'CLAUDE.md', 'b\n');
    write(dir, '.claude/settings.json', '{"x":1}\n');
    expect(outcome(asc(['capture', '--json'], dir))).toBe('recorded');

    const properties = propertiesOf(entries(dir)[0] as Record<string, unknown>);
    expect((properties['digest'] as readonly { path: string }[]).map(({ path }) => path)).toEqual([
      '.claude/settings.json',
      'CLAUDE.md',
    ]);
    expect(properties['change']).toBe('`.claude/settings.json`, `CLAUDE.md`');
  });

  it('reports a file that was deleted, with only the hash it had', () => {
    // The symmetric half. A `CLAUDE.md` that was deleted changes every session after it exactly as
    // much as one that was edited, and an asymmetric diff is what forgets it.
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    rmSync(join(dir, 'CLAUDE.md'));

    expect(outcome(asc(['capture', '--json'], dir))).toBe('recorded');
    const properties = propertiesOf(entries(dir)[0] as Record<string, unknown>);
    expect(properties['digest']).toEqual([{ path: 'CLAUDE.md', before_sha256: sha256('a\n') }]);
  });

  it('writes nothing when nothing moved', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    write(dir, 'CLAUDE.md', 'b\n');
    asc(['capture'], dir);

    const run = asc(['capture', '--json'], dir);
    expect(run.status).toBe(0);
    expect(outcome(run)).toBe('unchanged');
    expect(entries(dir)).toHaveLength(1);
  });

  it('writes no row when the same bytes come back, because a restore is not a change', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    write(dir, 'CLAUDE.md', 'b\n');
    write(dir, 'CLAUDE.md', 'a\n');

    expect(outcome(asc(['capture', '--json'], dir))).toBe('unchanged');
    expect(entries(dir)).toHaveLength(0);
  });
});

describe('asc capture: the first run, which has nothing to compare against', () => {
  it('writes no row and records the hashes', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');

    const run = asc(['capture', '--json'], dir);
    expect(run.status).toBe(0);
    expect(outcome(run)).toBe('baselined');
    expect(entries(dir)).toHaveLength(0);

    // Recorded, not claimed: the baseline holds the hash of what is there, and the NEXT run is what
    // can speak. An entry on the first run would have to say "these files changed" with nothing to
    // have changed from.
    const state = JSON.parse(readFileSync(baselinePath(dir), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(state.files['CLAUDE.md']).toBe(sha256('a\n'));
  });

  it('says nothing on stderr and exits 0, so a first session is not a failure', () => {
    const dir = project();
    const run = asc(['capture', '--json'], dir);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('re-baselines rather than reporting the whole set as newly appeared', () => {
    // The identity's whole job. A hook installed for the first time adds paths to the watched set,
    // and without the identity the next run would diff a list against a shorter one and write a row
    // claiming every newly watched file had just been created.
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);

    const before = JSON.parse(readFileSync(baselinePath(dir), 'utf8')) as { watch: string };
    write(dir, '.claude/hook.sh', '# a hook nobody had before\n');
    expect(outcome(asc(['capture', '--json'], dir))).toBe('baselined');
    expect(entries(dir)).toHaveLength(0);

    const after = JSON.parse(readFileSync(baselinePath(dir), 'utf8')) as { watch: string };
    expect(after.watch).not.toBe(before.watch);
  });
});

describe('asc capture: a baseline it cannot use', () => {
  it('writes no row, names the path on stderr, and repairs the file', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    writeFileSync(baselinePath(dir), 'this is not JSON\n', 'utf8');
    write(dir, 'CLAUDE.md', 'b\n');

    const run = asc(['capture', '--json'], dir);
    // Exit 0: the file is one machine-local file and the next run has already re-baselined from
    // here, so a change missed in between is recoverable where a spuriously claimed one would not
    // be. Turning that into a failing hook every session would be a nag, not a signal.
    expect(run.status).toBe(0);
    expect(outcome(run)).toBe('baselined');
    expect(run.stderr).toContain(baselinePath(dir));
    expect(entries(dir)).toHaveLength(0);

    // Repaired, and repaired into something the next run can actually compare against.
    const state = JSON.parse(readFileSync(baselinePath(dir), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(state.files['CLAUDE.md']).toBe(sha256('b\n'));
  });

  it('treats a leftover temp file from a killed run as inert', () => {
    // The atomic write's other half. A run killed between `writeFileSync` and `renameSync` leaves
    // its own temp file -- named after its pid, so two concurrent SessionStart hooks cannot collide
    // on one path -- and that file must never be what the next run reads or diffs against.
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    writeFileSync(`${baselinePath(dir)}.99999.ascend-tmp`, 'half a map', 'utf8');

    expect(outcome(asc(['capture', '--json'], dir))).toBe('unchanged');
    expect(entries(dir)).toHaveLength(0);
  });

  it('never leaves a torn baseline behind, whatever it did', () => {
    // A stronger statement of the same property, stated as bytes: after any run, the file named
    // `watched-hashes.json` is either absent or complete JSON with a `watch` and a `files` object.
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    write(dir, 'CLAUDE.md', 'b\n');
    asc(['capture'], dir);

    const parsed = JSON.parse(readFileSync(baselinePath(dir), 'utf8')) as Record<string, unknown>;
    expect(typeof parsed['watch']).toBe('string');
    expect(typeof parsed['files']).toBe('object');
    expect(parsed['format']).toBe(1);
  });
});

describe('asc capture: a watched file that is there and cannot be read', () => {
  it('writes no row, writes no baseline, names the path, and exits non-zero', () => {
    // The third state, and the only one that is a failure. Hashing the directory as "gone" would
    // write a false row claiming the file was deleted; guessing a hash for it would invent one; and
    // advancing the baseline would move past a change nobody saw. So nothing is written at all, and
    // the non-zero exit is what makes the sentence reach the model -- on SessionStart, exit-0 stderr
    // is discarded.
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    const sealed = readFileSync(baselinePath(dir), 'utf8');

    rmSync(join(dir, '.claude', 'settings.json'), { force: true });
    mkdirSync(join(dir, '.claude', 'settings.json'), { recursive: true });

    const run = asc(['capture', '--json'], dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('.claude/settings.json');
    expect(entries(dir)).toHaveLength(0);
    // The previous baseline is untouched, so the change it still describes is still visible once the
    // file can be read again.
    expect(readFileSync(baselinePath(dir), 'utf8')).toBe(sealed);
  });
});

describe('asc capture: --dry-run', () => {
  it('reports what would be recorded and writes neither the entry nor the baseline', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    asc(['capture'], dir);
    const sealed = readFileSync(baselinePath(dir), 'utf8');
    write(dir, 'CLAUDE.md', 'b\n');

    const run = asc(['capture', '--dry-run', '--json'], dir);
    expect(run.status).toBe(0);
    expect(outcome(run)).toBe('recorded');
    expect(entries(dir)).toHaveLength(0);
    expect(readFileSync(baselinePath(dir), 'utf8')).toBe(sealed);

    // And it really would have: the same run without the flag does it.
    expect(outcome(asc(['capture', '--json'], dir))).toBe('recorded');
  });
});

describe('asc capture: where the baseline lives', () => {
  it('puts the state file inside the store tree, named individually', () => {
    // `.ascend/` as a whole is NOT ignored -- the JSONL tree under it IS the store -- so a blanket
    // rule would carry no records at all. The baseline and its temp file are named one per line.
    const dir = project();
    asc(['capture'], dir);

    expect(readdirSync(join(dir, '.ascend'))).toContain('watched-hashes.json');
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.ascend/watched-hashes.json');
    expect(ignore).toContain('.ascend/watched-hashes.json.*.ascend-tmp');
    expect(ignore).not.toContain('.ascend/');
  });

  it('leaves the baseline readable, so a second run compares instead of re-baselining', () => {
    const dir = project();
    write(dir, 'CLAUDE.md', 'a\n');
    expect(outcome(asc(['capture', '--json'], dir))).toBe('baselined');
    expect(outcome(asc(['capture', '--json'], dir))).toBe('unchanged');
  });
});

/** The sha256 of a string's UTF-8 bytes, so the expectations are hashes and not restatements. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
