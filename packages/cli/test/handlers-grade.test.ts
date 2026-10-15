import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_DERIVE_VERSION } from '@ascend/adapter-claude-code';

/**
 * `asc handlers grade <entry-id>`, driven as the real binary (asc-09wx.8.3).
 *
 * **The point of this command is that the comparison cannot be re-chosen at read time**, so the two
 * tests that matter most here are the ones that pin it to the commands it must agree with: the
 * grader's compare block has to be the block `asc handlers compare` prints for the same handler at
 * the same instant, and its power block the one `asc handlers power` prints. `handler-compare-rows.ts`
 * and `handler-power.ts` were extracted so those cannot drift; this is what holds that claim up.
 *
 * **The fixture is thirty days and sixty sessions**, two a day, so a split in the middle leaves
 * thirty units in each arm and the difference is an estimate rather than the refusal `MIN_N` produces.
 * Every second session in the first half is answered by a trailing `ls` and no session in the second
 * half is, so the before arm is 15/30 and the after arm 30/30 -- a difference of exactly 0.5, which is
 * a number the fixture can be read for rather than one that was recorded.
 *
 * **Every refusal is reached through a row the tool wrote**, by handing `asc record` the properties
 * the case is about, rather than by editing JSONL and rebuilding behind the store's back. The one
 * exception says so where it happens: a metric with no rule is refused at write time, so nothing but
 * a hand-edited row can be that input, and that is the refusals's whole justification for existing.
 *
 * **`HOME` is the project directory**, as in `capture.test.ts`, so the default transcript root
 * resolves inside the fixture and this suite can never read the operator's own transcripts.
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

const PROJECT_DIR = '-Users-me-app';
/** Sixty sessions, two a day across September, so each arm of a mid-month split holds thirty. */
const SESSIONS = 60;
const APPLIED_AT = '2026-09-16T00:00:00.000Z';
const GRADING_POINT = 30;

const HANDLER_PATH = 'handlers/unfollowed.yaml';
const UNFOLLOWED = `on: command.run
where: { is_error: false, head: bd }
window:
  until: session.end
  absent:
    on: command.run
    where: { head: ls }
emit: { argv: '\${argv}' }
`;

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

/** `asc handlers grade`, with the flags every test needs. */
const grade = (dir: string, id: string, ...extra: string[]): Run =>
  asc(
    ['handlers', 'grade', id, '--effect', '0.5', '--project', PROJECT_DIR, '--json', ...extra],
    dir,
  );

/**
 * stderr with its wrapping undone.
 *
 * ascend wraps its own failures to the terminal width, so a refusal's sentence arrives with newlines
 * inside it and a substring assertion on the unwrapped text fails for a reason that has nothing to do
 * with the refusal. `record.test.ts` flattens the same way.
 */
const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The rows of a `--json` envelope, as `field -> value` for the one handler every replay reports. */
function fields(run: Run): Map<string, unknown> {
  const rows = (
    JSON.parse(run.stdout) as { rows: { handler: string; field: string; value: unknown }[] }
  ).rows;
  return new Map(
    rows.filter((row) => row.handler === 'unfollowed').map((row) => [row.field, row.value]),
  );
}

const field = (run: Run, name: string): unknown => fields(run).get(name);

