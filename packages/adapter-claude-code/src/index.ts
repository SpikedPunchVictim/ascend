/**
 * @ascend/adapter-claude-code -- derives entries from Claude Code transcripts.
 *
 * The package has one job in E5: turn `~/.claude/projects/*.jsonl` into records
 * a derived entry type can be built from. This module lands the READER only;
 * the derived types land in `asc-qib` and the command that drives them in
 * `asc-ycl`.
 *
 * Contract, carried in from the Stage 0 spike (`docs/evidence/EV-corpus.md`)
 * and now enforced rather than restated:
 *
 *   - READ-ONLY on ~/.claude/projects. Never write there. Checked by
 *     `reader-source.test.ts`, which scans this package's source for
 *     write-capable `fs` IMPORTS -- the capability, not a word that happens to
 *     spell a function name.
 *   - Streaming and memory-bounded. Loading a transcript fully into memory is a
 *     defect, not a tradeoff. Re-measured against the live corpus by
 *     `reader-real-corpus.test.ts`.
 *   - Self-healing: a malformed line is counted and skipped, never fatal. One
 *     bad line must not abort a sweep of hundreds of files.
 *   - Omit absent values. Never write a sentinel -- see ARCHITECTURE.md on the
 *     three states, and why a corpus that loses the distinction never gets it back.
 *
 * Three layers, and the split is the design:
 *
 *   decode.ts            pure  -- one line in, one record or one reason out
 *   transcript-file.ts   pure  -- one path in, its project/session/kind out
 *   transcript-root.ts   pure  -- where the corpus is, from an injected home
 *   reader.ts             I/O  -- the walk, the stream, the counters
 *
 * Everything except `reader.ts` is a pure function of its arguments, so the
 * rules that actually decide what a corpus MEANS are testable against string
 * literals. Only the layer that touches the filesystem needs a filesystem.
 */

export {
  decodeLine,
  type DecodeFailure,
  type DecodedLine,
  type TranscriptRecord,
} from './decode.js';

export { DERIVED_SOURCE, DERIVED_TYPES, derivedType } from './derived-types.js';

export {
  checkRunner,
  createDeriver,
  execSegments,
  type DeriveCounters,
  type DerivedEntry,
  type Deriver,
} from './derive.js';

export {
  JSONL_SUFFIX,
  classifyTranscript,
  type TranscriptFile,
  type TranscriptKind,
} from './transcript-file.js';

export {
  TRANSCRIPT_ROOT_SEGMENTS,
  defaultTranscriptRoot,
  transcriptRoot,
} from './transcript-root.js';

export {
  scanTranscripts,
  streamCorpus,
  streamTranscript,
  type CorpusOptions,
  type CorpusTotals,
  type ScanResult,
  type SkipReason,
  type SkippedEntry,
  type StreamOptions,
  type TranscriptCounters,
  type TranscriptFailure,
  type Visit,
} from './reader.js';
