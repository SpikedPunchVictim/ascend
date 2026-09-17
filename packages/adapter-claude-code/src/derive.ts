/**
 * Pure derivation: transcript records in, derived entries out.
 *
 * No `fs`, no clock, no environment. Every branch here is reachable by passing a plain object
 * literal, which is what lets the rules that decide what a corpus MEANS be tested against
 * fixtures -- and then driven against the real corpus unchanged, because it is the same code.
 *
 * STREAMING, like the reader it sits on: records arrive one at a time and entries leave one at
 * a time, with only per-FILE state held. A transcript is up to 107 MB; nothing here is
 * proportional to it.
 *
 * THE IDENTITY RULE, which is the whole of `asc-dh0.1`'s finding and the reason four of these
 * five types exist at all:
 *
 *     A derived type's N is its count of DISTINCT PER-EVENT IDENTITIES, never its line count.
 *
 * The gap runs in both directions and each direction has already produced a wrong number on
 * this corpus. `attributionSkill` is on 6,395 transcript records and yields 87 activations,
 * because a skill active across 54 consecutive messages is ONE activation -- a line count
 * inflates it 73x. `verification-run` measured 4,456 by one rule and 16,352 by another,
 * because "is this command a verification" is not a fact the transcript records; it is a
 * judgement this file makes, and the judgement is stated below rather than buried.
 *
 * So every entry carries a `key`: `session_id` + the identifier that makes this event
 * distinct, which is a different field per type and is documented at each. That key is what
 * makes re-ingesting idempotent -- the same transcript produces the same keys, so the second
 * run recognises every entry as one it already wrote.
 *
 * WHAT IS NOT DERIVED, deliberately: entries whose identity cannot be established are NOT
 * emitted and ARE counted (`counters.unkeyable`). A silently dropped record is the failure
 * this module is most able to cause -- the sweep reports success and the corpus is missing
 * rows -- so the drop is a number a caller can assert against rather than an absence nobody
 * can see.
 */

import type { TranscriptRecord } from './decode.js';
import { DERIVED_SOURCE } from './derived-types.js';
import type { TranscriptFile } from './transcript-file.js';

/**
 * One derived event, ready for the store.
 *
 * Deliberately NOT a `TypeSpec`-shaped thing: the spec is the definition, this is an
 * instance. The two are kept apart so a definition can be edited without the deriver having
 * to change, and so the deriver cannot quietly invent a property the spec does not declare --
 * `validateEntry` in the consuming command is what proves the two agree, and
 * `derive-real-corpus.test.ts` runs exactly that over the whole corpus.
 */
export interface DerivedEntry {
  /** The type name. Matches a `TypeSpec` name in `derived-types.ts`. */
  readonly type: string;
  /**
   * Stable per-event identity: the same transcript always yields the same key.
   *
   * Unique across the corpus by construction, and disambiguated rather than overwritten if a
   * transcript ever repeats one (see `key`). This is what an ingest keys idempotency on.
   */
  readonly key: string;
  /**
   * Always `'derived:claude-code'`. A constant in the type rather than a field a caller
   * passes, so the provenance claim cannot be omitted -- it is the Stage 2 success criterion
   * and the one column separating a machine's reading from a model's self-report.
   */
  readonly source: typeof DERIVED_SOURCE;
  /** The transcript's own timestamp, when it has one. Never the ingest clock. */
  readonly occurredAt: string | undefined;
  /**
   * The real working directory the event happened in, from the record's own `cwd`.
   *
   * NOT the `project` property, and the difference is the whole of `asc-5hs`. `project` is the
   * ENCODED directory name under `~/.claude/projects` -- one label per project, because that is
   * the name on disk. An agent works in subdirectories and worktrees under a project, so those
   * labels collapse -- and the collapse is measured, not argued. RE-MEASURED 2026-09-16 over
   * every record, because the corpus is live and any figure about it is a date: 20 encoded
   * directories hold 301 distinct real working directories (15.1:1), the largest collapsing
   * 123:1. The bead's figures (15 / 282 / 115, 2026-09-15) moved in the same direction for the
   * obvious reason. Over the derived ENTRIES alone -- the population this adapter actually
   * produces -- it is 14 projects over 84 real directories, 6.0:1. Either way this field is the
   * value the directory name cannot express.
   *
   * It belongs to the ENVELOPE (`entries.cwd`), not to the type's properties. A property may not
   * be named `cwd`: `reservedPropertyName` in `@ascend/core` refuses it, because the generated
   * view already projects the envelope's column under that name and SQLite would keep the first
   * and rename the loser rather than error -- returning the envelope value under the property's
   * name. Measured, not assumed: `asc types define` refuses the definition outright.
   */
  readonly cwd?: string;
  /** The checked-out branch, from the record's own `gitBranch`. Envelope column `branch`. */
  readonly branch?: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Raw text for the envelope's `evidence_text`, on the ONE type whose value is prose.
   * Everywhere else it is absent, and the reader's contract -- no raw transcript text
   * reaches a caller that prints -- stays intact through the whole sweep.
   */
  readonly evidenceText?: string;
}

