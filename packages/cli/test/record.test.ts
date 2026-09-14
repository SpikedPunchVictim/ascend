import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc record`, driven as the real binary.
 *
 * **Every claim about what was written is read back out of SQLite**, not inferred from the report.
 * This is the command where that matters most: it is the only writer of entries, and a version of
 * it that printed a correct-looking row while inserting nothing, or inserting a different value
 * than it reported, would pass any test that only read stdout. `types.test.ts` states the same rule
 * for the registry; here it covers three things the output cannot show -- the stored
 * `properties_json`, the `na_json` that encodes the second state, and the generated view, which is
 * what every later `asc query` actually reads.
 *
 * The three-state model gets its own block, because it is the product's load-bearing invariant
 * (`core/state.ts`) and the CLI is where a recorder can destroy it: `--prop=x=0` and `--na x` and
 * "said nothing" have to stay three different rows, and nothing downstream can recover the
 * distinction once it is lost.
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
  const dir = mkdtempSync(join(tmpdir(), 'asc-record-'));
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

const env = (dir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: dir,
  XDG_CACHE_HOME: join(dir, '.cache'),
});

function asc(args: readonly string[], cwd: string, input?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: env(cwd),
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A project: a directory that looks like a repository, with the starter types installed.
 *
 * `.git` is a plain directory rather than `git init`, so the test does not depend on git being
 * installed or on a global config -- `init` only ever asks whether the path exists.
 */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);
  return dir;
}

/** stderr with oclif's wrap decoration removed, so a substring assertion means what it reads like. */
function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The directory as the PROCESS resolves it. macOS `tmpdir()` is a symlink under `/var`. */
function real(dir: string): string {
  return realpathSync(dir);
}

function envelope(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

/** One entry read straight out of the table, so the assertion is about what was stored. */
interface StoredEntry {
  readonly id: string;
  readonly type_name: string;
  readonly type_version: number;
  readonly source: string;
  readonly recorded_at: string;
  readonly cwd: string | null;
  readonly properties_json: string;
  readonly na_json: string;
  readonly evidence_text: string | null;
  readonly run_id: string | null;
}

function stored(dir: string, where = '1 = 1', ...params: string[]): readonly StoredEntry[] {
  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'), { readOnly: true });
  try {
    return db
      .prepare(`SELECT * FROM entries WHERE ${where} ORDER BY recorded_at, id`)
      .all(...params) as unknown as StoredEntry[];
  } finally {
    db.close();
  }
}

function count(dir: string, sql: string): number {
  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'), { readOnly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/**
 * One row of a generated view, read by the name the naming convention promises.
 *
 * `v_<type>_v<version>` is spelled out here rather than imported from the store, deliberately: the
 * generated view is the interface every later `asc query` uses, and a test that imported the
 * function producing the name could not notice the name changing.
 */
function view(dir: string, name: string, where = '1 = 1'): readonly Record<string, unknown>[] {
  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${name} WHERE ${where}`).all();
  } finally {
    db.close();
  }
}

