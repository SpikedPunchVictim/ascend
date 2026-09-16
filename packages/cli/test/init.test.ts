import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatten } from './helpers.js';

/**
 * `asc init`, driven as the real binary.
 *
 * The claims worth testing here are mostly about what was NOT done. `asc init` is the one command
 * that edits a file outside the store -- `.gitignore` -- and the one command that could plausibly
 * have been written to edit settings (it must not). So the assertions are about absence and
 * preservation: `--dry-run` creating nothing at all, an existing `.gitignore` keeping every line it
 * had, a `.gitignore` with no trailing newline not having the new entry glued onto its last rule.
 *
 * Every claim about the store is read back out of SQLite rather than inferred from the report, for
 * the reason `types.test.ts` states: a command that printed the right thing and wrote the wrong
 * thing would pass a test that only read stdout.
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
  const dir = mkdtempSync(join(tmpdir(), 'asc-init-'));
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

/**
 * A directory that looks like a repository but is not one.
 *
 * `.git` is created as a directory rather than by running `git init`, so the test does not depend
 * on git being installed or on a global config -- `init` only ever asks whether the path exists.
 */
function repo(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  return dir;
}

function gitignore(dir: string): string {
  return readFileSync(join(dir, '.gitignore'), 'utf8');
}

/**
 * Is there a `.git` at `dir` or anywhere above it?
 *
 * Used to state the precondition the "no repository" test rests on, rather than assuming it. The
 * command's walk for `.git` goes to the filesystem root (asc-bcv.10), so that test asserts the
 * ABSENCE of a repository above a temp directory -- true on any ordinary machine, since it would
 * require a `.git` at `/var` or `/private`, but a machine where it is false would make the test
 * assert the wrong outcome rather than catch a defect. Asserting it makes that visible.
 *
 * `dirname('/') === '/'` terminates the walk, the same case the command's own walk terminates on.
 */