/**
 * What the deriver saw and what it could not use.
 *
 * Every field here exists because the alternative to a count is a silence, and a silence
 * looks identical to nothing having happened.
 */
export interface DeriveCounters {
  /** Transcript records offered. */
  records: number;
  /** Entries produced. */
  entries: number;
  /**
   * Entries whose per-event key was already issued for this file, so it was suffixed `#2`.
   * Measured: 6 across the whole 2026-09-15 corpus, out of 1,488 entries.
   *
   * Small, and reported rather than absorbed, because the alternative is a rule that silently
   * overwrites -- and a dropped event leaves no trace at all. The count is not broken down by
   * type, and no cause is claimed for it: a transcript that replays records (a compacted
   * session continuing) would produce exactly this, but it was not investigated, and a
   * plausible mechanism is not a measurement.
   */
  keyCollisions: number;
  /**
   * Events recognised but NOT emitted, because they had no stable identity: a denial or
   * compaction with no `session_id`, or a skill activation with no record uuid. Should be
   * zero; a non-zero value means the corpus holds rows nothing can key, which is a real
   * limitation to state rather than a bug to hide.
   */
  unkeyable: number;
  /**
   * Bash check runs whose result carried no boolean `is_error`, so no verdict could be read.
   * Should be zero, and measured zero on every drive of the real corpus: `is_error` was a
   * boolean on every check result seen. A non-zero value means the transcript changed shape
   * and `verification_run` is silently going blind -- which is why it is a counter and not an
   * assumption.
   *
   * Such a run is dropped AND does not advance the verdict chain, so the next readable run is
   * compared against the last verdict that was actually read. That is the conservative choice:
   * the alternative, treating an unreadable result as a pass, would fabricate a verdict change
   * out of a field the transcript failed to carry.
   */
  unverdictable: number;
}

export interface Deriver {
  /**
   * Take one record. Returns the entries it completed -- usually none or one.
   *
   * A file change is detected HERE rather than by the caller, because the state that must be
   * reset (the tool-name map, the pending skill run, the verdict chain) is exactly the state
   * whose staleness would be invisible: a tool id carried across a file boundary would resolve
   * to the wrong tool, and a verdict carried across it would fabricate a change.
   */
  accept(record: TranscriptRecord, file: TranscriptFile): readonly DerivedEntry[];
  /** Flush the last file's pending run. Call once, after the final `accept`. */
  drain(): readonly DerivedEntry[];
  readonly counters: DeriveCounters;
}

// ---------------------------------------------------------------------------
// Narrowing. Every transcript field is absent somewhere, so nothing is read
// without proving its type first. `noPropertyAccessFromIndexSignature` makes
// that a compiler rule rather than a convention.

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const list = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? (value as readonly unknown[]) : undefined;

/** Every block in a record's `message.content`, ignoring a content that is a plain string. */
function blocks(record: TranscriptRecord): readonly Record<string, unknown>[] {
  const message = rec(record['message']);
  const content = message === undefined ? undefined : list(message['content']);
  if (content === undefined) return [];
  const out: Record<string, unknown>[] = [];
  for (const block of content) {
    const one = rec(block);
    if (one !== undefined) out.push(one);
  }
  return out;
}

