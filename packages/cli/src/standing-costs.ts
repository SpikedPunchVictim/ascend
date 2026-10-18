/**
 * `asc standing-costs`: what a transcript corpus pays for standing context.
 *
 * WHY THIS EXISTS. EV-54 (`docs/evidence/EV-54.md`) measured three candidate detectors and found
 * that exactly one produced betterments: sizing what is injected into every stream — instructions,
 * skill listings, hook output, `--help` look-ups — and what tools return. The other two looked for
 * repeated behaviour and found the behaviour is not repeated at the grain they measured. That
 * measurement was a scratch script and it is gone; this is it as a command, with EV-54's surviving
 * output as the regression target.
 *
 * TWO SOURCES OF TRUTH, DELIBERATELY. EV-54's closing note is "the event stream was not enough
 * alone. Every finding here needed a size, and sizes are in the raw record." That is still true, and
 * this module keeps the split explicit rather than pretending one source suffices:
 *
 * - FROM EVENTS (`createNormalizer`): tool-result bytes, the per-segment argv that names a Bash
 *   call's first command, and `Skill` invocations.
 * - FROM THE RAW RECORD: every attachment the normalizer does not model. `instructions`,
 *   `skill_listing`, `file` and `mcp_instructions_delta` produce no event at all, so their sizes can
 *   only be read from `record.attachment`. So can `hook_success.stdout` — see the note on that
 *   report, because the event stream measures a DIFFERENT field.
 *
 * NO EVENT-MODEL CHANGE. Adding attachment kinds would need an `EVENT_DERIVE_VERSION` bump, and a
 * bump cannot be repaired by re-ingesting: the log is append-only, so `readEventLog` refuses forever
 * at the same file and line (`asc-qdkv`, `dogfood/0114`). Reading raw records costs a pass over data
 * we are already streaming and changes nothing anyone else depends on.
 *
 * BYTES ARE MEASURED, TOKENS ARE NOT — EV-54's own rule. Every number here is `Buffer.byteLength`,
 * never a character count, because the corpus is not ASCII.
 */

import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { MIN_N } from '@ascend/analysis';
import {
  createNormalizer,
  streamCorpus,
  type CorpusTotals,
  type NormalizeCounters,
  type TranscriptFile,
  type TranscriptRecord,
} from '@ascend/adapter-claude-code';
import type { NormalizedEvent } from '@ascend/core';
import { corpusOptionsFor, type TranscriptReplay } from './handler-replay.js';
import { subset, type Output, type Row } from './output.js';

export const REPORT_LOG = '(log)';
export const REPORT_INJECTED = 'injected';
export const REPORT_INSTRUCTIONS = 'instructions';
export const REPORT_SKILLS = 'skills';
export const REPORT_TOOLS = 'tools';
export const REPORT_BASH = 'bash';
export const REPORT_HELP = 'help';

/**
 * The ONE column projection the output layer carries for the whole result.
 *
 * A fixed superset rather than per-report columns, because `Output.columns` is a single array: a
 * field not named here is dropped from `--table` and `--csv` even though `--json` still carries it.
 * Reports leave each other's specialised columns blank, the idiom `explore-group.ts` already uses.
 */
export const STANDING_COST_COLUMNS = [
  'report',
  'key',
  'bytes',
  'count',
  'sessions',
  'stream_segments',
  'value',
  'note',
] as const;

/** The reports `--limit` applies to: ranked group rows, never fixed fact rows. */
const RANKED = new Set<string>([
  REPORT_INJECTED,
  REPORT_INSTRUCTIONS,
  REPORT_TOOLS,
  REPORT_BASH,
  REPORT_HELP,
]);

/** Where a Bash call's bytes go when no executed segment names a command. */
const NO_COMMAND = '(no command)';

/**
 * Heads that are a verb rather than a command on their own, so EV-54's `git diff` row survives.
 * `command.run`'s argv is the segment's own tokens, which is what makes the join legal at all.
 */
const MULTI_VERB_HEADS = new Set([
  'git',
  'bd',
  'td',
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'cargo',
  'go',
  'gh',
  'docker',
  'kubectl',
  'asc',
]);

/**
 * A `--help` look-up, anchored on both sides so `--helpful` is not one. A quoted `"--help"` still
 * matches: the flag was asked for, and whether a shell quoted it is not this report's question.
 */
const HELP_CALL = /(^|\s)--help(\s|$)/;

