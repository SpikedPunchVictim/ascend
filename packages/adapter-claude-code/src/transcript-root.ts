/**
 * Where the transcripts live.
 *
 * Split out from `reader.ts` so that the root is a value the caller can supply
 * rather than something the reader reaches for. The spike read `homedir()`
 * directly at module scope, which makes the corpus root a property of the
 * machine and not of the call -- untestable against a fixture directory, and
 * impossible to point at a second corpus.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The transcript root, relative to a home directory. Read-only, always. */
export const TRANSCRIPT_ROOT_SEGMENTS = ['.claude', 'projects'] as const;

/** `~/.claude/projects`, from an injected home. Pure. */
export function transcriptRoot(home: string): string {
  return join(home, ...TRANSCRIPT_ROOT_SEGMENTS);
}

/**
 * The corpus root for the current user.
 *
 * The single place this package reads the ambient environment, kept to one line
 * so it is easy to see that it is the only one -- and easy to bypass in a test,
 * which passes `root` instead.
 */
export function defaultTranscriptRoot(): string {
  return transcriptRoot(homedir());
}
