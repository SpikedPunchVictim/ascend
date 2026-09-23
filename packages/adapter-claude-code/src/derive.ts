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
import { outputVerdict } from './output-verdict.js';
import { projectRelativeCwd } from './transcript-file.js';
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
   * Entries whose per-event key was already issued in this SWEEP, so it was suffixed `#2`.
   *
   * CENSUS, not a sample. Both arms swept ONE frozen snapshot of the corpus -- 913 files,
   * 527,122 records, 1,816 entries -- so the only variable is this file:
   *
   *   before `asc-iq6`   8 collisions   1,815 distinct keys   1 DUPLICATE key
   *   after  `asc-iq6`   9 collisions   1,816 distinct keys   0 duplicate keys
   *
   * The whole difference is one line of 1,816: the second occurrence of
   * `verification_run|<session>:toolu_...` gained a `#2`, and every other key is byte-identical
   * across the two sweeps. That is what "a key that does not collide is unchanged" means as a
   * measurement rather than an argument. The 9th collision is the class the per-file set was
   * blind to by construction -- a repeat across two files of one session.
   *
   * An earlier reading of 6 on the 2026-09-15 corpus is superseded: it was taken while the set
   * was per file, so it counted same-file repeats only.
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
   * compaction with no `session_id`, a skill activation with no record uuid, or a verification
   * run whose verdict was readable but could not be attributed to a session and would
   * otherwise have been a first pass or a change. Also a denial or a correction whose record
   * carries MORE than one `tool_result` block (`toolUseId`, `asc-ik9`): `toolDenialKind` and
   * `userFeedback` are record-level facts, so with more than one candidate invocation there is
   * no way to know which one they name, and guessing would be a silent misattribution rather
   * than a visible drop. Should be zero; a non-zero value means the corpus holds rows nothing
   * can key, which is a real limitation to state rather than a bug to hide.
   */
  unkeyable: number;
  /**
   * Bash check runs whose result carried no boolean `is_error`, so no verdict could be read at
   * all. Distinct from `unkeyable`: this is a missing VALUE, not a missing identity -- a
   * verdict that could not be attributed to a session is counted there instead, because it is
   * a different failure of the transcript's shape and conflating the two would blur which one
   * fired. Should be zero, and measured zero on every drive of the real corpus: `is_error` was
   * a boolean on every check result seen. A non-zero value means the transcript changed shape
   * and `verification_run` is silently going blind -- which is why it is a counter and not an
   * assumption.
   *
   * Such a run is dropped AND does not advance the verdict chain, so the next readable run is
   * compared against the last verdict that was actually read. That is the conservative choice:
   * the alternative, treating an unreadable result as a pass, would fabricate a verdict change
   * out of a field the transcript failed to carry. A sessionless-but-readable verdict (counted
   * as `unkeyable`, just above) is held to the same rule for the same reason.
   */
  unverdictable: number;
  /**
   * Check runs whose exit status is NOT the check's own -- something after it can replace its
   * status (`| tail`, `;`, `||`, `&`; see `checkRun`) -- and whose output holds no line that
   * settles a verdict (`outputVerdict`). No entry is written and the chain does not advance,
   * for the reason `unverdictable` gives: the alternative is trusting `is_error`, and measured
   * on the frozen corpus (dogfood/0012) it said "passed" over 1,236 masked runs whose own
   * output said "failed".
   *
   * NOT expected to be zero, unlike the two counters above: it is the size of what this
   * adapter cannot see, and measured it is most masked runs -- 5,442 of 8,157 on the corpus,
   * largely output cut by `| tail` or never printed.
   */
  masked: number;
  /**
   * `user_correction` records whose `userFeedback` was the AskUserQuestion clarification form
   * (`CLARIFICATION_PREAMBLE`, above) rather than the user's own prose. THE ENTRY IS STILL
   * EMITTED for these -- that is what makes this counter different from `unkeyable`, just
   * above: the event's identity is fine (the user really did ask to clarify), only its prose
   * is absent. `evidenceText` is omitted rather than set to the harness's own questions,
   * because those questions read as plausible user content while the boilerplate at least read
   * as boilerplate -- see the comment at `CLARIFICATION_PREAMBLE`'s only caller. A withheld
   * `evidence_text` is a withheld measurement, so it is counted for the same reason a dropped
   * record is: a caller can assert against a number, not against a silence.
   *
   * MEASURED 2026-09-18: 10 of 19 `user_correction`-triggering records on the local corpus.
   */
  unquotable: number;
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
 * `cwd` HERE IS PROJECT-RELATIVE, not the transcript's raw absolute path (asc-tlc). The record's
 * own `cwd` belongs to a DIFFERENT project than this store's -- see `DerivedEntry.cwd`'s doc for
 * why the raw value is even wanted -- so it cannot be made relative to this store's root the way
 * `record.ts` does for a self-recorded entry; it is made relative to ITS OWN project's root
 * instead, via `projectRelativeCwd`. The absolute prefix that root recovers is the same on every
 * row of that project, so deleting it costs nothing the corpus needs (asc-37x DESIGN).
 *
 * Both are `undefined` rather than `''` on absence, and that is not tidiness: `entries` has
 * `CHECK (cwd IS NULL OR cwd <> '')`, so an empty string is a REFUSED write, while a `null` is
 * the honest "the transcript did not say". `str` already folds both absences into `undefined` --
 * and a `cwd` that IS present but whose label does not encode-match it (`projectRelativeCwd`
 * returning `undefined`) is folded into that same absence below. That is a NEW reason for the
 * same `undefined`: not "the transcript did not say", but "the transcript said something this
 * rule does not recognise how to place under its own root" -- fail closed, per that function's
 * own doc, rather than write a guess.
 */