/** The harness's own marker for hook output it persisted to a file instead of inlining. */
const PERSISTED = /^<persisted-output>/;

interface Tally {
  bytes: number;
  count: number;
  readonly sessions: Set<string>;
}

interface HelpTally extends Tally {
  readonly segments: Set<string>;
}

const tally = (): Tally => ({ bytes: 0, count: 0, sessions: new Set<string>() });

function bump(
  into: Map<string, Tally>,
  key: string,
  bytes: number,
  session: string | undefined,
): void {
  let entry = into.get(key);
  if (entry === undefined) {
    entry = tally();
    into.set(key, entry);
  }
  entry.bytes += bytes;
  entry.count += 1;
  if (session !== undefined) entry.sessions.add(session);
}

/** One report's rows, already sorted, ending with the `(groups)` row that states its population. */
export interface MeasuredReport {
  readonly id: string;
  readonly rows: readonly Row[];
}

export interface StandingCostMeasurement {
  readonly log: readonly Row[];
  readonly reports: readonly MeasuredReport[];
}

/** The meter, so a test can feed records and read a measurement without touching the filesystem. */
export interface StandingCostMeter {
  accept(record: TranscriptRecord, file: TranscriptFile): void;
  finish(totals?: CorpusTotals): StandingCostMeasurement;
}

/**
 * A meter over one corpus pass.
 *
 * `home` is injected rather than read from the environment so a fixture's instruction paths
 * abbreviate deterministically and `--json` does not depend on the machine that ran it.
 */