describe('asc record', () => {
  it('writes an entry from flags, and stores what it reported', () => {
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=walk up',
        '--prop=rationale=git does this already',
        '--prop=reversibility=reversible',
        '--json',
      ],
      dir,
    );

    expect(run.status).toBe(0);
    const [row] = envelope(run.stdout);
    expect(row?.['type']).toBe('decision');
    // The version and the hash are the store's to decide, and the row reports what it decided --
    // so this checks the report against the table rather than against a constant.
    const [entry] = stored(dir);
    expect(entry?.id).toBe(row?.['id']);
    expect(entry?.type_version).toBe(row?.['version']);
    expect(entry?.type_name).toBe('decision');
    expect(JSON.parse(entry?.properties_json ?? '{}')).toEqual({
      chosen: 'walk up',
      rationale: 'git does this already',
      reversibility: 'reversible',
    });
  });

  it('reads a document from standard input, which is the primary path', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--json'],
      dir,
      JSON.stringify({ properties: { chosen: 'operand', rationale: 'one convention for stdin' } }),
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(stored(dir)[0]?.properties_json ?? '{}')).toEqual({
      chosen: 'operand',
      rationale: 'one convention for stdin',
    });
  });

  it('reads a document from a file path as well, and the two agree', () => {
    const dir = project();
    writeFileSync(
      join(dir, 'entry.json'),
      JSON.stringify({ properties: { chosen: 'file', rationale: 'same shape' } }),
    );

    expect(asc(['record', 'decision', 'entry.json'], dir).status).toBe(0);
    // The cast, not a bare index: `JSON.parse` returns `any`, and a bare `['chosen']` is an unsafe
    // member access lint refuses. Same idiom as the `chosen`-keyed assertion below.
    expect((JSON.parse(stored(dir)[0]?.properties_json ?? '{}') as { chosen: string }).chosen).toBe(
      'file',
    );
  });

  it('keeps the three states three states, in the row and in the generated view', () => {
    const dir = project();
    // `stage` measured with a real value, `verdict` not applicable, `findings` not mentioned.
    const run = asc(
      ['record', 'review_completed', '--prop=stage=Stage 4', '--na=verdict', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    expect(envelope(run.stdout)[0]?.['states']).toEqual({
      findings: 'not_measured',
      stage: 'measured',
      verdict: 'not_applicable',
    });

    // And the same three states survive into the projection everything else reads. `stage` is a
    // value, `verdict` is NULL because it is N/A, and `findings` is NULL because nobody looked --
    // the two NULLs are the ones a naive reader collapses, which is the whole reason `_state`
    // columns exist alongside them.
    const [projected] = view(dir, 'v_review_completed_v1');
    expect(projected?.['stage']).toBe('Stage 4');
    expect(projected?.['verdict_state']).toBe('not_applicable');
    expect(projected?.['findings_state']).toBe('not_measured');
  });

  it('stores an empty json array as a measurement, not as silence', () => {
    // `json` was added to the vocabulary for exactly this shape (`core/spec.ts`), and this is the
    // CLI-level check that a recorder can express "looked, found nothing" through the real command
    // rather than only through the store's own API.
    const dir = project();
    const run = asc(
      ['record', 'review_completed', '--prop=verdict=approved', '--prop=findings=[]', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    expect(envelope(run.stdout)[0]?.['states']).toMatchObject({ findings: 'measured' });
    expect(view(dir, 'v_review_completed_v1')[0]?.['findings_state']).toBe('measured');
  });

  it('refuses a value the definition does not accept, and writes nothing', () => {
    const dir = project();
    const run = asc(['record', 'review_completed', '--prop=verdict=maybe'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'verdict' expects one of");
    // Not "the command failed" -- the store is untouched, which is the only claim that makes the
    // refusal useful.
    expect(stored(dir)).toEqual([]);
  });

  it('names a fix that actually works', () => {
    // The reason `--prop=<name>=<value>` is not a free choice: the store generates that spelling
    // into its own error messages (`core/state.ts`), so a parser that accepted something else
    // would make the fix ascend suggests a command that fails. This drives the suggestion.
    const dir = project();
    const failed = asc(['record', 'review_completed', '--prop=verdict=maybe'], dir);
    const suggestion = /Re-record with: (asc record \S+ --prop=\S+=\S+)/.exec(
      flatten(failed.stderr),
    );
    expect(suggestion).not.toBeNull();

    const repaired = asc([...(suggestion?.[1] ?? '').split(' ').slice(1)], dir);
    expect(repaired.status).toBe(0);
    expect(stored(dir)).toHaveLength(1);
  });

  it('does NOT print a runnable command whose value ascend had to invent', () => {
    // The end-to-end receipt for the defect the unit-level invariant in `core/state.test.ts`
    // pins. Before the fix, recording nothing for a required `string` property produced this
    // suggested repair -- and it RAN: exit 0, and `{"missing":"<string>"}` in the ledger. The
    // placeholder was `<${type}>`, which stores and validates for `string`, `text` and `ref`,
    // so ascend's own advice was writing a fabricated measurement into the ledger with ascend's
    // endorsement on it. That is the failure the whole product exists to prevent, so the check
    // is not "the suggestion validates" (it did) but "ascend never suggested it".
    const dir = project();
    writeFileSync(
      join(dir, 'pair.json'),
      JSON.stringify({
        name: 'pair',
        properties: [{ name: 'missing', type: 'string', required: true }],
      }),
    );
    expect(asc(['types', 'define', join(dir, 'pair.json')], dir).status).toBe(0);

    // An empty document, not bare `record pair`: no document and no entry flag is a usage
    // error (exit 2) and never reaches validation, so it would prove nothing about the message.
    const run = asc(['record', 'pair', '-'], dir, '{}');

    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    // It still refuses, and still names the flag -- a recorder is told the shape to supply.
    expect(message).toContain('--prop=missing=<value>');
    // And it still offers the half ascend CAN stand behind: an explicit N/A is a real command.
    expect(message).toContain('asc record pair --na missing');
    // What it must never again do is hand back a `--prop=` COMMAND LINE for a value ascend has
    // no way to know. Asserted on the command form rather than on the placeholder text, because
    // the next placeholder would not be spelled `<string>`.
    expect(message).not.toMatch(/asc record \S+ --prop=/);
    expect(stored(dir)).toEqual([]);
  });

  it('refuses an unregistered type, and lists the ones that exist', () => {
    const dir = project();
    const run = asc(['record', 'review', '--prop=x=y'], dir);

    expect(run.status).toBe(1);
    // Discovery lives in the error path because recall is pull-only (ARCHITECTURE.md): the useful
    // question after "no such type" is *which* types there are.
    const message = flatten(run.stderr);
    expect(message).toContain("no entry type 'review' is registered");
    expect(message).toContain('decision');
    expect(message).toContain('stuck_event');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses a usage error when there is no document and no entry flag', () => {
    // Rule 3: never wait for input nobody offered. The failure names both paths, and the exit
    // code is 2 rather than 1 because the fix is a different command line.
    const dir = project();
    const run = asc(['record', 'decision'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('nothing to record');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses a document and entry flags together, rather than picking a winner', () => {
    const dir = project();
    writeFileSync(join(dir, 'entry.json'), JSON.stringify({ properties: { chosen: 'a' } }));
    const run = asc(['record', 'decision', 'entry.json', '--prop=chosen=b'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('cannot be combined');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses a malformed --prop with the shape it wants', () => {
    const dir = project();
    const run = asc(['record', 'decision', '--prop=chosen'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--prop=<name>=<value>');
  });

  it('refuses a --prop given twice with different values, naming both and writing nothing', () => {
    // Measured before any of this existed: this command exited 0, printed NOTHING to stderr, and
    // the ledger held `"b"` -- `a` was gone with no signal at all, into a table that cannot be
    // corrected (entries are immutable, and re-recording the id is refused).
    //
    // It then warned and named the winner, and that is still a row whose contents the caller did
    // not choose: nothing in the stored row distinguishes it from one where they meant `b` all
    // along, and the caller this command is built for -- an LLM workflow -- reads stdout and may
    // never look at stderr. A conflict resolved by silently picking a winner is refused, which is
    // the same answer asc-4if took for the fold collision one spec over.
    const dir = project();
    const run = asc(
      ['record', 'decision', '--prop=chosen=a', '--prop=rationale=r', '--prop=chosen=b', '--json'],
      dir,
    );

    // 2, not 1: the conflict is entirely inside the caller's own argv -- no store state can make it
    // resolvable -- and it is the same class as a malformed `--prop`, which already exits 2.
    expect(run.status).toBe(2);
    const message = flatten(run.stderr);
    expect(message).toContain('--prop=chosen was given 2 times with different values');
    // Both values, so the caller can see the two they have to choose between.
    expect(message).toContain("'a'");
    expect(message).toContain("'b'");
    expect(message).toContain('Keep one of them');

    // The whole point: nothing was recorded, so no row can carry the ambiguity forward.
    expect(stored(dir)).toEqual([]);
  });

  it('refuses every conflicting name in one message, so one command line takes one pass', () => {
    // Two names, two conflicts. Reporting only the first would make the caller run the command
    // again to discover the second, which is the same defect one size down.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=a',
        '--prop=chosen=b',
        '--prop=rationale=r',
        '--prop=rationale=s',
      ],
      dir,
    );

    expect(run.status).toBe(2);
    const message = flatten(run.stderr);
    expect(message).toContain('--prop=chosen was given 2 times');
    expect(message).toContain('--prop=rationale was given 2 times');
    expect(stored(dir)).toEqual([]);
  });

  it('does NOT refuse when the repeated --prop carries the SAME value', () => {
    // The other half, and the reason the check is not simply "gave a name twice". Nothing
    // conflicted here, so there is nothing to refuse -- and `--na` already treats a repeat as a set
    // rather than a warning. A refusal that fires when nothing conflicted rejects legitimate work,
    // which is worse than the noise it replaced.
    const dir = project();
    const run = asc(
      ['record', 'decision', '--prop=chosen=a', '--prop=rationale=r', '--prop=chosen=a', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toBe('');
    expect(envelope(run.stdout)[0]?.['warnings']).toEqual([]);
    expect(JSON.parse(stored(dir)[0]?.properties_json ?? '{}')).toEqual({
      chosen: 'a',
      rationale: 'r',
    });
  });

  it('compares a repeated --prop value canonically, so key order is not a difference', () => {
    // `{"a":1,"b":2}` and `{"b":2,"a":1}` are one value written two ways, and `options_considered`
    // is a `json` property -- the type whose values ARE objects, so it is the only place this can
    // bite. Written twice identically-but-reordered nothing conflicted; a comparison on the raw
    // text (`===`, or the flag strings) would refuse this legitimate command.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=a',
        '--prop=rationale=r',
        '--prop=options_considered={"x":1,"y":2}',
        '--prop=options_considered={"y":2,"x":1}',
        '--json',
      ],
      dir,
    );

    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toBe('');
    expect(envelope(run.stdout)[0]?.['warnings']).toEqual([]);
    const recorded = JSON.parse(stored(dir)[0]?.properties_json ?? '{}') as Record<string, unknown>;
    expect(recorded['options_considered']).toEqual({ x: 1, y: 2 });
  });

  it('does not call an identical repeat "different" when the value cannot be compared', () => {
    // `--prop=x=1e999` parses to `Infinity`, and `canonicalJson` throws on a non-finite number --
    // measured, not hypothetical. Resolving "cannot compare" as "different" was defensible while
    // this fed a warning and is a false report now that it feeds a refusal: the message would quote
    // two IDENTICAL values as different. So the text is the tiebreak, and the accurate refusal --
    // the store's own, about the value being unusable -- is the one the caller reads.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=a',
        '--prop=rationale=r',
        '--prop=options_considered=1e999',
        '--prop=options_considered=1e999',
      ],
      dir,
    );

    expect(flatten(run.stderr)).not.toContain('different values');
    expect(flatten(run.stderr)).toContain('expects a JSON array or object');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses before validating, so the argv conflict is what the caller is told about', () => {
    // `rationale` is required and is left out; the repeated `chosen` is also here. Both are real
    // problems, and only one of them can be reported first. The conflict is entirely inside the
    // caller's argv -- no store state can resolve it -- and it is the more actionable of the two,
    // so it is checked before the store is opened at all. Refusing after validation would instead
    // report a missing property, and the repeat would surface only on the second run.
    const dir = project();
    const run = asc(['record', 'decision', '--prop=chosen=a', '--prop=chosen=b'], dir);

    expect(run.status).toBe(2);
    const message = flatten(run.stderr);
    expect(message).toContain('--prop=chosen was given 2 times with different values');
    expect(message).not.toContain('rationale');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses a --dry-run too, rather than previewing a recording that cannot happen', () => {
    // A preview promises what the real run would do, so it cannot promise a write this command
    // would refuse. The refusal is raised before the dry-run branch is reached, which is what makes
    // that true rather than a coincidence of ordering.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=a',
        '--prop=rationale=r',
        '--prop=chosen=b',
        '--dry-run',
      ],
      dir,
    );

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--prop=chosen was given 2 times with different values');
    // stdout stays empty, not "an envelope with no rows": stdout is the data channel, and a
    // refusal produces no data. A caller piping this into `jq` gets nothing to misread.
    expect(run.stdout).toBe('');
    expect(stored(dir)).toEqual([]);
  });

  it('splits --prop on the FIRST =, so a value may contain as many as it likes', () => {
    // The reason the split is `indexOf` rather than `lastIndexOf`. A rationale is prose about code,
    // and `x = y` is exactly what prose about code contains -- so a parser that split on the last
    // `=` would store the property under a name nobody wrote.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=walk up',
        '--prop=rationale=depth = path.length',
        '--json',
      ],
      dir,
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(stored(dir)[0]?.properties_json ?? '{}')).toEqual({
      chosen: 'walk up',
      rationale: 'depth = path.length',
    });
  });

  it('treats --na as a set, so repeating a name is not a warning', () => {
    // Deduplicated at the flag, so the flag's meaning is "these do not apply" rather than "these
    // names, plus a complaint about the repeat". The store deduplicates too and warns when it has
    // to -- which is right for a caller using the API directly, and noise for a caller who wrote
    // `--na a --na a` meaning one thing.
    const dir = project();
    const run = asc(
      ['record', 'decision', '--prop=rationale=because', '--na=chosen,chosen', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).not.toContain('more than once');
    expect(JSON.parse(stored(dir)[0]?.na_json ?? '[]')).toEqual(['chosen']);
    expect(envelope(run.stdout)[0]?.['warnings']).toEqual([]);
  });

  it('records a batch, and gives every entry its own id', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--json'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'first' } },
        { properties: { chosen: 'b', rationale: 'second' } },
        { properties: { chosen: 'c', rationale: 'third' } },
      ]),
    );

    expect(run.status).toBe(0);
    expect(envelope(run.stdout)).toHaveLength(3);
    expect(stored(dir)).toHaveLength(3);
    const ids = new Set(stored(dir).map((entry) => entry.id));
    expect(ids.size).toBe(3);
  });

  it('shares one recorded_at across a batch, so entries are not ordered by validation time', () => {
    const dir = project();
    asc(
      ['record', 'decision', '-'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'because' } },
        { properties: { chosen: 'b', rationale: 'because' } },
      ]),
    );

    const times = new Set(stored(dir).map((entry) => entry.recorded_at));
    expect(times.size).toBe(1);
    // UTC with a literal Z, which the store enforces and the row echoes -- the ledger sorts on
    // this column as text, so a local time or an offset would order it wrongly.
    expect([...times][0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('is all-or-nothing: a batch with one bad entry leaves the store empty', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'fine' } },
        { properties: { chosen: 'b', rationale: 'also fine' } },
        { properties: { chosen: 'c', rationale: 'contradictory' }, na: ['chosen'] },
      ]),
    );

    expect(run.status).toBe(1);
    expect(stored(dir)).toEqual([]);
  });

  it('says WHICH entry failed, because a batch is not one entry', () => {
    // Measured on the first draft: the store's message described the problem precisely and said
    // nothing about which of fifty entries had it, so a caller had to bisect its own batch.
    const dir = project();
    const run = asc(
      ['record', 'decision', '-'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'fine' } },
        { properties: { chosen: 'b', rationale: 'bad' }, na: ['chosen'] },
      ]),
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('entry 1:');
  });

  it('does not prefix the index onto a single entry, where it would be noise', () => {
    const dir = project();
    const run = asc(['record', 'decision', '--prop=chosen=a', '--na=chosen'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).not.toContain('entry 0:');
  });

  it('refuses a duplicate id inside one batch, which only the transaction can see', () => {
    // The property `withTransaction` exists for. A per-write transaction would make the second
    // entry blind to the first, so the id it reused would collide only on the NEXT run -- long
    // after the batch reported success.
    const dir = project();
    const run = asc(
      ['record', 'decision', '-'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'because' }, id: 'same-id' },
        { properties: { chosen: 'b', rationale: 'because' }, id: 'same-id' },
      ]),
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('entry 1:');
    expect(stored(dir)).toEqual([]);
  });

  it('honours an id the document names, so a caller can hold a stable reference', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--json'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'because' }, id: 'chosen-by-the-caller' },
      ]),
    );

    expect(run.status).toBe(0);
    expect(envelope(run.stdout)[0]?.['id']).toBe('chosen-by-the-caller');
    expect(stored(dir)[0]?.id).toBe('chosen-by-the-caller');
  });

  it('writes NOTHING on --dry-run, but reports the entries it would write', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--dry-run', '--json'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'because' } },
        { properties: { chosen: 'b', rationale: 'because' } },
      ]),
    );

    expect(run.status).toBe(0);
    expect(envelope(run.stdout)).toHaveLength(2);
    expect(stored(dir)).toEqual([]);
    // The E4.2 JSON-contract lesson: a boolean read from a flag that was not passed is
    // `undefined`, and `JSON.stringify` drops the field -- so "not a dry run" would be
    // indistinguishable from "this command does not report dry runs".
    expect(envelope(run.stdout).every((row) => row['dry_run'] === true)).toBe(true);
  });

  it('reports dry_run on a real run too, rather than dropping the field', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '--prop=chosen=a', '--prop=rationale=because', '--json'],
      dir,
    );

    expect(envelope(run.stdout)[0]?.['dry_run']).toBe(false);
  });

  it('fills in the provenance it can read, and refuses the parts it cannot', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--json'],
      dir,
      JSON.stringify({
        properties: { chosen: 'a', rationale: 'because' },
        run_id: 'run-7',
        workflow: 'stage-4',
        actor: 'claude-code',
        evidence_text: 'the store refused a nested transaction',
      }),
    );

    expect(run.status).toBe(0);
    const [entry] = stored(dir);
    // `cwd` is read from the process rather than asked for -- `asc-krw`'s principle: never make a
    // caller self-report what can be read off disk.
    expect(entry?.cwd).toBe(real(dir));
    expect(entry?.source).toBe('self');
    expect(entry?.run_id).toBe('run-7');
    expect(entry?.evidence_text).toBe('the store refused a nested transaction');
  });

  it('refuses source, recorded_at, cwd and type, each with its reason', () => {
    const dir = project();
    const cases: readonly (readonly [string, string])[] = [
      ['source', 'only the thing doing the deriving'],
      ['recorded_at', 'read from ascend'],
      ['cwd', 'read from the process'],
      ['type', 'the type is the command operand'],
    ];

    for (const [key, reason] of cases) {
      const run = asc(
        ['record', 'decision', '-'],
        dir,
        JSON.stringify({
          properties: { chosen: 'a' },
          [key]: key === 'recorded_at' ? '2020-01-01T00:00:00.000Z' : 'x',
        }),
      );
      expect(run.status, key).toBe(1);
      expect(flatten(run.stderr), key).toContain(reason);
    }
    expect(stored(dir)).toEqual([]);
  });

  it('refuses an unknown field rather than dropping it in silence', () => {
    // `evidenceText` where the field is `evidence_text` is the likely mistake, and ignoring it
    // would record the entry with no evidence text while reporting success.
    const dir = project();
    const run = asc(
      ['record', 'decision', '-'],
      dir,
      JSON.stringify({ properties: { chosen: 'a' }, evidenceText: 'spelt wrong' }),
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("no such field 'evidenceText'");
    expect(stored(dir)).toEqual([]);
  });

  it('warns about a dropped property, writes the entry, and puts the warning on the row', () => {
    // The store strips an undeclared property rather than refusing the entry -- legal, and almost
    // certainly unintended. It is silent data loss unless it is reported, and the caller most
    // likely to miss it is the one reading stdout alone.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=a',
        '--prop=rationale=because',
        '--prop=notaproperty=x',
        '--json',
      ],
      dir,
    );

    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toContain("'notaproperty' is not a property of decision");
    expect(envelope(run.stdout)[0]?.['warnings']).toEqual([
      "notaproperty: 'notaproperty' is not a property of decision, so it was dropped",
    ]);
    expect(stored(dir)).toHaveLength(1);
    expect(JSON.parse(stored(dir)[0]?.properties_json ?? '{}')).toEqual({
      chosen: 'a',
      rationale: 'because',
    });
  });

  it('reports a --prop whose name is a JavaScript prototype member, instead of dropping it mutely', () => {
    // The same warning as above, for the one name that used to escape it. Measured before the
    // fix: `--prop=__proto__=pwned` was swallowed when the flags were collected into an object
    // literal -- `Object.prototype`'s `__proto__` setter ignores a non-object, so the key never
    // became an own property, `Object.entries` never saw it, and the command exited 0 having
    // silently discarded a flag. Not "warned and stripped": not mentioned at all, which is the
    // one outcome this command refuses everywhere else. `notaproperty` above cannot catch it,
    // because an ordinary undefined key and an inherited accessor fail differently.
    const dir = project();
    const run = asc(
      [
        'record',
        'decision',
        '--prop=chosen=a',
        '--prop=rationale=because',
        '--prop=__proto__=pwned',
        '--json',
      ],
      dir,
    );

    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toContain("'__proto__' is not a property of decision");
    expect(JSON.parse(stored(dir)[0]?.properties_json ?? '{}')).toEqual({
      chosen: 'a',
      rationale: 'because',
    });
  });

  it('warns rather than refusing when every property is not applicable', () => {
    // Legal, and the entry is written: `required` means "must have a decision", never "must have a
    // value" (`core/state.ts`). Refusing here would pressure a recorder into fabricating one.
    const dir = project();
    const run = asc(
      ['record', 'decision', '--na=chosen,options_considered,rationale,reversibility', '--json'],
      dir,
    );

    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toContain('every property of decision is marked not applicable');
    expect(stored(dir)).toHaveLength(1);
    expect(JSON.parse(stored(dir)[0]?.na_json ?? '[]')).toHaveLength(4);
  });

  it('refuses --na with an empty name, rather than storing a property called ""', () => {
    const dir = project();
    const run = asc(['record', 'decision', '--prop=chosen=a', '--na=chosen,'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('empty name');
    expect(stored(dir)).toEqual([]);
  });

  it('pins the type version when asked, and refuses one that is not registered', () => {
    const dir = project();
    expect(
      asc(
        ['record', 'decision', '--prop=chosen=a', '--prop=rationale=because', '--type-version=1'],
        dir,
      ).status,
    ).toBe(0);
    expect(stored(dir)[0]?.type_version).toBe(1);

    const missing = asc(
      ['record', 'decision', '--prop=chosen=b', '--prop=rationale=because', '--type-version=2'],
      dir,
    );
    expect(missing.status).toBe(1);
    expect(stored(dir)).toHaveLength(1);
  });

  it('lets a call-level flag act as a default that an entry can override', () => {
    // A caller recording ten entries should not repeat the run id ten times -- and an entry that
    // states its own must not have the flag overwrite it.
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--run-id=call-level'],
      dir,
      JSON.stringify([
        { properties: { chosen: 'a', rationale: 'because' } },
        { properties: { chosen: 'b', rationale: 'because' }, run_id: 'entry-level' },
      ]),
    );

    expect(run.status).toBe(0);
    // Keyed by `chosen` rather than compared as a list, because the two entries SHARE a
    // `recorded_at` (one clock reading per call) and `stored` orders by that column -- so their
    // order is not insertion order, and asserting a list here would be asserting a tie-break.
    const byChosen = Object.fromEntries(
      stored(dir).map((entry) => [
        (JSON.parse(entry.properties_json) as { chosen: string }).chosen,
        entry.run_id,
      ]),
    );
    expect(byChosen).toEqual({ a: 'call-level', b: 'entry-level' });
  });

  it('refuses an empty batch, because zero entries is not a successful recording', () => {
    const dir = project();
    const run = asc(['record', 'decision', '-'], dir, '[]');

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('empty array');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses a document that is not JSON, naming where it came from', () => {
    const dir = project();
    const run = asc(['record', 'decision', '-'], dir, 'not json at all');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('standard input is not valid JSON');
    expect(stored(dir)).toEqual([]);
  });

  it('keeps the single command prefix the allowlist depends on', () => {
    // ARCHITECTURE.md: "Stable command prefix so `Bash(asc record:*)` works as a settings.json
    // allowlist entry. A permission prompt per record kills the workflow." So every recording
    // shape -- flags, stdin, file, batch, dry run -- has to go through `asc record`, and none of
    // them may need a further subcommand. The argv below is exactly what the allowlist matches.
    const dir = project();
    const shapes: readonly (readonly [string[], string])[] = [
      [['record', 'decision', '--prop=chosen=a', '--prop=rationale=because'], ''],
      [
        ['record', 'decision', '-'],
        JSON.stringify({ properties: { chosen: 'b', rationale: 'because' } }),
      ],
      [
        ['record', 'decision', '-', '--dry-run'],
        JSON.stringify({ properties: { chosen: 'c', rationale: 'because' } }),
      ],
    ];

    for (const [argv, input] of shapes) {
      const run = asc(argv, dir, input);
      expect(run.status, argv.join(' ')).toBe(0);
      // The type is the first word after `record`, and holds no command of its own -- a version of
      // this command that needed `asc record batch --json -` would break the allowlist entry.
      expect(argv[0], argv.join(' ')).toBe('record');
    }
    expect(stored(dir)).toHaveLength(2);
  });

  it('records two different types, which is what makes the store a corpus', () => {
    const dir = project();
    expect(asc(['record', 'decision', '--prop=chosen=a', '--prop=rationale=r'], dir).status).toBe(
      0,
    );
    expect(
      asc(
        [
          'record',
          'stuck_event',
          '--prop=attempt_count=3',
          '--prop=error_text=EACCES: permission denied',
        ],
        dir,
      ).status,
    ).toBe(0);

    expect(count(dir, 'SELECT COUNT(*) AS n FROM entries')).toBe(2);
    expect(count(dir, 'SELECT COUNT(*) AS n FROM v_decision_v1')).toBe(1);
    expect(count(dir, 'SELECT COUNT(*) AS n FROM v_stuck_event_v1')).toBe(1);
    // The generated view carries the type's own properties, which is the point of generating it.
    expect(view(dir, 'v_stuck_event_v1')[0]?.['error_text']).toBe('EACCES: permission denied');
  });
});

