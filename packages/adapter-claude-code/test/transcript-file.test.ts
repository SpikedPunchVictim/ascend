import { describe, expect, it } from 'vitest';
import { classifyTranscript, projectRelativeCwd } from '../src/index.js';

/**
 * This module makes the adapter's only claim about the corpus's STRUCTURE, and
 * that claim was wrong in its first draft.
 *
 * The tempting derivation is `basename(dirname(path))`. Measured on the real
 * corpus (2026-09-15, 843 files), 792 of those files live at
 * `<project>/<session-uuid>/subagents/agent-<id>.jsonl`, so that derivation
 * returns `subagents` for 94% of the corpus -- every record filed under one
 * project named after a directory, and nothing would have said so. The tests
 * below are written against paths copied from the real corpus so that the
 * regression is pinned to reality rather than to a shape someone imagined.
 *
 * The fixtures use the real project-directory encoding, including its
 * lossiness: `-Users-me-projects-alpha` cannot be decoded back to a path,
 * because `-` stands for both `/` and a literal `-`.
 */

const ROOT = '/home/u/.claude/projects';
const UUID = '96a5a5d3-89bd-437b-a692-aaae31485e90';

describe('classifyTranscript: the two shapes the corpus actually has', () => {
  it('classifies a main session transcript', () => {
    const file = classifyTranscript(ROOT, `${ROOT}/-Users-me-projects-alpha/${UUID}.jsonl`);
    expect(file).toEqual({
      path: `${ROOT}/-Users-me-projects-alpha/${UUID}.jsonl`,
      project: '-Users-me-projects-alpha',
      session: UUID,
      kind: 'session',
    });
  });

  it('classifies a subagent transcript WITHOUT mistaking subagents/ for the project', () => {
    // The regression test for the bug described above. If this ever returns
    // `subagents`, every derived count in E5 silently collapses onto one project.
    const file = classifyTranscript(
      ROOT,
      `${ROOT}/-Users-me-projects-alpha/${UUID}/subagents/agent-a592b8a168d3b3d36.jsonl`,
    );
    expect(file.project).toBe('-Users-me-projects-alpha');
    expect(file.session).toBe(UUID);
    expect(file.kind).toBe('subagent');
  });

  it('keeps the project as the ENCODED directory name, never a decoded path', () => {
    // Decoding is not injective: `-Users-a-b` could be `/Users/a/b` or
    // `/Users/a-b`. Grouping on a decoded path would merge two real projects and
    // report the merged figure with no indication that it happened.
    const file = classifyTranscript(ROOT, `${ROOT}/-Users-me-projects-demo-exp/${UUID}.jsonl`);
    expect(file.project).toBe('-Users-me-projects-demo-exp');
  });
});

describe('classifyTranscript: an unknown shape is labelled, not guessed', () => {
  it('labels a path matching neither known shape as unclassified', () => {
    // Still read -- never dropped -- but it must not be silently folded into
    // `session`, because that would make a stale model of the corpus look like a
    // working one.
    const file = classifyTranscript(ROOT, `${ROOT}/nested/odd/shape.jsonl`);
    expect(file.kind).toBe('unclassified');
    expect(file.project).toBe('nested');
    expect(file.session).toBe('odd');
  });

  it('labels a file sitting directly in the root as unclassified', () => {
    const file = classifyTranscript(ROOT, `${ROOT}/loose.jsonl`);
    expect(file.kind).toBe('unclassified');
    expect(file.session).toBeNull();
  });

  it('does not call a subagents-shaped path a subagent unless it ends in .jsonl', () => {
    // The shape test is on the SUFFIX too. Without that, a stray `subagents/`
    // directory holding something else would be classified as a transcript.
    const file = classifyTranscript(ROOT, `${ROOT}/proj/${UUID}/subagents/agent-a1.txt`);
    expect(file.kind).toBe('unclassified');
  });

  it('does not accept a subagents/ directory at the wrong depth', () => {
    const file = classifyTranscript(ROOT, `${ROOT}/proj/subagents/agent-a1.jsonl`);
    expect(file.kind).toBe('unclassified');
  });

  it('refuses to classify a path that is not under the root at all', () => {
    // Stripping a prefix that is not there would leave the path's absolute
    // segments, and the record would be filed under `home` or `Users` --
    // confidently, and identically to a correct answer.
    const file = classifyTranscript(ROOT, '/somewhere/else/proj/x.jsonl');
    expect(file.kind).toBe('unclassified');
    expect(file.project).toBe('projects');
    expect(file.session).toBeNull();
  });
});