export function createStandingCostMeter(options?: { readonly home?: string }): StandingCostMeter {
  const home = options?.home ?? homedir();
  const normalizer = createNormalizer();

  const injected = new Map<string, Tally>();
  const instructionFiles = new Map<string, Tally>();
  const tools = new Map<string, Tally>();
  const bash = new Map<string, Tally>();
  const help = new Map<string, HelpTally>();
  const unsized = new Map<string, number>();

  const listings = tally();
  let skillsSummed = 0;
  const listed = new Set<string>();
  const invoked = new Set<string>();
  const invokedSessions = new Set<string>();

  const sessions = new Set<string>();
  const streams = new Set<string>();
  let records = 0;
  let events = 0;
  let attachmentRecords = 0;
  let toolResults = 0;
  let unmeasuredCalls = 0;

  // Per-stream state. A tool-call id is unique within its transcript, so reusing one across two
  // files would be a defect in the transcript rather than a join worth surviving.
  let currentPath: string | undefined;
  const bashCommands = new Map<string, string>();
  // A Bash result arrives BEFORE the `command.run` that names its first segment: the normalizer
  // emits `tool.use.end` and then, from the same block, the command segments. So the end is
  // buffered here and settled when the label shows up.
  const pendingBash = new Map<
    string,
    { bytes: number; session: string | undefined; agent: string; segment: string }
  >();

  const sessionOf = (file: TranscriptFile, record: TranscriptRecord): string | undefined => {
    const fromRecord = record['sessionId'];
    if (typeof fromRecord === 'string' && fromRecord !== '') return fromRecord;
    return file.session ?? undefined;
  };

  function offer(event: NormalizedEvent, fallbackSession: string | undefined): void {
    events += 1;
    const fields = event as unknown as Record<string, unknown>;
    const session =
      typeof fields['session_id'] === 'string' ? fields['session_id'] : fallbackSession;

    if (fields['kind'] === 'tool.use.start') {
      const skill = fields['skill'];
      if (fields['tool'] === 'Skill' && typeof skill === 'string' && skill !== '') {
        invoked.add(skill);
        if (session !== undefined) invokedSessions.add(session);
      }
      return;
    }

    if (fields['kind'] === 'command.run') {
      // `index === 0` is the FIRST EXECUTED SEGMENT's own tokens. `tool.use.start.head` is only
      // argv[0] (so EV-54's `git diff` row would be lost) and `tool.use.start.argv` is flattened
      // across every segment (so `git && git diff` would read `git git`). Neither can be used.
      const id = fields['id'];
      const argv = fields['argv'];
      if (fields['index'] !== 0 || typeof id !== 'string' || !Array.isArray(argv)) return;
      const label = firstCommandLabel(argv.filter((t): t is string => typeof t === 'string'));
      const pending = pendingBash.get(id);
      if (pending === undefined) return;
      pendingBash.delete(id);
      settleBash(id, label, pending);
      return;
    }

    if (fields['kind'] !== 'tool.use.end') return;

    toolResults += 1;
    const tool = typeof fields['tool'] === 'string' ? fields['tool'] : '(unknown)';
    const measured = typeof fields['bytes'] === 'number' ? fields['bytes'] : undefined;
    if (measured === undefined) unmeasuredCalls += 1;
    bump(tools, tool, measured ?? 0, session);
    if (tool !== 'Bash') return;

    const id = typeof fields['id'] === 'string' ? fields['id'] : '';
    pendingBash.set(id, {
      bytes: measured ?? 0,
      session,
      // `text` rather than `String`: an event field is `unknown`, and a non-string there must
      // become empty rather than "[object Object]" in a segment key.
      agent: text(fields['agent_id']),
      segment: text(fields['segment']),
    });
  }

  function settleBash(
    id: string,
    label: string,
    pending: { bytes: number; session: string | undefined; agent: string; segment: string },
  ): void {
    bump(bash, label, pending.bytes, pending.session);
    const command = bashCommands.get(id);
    const key = command === undefined ? undefined : helpKey(command);
    if (key === undefined) return;
    let row = help.get(key);
    if (row === undefined) {
      row = { ...tally(), segments: new Set<string>() };
      help.set(key, row);
    }
    row.bytes += pending.bytes;
    row.count += 1;
    if (pending.session !== undefined) row.sessions.add(pending.session);
    // Distinct `(session, agent, segment)` triples, not calls: EV-54's point is that flags are
    // looked up again after each compaction, so two look-ups in one segment are one segment.
    row.segments.add(`${pending.session ?? ''}\u0000${pending.agent}\u0000${pending.segment}`);
  }

  /**
   * A Bash call whose every segment was stripped (`cd`, `export`, `timeout`) produces no
   * `command.run`, so its result never settles. It is attributed to `(no command)` rather than
   * dropped: the bytes were returned whether or not the adapter could name what produced them.
   */
  function flushBash(): void {
    for (const [id, pending] of pendingBash) settleBash(id, NO_COMMAND, pending);
    pendingBash.clear();
  }

  function readCommandText(record: TranscriptRecord): void {
    const message = record['message'];
    if (!isRecord(message)) return;
    const content = message['content'];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use' || block['name'] !== 'Bash') continue;
      const id = block['id'];
      const input = block['input'];
      if (typeof id === 'string' && isRecord(input) && typeof input['command'] === 'string') {
        bashCommands.set(id, input['command']);
      }
    }
  }

  function readAttachment(record: TranscriptRecord, session: string | undefined): void {
    if (record['type'] !== 'attachment') return;
    const attachment = record['attachment'];
    if (!isRecord(attachment)) return;
    attachmentRecords += 1;
    const kind = attachment['type'];

    if (kind === 'instructions') {
      // One record can carry several files, so this report's LOADS are per file while the
      // `injected` report's COUNT is per record. The two byte totals must reconcile exactly.
      const files = attachment['files'];
      let total = 0;
      if (Array.isArray(files)) {
        for (const file of files) {
          if (!isRecord(file)) continue;
          const bytes = byteLength(file['content']);
          total += bytes;
          const path = typeof file['path'] === 'string' ? file['path'] : '(unknown)';
          bump(instructionFiles, abbreviate(path, home), bytes, session);
        }
      }
      bump(injected, 'instructions', total, session);
      return;
    }

    if (kind === 'skill_listing') {
      // `names` is the list the listing actually named; `skillCount` is the harness's own total.
      // They can disagree, and EV-54 summed NAMES, so `names` wins and `skillCount` is only the
      // fallback rather than an addition.
      const bytes = byteLength(attachment['content']);
      bump(injected, 'skill_listing', bytes, session);
      listings.bytes += bytes;
      listings.count += 1;
      if (session !== undefined) listings.sessions.add(session);
      const names = attachment['names'];
      if (Array.isArray(names)) {
        for (const name of names) {
          if (typeof name !== 'string') continue;
          listed.add(name);
          skillsSummed += 1;
        }
      } else if (typeof attachment['skillCount'] === 'number') {
        skillsSummed += attachment['skillCount'];
      }
      return;
    }

    if (kind === 'file') {
      // NESTED: `content` is `{ type: 'text', file: { filePath, content } }` on the records the
      // corpus holds. Treating `content` as a string measures zero and looks like a corpus with no
      // file attachments at all.
      bump(injected, 'file', byteLength(fileAttachmentText(attachment['content'])), session);
      return;
    }

    if (kind === 'mcp_instructions_delta') {
      const blocks = attachment['addedBlocks'];
      let total = 0;
      if (Array.isArray(blocks)) for (const block of blocks) total += byteLength(block);
      bump(injected, 'mcp_instructions_delta', total, session);
      return;
    }

    if (kind === 'hook_success') {
      // `stdout`, NOT `content`. `hook.delivery.bytes` on the event stream measures `content`, and
      // the adapter's own docblock records the two are different strings on 76,000 of 86,877
      // attachments. EV-54's column is literally `hook_success(stdout)`, so the raw record is read
      // and the channel is named in the key — a reader comparing this table to the event stream
      // must be able to see which field produced it.
      const stdout = attachment['stdout'];
      const channel = typeof stdout === 'string' ? 'stdout' : 'content';
      const source = typeof stdout === 'string' ? stdout : attachment['content'];
      bump(
        injected,
        `hook_success(${channel}) ${hookEventOf(attachment)} ${hookCommandOf(attachment)}`,
        byteLength(source),
        session,
      );
      return;
    }

    if (kind === 'hook_additional_context') {
      const text = joinedText(attachment['content']);
      const channel = PERSISTED.test(text) ? 'persisted' : 'inline';
      // The `persisted` label is the point: that text is a ~2 KB preview the harness wrote in place
      // of the hook's output, so a table that does not distinguish it says the hook injected 2 KB
      // when it printed tens of KB.
      bump(
        injected,
        `hook_additional_context(${channel}) ${hookEventOf(attachment)} ${hookNameOf(attachment)}`,
        byteLength(text),
        session,
      );
      return;
    }

    // Every other attachment type is counted, never sized. Summing arbitrary strings out of one
    // would count metadata (names, paths, type tags) as injected text.
    const label = typeof kind === 'string' ? kind : '(unknown)';
    unsized.set(label, (unsized.get(label) ?? 0) + 1);
  }

  return {
    accept(record, file) {
      if (file.path !== currentPath) {
        flushBash();
        currentPath = file.path;
        streams.add(file.path);
        bashCommands.clear();
      }
      records += 1;
      if (file.session !== null) sessions.add(file.session);
      const session = sessionOf(file, record);
      for (const event of normalizer.accept(record, file)) offer(event, session);
      readCommandText(record);
      readAttachment(record, session);
    },

    finish(totals) {
      for (const event of normalizer.drain()) offer(event, undefined);
      flushBash();
      return {
        log: logRows({
          totals,
          records,
          events,
          sessions: sessions.size,
          streams: streams.size,
          attachmentRecords,
          toolResults,
          unmeasuredCalls,
          unsized,
          counters: normalizer.counters,
        }),
        reports: [
          { id: REPORT_INJECTED, rows: rankedRows(REPORT_INJECTED, injected) },
          { id: REPORT_INSTRUCTIONS, rows: rankedRows(REPORT_INSTRUCTIONS, instructionFiles) },
          { id: REPORT_SKILLS, rows: skillRows() },
          { id: REPORT_TOOLS, rows: rankedRows(REPORT_TOOLS, tools) },
          { id: REPORT_BASH, rows: rankedRows(REPORT_BASH, bash) },
          { id: REPORT_HELP, rows: helpRows() },
        ],
      };
    },
  };

  function skillRows(): Row[] {
    const rows: Row[] = [
      {
        report: REPORT_SKILLS,
        key: 'listings',
        bytes: listings.bytes,
        count: listings.count,
        sessions: listings.sessions.size,
        ...note(listings.sessions.size),
      },
    ];
    if (listings.count > 0) {
      rows.push({
        report: REPORT_SKILLS,
        key: 'bytes_per_listing',
        value: Math.round(listings.bytes / listings.count),
      });
    }
    rows.push({ report: REPORT_SKILLS, key: 'skills_summed', value: skillsSummed });
    rows.push({ report: REPORT_SKILLS, key: 'distinct_listed', value: listed.size });
    rows.push({
      report: REPORT_SKILLS,
      key: 'distinct_invoked',
      value: invoked.size,
      sessions: invokedSessions.size,
      ...note(invokedSessions.size),
    });
    // The SET DIFFERENCE, not `distinct_listed - distinct_invoked`: EV-54 printed 540 listed, 14
    // invoked and 528 never-invoked, which is only self-consistent if two invoked names were never
    // in a listing. Subtracting the counts would have printed 526.
    rows.push({
      report: REPORT_SKILLS,
      key: 'listed_never_invoked',
      value: [...listed].filter((name) => !invoked.has(name)).length,
    });
    return rows;
  }

  function helpRows(): Row[] {
    const entries = [...help.entries()].sort(compareTally);
    const rows: Row[] = entries.map(([key, value]) => ({
      report: REPORT_HELP,
      key,
      bytes: value.bytes,
      count: value.count,
      sessions: value.sessions.size,
      stream_segments: value.segments.size,
      ...note(value.sessions.size),
    }));
    const all = new Set<string>();
    for (const [, value] of entries) for (const s of value.sessions) all.add(s);
    rows.push(groupsRow(REPORT_HELP, entries, all));
    return rows;
  }
}