function repositoryAbove(dir: string): boolean {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The directory as the PROCESS resolves it.
 *
 * On macOS `tmpdir()` is `/var/folders/...`, which is a symlink to `/private/var/folders/...`, and
 * the CLI resolves the path it prints. Comparing a printed path against `join(dir, '.ascend')`
 * therefore fails on two spellings of the same directory -- the same `/var` vs `/private/var`
 * distinction the store's `verifyPragmas` has to survive.
 */
function real(dir: string): string {
  return realpathSync(dir);
}

/**
 * Text reduced to just its characters, for asserting that a long token survived the wrapper.
 *
 * Built ON `flatten`, and the order is the whole point. oclif wraps at the terminal width and
 * breaks **inside a token** when there is no space to break at, inserting its `›` marker at the
 * break: a tmpdir path arrives as `...szvxz58d2r95y` / ` ›   793l9hvwj...`. So two distortions have
 * to go, in this order -- the `›` is only at a line start in the RAW text, so `flatten` has to
 * strip it before the newline that anchors it is collapsed away. Measured both ways: collapsing
 * whitespace first leaves `<tmpdir-id-pre›suffix>` (glyph still embedded), and collapsing without
 * stripping leaves `szvxz58d2r95y 793l9hvwj` (a phantom space that was never in the path).
 *
 * What remains is the characters themselves, which is exactly the claim being made: the path was
 * printed. Neither `›` nor a space can occur in a real path, so this cannot pass by accident.
 */
function squeeze(text: string): string {
  return flatten(text).replace(/\s+/g, '');
}

function envelope(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

/** The outcome `asc init` reported for one action and target. */
function outcomeOf(run: Run, action: string, target?: string): unknown {
  const row = envelope(run.stdout).find(
    (candidate) =>
      candidate['action'] === action &&
      (target === undefined || String(candidate['target']).endsWith(target)),
  );
  if (row === undefined) throw new Error(`no '${action}' row in:\n${run.stdout}`);
  return row['outcome'];
}

/** The registry, read from the store rather than from the command's report. */
function registry(dir: string): readonly { name: string; version: number; record_when: string }[] {
  const file = join(dir, '.ascend', 'ascend.db');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT name, version, record_when FROM entry_types ORDER BY name, version')
      .all() as unknown as { name: string; version: number; record_when: string }[];
  } finally {
    db.close();
  }
}

/** Every name a view is generated for, which is the other half of "the types were installed". */
function viewCount(dir: string): number {
  const file = join(dir, '.ascend', 'ascend.db');
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'view'`).get() as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
}

const STARTERS = ['decision', 'review_completed', 'stage_transition', 'stuck_event'];

describe('asc init', () => {
  it('creates the store, ignores it, and installs the four starter types', () => {
    const dir = repo();
    const run = asc(['init'], dir);

    expect(run.status).toBe(0);
    expect(gitignore(dir)).toBe('.ascend/\n');
    expect(registry(dir).map((row) => row.name)).toEqual(STARTERS);
    expect(registry(dir).every((row) => row.version === 1)).toBe(true);
    // Views, not just rows: a type row whose view failed to build is a type that cannot be
    // queried, and `registerType` would have rolled the row back -- so this checks the two agree.
    expect(viewCount(dir)).toBe(4);
  });

  it('reports every step as a row, so --json describes the same run as the table', () => {
    const dir = repo();
    const run = asc(['init', '--json'], dir);

    expect(outcomeOf(run, 'store')).toBe('created');
    expect(outcomeOf(run, 'gitignore')).toBe('created');
    expect(outcomeOf(run, 'type', 'review_completed')).toBe('created');
    expect(outcomeOf(run, 'hook')).toBe('offered, not installed');
    // The E4.2 contract lesson: a boolean built from a flag that was not passed is `undefined`,
    // and `JSON.stringify` drops the field -- so "not a dry run" would be indistinguishable from
    // "this command does not report dry runs".
    expect(envelope(run.stdout).every((row) => row['dry_run'] === false)).toBe(true);
  });

  it('NEVER writes settings, and says so rather than doing it', () => {
    // The architecture requirement is explicit: "ascend never silently edits a user's settings
    // file". Asserting the file is absent is the only form of that claim a test can make.
    const dir = repo();
    asc(['init'], dir);

    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
    // And the offer is on stderr, where advice belongs -- stdout carries data only.
    expect(flatten(asc(['init'], dir).stderr)).toContain('asc install-hook');
    expect(asc(['init'], dir).stdout).not.toContain('install-hook');
  });

  it('is idempotent: re-running changes nothing and says so', () => {
    const dir = repo();
    asc(['init'], dir);
    const before = registry(dir);

    const again = asc(['init', '--json'], dir);
    expect(again.status).toBe(0);
    expect(outcomeOf(again, 'store')).toBe('already present');
    expect(outcomeOf(again, 'gitignore')).toBe('already ignores it');
    expect(outcomeOf(again, 'type', 'decision')).toBe('unchanged');
    expect(registry(dir)).toEqual(before);

    // And it does NOT warn about being shadowed by itself. The shadow check looks at the PARENT
    // of the working directory; looking at the working directory instead would find the store
    // this very command is re-initialising and warn about it on every re-run -- a warning that
    // fires always is one nobody reads.
    expect(flatten(again.stderr)).not.toContain('shadowed');
  });

  it('reports prose-updated when a starter word changed, rather than dropping it as unchanged', () => {
    // The reason `init` registers through `registerDocument` instead of `registerType`: prose is
    // not identity, so an improved `record_when` in a later ascend must land in an existing project
    // rather than being silently discarded because the SHAPE was already known.
    const dir = repo();
    asc(['init'], dir);

    const file = join(dir, '.ascend', 'ascend.db');
    const db = new DatabaseSync(file);
    try {
      db.prepare(
        `UPDATE entry_types SET record_when = 'stale wording' WHERE name = 'decision'`,
      ).run();
    } finally {
      db.close();
    }

    const again = asc(['init', '--json'], dir);
    expect(outcomeOf(again, 'type', 'decision')).toBe('prose-updated');
    expect(registry(dir).find((row) => row.name === 'decision')?.record_when).not.toBe(
      'stale wording',
    );
  });

  it('writes NOTHING at all on --dry-run in a directory with no project', () => {
    const dir = repo();
    const run = asc(['init', '--dry-run', '--json'], dir);

    expect(run.status).toBe(0);
    // The report describes a completed run...
    expect(outcomeOf(run, 'store')).toBe('created');
    expect(outcomeOf(run, 'type', 'stuck_event')).toBe('created');
    expect(envelope(run.stdout).every((row) => row['dry_run'] === true)).toBe(true);
    // ...and the directory contains nothing but what was already there. Not ".ascend/ exists but
    // is empty" -- absent, because a dry run that created the directory would have created the
    // thing it was asked to preview.
    expect(existsSync(join(dir, '.ascend'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    expect(registry(dir)).toEqual([]);
  });

  it('previews against the real registry on --dry-run, and leaves it byte-identical', () => {
    const dir = repo();
    asc(['init'], dir);
    const before = registry(dir);

    const run = asc(['init', '--dry-run', '--json'], dir);
    // `unchanged` rather than `created`: the preview read the store it was asked about. A
    // preview that reported `created` for four existing types would be describing a run that
    // does not exist.
    expect(outcomeOf(run, 'type', 'review_completed')).toBe('unchanged');
    expect(outcomeOf(run, 'store')).toBe('already present');
    expect(registry(dir)).toEqual(before);
    expect(viewCount(dir)).toBe(4);
  });

  it('preserves an existing .gitignore, including a last line with no newline', () => {
    // The gluing failure: appending to a file whose final line has no terminator turns that
    // rule into part of the new entry, so an unrelated ignore pattern silently stops matching.
    const dir = repo();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log');

    const run = asc(['init', '--json'], dir);
    expect(outcomeOf(run, 'gitignore')).toBe('appended');
    expect(gitignore(dir)).toBe('node_modules/\n*.log\n.ascend/\n');
  });

  it('follows a symlinked .gitignore instead of replacing the link with a regular file', () => {
    // asc-bcv.11 (B7). The write is temp-file-then-rename, and renaming onto the LINK's own path
    // replaces the link. Measured before the fix (/tmp/probe-b7.mjs): `isSymbolicLink` went
    // true -> false, the content survived, and a second repository pointed at the same target no
    // longer saw the change -- the sharing was broken silently, and the target path is not
    // recoverable from the file afterwards.
    const outer = scratch();
    const shared = join(outer, 'shared', 'gitignore');
    mkdirSync(join(outer, 'shared'), { recursive: true });
    writeFileSync(shared, 'node_modules/\n');

    const dirs = [join(outer, 'alpha'), join(outer, 'beta')];
    for (const dir of dirs) {
      mkdirSync(join(dir, '.git'), { recursive: true });
      symlinkSync('../shared/gitignore', join(dir, '.gitignore'));
    }

    const run = asc(['init', '--json'], dirs[0] as string);

    expect(outcomeOf(run, 'gitignore')).toBe('appended');
    // The link survives, and still points at the same place -- asserted on the link itself rather
    // than on the content, because content is what survived even when the link was destroyed.
    expect(lstatSync(join(dirs[0] as string, '.gitignore')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dirs[0] as string, '.gitignore'))).toBe('../shared/gitignore');
    expect(readFileSync(shared, 'utf8')).toBe('node_modules/\n.ascend/\n');
    // And the sharing still WORKS: the sibling that shares the target sees the new entry. This is
    // the assertion the whole fix is for -- "the link is still a link" would pass for a link
    // repointed somewhere harmless.
    expect(readFileSync(join(dirs[1] as string, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.ascend/\n',
    );
    // The row names the file the user asked about, not the resolved target; the resolved target is
    // on stderr instead, because `target` is the column a caller joins on across runs. Compared
    // through `real()` because the command reports the directory as the PROCESS resolved it, which
    // on macOS is `/private/var/...` for a `join(tmpdir(), ...)` this test wrote as `/var/...`.
    expect(envelope(run.stdout).find((row) => row['action'] === 'gitignore')?.['target']).toBe(
      join(real(dirs[0] as string), '.gitignore'),
    );
    // `squeeze`, not `flatten`: oclif wraps at the terminal width and breaks MID-TOKEN, so the path
    // arrives with a space inside it (`asc-init -0DTHfR/alpha`). Measured on this assertion's first
    // run -- `flatten` fails against output that is correct.
    expect(squeeze(run.stderr)).toContain(real(shared));
  });

  it('leaves a DANGLING .gitignore symlink alone, which existsSync cannot tell from no file', () => {
    // The arm the bead did not name, found by asking what else `existsSync` gets wrong here
    // (/tmp/probe-b7.mjs). `existsSync` FOLLOWS a link, so a link to nothing answers "no file here",
    // takes the create branch, and is replaced by a regular file -- the same defect reached through
    // the branch that looks like it is creating something new.
    const dir = repo();
    symlinkSync('../nowhere/gitignore', join(dir, '.gitignore'));

    const run = asc(['init', '--json'], dir);

    expect(String(outcomeOf(run, 'gitignore'))).toContain('skipped');
    expect(lstatSync(join(dir, '.gitignore')).isSymbolicLink()).toBe(true);
    // Nothing was created at the link's target either, which is the other way this could have gone
    // wrong: repairing the link by inventing the file it points at is not this command's call.
    expect(existsSync(join(dirname(dir), 'nowhere', 'gitignore'))).toBe(false);
    // The store is still made, as in every other skipped-gitignore case.
    expect(registry(dir).map((row) => row.name)).toEqual(STARTERS);
  });

  it('recognises the store in every spelling git accepts, and does not mistake a re-include', () => {
    for (const entry of ['.ascend', '.ascend/', '/.ascend', '/.ascend/']) {
      const dir = repo();
      writeFileSync(join(dir, '.gitignore'), `${entry}\n`);
      expect(outcomeOf(asc(['init', '--json'], dir), 'gitignore'), entry).toBe(
        'already ignores it',
      );
    }

    // `!.ascend/` re-includes the path, so the store is NOT ignored and the entry is needed.
    // Treating it as a match would report success while leaving the database committable.
    const dir = repo();
    writeFileSync(join(dir, '.gitignore'), '!.ascend/\n');
    expect(outcomeOf(asc(['init', '--json'], dir), 'gitignore')).toBe('appended');
  });

  it('ignores the store from a repository subdirectory, where the repository is ABOVE it', () => {
    // asc-bcv.10 (B6). The command asked whether `.git` was in the working directory, so every
    // subdirectory of a repository looked like no repository at all and the store was left
    // untracked. Measured before the fix (/tmp/probe-b6.mjs): `asc init` in `packages/api` exited 0,
    // reported `skipped: ...no git repository to apply one to`, wrote no `.gitignore`, and
    // `git status --porcelain` showed `?? packages/` -- the whole subtree one `git add -A` from
    // being committed, with a database in it.
    const outer = repo();
    const dir = join(outer, 'packages', 'api');
    mkdirSync(dir, { recursive: true });

    const run = asc(['init', '--json'], dir);

    expect(outcomeOf(run, 'gitignore')).toBe('created');
    // NEXT TO THE STORE, not at the repository root. A scoped file says what it means without a
    // relative path computed from here to there, and this is the file the store's own directory is
    // read from. Asserted, because "wrote a .gitignore somewhere" would also pass for the root.
    expect(gitignore(dir)).toBe('.ascend/\n');
    expect(existsSync(join(outer, '.gitignore'))).toBe(false);
  });

  it('finds the repository through a `.git` FILE, which is what a worktree leaves', () => {
    // The second half of the same detection. In a linked worktree or a submodule `.git` is a file
    // holding `gitdir: ...`, so a walk that tested `isDirectory` would report "no repository" for
    // every worktree -- the same defect one layer down. Asserted on the content git actually
    // writes, so this is the shape being tested and not a stand-in for it.
    const outer = scratch();
    const dir = join(outer, 'packages', 'api');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(outer, '.git'), 'gitdir: /somewhere/.git/worktrees/api\n');

    const run = asc(['init', '--json'], dir);

    expect(outcomeOf(run, 'gitignore')).toBe('created');
    expect(gitignore(dir)).toBe('.ascend/\n');
  });

  it('leaves .gitignore alone when there is no repository to apply it to', () => {
    // A `.gitignore` in a directory git tracks nothing from is a file that does nothing, and
    // creating one is exactly the unrequested edit this command avoids.
    const dir = scratch();
    // Stated rather than assumed: the walk now reaches the filesystem root, so this assertion is
    // only about "no repository" while there is genuinely none above the temp directory.
    expect(repositoryAbove(dir)).toBe(false);

    const run = asc(['init', '--json'], dir);

    expect(String(outcomeOf(run, 'gitignore'))).toContain('skipped');
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    // The store is still created: not being a repository does not stop a project being one.
    expect(registry(dir).map((row) => row.name)).toEqual(STARTERS);
  });

  it('warns when an ancestor already has a store, because this one will shadow it', () => {
    const dir = repo();
    asc(['init'], dir);
    const nested = join(dir, 'packages', 'inner');
    mkdirSync(nested, { recursive: true });

    const run = asc(['init'], nested);
    expect(run.status).toBe(0);
    // Proceeding is deliberate -- more than one store in a tree is supported -- but it must be
    // said, because `openProject` walks up and would otherwise silently switch which store
    // answers for everything under the new one.
    expect(flatten(run.stderr)).toContain('shadowed');
    expect(squeeze(run.stderr)).toContain(squeeze(join(real(dir), '.ascend')));
    expect(registry(nested).map((row) => row.name)).toEqual(STARTERS);
  });

  it('makes the "no store found" refusal a real suggestion', () => {
    // `project.ts` has always told the caller to run `asc init`. Until this command existed that
    // was a forward reference, which is the shape of error message that teaches people the tool
    // is broken. This asserts the loop closes: the message is printed, and the command works.
    const dir = repo();

    const before = asc(['types', 'brief'], dir);
    expect(before.status).toBe(1);
    expect(before.stderr).toContain("Run 'asc init'");

    expect(asc(['init'], dir).status).toBe(0);
    const after = asc(['types', 'brief'], dir);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('review_completed');
  });

  it('installs types that export and re-import as unchanged, which is the round trip', () => {
    const dir = repo();
    asc(['init'], dir);

    // Not "the command exited 0" -- the documents a project exports must describe the definitions
    // it holds, so re-importing them reports no work rather than minting versions.
    const exported = asc(['types', 'export'], dir);
    expect(exported.status).toBe(0);
    const reimport = spawnSync('sh', ['-c', `printf '%s' "$DOC" | "$NODE" "$BIN" types import -`], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        XDG_CACHE_HOME: join(dir, '.cache'),
        BIN: bin,
        NODE: process.execPath,
        DOC: exported.stdout,
      },
    });
    expect(reimport.status).toBe(0);
    expect(reimport.stdout).not.toContain('created');
    expect(registry(dir).every((row) => row.version === 1)).toBe(true);
  });

  it('ships starter prose that reaches the reader, including the guidance a json property needs', () => {
    // `json` validates the container and says nothing about what goes inside it, so the ONLY place
    // the shape of a `findings` entry is written down is that property's description. It is stored
    // in the prose column rather than the spec, and `asc types show` used to drop it entirely.
    const dir = repo();
    asc(['init'], dir);

    // Read through `--json`, not the table: a table cell is elided at 60 characters and marked
    // with `…`, so the table shows the START of this guidance and the assertion would be testing
    // the elision rather than the prose. `output.ts` says the untruncated copy is in `--json`.
    const descriptionOf = (name: string, property: string): string => {
      const rows = envelope(asc(['types', 'show', '--json', name], dir).stdout);
      const row = rows.find((candidate) => candidate['field'] === `property.${property}`);
      return String(row?.['description']);
    };

    expect(descriptionOf('review_completed', 'findings')).toContain(
      'An EMPTY array is a real measurement',
    );
    expect(descriptionOf('stuck_event', 'resolution')).toContain('Leave `resolution` out ENTIRELY');
    // The other list-shaped property, so a later edit cannot fix one and drop the other.
    expect(descriptionOf('decision', 'options_considered')).toContain(
      'An EMPTY array is a real measurement',
    );
  });

  it('keeps the brief small, because it is a context tax on every session', () => {
    // ARCHITECTURE.md's benchmark: `bd prime` costs ~4.9 KB (~1.2k tokens) per session, and the
    // recall hook runs this digest on every single one. The budget is asserted rather than eyeballed
    // so a later starter cannot quietly double it.
    const dir = repo();
    asc(['init'], dir);

    const brief = asc(['types', 'brief'], dir);
    expect(brief.stdout.split('\n').filter((line) => line.trim() !== '')).toHaveLength(4);
    expect(brief.stdout.length).toBeLessThan(2500);
  });
});
