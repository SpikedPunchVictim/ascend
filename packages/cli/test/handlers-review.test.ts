import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc handlers review`, driven as the real binary (asc-09wx.8.5).
 *
 * **The command exists because a handler is a file and a row is an entry and nothing joined them.**
 * So every test here is about the join: which rows name a handler, what those rows leave it as, and
 * -- the answer a reader is usually looking for -- which handler files no row names at all. None of
 * these cases needs a corpus: the command replays nothing, and a suite that had to build sixty
 * sessions to check a four-valued rule would be testing the fixture instead.
 *
 * **The fixture is a directory and a handful of rows, and the rows are written through `asc record`.**
 * Every state below is reached by recording an intervention row with the properties that state is
 * about, so the four states are produced by the tool rather than by a hand-written index.
 *
 * **`handlers/` holds a handler that is neither typed nor `say:`**, and that file is the one test
 * here that pins an implementation choice rather than a behaviour: `loadProjectHandlers` returns only
 * the typed and `say:` ones, so a listing built on it would omit exactly the file a reader most needs
 * to see. `handler-life.ts` enumerates the directory itself and says why.
 *
 * **`HOME` is the project directory**, as in `capture.test.ts`, so nothing here can read the
 * operator's own store or transcripts.
 */

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(repo, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: repo,
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

function asc(args: readonly string[], cwd: string, input?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * stderr with its wrapping undone.
 *
 * The CLI wraps its own failures to the terminal width, so a refusal's sentence arrives with newlines
 * inside it and a substring assertion on the unwrapped text fails for a reason that has nothing to do
 * with the refusal.
 */
const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

interface Row {
  readonly handler: string;
  readonly field: string;
  readonly value: unknown;
}

const review = (dir: string): Run => asc(['handlers', 'review', '--json'], dir);
const rows = (run: Run): readonly Row[] => (JSON.parse(run.stdout) as { rows: Row[] }).rows;

/** Every value this listing prints for one handler, by field, in the order it printed them. */
function fieldsFor(run: Run, handler: string): Map<string, unknown[]> {
  const byField = new Map<string, unknown[]>();
  for (const row of rows(run)) {
    if (row.handler !== handler) continue;
    const values = byField.get(row.field);
    if (values === undefined) byField.set(row.field, [row.value]);
    else values.push(row.value);
  }
  return byField;
}

/** The one value for one field, or `undefined` when this listing said nothing about it. */
function field(run: Run, handler: string, name: string): unknown {
  const values = fieldsFor(run, handler).get(name);
  return values?.[0];
}

/**
 * A handler file that is neither typed nor `say:`.
 *
 * Legal, and loadable: `loadProjectHandlers` compiles it, finds no `type:` and no `say:`, and drops
 * it on the floor. That is the whole reason this suite ships one.
 */
const PLAIN = `on: command.run
where: { head: ls }
emit: { argv: '\${argv}' }
`;

let counter = 0;
/** An `intervention` row, recorded through the real command, returning its place in the ledger. */
function record(dir: string, properties: Record<string, unknown>): void {
  counter += 1;
  const run = asc(['record', 'intervention', '-'], dir, JSON.stringify({ properties }));
  expect(run.status, `row ${String(counter)}: ${flat(run.stderr)}`).toBe(0);
}

/**
 * A project whose `handlers/` holds four handler files, one file that is not a handler, and whose
 * ledger holds six rows.
 *
 * | handler | on disk | rows | what it is |
 * |---|---|---|---|
 * | `alpha` | yes | `applied`, then `graded` | two chains, so the strongest claim decides |
 * | `beta` | yes | `graded` + `regression_watch` | the watch the ledger writes down |
 * | `gamma` | **no** | `reverted` | a row whose ruler was deleted or renamed |
 * | `delta` | yes | none | the absence a reader is looking for |
 * | `epsilon` | yes | `applied` + `regression_watch` | still measuring, whatever the note says |
 *
 * `metric` rides on every row with the `rule` the write-time rule demands beside it, and carries only
 * the `handler` a row and a file are matched on -- `sha256` and `derive_version` are the grader's
 * business, and this listing replays nothing and reads neither.
 */
function fixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-review-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);

  mkdirSync(join(dir, 'handlers'));
  for (const name of ['alpha', 'beta', 'delta', 'epsilon']) {
    writeFileSync(join(dir, 'handlers', `${name}.yaml`), PLAIN, 'utf8');
  }
  // **A file in `handlers/` that is not a handler, because a fixture of four `.yaml` files cannot see
  // the extension filter at all.** `handlerFiles` keeps only `.ya?ml`, and with nothing else in the
  // directory, deleting that filter changed no line of this suite's output -- measured, by planting
  // exactly that mutant. A README beside a directory of handler definitions is the ordinary case the
  // filter exists for, and reporting it as a handler nothing holds would be the listing inventing a
  // finding.
  writeFileSync(join(dir, 'handlers', 'README.md'), 'These are the handlers.\n', 'utf8');

  const row = (name: string, properties: Record<string, unknown>): void => {
    record(dir, {
      change: `\`handlers/${name}.yaml\``,
      metric: { handler: `handlers/${name}.yaml` },
      rule: 'the rate this handler counts rises in the after arm',
      ...properties,
    });
  };

  row('alpha', { status: 'applied' });
  row('alpha', { status: 'graded' });
  row('beta', { status: 'graded', disposition: 'regression_watch' });
  row('gamma', { status: 'reverted' });
  row('epsilon', { status: 'applied', disposition: 'regression_watch' });
  return dir;
}