/** Measure a corpus. One pass; the scope decides which transcripts it covers. */
export async function measureStandingCosts(
  scope: Pick<TranscriptReplay, 'root' | 'projects' | 'includeEphemeral'>,
  options?: { readonly home?: string },
): Promise<StandingCostMeasurement> {
  const meter = createStandingCostMeter(options);
  const totals = await streamCorpus((record, file) => {
    meter.accept(record, file);
  }, corpusOptionsFor(scope));
  return meter.finish(totals);
}

/**
 * The rows the command emits.
 *
 * `--limit` applies per RANKED report and never to the `(log)` facts, the `skills` metrics, or the
 * `(groups)` row — so a truncated view still states each report's population. Coverage then
 * describes emitted rows, which is the one thing the envelope's single `coverage` can honestly say
 * about six reports at once.
 */
export function standingCostOutput(measurement: StandingCostMeasurement, limit: number): Output {
  const rows: Row[] = [...measurement.log];
  let shown = rows.length;
  let total = rows.length;
  let hasMore = false;
  for (const report of measurement.reports) {
    if (RANKED.has(report.id)) {
      const head = report.rows.slice(0, Math.max(0, report.rows.length - 1));
      const groups = report.rows[report.rows.length - 1];
      const kept = head.slice(0, limit);
      if (kept.length < head.length) hasMore = true;
      rows.push(...kept);
      shown += kept.length;
      total += report.rows.length;
      if (groups !== undefined) {
        rows.push(groups);
        shown += 1;
      }
    } else {
      rows.push(...report.rows);
      shown += report.rows.length;
      total += report.rows.length;
    }
  }
  return {
    columns: [...STANDING_COST_COLUMNS],
    rows,
    ...(hasMore ? { coverage: subset(shown, total, hasMore) } : {}),
  };
}