describe('classifyTranscript: a trailing separator on the root changes nothing', () => {
  it('classifies identically with and without a trailing slash', () => {
    // `scanTranscripts` is handed whatever the caller passed; a trailing slash
    // is the normal shape when the root came from a URL or a shell completion.
    const bare = classifyTranscript(ROOT, `${ROOT}/proj/${UUID}.jsonl`);
    const slashed = classifyTranscript(`${ROOT}/`, `${ROOT}/proj/${UUID}.jsonl`);
    expect(slashed).toEqual(bare);
  });
});

describe('classifyTranscript: a non-canonical root still matches the paths found under it', () => {
  // `asc-c8g`: `reader.ts` discovers files with `node:path`'s `join`, which normalizes as it
  // joins -- so a root spelled with a `./` prefix, an `a/../` detour, or a doubled separator
  // must still be recognised as the same root the discovered paths were built from. Before the
  // fix, `segmentsUnder` folded `\` to `/` but never collapsed any of these, so EVERY file
  // compared unequal to it, fell into the "not under this root" branch, and was fabricated a
  // project label off the root's own `basename` -- for the whole corpus, not just one file.
  //
  // Each fixture's `path` is what `path.join(root, ...)` actually returns for that `root` --
  // i.e. what `reader.ts` would hand `classifyTranscript` -- so these are not hypothetical
  // inputs; they are the exact pairing a non-canonical `--root` produces today.

  it('matches a root spelled with a leading "./"', () => {
    const classified = classifyTranscript('./corpus', `corpus/proj/${UUID}.jsonl`);
    expect(classified.kind).toBe('session');
    expect(classified.project).toBe('proj');
    expect(classified.session).toBe(UUID);
  });

  it('matches a root spelled with an "a/../b" detour', () => {
    const classified = classifyTranscript(
      `${ROOT}/alpha/../beta`,
      `${ROOT}/beta/proj/${UUID}.jsonl`,
    );
    expect(classified.kind).toBe('session');
    expect(classified.project).toBe('proj');
  });

  it('matches a root spelled with a doubled separator', () => {
    const classified = classifyTranscript(
      `${ROOT}//projects`,
      `${ROOT}/projects/proj/${UUID}.jsonl`,
    );
    expect(classified.kind).toBe('session');
    expect(classified.project).toBe('proj');
  });

  it('still reports the path exactly as given, even when the root was non-canonical', () => {
    // The identity field is untouched by the comparison's own normalization -- only the
    // decision of WHICH project a path falls under is affected.
    const rawPath = `corpus/proj/${UUID}.jsonl`;
    const classified = classifyTranscript('./corpus', rawPath);
    expect(classified.path).toBe(rawPath);
  });
});

describe('classifyTranscript: separators do not change the answer', () => {
  it('classifies a Windows path identically to the POSIX path it describes', () => {
    // The corpus is `~/.claude/projects` on whatever platform the user runs. If
    // classification differed by OS, the population a record is filed under
    // would differ by OS -- an environment-divergence bug in the one place the
    // adapter decides what a record MEANS.
    const posix = classifyTranscript(ROOT, `${ROOT}/proj/${UUID}/subagents/agent-a1.jsonl`);
    const windows = classifyTranscript(
      'C:\\Users\\u\\.claude\\projects',
      `C:\\Users\\u\\.claude\\projects\\proj\\${UUID}\\subagents\\agent-a1.jsonl`,
    );
    expect(windows.kind).toBe(posix.kind);
    expect(windows.project).toBe(posix.project);
    expect(windows.session).toBe(posix.session);
  });
});