interface Locality {
  readonly cwd: string | undefined;
  readonly branch: string | undefined;
}

/**
 * The two transcript fields, under their own names, with absence preserved -- `cwd` made
 * relative to `project`, the transcript's own root, rather than left as the raw absolute path.
 */
function localityOf(record: TranscriptRecord, project: string): Locality {
  const rawCwd = str(record['cwd']);
  return {
    cwd: rawCwd === undefined ? undefined : projectRelativeCwd(project, rawCwd),
    branch: str(record['gitBranch']),
  };
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
  return execSteps(command).flatMap((step) => (step.segment === undefined ? [] : [step.segment]));
}

/**
 * The shell's control operators, CAPTURED so a step keeps the one that follows it. `|&` before
 * `|`, and `&` only when it is not part of a redirection: `2>&1`, `>&2` and `&>file` are not
 * operators, and reading them as one would split `pnpm test 2>&1` into two steps.
 */
const OPERATOR = /(\|\||&&|;|\|&|\|(?!&)|(?<![<>&])&(?![>&]))/;

/**
 * One executed step: its segment (`undefined` when stripping leaves nothing, as `cd dir` does --
 * it still RAN, and still sets the exit status) and the operator after it (`'\n'` for a line
 * end, `undefined` after the last step unless that step is backgrounded).
 */
interface ExecStep {
  readonly segment: readonly string[] | undefined;
  readonly next: string | undefined;
}

function execSteps(command: string): readonly ExecStep[] {
  const steps: { segment: readonly string[] | undefined; next: string | undefined }[] = [];
  let heredoc: string | undefined;

  for (const line of command.split('\n')) {
    if (heredoc !== undefined) {
      // `<<-` allows the terminator to be indented, and so does this.
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const opened = HEREDOC.exec(line);

    const parts = line.split(OPERATOR);
    for (let at = 0; at < parts.length; at += 2) {
      const raw = parts[at] ?? '';
      if (raw.trim().length === 0) continue;
      steps.push({ segment: stripSegment(raw), next: parts[at + 1] ?? '\n' });
    }

    // After the line's own segments: the body starts on the NEXT line.
    if (opened !== null) heredoc = opened[1];
  }

  // A trailing `;` or line end is no operator: nothing follows it. A trailing `&` still is --
  // it backgrounds the step, and the command's status becomes 0 at once.
  const last = steps.at(-1);
  if (last !== undefined && last.next !== '&') last.next = undefined;
  return steps;
}

/** The step's tokens from its real head on, or `undefined` if stripping consumes them all. */
function stripSegment(raw: string): readonly string[] | undefined {
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
    return tokens.slice(at).map((one) => one.split('/').pop() ?? one);
  }
  return undefined;
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
  return checkRun(command)?.runner;
}

