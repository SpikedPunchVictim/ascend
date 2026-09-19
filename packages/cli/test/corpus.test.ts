import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc export` and `asc import`, driven as the real binary against real stores.
 *
 * `asc-brt`. The store is per-project and gitignored, so this pair is the only thing that carries a
 * corpus out of a working copy -- which makes it the command where "reports success wrongly" costs
 * the most. A restore that silently drops the entries, or that re-records them with fresh ids and
 * timestamps while reporting `restored`, is a backup that was never a backup, discovered at the
 * moment it is needed.
 *
 * **Every claim about what was written is read back out of SQLite**, not inferred from the report,
 * for the reason `types.test.ts` states and a sharper one: the report and the store are two
 * different things here, and the report is the one that would still look right. The assertions
 * compare whole rows -- all eighteen columns -- rather than the handful a hand-written check would
 * think to name.
 *
 * **The flagship test is an `sh` pipeline, not `spawnSync({input})`.** `types.test.ts` records why
 * for `types import`: `input` writes the whole document before the child starts, so the child never
 * sees an empty pipe, and an empty pipe at read time is exactly what broke the documented pipeline
 * there. The same form is offered by `asc export --help`, so the same form is what gets tested.
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
  const dir = mkdtempSync(join(tmpdir(), 'asc-corpus-'));
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

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: env(cwd),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run a real `sh` pipeline, with `BIN`, `NODE`, `SRC` and `DST` in the environment.
 *
 * The two commands are started by the shell at the same time and the producer's output reaches the
 * consumer through a pipe, which is the only way the consumer can meet the empty-pipe condition.
 */
function shell(script: string, projects: { readonly src: string; readonly dst: string }): Run {
  const result = spawnSync('sh', ['-c', script], {
    cwd: projects.dst,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: projects.dst,
      XDG_CACHE_HOME: join(projects.dst, '.cache'),
      BIN: bin,
      NODE: process.execPath,
      SRC: projects.src,
      DST: projects.dst,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * stderr with its wrapping undone, so a substring assertion means what it reads like.
 *
 * No `›` gutter is stripped: ascend renders its own failures and warnings (`errors.ts`), so
 * stderr carries none -- and an assertion here is what fails if one comes back.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A project with the starter types installed: a directory that looks like a repository, plus `init`.
 *
 * `.git` is a plain directory rather than `git init`, so the suite does not depend on git being
 * installed -- `init` only ever asks whether the path exists.
 */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);
  return dir;
}

/** A store directory with nothing registered in it at all. */
function bare(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.ascend'));
  return dir;
}

function envelope(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

/** A JSONL stream as objects, with the blank lines an appended export leaves behind dropped. */
function lines(text: string): readonly Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A row of `entry_types`, as this suite reads it back. */
interface RegistryRow {
  readonly name: string;
  readonly version: number;
  readonly major: number;
  readonly type_hash: string;
  readonly status: string;
}

/** A row of `annotation_schemes`, as this suite reads it back. */
interface SchemeRow {
  readonly name: string;
  readonly version: number;
  readonly created_at: string;
  readonly spec_json: string;
}

/** A row of `annotations`, as this suite reads it back -- every column `recordAnnotations` writes. */
interface StoredAnnotation {
  readonly id: string;
  readonly entry_id: string;
  readonly scheme: string;
  readonly scheme_version: number;
  readonly label: string;
  readonly value_json: string | null;
  readonly confidence: number | null;
  readonly note: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

/** One `(scheme, scheme_version, created_at, created_by)` pass, with its row count. */
interface PassGroup {
  readonly scheme: string;
  readonly scheme_version: number;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly n: number;
}

interface StoredEntry {
  readonly id: string;
  readonly type_name: string;
  readonly type_version: number;
  readonly type_hash: string;
  readonly recorded_at: string;
  readonly run_id: string | null;
  readonly workflow: string | null;
  readonly actor: string | null;
  readonly source: string;
  readonly cwd: string | null;
  readonly repo: string | null;
  readonly git_sha: string | null;
  readonly branch: string | null;
  readonly properties_json: string;
  readonly na_json: string;
  readonly evidence_text: string | null;
  readonly ascend_version: string;
  readonly schema_version: number;
}

/** Open the store read-only, or hand back `undefined` when there is no store file to open. */
function open(dir: string): DatabaseSync | undefined {
  const file = join(dir, '.ascend', 'ascend.db');
  if (!existsSync(file)) return undefined;
  return new DatabaseSync(file, { readOnly: true });
}

/**
 * Every registered version, read straight out of the store.
 *
 * `registered_at` is deliberately not selected: it is the one column a restore cannot reproduce --
 * `registerType` takes it from the caller, so it becomes the moment of the import. Selecting it
 * would make this helper assert something the product does not promise, and the promise it would
 * silently weaken is the one about everything else.
 */
function registry(dir: string): readonly RegistryRow[] {
  const db = open(dir);
  if (db === undefined) return [];
  try {
    return db
      .prepare(
        'SELECT name, version, major, type_hash, status FROM entry_types ORDER BY name, version',
      )
      .all() as unknown as RegistryRow[];
  } finally {
    db.close();
  }
}

/** Every entry, every column, read straight out of the store. */
function entries(dir: string): readonly StoredEntry[] {
  const db = open(dir);
  if (db === undefined) return [];
  try {
    return db
      .prepare(
        `SELECT id, type_name, type_version, type_hash, recorded_at, run_id, workflow, actor,
                source, cwd, repo, git_sha, branch, properties_json, na_json, evidence_text,
                ascend_version, schema_version
           FROM entries ORDER BY recorded_at, id`,
      )
      .all() as unknown as StoredEntry[];
  } finally {
    db.close();
  }
}

/** Every registered scheme version, read straight out of the store. */
function schemeRows(dir: string): readonly SchemeRow[] {
  const db = open(dir);
  if (db === undefined) return [];
  try {
    return db
      .prepare(
        'SELECT name, version, created_at, spec_json FROM annotation_schemes ORDER BY name, version',
      )
      .all() as unknown as SchemeRow[];
  } finally {
    db.close();
  }
}

/** Every annotation, every column, read straight out of the store. */
function annotationsOf(dir: string): readonly StoredAnnotation[] {
  const db = open(dir);
  if (db === undefined) return [];
  try {
    return db
      .prepare(
        `SELECT id, entry_id, scheme, scheme_version, label, value_json, confidence, note,
                created_by, created_at
           FROM annotations ORDER BY scheme, scheme_version, created_at, id`,
      )
      .all() as unknown as StoredAnnotation[];
  } finally {
    db.close();
  }
}

/**
 * The distinct `(scheme, scheme_version, created_at, created_by)` passes, with each one's row
 * count -- the shape a restore that collapsed every pass into one would get visibly wrong, and the
 * shape a row count alone cannot see wrong. See the round-trip test below.
 */
function passGroups(dir: string): readonly PassGroup[] {
  const db = open(dir);
  if (db === undefined) return [];
  try {
    return db
      .prepare(
        `SELECT scheme, scheme_version, created_at, created_by, count(*) AS n
           FROM annotations
          GROUP BY scheme, scheme_version, created_at, created_by
          ORDER BY scheme, scheme_version, created_at, created_by`,
      )
      .all() as unknown as PassGroup[];
  } finally {
    db.close();
  }
}

/**
 * Two passes of one scheme, over two of the entries `corpus()` just recorded.
 *
 * This is the shape `asc-6u5` needs a fixture to have: the same scheme at the same version, but a
 * different `created_at` AND a different `created_by`, so the pass-identity assertion in the
 * round-trip test below is not vacuous -- a restore that stamped every annotation with the
 * import's own clock and collapsed both passes into one would still pass a single-pass fixture.
 *
 * Both calls assign the SAME label (`looks_good`) to a DIFFERENT entry, so the scheme's vocabulary
 * never changes between them: the second registration reports `unchanged` and both passes land
 * under version 1, which is what makes this two passes of ONE scheme version rather than two
 * different schemes.
 */
function annotateTwice(dir: string): void {
  const recorded = entries(dir);
  const first = recorded[0];
  const second = recorded[1];
  expect(first).toBeDefined();
  expect(second).toBeDefined();

  expect(
    asc(
      [
        'annotate',
        '--scheme',
        'reviewed',
        '--ids',
        `looks_good=${String(first?.id)}`,
        '--actor',
        'rater-a',
      ],
      dir,
    ).status,
  ).toBe(0);
  expect(
    asc(
      [
        'annotate',
        '--scheme',
        'reviewed',
        '--ids',
        `looks_good=${String(second?.id)}`,
        '--actor',
        'rater-b',
      ],
      dir,
    ).status,
  ).toBe(0);
}

/**
 * A corpus small enough to read, varied enough that a lost column shows up as a diff.
 *
 * Three entries chosen for the columns they force into play: a `--evidence` text, a `false` (which
 * is a measurement and not a hole), and an `--na` list (which lives in its own column because the
 * store keeps four states and not three). A corpus of three identical `measured` rows would let a
 * restore drop the whole not-applicable column and still compare equal. `annotateTwice` adds one
 * scheme and two passes of it, for the same reason applied to `asc-6u5`'s half of the corpus.
 */
function corpus(dir: string): void {
  expect(
    asc(
      [
        'record',
        'stage_transition',
        '--prop=stage=Stage 2: the store',
        '--prop=from_status=in_progress',
        '--prop=to_status=complete',
        '--prop=tests_passing=false',
        '--evidence=the gate was green except for two driver tests',
      ],
      dir,
    ).status,
  ).toBe(0);
  expect(
    asc(
      [
        'record',
        'stage_transition',
        '--prop=stage=Stage 3: the CLI',
        '--prop=from_status=complete',
        '--prop=to_status=in_progress',
        '--na=tests_passing',
      ],
      dir,
    ).status,
  ).toBe(0);
  expect(
    asc(
      [
        'record',
        'decision',
        '--prop=chosen=JSONL',
        '--prop=rationale=a truncated array parses to nothing; a truncated line stream reads up to the damage',
        '--na=options_considered',
      ],
      dir,
    ).status,
  ).toBe(0);
  annotateTwice(dir);
}

/** Write a stream into `dir` and return its path. */
function stream(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/**
 * Record one `decision`, asserted rather than assumed.
 *
 * The status check is not ceremony: `decision` has no `summary` property, and a recording that is
 * refused for naming one returns exit 1 and writes nothing -- which would leave every test below
 * passing its own assertions against an empty corpus. `decision`'s two required properties are
 * `chosen` and `rationale`.
 */
function recordDecision(dir: string, chosen: string): void {
  const run = asc(
    ['record', 'decision', `--prop=chosen=${chosen}`, `--prop=rationale=because ${chosen}`],
    dir,
  );
  expect(run.status).toBe(0);
}

describe('asc export', () => {
  it('writes every kind in the order the foreign keys require: type, entry, scheme, annotation', () => {
    const dir = project();
    corpus(dir);

    const run = asc(['export'], dir);
    expect(run.status).toBe(0);

    const rows = lines(run.stdout);
    const kinds = rows.map((row) => row['kind']);
    // The order is a foreign-key contract, not a preference (`corpus.ts`): `annotations` carries
    // `FOREIGN KEY (entry_id) REFERENCES entries` and `FOREIGN KEY (scheme, scheme_version)
    // REFERENCES annotation_schemes`, so `import` has to meet both before an annotation line, and
    // an entry before it has to meet its type. `type`, `entry`, `scheme`, `annotation` is the one
    // order that satisfies all of that at once.
    const typeCount = kinds.filter((kind) => kind === 'type').length;
    const entryCount = kinds.filter((kind) => kind === 'entry').length;
    const schemeCount = kinds.filter((kind) => kind === 'scheme').length;
    const annotationCount = kinds.filter((kind) => kind === 'annotation').length;
    expect(typeCount).toBeGreaterThan(0);
    expect(entryCount).toBe(3);
    // One scheme (`reviewed`), and `annotateTwice` writes one annotation per pass.
    expect(schemeCount).toBe(1);
    expect(annotationCount).toBe(2);
    expect(kinds).toEqual([
      ...Array<string>(typeCount).fill('type'),
      ...Array<string>(entryCount).fill('entry'),
      ...Array<string>(schemeCount).fill('scheme'),
      ...Array<string>(annotationCount).fill('annotation'),
    ]);

    // A POSIX text file: `wc -l` counts the lines rather than reporting one short.
    expect(run.stdout.endsWith('\n')).toBe(true);
  });

  it('writes one newline per line and no blank one at the end', () => {
    const dir = project();
    corpus(dir);
    const run = asc(['export'], dir);
    const rows = lines(run.stdout);

    // Exactly `rows.length` terminators, so the file has no trailing blank line. It had one --
    // `serializeCorpus` wrote its own terminator and `this.log` added another, so `wc -l` on a
    // 42-line corpus said 43. Nothing else in this suite caught it, and the reason is worth
    // recording: the byte-identical round-trip comparison cannot see it, because both sides of the
    // trip run the same writer, and `parseCorpus` skips blank lines so the restore is unaffected.
    // A blank line in a JSONL file is also the exact thing `serializeCorpus` documents itself as
    // refusing to write -- "a JSON parse error waiting for whoever reads it next" -- so the file it
    // produced contradicted the rule it states.
    expect(run.stdout.split('\n')).toHaveLength(rows.length + 1);
    expect(run.stdout.endsWith('\n\n')).toBe(false);
  });

  it('is byte-stable, so a diff of two exports means something', () => {
    const dir = project();
    corpus(dir);

    // Two reads of one store. Fixed key order is what makes this hold, and it is what lets the
    // round-trip test below compare bytes at all.
    expect(asc(['export'], dir).stdout).toBe(asc(['export'], dir).stdout);
  });

  it('writes zero bytes for a store with nothing in it, and says so through --json', () => {
    const dir = bare();

    const run = asc(['export'], dir);
    expect(run.status).toBe(0);
    // Not a blank line: a corpus is read line by line, and a blank line is a JSON parse error
    // waiting for whoever reads it next.
    expect(run.stdout).toBe('');

    const json = asc(['export', '--json'], dir);
    expect(json.status).toBe(0);
    // The envelope is what tells a script that this is an empty corpus rather than a truncated
    // answer -- the same argument `types export` makes for its own.
    expect(JSON.parse(json.stdout)).toMatchObject({ row_count: 0 });
    expect(envelope(json.stdout)).toEqual([]);
  });

  it('refuses --csv, and points at the command that does print columns', () => {
    const dir = project();

    const run = asc(['export', '--csv'], dir);
    // A usage error: the command line was fine and the flag is real, but no single header row
    // describes a stream of two different shapes.
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('asc query --csv');

    // Hidden as well as refused -- `asc-3u2` item (d). A flag that appears in help is a flag
    // callers will use, and the refusal is a worse teacher than the help is.
    expect(asc(['export', '--help'], dir).stdout).not.toContain('--csv');
  });

  it('offers the pipeline it supports in its own help', () => {
    const run = asc(['export', '--help'], project());
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('USAGE');
    expect(run.stdout).toContain('import -');
  });
});