let counter = 0;
/** One tool call and its result, so a `bd` and the `ls` that follows it sit in one session. */
const bash = (session: string, command: string, day: number, minute: number): string[] => {
  counter += 1;
  const id = `t${String(counter)}`;
  const ts =
    `2026-09-${String(day).padStart(2, '0')}` + `T10:${String(minute).padStart(2, '0')}:00.000Z`;
  return [
    {
      type: 'assistant',
      sessionId: session,
      timestamp: ts,
      message: {
        id: `msg-${id}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      sessionId: session,
      timestamp: ts,
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: '' }],
      },
    },
  ].map((record) => JSON.stringify(record));
};

/**
 * A project with a store, a handler, a corpus, and one recorded `intervention` row naming both.
 *
 * **`sha256` is read off `asc handlers power` rather than computed here**, because it is the COMPILED
 * handler's identity and not the sha256 of the file's bytes. A fixture that hashed the file would
 * fail the check this command exists to make, for a reason having nothing to do with the behaviour
 * under test -- and would have been the trap the docblock warns a reader about.
 *
 * `overrides` replaces whole properties, so a case can hand `asc record` the exact `metric` object it
 * is about. `answeredEverywhere` makes every session produce no row, which is the one shape the
 * planning arithmetic refuses before it computes anything.
 */
function fixture(
  overrides: Record<string, unknown> = {},
  answeredEverywhere = false,
): { dir: string; id: string; hash: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asc-grade-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);

  const handler = join(dir, HANDLER_PATH);
  mkdirSync(join(handler, '..'), { recursive: true });
  writeFileSync(handler, UNFOLLOWED, 'utf8');

  const transcripts = join(dir, '.claude', 'projects', PROJECT_DIR);
  mkdirSync(transcripts, { recursive: true });
  for (let index = 0; index < SESSIONS; index += 1) {
    const session = `s${String(index).padStart(2, '0')}`;
    const day = 1 + Math.floor(index / 2);
    const lines = bash(session, 'bd ready', day, index);
    const answered = answeredEverywhere || (index < SESSIONS / 2 && index % 2 === 0);
    writeFileSync(
      join(transcripts, `${session}.jsonl`),
      `${(answered ? [...lines, ...bash(session, 'ls', day, index)] : lines).join('\n')}\n`,
    );
  }

  const powered = asc(
    ['handlers', 'power', HANDLER_PATH, '--effect', '0.5', '--project', PROJECT_DIR, '--json'],
    dir,
  );
  expect(powered.status).toBe(0);
  const hash = String(field(powered, 'hash'));

  const entry = {
    properties: {
      change: `\`${HANDLER_PATH}\``,
      status: 'applied',
      applied_at: APPLIED_AT,
      grading_point: GRADING_POINT,
      rule: 'unprompted recall rises by half in the after arm at the grading point',
      metric: {
        handler: HANDLER_PATH,
        sha256: hash,
        derive_version: EVENT_DERIVE_VERSION,
        unit: 'compaction segment',
        scope: PROJECT_DIR,
      },
      ...overrides,
    },
  };
  const recorded = asc(['record', 'intervention', '-'], dir, JSON.stringify(entry));
  expect(recorded.status, flat(recorded.stderr)).toBe(0);
  return { dir, id: entryIdOf(dir, 'intervention'), hash };
}

/** The one entry of `typeName` in the tree, read off disk rather than inferred from a report. */
function entryIdOf(dir: string, typeName: string): string {
  const entriesDir = join(dir, '.ascend', 'entries');
  for (const folder of readdirSync(entriesDir)) {
    for (const file of readdirSync(join(entriesDir, folder))) {
      for (const line of readFileSync(join(entriesDir, folder, file), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        const parsed = JSON.parse(line) as { kind?: string; type_name?: string; id?: string };
        if (parsed.kind === 'entry' && parsed.type_name === typeName) return String(parsed.id);
      }
    }
  }
  throw new Error(`the fixture holds no ${typeName} entry.`);
}

/** Every file under `.ascend`, by path and bytes -- what "writes nothing" is checked against. */
function tree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk(join(dir, '.ascend'));
  return files;
}

describe('asc handlers grade: the row, read back off its own metric', () => {
  it('prints the row’s state and the ruler it names', () => {
    const { dir, id, hash } = fixture();
    const run = grade(dir, id);
    expect(run.status, flat(run.stderr)).toBe(0);
    const rows = fields(run);
    expect(rows.get('entry')).toBe(id);
    expect(rows.get('status')).toBe('applied');
    expect(rows.get('chain_entries')).toBe(1);
    expect(rows.get('applied_at')).toBe(APPLIED_AT);
    expect(rows.get('grading_point')).toBe(GRADING_POINT);
    expect(rows.get('metric.handler')).toBe(HANDLER_PATH);
    expect(rows.get('metric.sha256')).toBe(hash);
    expect(rows.get('metric.derive_version')).toBe(EVENT_DERIVE_VERSION);
    expect(rows.get('metric.unit')).toBe('compaction segment');
    expect(rows.get('rule')).toBe(
      'unprompted recall rises by half in the after arm at the grading point',
    );
    expect(rows.get('ruler')).toMatch(/^matched the metric -- handlers\/unfollowed\.yaml /);
  });

  it('says a row that claims no grade is not a premature one, rather than saying it is on time', () => {
    // `LedgerRow.premature` is absent both for a row graded on time and for a row never graded, and a
    // boolean here would collapse them -- reporting "not premature" about a grade nobody took.
    const { dir, id } = fixture();
    const rows = fields(grade(dir, id));
    expect(rows.get('premature')).toBe('not applicable -- this row claims no grade yet');
    expect(rows.has('days_short')).toBe(false);
  });

  it('prints the due instant it can build, and the basis that stops it being read as the wait itself', () => {
    // `due_at` is `applied_at` plus `grading_point` CALENDAR days while `grading_point` is stated in
    // ACTIVE days. `asc-09wx.8.5` settled the label rather than the arithmetic (decision
    // `c38bf1a2`): the instant stays as pinned, and `due_at_basis` is what a reader takes it as --
    // an earlier bound. Both assertions are here so moving either one has to face the other.
    const { dir, id } = fixture();
    const rows = fields(grade(dir, id));
    expect(rows.get('due_at')).toBe('2026-10-16T00:00:00.000Z');
    expect(rows.get('due_at_basis')).toBe(
      'an EARLIER bound -- calendar days, not the active days grading_point states',
    );
  });
});

describe('asc handlers grade: the comparison it was filed for', () => {
  it('splits at the row’s own applied_at, not at the moment it is read', () => {
    const { dir, id } = fixture();
    expect(field(grade(dir, id), 'at')).toBe(APPLIED_AT);
  });

  it('counts each arm, and the difference the fixture’s two halves were built to have', () => {
    const { dir, id } = fixture();
    const rows = fields(grade(dir, id));
    expect([
      rows.get('before.units'),
      rows.get('before.with_row'),
      rows.get('after.units'),
      rows.get('after.with_row'),
      rows.get('difference'),
    ]).toStrictEqual([30, 15, 30, 30, 0.5]);
  });

  it('says observational, because the change was not assigned at random', () => {
    const { dir, id } = fixture();
    expect(String(field(grade(dir, id), 'design'))).toMatch(/^observational -- /);
  });

  it('prints the block asc handlers compare prints, for the same handler at the same instant', () => {
    // The anti-drift assertion. `handler-compare-rows.ts` exists so these two cannot diverge; this is
    // the test that fails if someone gives the grader its own sentences back.
    const { dir, id } = fixture();
    const graded = fields(grade(dir, id));
    const compared = fields(
      asc(
        [
          'handlers',
          'compare',
          HANDLER_PATH,
          '--at',
          APPLIED_AT,
          '--project',
          PROJECT_DIR,
          '--json',
        ],
        dir,
      ),
    );
    expect(compared.size).toBeGreaterThan(0);
    const shared = [
      'at',
      'unit',
      'outcome',
      'design',
      'before.units',
      'before.with_row',
      'before.triggers',
      'before.rows',
      'before.proportion',
      'after.units',
      'after.with_row',
      'after.triggers',
      'after.rows',
      'after.proportion',
      'straddling',
      'undated',
      'difference',
    ];
    for (const name of shared) {
      expect([name, graded.get(name)]).toStrictEqual([name, compared.get(name)]);
    }
  });

  it('honours --at over the row’s own date, and says which it used', () => {
    const { dir, id } = fixture();
    const rows = fields(grade(dir, id, '--at', '2026-09-01T00:00:00.000Z'));
    expect([rows.get('at'), rows.get('before.units'), rows.get('after.units')]).toStrictEqual([
      '2026-09-01T00:00:00.000Z',
      0,
      60,
    ]);
  });
});

describe('asc handlers grade: the plan, and whether the row waits long enough for it', () => {
  it('prints the block asc handlers power prints, for the handler the metric names', () => {
    const { dir, id } = fixture();
    const graded = fields(grade(dir, id));
    const powered = fields(
      asc(
        ['handlers', 'power', HANDLER_PATH, '--effect', '0.5', '--project', PROJECT_DIR, '--json'],
        dir,
      ),
    );
    expect(powered.size).toBeGreaterThan(0);
    const shared = [
      'hash',
      'units',
      'successes',
      'undated',
      'active_days',
      'holdout',
      'effect',
      'horizon_days',
      'proportion',
      'clusters',
      'rho_source',
      'design_effect',
      'units_per_day',
      'units_needed',
      'units_per_arm',
      'days_to_power',
      'min_n_days',
      'multiple',
      'verdict',
    ];
    for (const name of shared) {
      expect([name, graded.get(name)]).toStrictEqual([name, powered.get(name)]);
    }
  });

  it('says the row is short, with the gap, when its grading point is under what the effect needs', () => {
    // The acceptance criterion's sentence. A grade taken at a grading point below what the effect
    // needs is an anecdote, and the row is the one place that can be said about it.
    const { dir, id } = fixture({ grading_point: 3 });
    const run = grade(dir, id);
    const needed = Number(field(run, 'days_to_power'));
    expect(needed).toBeGreaterThan(3);
    // The gap is reported the way `days_to_power` itself is -- to three decimals, in the same active
    // days -- because the two numbers sit in one sentence and a reader will subtract them by eye.
    const gap = Math.round((needed - 3) * 1000) / 1000;
    expect(field(run, 'reaches_grading_point')).toBe(
      `the row waits 3 active days and this effect needs ${String(needed)}: ${String(gap)} active ` +
        `days short, so a grade taken at the row’s own grading point would be an anecdote rather ` +
        `than a comparison`,
    );
  });

  it('says the row is planned for when its grading point covers the wait', () => {
    const { dir, id } = fixture({ grading_point: 400 });
    const run = grade(dir, id);
    const needed = Number(field(run, 'days_to_power'));
    expect(field(run, 'reaches_grading_point')).toBe(
      `the row waits 400 active days and this effect needs ${String(needed)}, so a grade at the ` +
        `row’s own grading point is planned for rather than hoped for`,
    );
  });

  it('says the plan could not be computed rather than comparing against nothing', () => {
    // A row whose outcome never varied has no plan to compare a grading point against, and a row that
    // silently dropped its last sentence would read as though it had been checked.
    const { dir, id } = fixture({}, true);
    const run = grade(dir, id);
    expect(field(run, 'verdict')).toMatch(/^nothing to plan -- the outcome was the same in all 60/);
    expect(field(run, 'reaches_grading_point')).toBe(
      'not checked -- the plan above could not be computed, so there is no figure for this row’s ' +
        'grading point to reach',
    );
  });
});

describe('asc handlers grade: refusing to read a row whose ruler has moved', () => {
  it('refuses when the handler on disk is not the one the metric names', () => {
    // `intervention`'s own words: a handler whose `where` clause was improved is a DIFFERENT RULER.
    // The refusal names both hashes, because "it moved" without them is a claim the reader cannot act
    // on -- and nothing is compared, because a comparison here is the number that looks right.
    const { dir, id } = fixture({
      metric: {
        handler: HANDLER_PATH,
        sha256: 'f'.repeat(64),
        derive_version: EVENT_DERIVE_VERSION,
      },
    });
    const run = grade(dir, id);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(flat(run.stderr)).toMatch(/The ruler has moved since intervention row .* was written\./);
    expect(flat(run.stderr)).toContain(`Its metric names ${'f'.repeat(64)}`);
    expect(flat(run.stderr)).toMatch(/Nothing was compared; nothing was written\.$/);
  });

  it('names the derivation when the row was read at a different one, and the handler is unchanged', () => {
    const { dir, id, hash } = fixture();
    reindex(dir, (properties) => {
      const metric = properties['metric'] as Record<string, unknown>;
      metric['derive_version'] = EVENT_DERIVE_VERSION + 1;
      expect(metric['sha256']).toBe(hash);
    });
    const run = grade(dir, id);
    expect(run.status).toBe(1);
    expect(flat(run.stderr)).toMatch(
      /The log has moved since intervention row \S+'s baseline was read\./,
    );
    expect(flat(run.stderr)).toContain(`names derive version ${String(EVENT_DERIVE_VERSION + 1)}`);
  });

  it('refuses a metric with no rule beside it, which asc record also refuses at write time', () => {
    // The one case the tool cannot write. `asc record` refuses this row (`metricWithoutRuleIssue`), so
    // a hand-edited row is the only input that reaches the refusal -- which is exactly why the
    // refusal is worth having: a grade with no criterion is not a grade, whoever wrote the row.
    const { dir, id } = fixture();
    reindex(dir, (properties) => {
      delete properties['rule'];
    });
    const run = grade(dir, id);
    expect(run.status).toBe(1);
    expect(flat(run.stderr)).toMatch(/names a metric with no 'rule' beside it/);
  });

  it('refuses a metric missing each of its three facts, naming the fact', () => {
    // The three refusals, and the order they are checked in: a metric names all three or it is not
    // yet a metric, and comparing anyway is the number that looks right and is not.
    for (const name of ['handler', 'sha256', 'derive_version'] as const) {
      const { dir, id } = fixture();
      reindex(dir, (properties) => {
        const metric = properties['metric'] as Record<string, unknown>;
        properties['metric'] = Object.fromEntries(
          Object.entries(metric).filter(([key]) => key !== name),
        );
      });
      const run = grade(dir, id);
      expect([name, run.status]).toStrictEqual([name, 1]);
      expect(flat(run.stderr)).toContain(`names no '${name}'`);
    }
  });

  it('refuses a row that states no metric anywhere in its chain', () => {
    // A row with no metric is a capture, not a proposal -- `asc capture` writes exactly that shape,
    // which is why this one is reachable through `asc record` with nothing removed at all.
    const { dir, id } = fixture({ metric: undefined });
    const run = grade(dir, id);
    expect(run.status).toBe(1);
    expect(flat(run.stderr)).toMatch(
      /states no metric anywhere in its chain, so there is nothing to grade/,
    );
  });

  it('refuses an id the store does not hold, and one that is not an intervention', () => {
    const { dir, id } = fixture();
    const missing = grade(dir, 'no-such-entry');
    expect(missing.status).toBe(1);
    expect(flat(missing.stderr)).toMatch(/No entry 'no-such-entry' in this project's store/);

    // The other way to be the wrong id: a real entry of a type that carries no metric at all. A grader
    // that fell through to "no metric" here would blame the row for the caller's mistake, and the two
    // have different fixes.
    expect(asc(['record', 'decision', '--prop=chosen=a', '--prop=rationale=b'], dir).status).toBe(
      0,
    );
    const other = entryIdOf(dir, 'decision');
    expect(other).not.toBe(id);
    const wrong = grade(dir, other);
    expect(wrong.status).toBe(1);
    expect(flat(wrong.stderr)).toMatch(
      /is a 'decision' entry, and this command grades an intervention row/,
    );
  });

  it('refuses to split at a moment the row does not state and was not given', () => {
    const { dir, id } = fixture({ applied_at: undefined });
    const run = grade(dir, id);
    expect(run.status).toBe(1);
    expect(flat(run.stderr)).toMatch(/states no 'applied_at' -- the wait it means has no start/);
    // And --at is the way out, which is why the refusal names it.
    expect(grade(dir, id, '--at', '2026-09-16').status).toBe(0);
  });

  it('writes nothing, on the path that refuses and on the path that prints', () => {
    const { dir, id } = fixture();
    const sealed = tree(dir);
    expect(grade(dir, id).status).toBe(0);
    expect([...tree(dir)]).toStrictEqual([...sealed]);
    expect(grade(dir, 'no-such-entry').status).toBe(1);
    expect([...tree(dir)]).toStrictEqual([...sealed]);
  });
});

describe('asc handlers grade: the flags', () => {
  it('refuses a missing --effect rather than inventing an effect size for the row', () => {
    const { dir, id } = fixture();
    const run = asc(['handlers', 'grade', id, '--project', PROJECT_DIR, '--json'], dir);
    expect(run.status).toBe(2);
    expect(flat(run.stderr)).toContain('effect');
  });

  it('names --effect, not --holdout, when the effect is the flag that was wrong', () => {
    const { dir, id } = fixture();
    const run = asc(
      ['handlers', 'grade', id, '--effect', '2', '--project', PROJECT_DIR, '--json'],
      dir,
    );
    expect(run.status).toBe(2);
    expect(flat(run.stderr)).toMatch(/--effect takes a fraction strictly between 0 and 1/);
  });

  it('names --holdout when the holdout is the flag that was wrong', () => {
    const { dir, id } = fixture();
    const run = grade(dir, id, '--holdout', '1');
    expect(run.status).toBe(2);
    expect(flat(run.stderr)).toMatch(/--holdout takes a fraction strictly between 0 and 1/);
  });

  it('names --at when the instant does not parse', () => {
    const { dir, id } = fixture();
    const run = grade(dir, id, '--at', 'sometime last week');
    expect(run.status).toBe(2);
    expect(flat(run.stderr)).toMatch(/--at sometime last week is not an ISO 8601 date or time\./);
  });

  it('refuses a horizon of zero active days', () => {
    const { dir, id } = fixture();
    const run = grade(dir, id, '--horizon', '0');
    expect(run.status).toBe(2);
    expect(flat(run.stderr)).toMatch(/--horizon takes a positive number of active days; got 0\./);
  });
});

/**
 * Edit the one `intervention` row's properties on disk, then rebuild the index.
 *
 * **This is the store's own recovery path, not a way around it.** A read goes through the derived
 * index, and an index that disagrees with the tree refuses and names `asc index build` -- so a
 * hand-edit that skipped the rebuild would fail this suite for the edit rather than for the
 * behaviour, which is the wrong reason twice over.
 */
function reindex(dir: string, edit: (properties: Record<string, unknown>) => void): void {
  const entriesDir = join(dir, '.ascend', 'entries');
  let edited = 0;
  for (const folder of readdirSync(entriesDir)) {
    const path = join(entriesDir, folder, '0001.jsonl');
    const parsed = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      type_name?: string;
      properties: Record<string, unknown>;
    };
    if (parsed.type_name !== 'intervention') continue;
    edit(parsed.properties);
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');
    edited += 1;
  }
  expect(edited).toBe(1);
  const built = asc(['index', 'build'], dir);
  expect(built.status, flat(built.stderr)).toBe(0);
}