/**
 * The first check a command runs, and whether the command's exit status -- the tool result's
 * `is_error` -- is that check's own.
 *
 * The shell reports the status of the last step it ran. `&&` cannot replace a check's status:
 * when the check fails, nothing after it runs. Every other operator can. A pipe reports its
 * last command, so `pnpm test | tail` exits 0 on a failing suite; `;`, a newline and `||` run
 * something else afterwards; `&` returns 0 at once. So the status is the check's own exactly
 * when every operator after it is `&&`. Measured on the frozen corpus (dogfood/0012): outside
 * that rule, 1,578 of 3,349 runs with a summary had `is_error` false over a failing one.
 *
 * `set -o pipefail` would make a pipe honest, and is not honoured: 9 of 8,339 check runs
 * mention it, and treating them as masked costs a verdict, never a wrong one.
 */
export function checkRun(
  command: string,
): { readonly runner: string; readonly exitStatusIsCheck: boolean } | undefined {
  const steps = execSteps(command);
  for (const [at, step] of steps.entries()) {
    const label = step.segment === undefined ? undefined : checkLabel(step.segment);
    if (label === undefined) continue;
    const exitStatusIsCheck = steps
      .slice(at)
      .every((later) => later.next === undefined || later.next === '&&');
    return { runner: label.slice(0, 60), exitStatusIsCheck };
  }
  return undefined;
}

/**
 * A check run's verdict and where it was read from, or why none could be read.
 *
 * `exitStatusIsCheck` decides the source, and there is no fallback between the two. An owned
 * run reads `is_error`; a masked run reads its output, and never `is_error`, because masked is
 * exactly the case where `is_error` belongs to something else.
 */
function readVerdict(
  exitStatusIsCheck: boolean,
  block: Readonly<Record<string, unknown>>,
):
  | { readonly verdict: boolean; readonly source: 'exit_status' | 'output' }
  | 'unverdictable'
  | 'masked' {
  if (exitStatusIsCheck) {
    const failed = block['is_error'];
    return typeof failed === 'boolean'
      ? { verdict: !failed, source: 'exit_status' }
      : 'unverdictable';
  }
  const said = outputVerdict(resultText(block['content']));
  return said === undefined ? 'masked' : { verdict: said === 'passed', source: 'output' };
}