describe('asc export | asc import', () => {
  it('round-trips a whole corpus through a real pipeline, byte for byte', () => {
    const source = project();
    const target = project();
    corpus(source);

    const run = shell(
      `( cd "$SRC" && HOME="$SRC" "$NODE" "$BIN" export ) | ` +
        `( cd "$DST" && HOME="$DST" "$NODE" "$BIN" import - )`,
      { src: source, dst: target },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');

    // The rows, not the shapes: names, versions, majors and hashes. A latest-only export would
    // reproduce every type's *current* shape and lose version 1, which is the definition any entry
    // recorded under it attaches to.
    expect(registry(target)).toEqual(registry(source));

    // All eighteen columns of every entry, compared as whole rows. This is the promise `--dry-run`
    // and the report cannot show: the id is the file's id and not a fresh one, `recorded_at` is the
    // moment the entry was recorded rather than the moment it was restored, and the not-applicable
    // list, the provenance and the build that wrote the row all came across.
    expect(entries(target)).toEqual(entries(source));
    expect(entries(target)).toHaveLength(3);

    // `asc-tlc`: `cwd` is one of those eighteen columns, and the equality above already proves it
    // round-trips -- but it proves it BLINDLY, the same way it would if both sides carried the old
    // absolute path. This names what the value actually is: `corpus()` records every entry from
    // `dir` itself, the project root, so `record.ts` writes `'.'`, never `''` and never an absolute
    // path -- and the round trip through `export | import` must carry that literal `'.'` across
    // unchanged, the same as every other column.
    for (const entry of entries(source)) expect(entry.cwd).toBe('.');
    for (const entry of entries(target)) expect(entry.cwd).toBe('.');

    // Every scheme version, compared as whole rows -- the same argument as the entry columns
    // above, applied to the definition side of an annotation.
    expect(schemeRows(target)).toEqual(schemeRows(source));
    expect(schemeRows(source)).toHaveLength(1);

    // Every annotation column, compared as whole rows -- `id`, `entry_id`, `scheme`,
    // `scheme_version`, `label`, `value`, `confidence`, `note`, `created_by`, `created_at`, all of
    // them, because a count match is exactly what the defect this bead fixes could still pass.
    expect(annotationsOf(target)).toEqual(annotationsOf(source));
    expect(annotationsOf(source)).toHaveLength(2);

    // The assertion the collapsed-pass defect cannot pass: `annotateTwice` records the SAME scheme
    // at the SAME version twice, under two different `(created_at, created_by)` pairs, so a
    // restore that grouped by anything less than all four keys -- or restored row by row under the
    // import clock -- would merge the two passes into one. Two distinct groups of one row each,
    // both surviving the round trip unchanged, is the only outcome that proves each pass came back
    // as its own pass rather than as loose rows that happened to add up.
    const sourcePasses = passGroups(source);
    expect(sourcePasses).toHaveLength(2);
    for (const group of sourcePasses) expect(group.n).toBe(1);
    expect(passGroups(target)).toEqual(sourcePasses);

    // And the strongest statement available: the restored project exports the same bytes. If any
    // column had been dropped, re-derived or re-ordered, this is where it shows.
    expect(asc(['export'], target).stdout).toBe(asc(['export'], source).stdout);
  });

  it('refuses a second restore, naming the ids it already holds and writing nothing', () => {
    const source = project();
    const target = project();
    corpus(source);
    const file = stream(source, 'corpus.jsonl', asc(['export'], source).stdout);

    expect(asc(['import', file], target).status).toBe(0);
    const before = { registry: registry(target), entries: entries(target) };

    const again = asc(['import', file], target);
    expect(again.status).toBe(1);
    const message = flatten(again.stderr);
    expect(message).toContain('3 of 3 entry id(s) this project already has');
    // The remedy for the accident that actually happens -- someone re-runs the restore -- is to
    // know nothing is wrong, so the message says the rows are the ones from the file.
    expect(message).toContain('nothing to do');
    expect(registry(target)).toEqual(before.registry);
    expect(entries(target)).toEqual(before.entries);
  });

  it('restores an entry under the id and the timestamp it was recorded with', () => {
    const source = project();
    const target = project();
    recordDecision(source, 'keep the id');
    const original = entries(source)[0];
    expect(original).toBeDefined();

    const file = stream(source, 'corpus.jsonl', asc(['export'], source).stdout);
    expect(asc(['import', file], target).status).toBe(0);

    // The whole row, one line, rather than the two fields this test is named for: a restore that
    // re-recorded the entry would produce a fresh id AND a fresh timestamp, and the equality of one
    // field alone would still hold if the clock had not moved between the two commands.
    expect(entries(target)).toEqual(entries(source));

    const restored = entries(target)[0];
    expect(restored?.id).toBe(original?.id);
    expect(restored?.recorded_at).toBe(original?.recorded_at);
  });
});

describe('asc import', () => {
  it('names the line an entry is on, not its position among the entries', () => {
    const source = project();
    recordDecision(source, 'line numbers matter');

    // The entry is the LAST line: after every definition. Numbering it by its index in the list of
    // entries -- which is what this did -- reports it as `line 1`, and line 1 is a type definition.
    const exported = lines(asc(['export'], source).stdout);
    const entryAt = exported.findIndex((row) => row['kind'] === 'entry');
    expect(entryAt).toBeGreaterThan(0);
    const tampered = exported.map((row, index) =>
      index === entryAt ? { ...row, type_version: 9 } : row,
    );

    const target = bare();
    const file = stream(
      target,
      'tampered.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const run = asc(['import', file], target);

    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain(`line ${String(entryAt + 1)}`);
    expect(message).not.toContain('line 1)');
  });

  it('tells a divergent target apart from a tampered file, because the repairs differ', () => {
    // Two projects that independently invented the same type name with different shapes -- which is
    // the case that produced the wrong message: the first draft blamed the caller's file and told
    // them to re-export it, when the file was the one thing that was not broken.
    const source = project();
    asc(
      [
        'types',
        'define',
        stream(
          source,
          'a.json',
          '{"name":"probe_kind","properties":[{"name":"a","type":"string"}]}',
        ),
      ],
      source,
    );
    asc(['record', 'probe_kind', '--prop=a=hello'], source);
    const file = stream(source, 'corpus.jsonl', asc(['export'], source).stdout);

    const divergent = project();
    asc(
      [
        'types',
        'define',
        stream(
          divergent,
          'b.json',
          '{"name":"probe_kind","properties":[{"name":"b","type":"number"}]}',
        ),
      ],
      divergent,
    );

    const run = asc(['import', file], divergent);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('already held its own probe_kind');
    expect(message).toContain('Restore this corpus into a project that does not already hold');
    // The wrong instruction, asserted absent: this is the assertion that fails if the two cases
    // are ever routed back through one message.
    expect(message).not.toContain('Re-export the corpus');
    expect(entries(divergent)).toEqual([]);
  });

  it('refuses a file that disagrees with the definitions it carries', () => {
    const source = project();
    recordDecision(source, 'tampered');

    const exported = lines(asc(['export'], source).stdout);
    const tampered = exported.map((row) =>
      row['kind'] === 'entry' ? { ...row, type_version: 9 } : row,
    );

    // A target with none of these names, so the numbering came from the stream and the entry is
    // the one that disagrees with it.
    const target = bare();
    const file = stream(
      target,
      'tampered.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('this project held no decision before the restore');
    expect(message).toContain('Re-export the corpus');
    expect(entries(target)).toEqual([]);
  });

  it('refuses a type line whose type_hash is not its own hash', () => {
    const source = project();
    recordDecision(source, 'hash check');

    const exported = lines(asc(['export'], source).stdout);
    const tampered = exported.map((row, index) =>
      index === 0 ? { ...row, type_hash: 'f'.repeat(64) } : row,
    );

    const target = bare();
    const file = stream(
      target,
      'tampered.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('claims type_hash');
    // Both hashes, because the useful question is which two definitions are being confused.
    expect(message).toContain('ffffffff');
    expect(registry(target)).toEqual([]);
  });

  it('refuses a type line with no type_hash at all', () => {
    const source = project();
    recordDecision(source, 'no hash');

    const exported = lines(asc(['export'], source).stdout);
    // A copy with the key deleted rather than a destructuring rest: the discarded binding is an
    // unused variable under this repo's lint config, which exempts no prefix.
    const stripped = exported.map((row) => {
      if (row['kind'] !== 'type') return row;
      const copy = { ...row };
      delete copy['type_hash'];
      return copy;
    });

    const target = bare();
    const file = stream(
      target,
      'nohash.jsonl',
      `${stripped.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const run = asc(['import', file], target);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('no type_hash');
    expect(registry(target)).toEqual([]);
  });

  it('refuses a scheme line whose scheme_hash is not its own hash', () => {
    const source = project();
    corpus(source);

    const exported = lines(asc(['export'], source).stdout);
    const tampered = exported.map((row) =>
      row['kind'] === 'scheme' ? { ...row, scheme_hash: 'f'.repeat(64) } : row,
    );

    const target = bare();
    const file = stream(
      target,
      'tampered.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    // Mirrors `type_hash`'s own refusal (`verifyTypeLine`, above): `verifySchemeLine` checks the
    // carried hash rather than trusting it, for the identical reason.
    expect(message).toContain('claims scheme_hash');
    expect(message).toContain('ffffffff');
    expect(registry(target)).toEqual([]);
    expect(schemeRows(target)).toEqual([]);
  });

  it('refuses an annotation naming an entry that is in neither the stream nor the project', () => {
    const source = project();
    corpus(source);

    const exported = lines(asc(['export'], source).stdout);
    let tamperedId: string | undefined;
    const tampered = exported.map((row) => {
      if (row['kind'] !== 'annotation' || tamperedId !== undefined) return row;
      tamperedId = 'entry-does-not-exist';
      return { ...row, entry_id: tamperedId };
    });
    expect(tamperedId).toBeDefined();

    const target = bare();
    const file = stream(
      target,
      'tampered.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('neither in this stream nor in this project');
    expect(message).toContain(tamperedId);
    // Checked before the transaction opens (`refuseUnknownAnnotationEntries`), so not one row of
    // the file -- types, entries, schemes, or the other annotation -- made it in either.
    expect(registry(target)).toEqual([]);
    expect(entries(target)).toEqual([]);
    expect(schemeRows(target)).toEqual([]);
    expect(annotationsOf(target)).toEqual([]);
  });

  it('refuses an annotation id the target already holds, leaving everything else untouched', () => {
    const first = project();
    corpus(first);
    const target = project();
    expect(
      asc(['import', stream(first, 'first.jsonl', asc(['export'], first).stdout)], target).status,
    ).toBe(0);
    const before = {
      registry: registry(target),
      entries: entries(target),
      schemes: schemeRows(target),
      annotations: annotationsOf(target),
    };
    const takenId = before.annotations[0]?.id;
    expect(takenId).toBeDefined();

    // A second, independent project -- its own entries, so their ids cannot collide with the
    // first's -- whose only shared feature is the same scheme name and shape (`annotateTwice`
    // always writes the identical `reviewed` spec), so `registerScheme` reports it `unchanged`
    // rather than colliding. That isolates this refusal to the annotation id path: nothing about
    // entries or schemes is in conflict here, only the id spliced onto one annotation line below.
    const second = project();
    corpus(second);
    const exported = lines(asc(['export'], second).stdout);
    let collided = false;
    const tampered = exported.map((row) => {
      if (row['kind'] !== 'annotation' || collided) return row;
      collided = true;
      return { ...row, id: takenId };
    });
    expect(collided).toBe(true);

    const file = stream(
      target,
      'second.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('1 of 2 annotation id(s) this project already has');

    expect(registry(target)).toEqual(before.registry);
    expect(entries(target)).toEqual(before.entries);
    expect(schemeRows(target)).toEqual(before.schemes);
    expect(annotationsOf(target)).toEqual(before.annotations);
  });

  it('refuses entries with no definitions, before the store is even opened', () => {
    const source = project();
    recordDecision(source, 'half a corpus');

    const onlyEntries = lines(asc(['export'], source).stdout).filter(
      (row) => row['kind'] === 'entry',
    );
    const target = bare();
    const file = stream(
      target,
      'entries.jsonl',
      `${onlyEntries.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('1 entry line(s) and no type definitions');
    // Refused before the store is opened, so there is no store file at all -- the strongest
    // available form of "nothing was written".
    expect(existsSync(join(target, '.ascend', 'ascend.db'))).toBe(false);
  });

  it('refuses a stream with no corpus lines, which is what an empty export writes', () => {
    const target = bare();
    const file = stream(target, 'empty.jsonl', '');

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    // The pair matters: `asc export` writes zero bytes for an empty store, so this refusal is the
    // thing that turns "restored nothing" from a silent success into a sentence.
    expect(flatten(run.stderr)).toContain('holds no corpus lines');
    expect(existsSync(join(target, '.ascend', 'ascend.db'))).toBe(false);
  });

  it('refuses a line that is not JSON, and names the line', () => {
    const target = bare();
    const file = stream(
      target,
      'bad.jsonl',
      '{"kind":"type","name":"x","properties":[]}\nnot json\n',
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    const message = flatten(run.stderr);
    expect(message).toContain('line 2');
    expect(message).toContain('not valid JSON');
  });

  it('counts blank lines when it names a line, because the caller’s editor does', () => {
    const target = bare();
    // A blank line first -- what a caller who pasted a stream under a heading has -- then a valid
    // definition, then the line that fails. Counting only the lines that were parsed would report
    // this as line 2, and line 2 is a definition that parses perfectly well: the caller would go
    // to a line with nothing wrong with it. This survived the first mutation round, which is the
    // only reason it is written down.
    const file = stream(
      target,
      'blank-first.jsonl',
      '\n{"kind":"type","name":"x","properties":[]}\nnot json\n',
    );

    const run = asc(['import', file], target);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('line 3');
  });

  it('refuses a field it does not recognise, rather than dropping it in silence', () => {
    const source = project();
    recordDecision(source, 'unknown field');

    const exported = lines(asc(['export'], source).stdout);
    const tampered = exported.map((row) => (row['kind'] === 'entry' ? { ...row, oops: 1 } : row));

    const target = bare();
    const file = stream(
      target,
      'oops.jsonl',
      `${tampered.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const run = asc(['import', file], target);

    expect(run.status).toBe(1);
    // A misspelt field that were ignored would restore a corpus missing whatever it meant.
    expect(flatten(run.stderr)).toContain("no such field 'oops'");
  });

  it('skips blank lines, so two exports can be concatenated', () => {
    const source = project();
    recordDecision(source, 'blank lines');

    const text = asc(['export'], source).stdout;
    // A blank line between the definitions and the entries, and the trailing newline the stream
    // already carries. Both are blank lines a real file has: an appended export puts one between
    // the halves, and every text file ends with one.
    const rows = lines(text);
    const typeCount = rows.filter((row) => row['kind'] === 'type').length;
    const spliced = `${rows
      .slice(0, typeCount)
      .map((r) => JSON.stringify(r))
      .join('\n')}\n\n${rows
      .slice(typeCount)
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`;

    const target = project();
    const file = stream(target, 'spliced.jsonl', spliced);
    expect(asc(['import', file], target).status).toBe(0);

    // The definitions restored, one entry restored, and the blank line did not become a phantom.
    expect(entries(target)).toEqual(entries(source));
  });

  it('previews the whole restore with --dry-run and writes nothing', () => {
    const source = project();
    const target = project();
    corpus(source);
    const file = stream(source, 'corpus.jsonl', asc(['export'], source).stdout);
    const exported = lines(asc(['export'], source).stdout);
    const before = registry(target);

    // `--json`, because `import`'s DEFAULT output is the table of what happened -- the report is
    // the point of this command, where for `export` the stream is. The envelope is also the only
    // form in which a row count can be asserted as a number rather than counted out of a grid.
    const run = asc(['import', '--dry-run', '--json', file], target);
    expect(run.status).toBe(0);
    expect(flatten(run.stderr)).toContain('dry run: nothing was written');

    // The report covers the whole stream, and it is emitted after the rollback rather than inside
    // it -- a report that was rolled back with the restore would describe a corpus that does not
    // exist.
    const reported = envelope(run.stdout);
    expect(reported).toHaveLength(exported.length);
    // Three entries restored, plus one row per annotation PASS rather than per annotation line --
    // `annotateTwice` writes two passes of one row each, so the count happens to match the raw
    // line count here, but the grain is passes: a pass of many rows would still be one row.
    expect(reported.filter((row) => row['outcome'] === 'restored')).toHaveLength(5);

    // Read back, all four halves: the registry, the entries, the schemes and the annotations. A
    // rollback that left a row behind is a rollback that only looks like one, and a preview that
    // registered the definitions anyway would still print this exact report. `before` is this
    // project's own registry, captured before the preview -- so this also catches a rollback that
    // undid the restore and left the definitions.
    expect(registry(target)).toEqual(before);
    expect(entries(target)).toEqual([]);
    expect(schemeRows(target)).toEqual([]);
    expect(annotationsOf(target)).toEqual([]);
  });

  it('refuses --csv too, for the reason the pair shares', () => {
    const run = asc(['import', '--csv', 'x.jsonl'], project());
    // `import` has no `--csv` at all, so oclif rejects the flag itself: a usage error, not a
    // refusal. Different exit code from `export --csv` above, and deliberately so.
    expect(run.status).toBe(2);
  });

  it('offers the pipeline it supports in its own help', () => {
    const run = asc(['import', '--help'], project());
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('USAGE');
    expect(run.stdout).toContain('--dry-run');
  });
});