/**
 * `projectRelativeCwd` (asc-tlc): the part of `cwd` below the transcript's OWN project root,
 * recovered from the encoded `project` label. Every expected value below is hand-derived from
 * the label, not read back from the function under test.
 */
describe('projectRelativeCwd', () => {
  const PROJECT = '-Users-me-app'; // 13 characters: the encoded form of '/Users/me/app'.

  it('returns "." when cwd IS the project root', () => {
    expect(projectRelativeCwd(PROJECT, '/Users/me/app')).toBe('.');
  });

  it('returns the path below the root for a nested directory', () => {
    expect(projectRelativeCwd(PROJECT, '/Users/me/app/packages/core')).toBe('packages/core');
  });

  it('returns undefined when the label is not the encoded prefix of cwd', () => {
    // '/opt/other/pl' -- the first 13 characters of '/opt/other/place' -- encodes to
    // '-opt-other-pl', which is not PROJECT. No read of a root this reasoning cannot support.
    expect(projectRelativeCwd(PROJECT, '/opt/other/place')).toBeUndefined();
  });

  it('returns undefined when the label is LONGER than cwd', () => {
    // `head = cwd.slice(0, project.length)` is clamped to cwd's own length by `String.slice`,
    // so `head` here is the whole 13-character cwd -- 6 characters short of PROJECT's own
    // 19, and re-encoding it can never equal a 19-character string. No separate length guard
    // is needed for this to fail closed; the length mismatch alone is enough.
    const longerProject = '-Users-me-app-extra'; // 19 characters.
    expect(projectRelativeCwd(longerProject, '/Users/me/app')).toBeUndefined();
  });

  it('returns undefined for a SIBLING whose name merely extends the root', () => {
    // The case the encode-match alone cannot separate, and the reason for the `/` boundary.
    // '/Users/me/apple/x' has the same first 13 characters as '/Users/me/app' -- so `head`
    // re-encodes to PROJECT exactly -- yet the directory is beside the root, not under it. The
    // remainder is 'le/x', which begins mid-segment rather than at a separator; writing it would
    // put a path naming no directory into a column that exists to say where something happened.
    expect(projectRelativeCwd(PROJECT, '/Users/me/apple/x')).toBeUndefined();
    // And the boundary is not satisfied by a mere prefix either: even with nothing after it, a
    // longer last segment is still a different directory.
    expect(projectRelativeCwd(PROJECT, '/Users/me/apple')).toBeUndefined();
  });

  it('returns undefined for a Windows-spelled remainder rather than mangling it', () => {
    // Windows is out of this function's scope, so the honest answer is refusal: the remainder
    // '\\sub' does not begin with '/', so there is no separator this function agreed to
    // interpret, and it omits rather than writing a path in a spelling it never parsed.
    expect(projectRelativeCwd(PROJECT, '/Users/me/app\\sub')).toBeUndefined();
  });

  it('still recovers the root when it contains a real "-", not just an encoded "/"', () => {
    // This is the whole reason the check is `encode(head) === project` rather than a string
    // split on '-': the root '/Users/me/my-app' has a REAL hyphen in its last segment, and a
    // split would see four segments ('Users', 'me', 'my', 'app') where there are really three.
    // Encoding is length-preserving (one character in, one character out) either way, so
    // '/Users/me/my-app' (16 characters) and its encoded label '-Users-me-my-app' (also 16)
    // still line up exactly, and the prefix comparison recovers the root regardless of what
    // produced each '-'.
    const project = '-Users-me-my-app';
    expect(projectRelativeCwd(project, '/Users/me/my-app')).toBe('.');
    expect(projectRelativeCwd(project, '/Users/me/my-app/packages/core')).toBe('packages/core');
  });
});