/**
 * A Bash call's first command, in EV-54's spelling.
 *
 * The argv comes from `command.run` with `index === 0`, the first EXECUTED segment. The adapter has
 * already basenamed the tokens (`/usr/bin/git` is `git`), so only the subcommand join is done here.
 * One call contributes to exactly one row: EV-54 states that a multi-segment command's whole result
 * is attributed to its first command, and this does not try to allocate it.
 */
/**
 * The `--help` key: the command up to and including the flag.
 *
 * NOT the whole command text, and the live corpus is why. Help output is almost always piped —
 * `bd create --help 2>&1 | head -40` — so a whole-text key turns one look-up into as many rows as
 * there are ways to pipe it, and the counts fragment (27 against EV-54's 51 for one command).
 * EV-54's own printed keys stop at the flag, which is what this reproduces. The flag itself is kept
 * so a reader can see which form was asked for.
 */
export function helpKey(command: string): string | undefined {
  const match = HELP_CALL.exec(command);
  if (match === null) return undefined;
  return command.slice(0, match.index + match[0].length).trim();
}

export function firstCommandLabel(argv: readonly string[]): string {
  const head = argv[0];
  if (head === undefined || head === '') return NO_COMMAND;
  const sub = argv[1];
  return sub !== undefined && !sub.startsWith('-') && MULTI_VERB_HEADS.has(head)
    ? `${head} ${sub}`
    : head;
}

