/**
 * @ascend/adapter-claude-code -- derives entries from Claude Code transcripts.
 *
 * Empty at E1 (repo foundation); lands in E5 -- see beads `asc-adapter-*`.
 *
 * Contract, carried in from the Stage 0 spike (docs/evidence/EV-corpus.md):
 *   - READ-ONLY on ~/.claude/projects/. Never write there.
 *   - Streaming and memory-bounded. The spike read 1.14 GB at 213 MB peak RSS
 *     in 11.2 s; loading a transcript fully into memory is a defect, not a
 *     tradeoff.
 *   - Self-healing: a malformed line is counted and skipped, never fatal. One
 *     bad line must not abort a sweep of hundreds of files.
 *   - Omit absent values. Never write a sentinel -- see ARCHITECTURE.md on the
 *     fold corpus, which lost the absent-vs-zero distinction permanently.
 *
 * The spike's implementation is in `spike/lib/reader.mjs` and is intended as the
 * porting reference; it is throwaway code, not a dependency.
 */

/** The transcript root, read-only. */
export const TRANSCRIPT_ROOT_SEGMENTS = ['.claude', 'projects'] as const;