/**
 * Where an event happened, as the record that triggered it reports it -- both halves optional.
 *
 * Read from the TRIGGER record itself, never carried forward and never derived from the
 * transcript's own directory name. Measured 2026-09-15: 340,137 of 432,471 records (78.6%)
 * carry a string `cwd`, and the SAME 340,137 carry `gitBranch`. Re-measured 2026-09-16 on a
 * larger corpus: 356,331 of 459,399 (77.6%), again the same set -- the two co-occur exactly,
 * on both dates, which is the property this function relies on.
 *
 * The per-trigger breakdown was taken on 2026-09-15 too -- `toolDenialKind` 457/457,
 * `compactMetadata` 441/441, `userFeedback` 20/20, `attributionSkill` 6,395/6,395,
 * `attributionAgent` 69,698/69,698, i.e. every record that can trigger a derived event carries
 * both. The claim was re-checked at the ENTRIES level on 2026-09-16 rather than guessed forward:
 * 1,607 derived entries, 0 without a `cwd`, 0 without a `branch`. So for these five types this
 * is a copy, not a lookup.
 *
 * The 21.4% that carry neither are CONTROL records -- `mode`, `permission-mode`, `last-prompt`,
 * `ai-title`, `agent-name`, `bridge-session`. None of them triggers a derived event today, so
 * the omission below is not a gap in practice. It would become one the day a derived type keys
 * off a control record, which is why the omission is a value rather than a default.
 *
 * Both are `undefined` rather than `''` on absence, and that is not tidiness: `entries` has
 * `CHECK (cwd IS NULL OR cwd <> '')`, so an empty string is a REFUSED write, while a `null` is
 * the honest "the transcript did not say". `str` already folds both absences into `undefined`.
 */
interface Locality {
  readonly cwd: string | undefined;
  readonly branch: string | undefined;
}

/** The two transcript fields, under their own names, with absence preserved. */
function localityOf(record: TranscriptRecord): Locality {
  return { cwd: str(record['cwd']), branch: str(record['gitBranch']) };
}

// ---------------------------------------------------------------------------
// The check rule. This is a JUDGEMENT, not a reading, and it is the least
// certain thing in this file -- so it is written out rather than tuned.
//
// KNOWN LIMITATIONS, each stated rather than discovered later:
//
//   - A flag placed AFTER `run` defeats the flag skip: `npm run -w pkg test` is
//     valid npm and is not recognized. NOT fixed, because the corpus contains
//     ZERO such commands out of 72,014 -- a rule change for zero measured impact
//     would add an untested branch to the least certain code here.
//   - Verbs match EXACTLY. `npm run test:unit` is in the set because the corpus
//     runs it 746 times; `npm run test:e2e:headed` is not. A prefix rule would
//     swallow every bespoke script whose name merely starts with a known verb.
//   - Bare `node` is deliberately NOT a runner. It looked like the broadest
//     defensible rule and produced 9,257 hits, nearly all `node -e` one-liners
//     that check nothing. It was the single largest source of a 16,352 figure
//     that counted probes as verification.