function rankedRows(report: string, groups: Map<string, Tally>): Row[] {
  const entries = [...groups.entries()].sort(compareTally);
  const rows: Row[] = entries.map(([key, value]) => ({
    report,
    key,
    bytes: value.bytes,
    count: value.count,
    sessions: value.sessions.size,
    ...note(value.sessions.size),
  }));
  const all = new Set<string>();
  for (const [, value] of entries) for (const s of value.sessions) all.add(s);
  rows.push(groupsRow(report, entries, all));
  return rows;
}

/**
 * The reserved row that states a report's population.
 *
 * Always emitted and never truncated, so a `--limit`ed view still says how many groups it is a
 * view of — which the envelope's single `coverage` cannot say for six reports at once.
 */
function groupsRow(
  report: string,
  entries: readonly [string, Tally][],
  sessions: Set<string>,
): Row {
  return {
    report,
    key: '(groups)',
    bytes: entries.reduce((sum, [, value]) => sum + value.bytes, 0),
    sessions: sessions.size,
    value: entries.length,
  };
}

/** `MIN_N` is a floor on reporting, so a group under it is named as an anecdote, never withheld. */
function note(sessionCount: number): { note?: string } {
  return sessionCount < MIN_N
    ? { note: `anecdote: ${String(sessionCount)} sessions < ${String(MIN_N)}` }
    : {};
}

function compareTally(a: [string, Tally], b: [string, Tally]): number {
  if (a[1].bytes !== b[1].bytes) return b[1].bytes - a[1].bytes;
  if (a[1].count !== b[1].count) return b[1].count - a[1].count;
  // Bytewise, not localeCompare: `reader.ts` sorts paths the same way, so two runs over one corpus
  // agree whatever locale the machine has.
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function logRows(input: {
  totals: CorpusTotals | undefined;
  records: number;
  events: number;
  sessions: number;
  streams: number;
  attachmentRecords: number;
  toolResults: number;
  unmeasuredCalls: number;
  unsized: Map<string, number>;
  counters: NormalizeCounters;
}): Row[] {
  const facts: [string, unknown][] = [
    ['source', 'transcripts'],
    ['records', input.records],
    ['events', input.events],
    ['sessions', input.sessions],
    ['streams', input.streams],
    ['attachment_records', input.attachmentRecords],
    ['tool_results', input.toolResults],
    // Not zero when it is not zero: a result with no text is a call with no measured bytes, and
    // folding it into the byte total as 0 would claim a measurement nobody took.
    ['unmeasured_calls', input.unmeasuredCalls],
  ];
  if (input.totals !== undefined) {
    facts.push(
      ['files', input.totals.files],
      ['lines', input.totals.lines],
      ['malformed', input.totals.malformed],
      ['corpus_bytes', input.totals.bytes],
      ['failures', input.totals.failures.length],
      ['aborted', input.totals.aborted],
      // Always, including zero: an all-projects sweep that silently left out the temp-root
      // projects would read as the whole corpus.
      ['ephemeral_skipped', input.totals.skipped.filter((e) => e.reason === 'ephemeral').length],
    );
  }
  for (const [name, count] of Object.entries(input.counters)) {
    facts.push([`normalizer.${name}`, count]);
  }
  for (const [name, count] of [...input.unsized.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    facts.push([`unsized_attachment.${name}`, count]);
  }
  return facts.map(([key, value]) => ({ report: REPORT_LOG, key, value }));
}

/** An event field as a string, or empty. Never `String(value)`, which stringifies objects. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function byteLength(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function joinedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((part): part is string => typeof part === 'string').join('');
}

function fileAttachmentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return '';
  const file = content['file'];
  if (!isRecord(file)) return '';
  return typeof file['content'] === 'string' ? file['content'] : '';
}

function hookEventOf(attachment: Record<string, unknown>): string {
  return typeof attachment['hookEvent'] === 'string' ? attachment['hookEvent'] : '(unknown)';
}

function hookCommandOf(attachment: Record<string, unknown>): string {
  return typeof attachment['command'] === 'string' ? attachment['command'] : '(unknown)';
}

function hookNameOf(attachment: Record<string, unknown>): string {
  return typeof attachment['hookName'] === 'string' ? attachment['hookName'] : '(unknown)';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `~` for the home directory, matching EV-54's printed keys; anything else stays absolute. */
function abbreviate(path: string, home: string): string {
  if (path === home) return '~';
  const prefix = home.endsWith('/') ? home : `${home}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}
