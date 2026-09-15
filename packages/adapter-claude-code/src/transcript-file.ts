/**
 * What a transcript path SAYS about the transcript, with no I/O.
 *
 * This is a pure function of two strings, which matters because it is the one
 * place the adapter makes a claim about the corpus's structure -- and that claim
 * was wrong in the first draft of this file. The measured shape (2026-09-15,
 * 843 files under ~/.claude/projects) is:
 *
 *   <project>/<session-uuid>.jsonl                              51 files
 *   <project>/<session-uuid>/subagents/agent-<id>.jsonl        792 files
 *
 * The tempting derivation -- `basename(dirname(path))` -- returns `subagents`
 * for 94% of the corpus. The project is the segment immediately AFTER the root,
 * and there is no way to know that from the leaf path alone; the root has to be
 * part of the question. Hence `classifyTranscript(root, path)`.
 *
 * `kind` is surfaced rather than hidden because a subagent transcript is a
 * different population: it is a nested agent's own session, not the user's. A
 * derived type that counts over both without saying so is reporting a number
 * about two things at once.
 */

import { basename } from 'node:path';

export const JSONL_SUFFIX = '.jsonl';

/** The `subagents` directory name whose presence distinguishes a nested transcript. */
const SUBAGENTS_DIR = 'subagents';

export type TranscriptKind =
  /** A main session transcript: `<project>/<session-uuid>.jsonl`. */
  | 'session'
  /** A nested agent's transcript: `<project>/<session-uuid>/subagents/agent-*.jsonl`. */
  | 'subagent'
  /**
   * A `.jsonl` under the root that matches neither known shape. Still read --
   * never dropped -- but labelled, because an unrecognized shape means this
   * module's model of the corpus is out of date and a human should see that
   * rather than have it silently folded into `session`.
   */
  | 'unclassified';

export interface TranscriptFile {
  /** The path as given. Not resolved: the caller's path is the caller's identity. */
  readonly path: string;
  /**
   * The first path segment under the root -- Claude Code's encoded project
   * directory name, e.g. `-Users-me-projects-ascend`.
   *
   * The ENCODED name, deliberately not a decoded path: the encoding replaces
   * both `/` and `-` with `-`, so decoding is not injective (`a-b/c` and `a/b-c`
   * collide). Grouping on the raw name is lossless; grouping on a decoded path
   * would merge two projects and never say so.
   */
  readonly project: string;
  /** The session uuid, or `null` when the path is too shallow to carry one. */
  readonly session: string | null;
  readonly kind: TranscriptKind;
}

/**
 * The path's segments below `root`, or `null` when the path is not under it.
 *
 * Deliberately NOT `path.relative`, which is the platform's function and answers
 * differently on Windows than on POSIX. This module's whole job is to decide
 * which population a record belongs to, and a classification that changed with
 * the OS would file the same record differently on two machines while looking
 * perfectly correct on each. Separators are folded to `/` first so a Windows
 * path classifies exactly as the POSIX path it describes.
 */
function segmentsUnder(root: string, path: string): string[] | null {
  const prefix = `${foldSeparators(root)}/`;
  const folded = foldSeparators(path);
  if (!folded.startsWith(prefix)) return null;
  return folded
    .slice(prefix.length)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
}

/** `/`-separated, with any trailing separators removed. */
function foldSeparators(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Classify one path against the root it was found under.
 */
export function classifyTranscript(root: string, path: string): TranscriptFile {
  const segments = segmentsUnder(root, path);
  const first = segments?.[0];

  if (segments === null || first === undefined) {
    // Not under this root. It cannot be classified against a root it is not
    // inside, and picking a segment off its absolute path would file the record
    // under a project that is not its own -- wrong, and indistinguishable from
    // right at the call site. Labelled with the root instead, so `unclassified`
    // never quietly means "I guessed".
    return { path, project: basename(root), session: null, kind: 'unclassified' };
  }

  const project = first;
  const second = segments[1];
  const session = second === undefined ? null : stripSuffix(second);

  if (segments.length === 2 && endsWithJsonl(second)) {
    return { path, project, session, kind: 'session' };
  }
  if (segments.length === 4 && segments[2] === SUBAGENTS_DIR && endsWithJsonl(segments[3])) {
    return { path, project, session, kind: 'subagent' };
  }
  return { path, project, session, kind: 'unclassified' };
}

function endsWithJsonl(segment: string | undefined): boolean {
  return segment !== undefined && segment.endsWith(JSONL_SUFFIX);
}

function stripSuffix(segment: string): string {
  return segment.endsWith(JSONL_SUFFIX) ? segment.slice(0, -JSONL_SUFFIX.length) : segment;
}