describe('asc handlers review: what holds each handler', () => {
  it('names a handler nothing holds, and points at the file it means', () => {
    const dir = fixture();
    const run = review(dir);
    expect(run.status, flat(run.stderr)).toBe(0);
    expect(field(run, 'handlers/delta.yaml', 'state')).toBe('unheld');
    expect(field(run, 'handlers/delta.yaml', 'file')).toBe(join(dir, 'handlers/delta.yaml'));
    // No holdings means no `holds` row at all, rather than a `holds 0` a reader could mistake for
    // the count of a handler whose holdings produced no rows.
    expect(field(run, 'handlers/delta.yaml', 'holds')).toBeUndefined();
  });

  it('leaves a file under handlers/ alone when it is not a handler at all', () => {
    const dir = fixture();
    const run = review(dir);
    expect(run.status, flat(run.stderr)).toBe(0);
    // `handlers/README.md` is in the directory and is not a handler. Reporting it as one would be the
    // listing inventing a finding -- an absence surfaced for a file that was never a ruler.
    //
    // **Nothing else in this repository can see the extension filter, which is why the mutant that
    // deleted it survived.** `ls handlers/` in this checkout is twelve `.yaml` files and nothing else,
    // so no test, no fixture and no real run here has ever had a non-handler file in front of it. The
    // README is the whole measurement, and it is one line of a fixture.
    expect(rows(run).map((row) => row.handler)).not.toContain('handlers/README.md');
    expect([...new Set(rows(run).map((row) => row.handler))]).toEqual([
      'handlers/alpha.yaml',
      'handlers/beta.yaml',
      'handlers/delta.yaml',
      'handlers/epsilon.yaml',
      'handlers/gamma.yaml',
    ]);
  });

  it('reads a still-open row as the strongest claim on a handler two rows name', () => {
    const dir = fixture();
    const fields = fieldsFor(review(dir), 'handlers/alpha.yaml');
    expect(fields.get('state')).toEqual(['open']);
    expect(fields.get('holds')).toEqual([2]);
    // The state rides on each holding, so a reader can see WHICH row is still measuring -- the
    // collapse a single summary state would make.
    //
    // **Sorted, because the order the two holdings arrive in is a RANDOM ID ORDER.** `handlerLives`
    // pushes holdings in `ledgerRows` order, and `ledgerRows` sorts by root id -- which is a UUID v4,
    // so the row recorded first is not the row printed first. Asserting `['applied', 'graded']`
    // outright made this test fail on **4 of 6 consecutive runs of the unmutated tree**. What the case
    // is about is that the two holdings carry DIFFERENT states, and that survives sorting; which one
    // leads is not a fact about this feature and was never meant to be asserted.
    expect([...(fields.get('row_status') ?? [])].sort()).toEqual(['applied', 'graded']);
    expect([...(fields.get('row_state') ?? [])].sort()).toEqual(['open', 'retired']);
  });

  it('reports a closed row that says regression_watch as a watch, and says how to re-read it', () => {
    const dir = fixture();
    const run = review(dir);
    const fields = fieldsFor(run, 'handlers/beta.yaml');
    expect(fields.get('state')).toEqual(['watch']);
    expect(fields.get('row_state')).toEqual(['watch']);
    expect(String(field(run, 'handlers/beta.yaml', 're_read'))).toContain(
      'asc handlers check handlers/beta.yaml',
    );
  });

  it('leaves a handler open when a live row carries the watch disposition', () => {
    const dir = fixture();
    // `applied` beside `regression_watch` is a row the schema does not forbid, and it means "still
    // running, and here is what to do afterwards". Reading the disposition first would report this
    // handler as watched while a row still reads it.
    const fields = fieldsFor(review(dir), 'handlers/epsilon.yaml');
    expect(fields.get('state')).toEqual(['open']);
    expect(fields.get('row_state')).toEqual(['open']);
  });

  it('retires a handler whose rows all closed, and lists one whose file is gone', () => {
    const dir = fixture();
    const run = review(dir);
    // A `metric.handler` whose file was deleted or renamed is a row that can never be graded. A
    // listing built from the directory alone would omit exactly the row that needs looking at.
    const fields = fieldsFor(run, 'handlers/gamma.yaml');
    expect(fields.get('state')).toEqual(['retired']);
    expect(fields.get('row_state')).toEqual(['retired']);
    // `file` is for a handler nothing holds -- not a pointer on every row.
    expect(fields.get('file')).toBeUndefined();
    expect(fields.get('re_read')).toBeUndefined();
  });

  it('lists a handler the ledger names even when there is no handlers/ directory', () => {
    // The listing is the ledger FIRST and the directory second: a project with no handlers/ still
    // has rows, and dropping them would hide every handler whose file was never committed.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-review-nodir-')));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));
    expect(asc(['init'], dir).status).toBe(0);
    record(dir, {
      change: '`handlers/ghost.yaml`',
      status: 'graded',
      metric: { handler: 'handlers/ghost.yaml' },
      rule: 'the rate this handler counts rises in the after arm',
    });

    const run = review(dir);
    expect(run.status, flat(run.stderr)).toBe(0);
    expect([...new Set(rows(run).map((row) => row.handler))]).toEqual(['handlers/ghost.yaml']);
    expect(field(run, 'handlers/ghost.yaml', 'state')).toBe('retired');
  });

  it('prints nothing at all for a project with no handlers and no rows', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-review-empty-')));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));
    expect(asc(['init'], dir).status).toBe(0);
    const run = review(dir);
    expect(run.status, flat(run.stderr)).toBe(0);
    expect(rows(run)).toEqual([]);
  });

  it('answers a row naming no handler at all, rather than inventing a placeholder for it', () => {
    // A `metric` with no `handler` is refused at grade time, and a capture row has no metric at all.
    // Neither can ever name a file, so neither may appear in a listing keyed by path.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-review-nometric-')));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));
    expect(asc(['init'], dir).status).toBe(0);
    record(dir, { change: 'a capture row', status: 'applied' });

    const run = review(dir);
    expect(run.status, flat(run.stderr)).toBe(0);
    expect(rows(run)).toEqual([]);
  });
});