describe('a piped value is never taken for an operand', () => {
  /**
   * `asc record` has two positional args, and oclif would fill either one from stdin. The guard
   * this makes reachable already existed -- "nothing to record: give a document to read (a path,
   * or - for standard input)", above -- and the bead that found this recorded that it "cannot fire
   * when stdin is piped". It could not: the fill assigned the piped document to `document`, and
   * the guard's first condition is `args.document === undefined`.
   *
   * The consequence was not only a wrong error. A document past `NAME_MAX` was echoed into stderr
   * **twice** -- measured at 2.164x the document, holding across 40,034 and 100,034 bytes -- and
   * `evidence_text` is exactly the field `ARCHITECTURE` routes through stdin.
   */
  const DOCUMENT = JSON.stringify({ properties: { chosen: 'piped' } });

  it('reaches the "nothing to record" guard when a document is piped with no operand', () => {
    const dir = project();
    const run = asc(['record', 'decision'], dir, DOCUMENT);

    expect(run.status).toBe(2);
    const message = flatten(run.stderr);
    expect(message).toContain('nothing to record');
    // A refusal is a dead end unless it names the spelling that works.
    expect(message).toContain('- for standard input');
    expect(stored(dir)).toEqual([]);
  });

  it('refuses a pipe where the TYPE is the missing operand', () => {
    // Before the fix this assigned the piped value to `type` and advised
    // `Run 'asc types show decision'` -- a runnable-looking command built from a value nobody
    // typed on the command line.
    const run = asc(['record'], project(), 'decision');

    expect(run.status).toBe(2);
    const message = flatten(run.stderr);
    expect(message).toContain('Missing 1 required arg');
    expect(message).not.toContain('types show');
  });

  it('still records the document when the operand says `-`', () => {
    const dir = project();
    const run = asc(
      ['record', 'decision', '-', '--json'],
      dir,
      JSON.stringify({ properties: { chosen: 'operand', rationale: 'one convention for stdin' } }),
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(stored(dir)[0]?.properties_json ?? '{}')).toEqual({
      chosen: 'operand',
      rationale: 'one convention for stdin',
    });
  });
});