const STRIP_ONE = new Set(['cd', 'export', 'timeout', 'env', 'nice', 'sudo']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const BARE_RUNNERS = new Set([
  'vitest',
  'jest',
  'pytest',
  'tsc',
  'eslint',
  'prettier',
  'ruff',
  'mypy',
  'make',
]);
/** Verbs that mean "check this project". `build` is here: it is the strictest check there is. */
const CHECK_VERB = new Set([
  'test',
  'tests',
  'typecheck',
  'type-check',
  'lint',
  'check',
  'verify',
  'format:check',
  'test:unit',
  'test:e2e',
  'test:integration',
  'tsc',
  'build',
]);
const RUN_VIA = new Set(['npx', 'bunx']);
/** Flags that consume the token after them, so the verb is further right. */
const FLAG_WITH_VALUE = new Set([
  '-F',
  '--filter',
  '-C',
  '--dir',
  '-w',
  '--workspace',
  '-r',
  '-s',
  '--silent',
]);

/** A heredoc opener, and the tag that ends it. `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`. */
const HEREDOC = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

/**
 * Split a shell command into execution-POSITION segments, each a token list.
 *
 * The distinction this exists for: matching whether a command merely CONTAINS a verify token
 * counts text rather than events. Searching the raw command text for a token set matches
 * 10,893 of the corpus's 72,014 Bash commands; requiring the token to be at an execution
 * position gives 6,826. The extra 4,067 are commands that mention a check, not commands that
 * ran one -- including every file edit whose heredoc body happens to contain the line.
 *
 * `VAR=x`, `cd`, `export` and `timeout` are stripped from the left so the head is the thing
 * actually being run, not an environment prefix.
 *
 * HEREDOC BODIES ARE SKIPPED, and that is not tidiness. A newline is a command separator, so
 * splitting on one turns the body of `cat > x.mjs <<'EOF'` into a series of segments -- and a
 * body that happens to contain the line `pnpm test` then reads as a check that ran. It did
 * not run; it is text in a file. The entry it would produce is a FABRICATED EVENT in the
 * ledger, which is the one thing this project exists to prevent, so the body is skipped
 * rather than counted.
 *
 * Measured on a FROZEN list of the corpus's 72,014 Bash commands -- frozen because
 * ~/.claude/projects is live and a per-variant re-sweep is not a controlled comparison:
 *
 *                                    segments   commands that check   entries
 *   splitting on every newline        922,333                6,940       493
 *   skipping heredoc bodies           424,353                6,826       486
 *
 * So 497,980 of those segments, 54%, are file CONTENTS rather than commands. 149 body lines
 * match a check label; 145 of them sit in the 122 commands whose label this rule changes, and
 * the other four are in commands whose own head already resolved to the same label. The rule
 * removes 7 verification_run entries --
 * seven rows that would have asserted a check ran when what actually happened is that someone
 * wrote a file. Seven is a small number and the reason to fix it is not its size: it is that
 * every one of those rows is a fabrication, and a ledger that fabricates events is not one
 * anything else in this project can be trusted against.
 *
 * The cost of the rule, stated: a heredoc opener that is never terminated swallows the rest of
 * the command, and a check after it is missed. Measured: 5 of the corpus's 12,818 openers are
 * unterminated. False negatives rather than fabrications -- the direction to err in, but still
 * an error.
 */
export function execSegments(command: string): readonly (readonly string[])[] {
  const out: string[][] = [];
  let heredoc: string | undefined;

  for (const line of command.split('\n')) {
    if (heredoc !== undefined) {
      // `<<-` allows the terminator to be indented, and so does this.
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const opened = HEREDOC.exec(line);

    for (const raw of line.split(/&&|;|\|/)) {
      const tokens = raw
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      let at = 0;
      while (at < tokens.length) {
        const token = tokens[at] ?? '';
        if (ASSIGNMENT.test(token)) {
          at += 1;
          continue;
        }
        const head = token.split('/').pop() ?? token;
        if (STRIP_ONE.has(head)) {
          at += 2;
          continue;
        }
        out.push(tokens.slice(at).map((one) => one.split('/').pop() ?? one));
        break;
      }
    }

    // After the line's own segments: the body starts on the NEXT line.
    if (opened !== null) heredoc = opened[1];
  }

  return out;
}

/**
 * What check this segment runs, or `undefined` if it runs none.
 *
 * Returns a LABEL rather than a boolean so the entry can record which check it was. The label
 * is bounded by construction -- a head and at most its sub-verb -- which is what keeps a
 * heredoc holding an entire source file out of the store.
 */
function checkLabel(segment: readonly string[]): string | undefined {
  const head = segment[0];
  if (head === undefined) return undefined;

  if (BARE_RUNNERS.has(head)) return head;
  if (head === 'cargo') {
    const verb = segment[1];
    return verb === 'test' || verb === 'clippy' || verb === 'check' ? `${head} ${verb}` : undefined;
  }
  if (head === 'go') return segment[1] === 'test' ? `${head} test` : undefined;
  if (RUN_VIA.has(head)) {
    const verb = segment[1];
    if (verb === undefined) return undefined;
    return CHECK_VERB.has(verb) || BARE_RUNNERS.has(verb) || verb === 'align'
      ? `${head} ${verb}`
      : undefined;
  }
  if (PACKAGE_MANAGERS.has(head)) {
    let at = 1;
    while (at < segment.length && FLAG_WITH_VALUE.has(segment[at] ?? '')) at += 2;
    const verb = segment[at];
    if (verb === 'run') {
      const script = segment[at + 1];
      return script !== undefined && CHECK_VERB.has(script) ? `${head} run ${script}` : undefined;
    }
    return verb !== undefined && CHECK_VERB.has(verb) ? `${head} ${verb}` : undefined;
  }
  return undefined;
}

/** The first check a command runs, or `undefined`. */
export function checkRunner(command: string): string | undefined {
  for (const segment of execSegments(command)) {
    const label = checkLabel(segment);
    if (label !== undefined) return label.slice(0, 60);
  }
  return undefined;
}

// ---------------------------------------------------------------------------

/** A skill that has been active without interruption, from its first record to now. */
interface SkillRun {
  readonly skill: string;
  readonly agent: string | undefined;
  readonly sessionId: string;
  readonly project: string;
  readonly occurredAt: string | undefined;
  /** The FIRST record's cwd and branch, for the same reason as the rest of this struct. */
  readonly locality: Locality;
  /** The FIRST record's uuid. The run's identity, and stable across a re-ingest. */
  readonly uuid: string;
}

/**
 * Create a deriver. One per sweep, or one per file -- `accept` resets on a file change, so
 * reusing it across files is the intended use and reusing it across SWEEPS is not.
 */
export function createDeriver(): Deriver {
  let path: string | undefined;
  /**
   * tool_use id -> what that invocation was, per file. The join that names a denial and
   * identifies a check.
   *
   * The COMMAND is carried here rather than read where it is needed, and that is not an
   * optimisation: the command lives on the `tool_use` block of an ASSISTANT record, and the
   * result it belongs to arrives on a LATER USER record. By the time a check result is in
   * hand the record that named the command has already streamed past, so a lookup that
   * searched the current record would find nothing and silently report zero checks. Measured
   * during development: it did exactly that.
   */
  let invocations = new Map<
    string,
    { readonly name: string; readonly command: string | undefined }
  >();
  /** Keys already issued for THIS file, so a repeat is suffixed rather than lost. */
  let issued = new Set<string>();
  let run: SkillRun | undefined;
  /**
   * The last check verdict in this file, which is what "a verdict change" is measured
   * against. Deliberately advanced by EVERY check run, including the ones that produce no
   * entry: a filter that only remembered the emitted runs would compare each green against
   * the last green and find no change at all.
   */
  let lastVerdict: boolean | undefined;

  const counters: DeriveCounters = {
    records: 0,
    entries: 0,
    keyCollisions: 0,
    unkeyable: 0,
    unverdictable: 0,
  };

  const key = (raw: string): string => {
    let candidate = raw;
    let suffix = 2;
    while (issued.has(candidate)) {
      candidate = `${raw}#${String(suffix)}`;
      suffix += 1;
    }
    if (candidate !== raw) counters.keyCollisions += 1;
    issued.add(candidate);
    return candidate;
  };

  const emit = (
    out: DerivedEntry[],
    type: string,
    rawKey: string,
    sessionId: string,
    project: string,
    occurredAt: string | undefined,
    locality: Locality,
    properties: Record<string, unknown>,
    evidenceText?: string,
  ): void => {
    const entry: DerivedEntry = {
      type,
      key: key(rawKey),
      source: DERIVED_SOURCE,
      occurredAt,
      // OMITTED, never `''`, when the transcript carries neither -- `entries` refuses an empty
      // string and treats NULL as "not said", which is the distinction this project is built on.
      ...(locality.cwd === undefined ? {} : { cwd: locality.cwd }),
      ...(locality.branch === undefined ? {} : { branch: locality.branch }),
      properties: {
        ...properties,
        session_id: sessionId,
        project,
        // OMITTED when the transcript carries no timestamp, per the spec's own rule: an
        // absent time is not the epoch.
        //
        // This line is the one the unit tests actually caught. `occurredAt` is also the
        // envelope-level `DerivedEntry.occurredAt`, and for a while that field was populated
        // while this property was not -- so a sweep reported 100% timestamp coverage (it was
        // measuring the envelope field) while every entry in the store had `occurred_at` as
        // NOT MEASURED. The provenance argument above rests on the property, because the
        // property is what lands in `properties_json`; the envelope field is transient. A
        // coverage number computed from the field that does not survive to disk is the exact
        // false-green this project treats as severity-zero.
        ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
      },
      ...(evidenceText === undefined ? {} : { evidenceText }),
    };
    out.push(entry);
    counters.entries += 1;
  };

  /** Close the pending run, if any, producing its entry. */
  const flushRun = (out: DerivedEntry[]): void => {
    const pending = run;
    run = undefined;
    if (pending === undefined) return;
    emit(
      out,
      'skill_activation',
      // The FIRST record's uuid, not the last: a run that is still growing when the file ends
      // must key the same as it would have at any earlier flush point, or a re-ingest of a
      // live transcript would write a second entry for the same activation.
      `${pending.sessionId}:${pending.uuid}`,
      pending.sessionId,
      pending.project,
      pending.occurredAt,
      pending.locality,
      {
        skill: pending.skill,
        ...(pending.agent === undefined ? {} : { agent: pending.agent }),
      },
    );
  };

  const begin = (): void => {
    invocations = new Map();
    issued = new Set();
    lastVerdict = undefined;
  };

  const accept = (record: TranscriptRecord, file: TranscriptFile): readonly DerivedEntry[] => {
    const out: DerivedEntry[] = [];

    if (path !== file.path) {
      // The pending run belongs to the file being left, so it is flushed BEFORE the reset.
      flushRun(out);
      begin();
      path = file.path;
    }

    counters.records += 1;

    const sessionId = str(record['sessionId']);
    const occurredAt = str(record['timestamp']);
    const uuid = str(record['uuid']);
    const locality = localityOf(record);
    const blocksIn = blocks(record);

    // Index this record's tool invocations before reading its results: a denial and the
    // invocation it refused are on DIFFERENT records, so the name is only knowable from a
    // map built as the file streams past.
    for (const block of blocksIn) {
      if (block['type'] !== 'tool_use') continue;
      const id = str(block['id']);
      const name = str(block['name']);
      if (id === undefined || name === undefined) continue;
      const input = rec(block['input']);
      const command = input === undefined ? undefined : str(input['command']);
      invocations.set(id, { name, command });
    }

    // ---- tool_denial ------------------------------------------------------
    const denialKind = str(record['toolDenialKind']);
    if (denialKind !== undefined) {
      const useId = toolUseId(blocksIn);
      if (sessionId === undefined || useId === undefined) {
        counters.unkeyable += 1;
      } else {
        const name = invocations.get(useId)?.name;
        emit(
          out,
          'tool_denial',
          `${sessionId}:${useId}`,
          sessionId,
          file.project,
          occurredAt,
          locality,
          {
            denial_kind: denialKind,
            tool_use_id: useId,
            ...(name === undefined ? {} : { tool_name: name }),
          },
        );
      }
    }

    // ---- context_compaction ----------------------------------------------
    const metadata = rec(record['compactMetadata']);
    if (metadata !== undefined) {
      const pre = num(metadata['preTokens']);
      const post = num(metadata['postTokens']);
      const dropped = num(metadata['cumulativeDroppedTokens']);
      const duration = num(metadata['durationMs']);
      const trigger = str(metadata['trigger']);
      const discovered = list(metadata['preCompactDiscoveredTools']);
      if (sessionId === undefined || uuid === undefined) {
        // The identity is the record's own uuid, because a compaction has no tool call to
        // name it by -- `cumulativeDroppedTokens` is cumulative across the session, so it
        // names the Nth compaction only by accident.
        counters.unkeyable += 1;
      } else if (
        trigger === undefined ||
        pre === undefined ||
        post === undefined ||
        dropped === undefined ||
        duration === undefined
      ) {
        // All five are `required` in the spec and were present on 438 of 438 measured
        // compactions. Emitting an entry that cannot satisfy its own definition would fail
        // validation downstream, so the record is counted here instead -- the count is the
        // signal that the transcript's shape moved.
        counters.unkeyable += 1;
      } else {
        emit(
          out,
          'context_compaction',
          `${sessionId}:${uuid}`,
          sessionId,
          file.project,
          occurredAt,
          locality,
          {
            trigger,
            pre_tokens: pre,
            post_tokens: post,
            cumulative_dropped_tokens: dropped,
            duration_ms: duration,
            // OMITTED, never `[]`. Present on 282 of 438; on the other 156 the transcript says
            // nothing, and an empty array would say it looked and found none.
            ...(discovered === undefined ? {} : { discovered_tools: discovered }),
          },
        );
      }
    }

    // ---- skill_activation -------------------------------------------------
    const skill = str(record['attributionSkill']);
    if (skill !== undefined) {
      if (run !== undefined && run.skill === skill) {
        // Same activation, still running. The FIRST record's facts stand.
      } else {
        flushRun(out);
        if (sessionId === undefined || uuid === undefined) {
          counters.unkeyable += 1;
        } else {
          run = {
            skill,
            agent: str(record['attributionAgent']),
            sessionId,
            project: file.project,
            occurredAt,
            locality,
            uuid,
          };
        }
      }
    }

    // ---- verification_run and user_correction -----------------------------
    const useId = toolUseId(blocksIn);

    for (const block of blocksIn) {
      if (block['type'] !== 'tool_result') continue;
      const resultId = str(block['tool_use_id']);
      if (resultId === undefined) continue;

      // ---- verification_run ----------------------------------------------
      const invocation = invocations.get(resultId);
      if (invocation?.name === 'Bash') {
        const command = invocation.command;
        if (command !== undefined) {
          const runner = checkRunner(command);
          if (runner !== undefined) {
            const failed = block['is_error'];
            if (typeof failed !== 'boolean') {
              counters.unverdictable += 1;
            } else {
              const verdict = !failed;
              const previous = lastVerdict;
              lastVerdict = verdict;
              // The filter, and it is a filter rather than a preference. Measured: the corpus
              // holds 6,826 commands that run a check, which without this filter would make
              // `pnpm test` an entry and put a row in the store for every keystroke of a
              // red-green loop. A verdict CHANGE, or a first verified pass, is 486 -- the
              // moments the gate actually moved. 6,826 is the size of the signal, not of the
              // store, and it grows every time anyone runs a test.
              //
              // The chain is per FILE, not per session id, and the difference is measured:
              // chaining across a session id gives 171, because a session's subagent
              // transcripts share the parent's id and a verdict carried between two separate
              // conversations fabricates relationships neither one had.
              const firstPass = previous === undefined && verdict;
              const changed = previous !== undefined && previous !== verdict;
              if ((firstPass || changed) && sessionId !== undefined) {
                emit(
                  out,
                  'verification_run',
                  `${sessionId}:${resultId}`,
                  sessionId,
                  file.project,
                  occurredAt,
                  locality,
                  {
                    runner,
                    verdict: verdict ? 'passed' : 'failed',
                    // OMITTED on a first verified pass. "There was no earlier run" and
                    // "the earlier run agreed" are different facts.
                    ...(previous === undefined
                      ? {}
                      : { previous_verdict: previous ? 'passed' : 'failed' }),
                  },
                );
              }
            }
          }
        }
      }
    }

    // ---- user_correction --------------------------------------------------
    const feedback = str(record['userFeedback']);
    if (feedback !== undefined) {
      if (sessionId === undefined || uuid === undefined) {
        counters.unkeyable += 1;
      } else {
        const name = useId === undefined ? undefined : invocations.get(useId)?.name;
        emit(
          out,
          'user_correction',
          `${sessionId}:${uuid}`,
          sessionId,
          file.project,
          occurredAt,
          locality,
          { ...(name === undefined ? {} : { tool_name: name }) },
          feedback,
        );
      }
    }

    return out;
  };

  return {
    accept,
    drain: (): readonly DerivedEntry[] => {
      const out: DerivedEntry[] = [];
      flushRun(out);
      begin();
      path = undefined;
      return out;
    },
    counters,
  };
}

/** The tool_use id a record's first block refers to, when it refers to one. */
function toolUseId(blocksIn: readonly Record<string, unknown>[]): string | undefined {
  for (const block of blocksIn) {
    const id = str(block['tool_use_id']);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The command behind a Bash result.
 *
 * The transcript does NOT put the command on the result -- it is on the `tool_use` block of
 * the assistant record that invoked it, which has already streamed past. That is what the
 * per-file `invocations` map is for, and why it holds the command and not just the name: the
 * alternative is reading the file twice, and the second read would be of a 107 MB file.
 */