/** A tool result's text: a string, or the `text` of each text block in an array. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// The AskUserQuestion clarification form. `userFeedback` on this form is not what the user
// said -- see `unquotable` on `DeriveCounters` for the measurement and the reasoning.
//
// Matched on the FIRST LINE only, never the full harness prose that follows it. The indented
// body ("This means they may have additional information...") is boilerplate a Claude Code
// release can reword at any time; a match on the full prefix would silently stop firing after
// such a copy-edit and quietly resume writing boilerplate into `evidence_text` with nobody the
// wiser. The opening sentence is what identifies the form, so it is the only thing tested.
//
// MEASURED 2026-09-18, every `*.jsonl` under `~/.claude/projects/` (read-only scan): 19
// `userFeedback` values total, 10 begin with this literal, the other 9 are the user's own
// prose -- a `startsWith` test on this literal alone has 0 false positives on that corpus.
const CLARIFICATION_PREAMBLE = 'The user wants to clarify these questions.';

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
  /**
   * Keys already issued for THIS SWEEP, so a repeat is suffixed rather than lost.
   *
   * **Sweep-wide, not per file, and the difference is the whole of `asc-iq6`.** Every raw key
   * here embeds a `sessionId`, and a session id is NOT per file: a session's subagent
   * transcripts carry the PARENT's session id -- the same fact the verdict chain below relies
   * on when it refuses to chain across one. Tool-use ids are unique within ONE agent's
   * conversation, so two sibling subagent transcripts can independently mint the same
   * `toolu_...`, and with a per-file set each file disambiguated against itself, found no
   * repeat, and emitted the SAME unsuffixed key. The collision existed only in the union --
   * which is exactly the scope the key claims.
   *
   * Measured when it was found, on the live corpus: one duplicate,
   * `verification_run|<session>:toolu_...`, from two subagent transcripts of one session
   * holding 218 and 141 records. Both reported the same `sessionId`. 861 of the 913
   * transcripts in that corpus are subagent transcripts, so this is the majority surface
   * rather than a corner of it.
   *
   * A set that spans the sweep costs one string per DERIVED entry, not per record read. Measured
   * on a frozen snapshot of that corpus: 1,816 entries from 527,122 records across 913 files.
   * Three orders of magnitude below the input it is already reading, and not a reason to
   * reintroduce a correctness gap.
   *
   * `const` is load-bearing rather than tidiness: the defect was one assignment, in `begin()`,
   * and `const` is what makes reintroducing it a compile error instead of a review question.
   */
  const issued = new Set<string>();
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
    masked: 0,
    unquotable: 0,
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

  /**
   * Reset the state that belongs to ONE file, when the sweep moves to the next one.
   *
   * `issued` is deliberately NOT reset here -- see its own doc. It is the one piece of state
   * whose scope is the sweep rather than the file, because the keys it guards embed a session
   * id that several files share.
   */
  const begin = (): void => {
    invocations = new Map();
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
    const locality = localityOf(record, file.project);
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
          const run = checkRun(command);
          if (run !== undefined) {
            const reading = readVerdict(run.exitStatusIsCheck, block);
            if (reading === 'unverdictable') {
              counters.unverdictable += 1;
            } else if (reading === 'masked') {
              counters.masked += 1;
            } else {
              const { verdict, source } = reading;
              const runner = run.runner;
              const previous = lastVerdict;
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
              if (sessionId === undefined) {
                // Attribution failure on a verdict that WAS readable. Handled the same
                // conservative way as an unreadable one just above: the chain does not
                // advance. Advancing it here would let a LATER, attributable run silently
                // inherit this value as `previous_verdict` -- attributing a fact to a run the
                // store never actually holds, which is the exact fabrication this project's
                // rule forbids. Counted only when it was actually a candidate for an entry: a
                // repeat that matches the known chain was never going to be written even with
                // a session id, so counting it here would overstate what was lost.
                if (firstPass || changed) counters.unkeyable += 1;
              } else {
                lastVerdict = verdict;
                if (firstPass || changed) {
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
                      verdict_source: source,
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
    }

    // ---- user_correction --------------------------------------------------
    const feedback = str(record['userFeedback']);
    if (feedback !== undefined) {
      if (sessionId === undefined || uuid === undefined) {
        counters.unkeyable += 1;
      } else {
        const name = useId === undefined ? undefined : invocations.get(useId)?.name;
        // The AskUserQuestion clarification form carries none of the user's own words -- see
        // `unquotable` on `DeriveCounters`. The entry still stands (the user did act), it is
        // only the prose that is withheld, so `evidenceText` is passed as `undefined` rather
        // than the harness's own questions.
        const quotable = !feedback.startsWith(CLARIFICATION_PREAMBLE);
        if (!quotable) counters.unquotable += 1;
        emit(
          out,
          'user_correction',
          `${sessionId}:${uuid}`,
          sessionId,
          file.project,
          occurredAt,
          locality,
          { ...(name === undefined ? {} : { tool_name: name }) },
          quotable ? feedback : undefined,
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

/**
 * The tool_use id a record's `tool_result` block refers to, when the record carries EXACTLY
 * one such block.
 *
 * `asc-ik9`: this used to be first-match-wins, which was correct only because every record
 * measured across the whole local corpus carries at most one `tool_result` -- never proven, only
 * observed, and the transcript format is a third party's, not this project's. `toolDenialKind`
 * and `userFeedback` (the two callers of this function, `tool_denial` and `user_correction`) are
 * RECORD-level facts: the record says a denial or a correction happened, but not which of
 * several tool_result blocks it is about. Picking the first one when there is more than one
 * would silently attribute the fact to a possibly-wrong tool call -- a wrong entry recorded is a
 * worse failure than a dropped one, because a drop is visible in `counters.unkeyable` (both
 * callers already treat `undefined` that way) and a wrong attribution is invisible until
 * something else contradicts it. So more than one candidate refuses the id entirely, exactly
 * like zero candidates already did.
 *
 * `verification_run`, below, is deliberately NOT built on this function: "did any of this
 * record's tool_result blocks report a Bash check?" is well-defined per block, with no record-
 * level fact to attribute, so it loops over every block rather than requiring exactly one.
 */
function toolUseId(blocksIn: readonly Record<string, unknown>[]): string | undefined {
  let found: string | undefined;
  for (const block of blocksIn) {
    const id = str(block['tool_use_id']);
    if (id === undefined) continue;
    if (found !== undefined) return undefined;
    found = id;
  }
  return found;
}

/**
 * The command behind a Bash result.
 *
 * The transcript does NOT put the command on the result -- it is on the `tool_use` block of
 * the assistant record that invoked it, which has already streamed past. That is what the
 * per-file `invocations` map is for, and why it holds the command and not just the name: the
 * alternative is reading the file twice, and the second read would be of a 107 MB file.
 */
