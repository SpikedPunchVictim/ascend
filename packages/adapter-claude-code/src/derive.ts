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
 * types exist at all:
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
import { DERIVED_SOURCE, isFindingLens } from './derived-types.js';
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
   * Entries whose per-event key was already issued in this SWEEP **by the same type**, so it was
   * suffixed `#2`. Per type since `asc-77b7`: the namespace is the type because the id's is, so a
   * second type minting one raw key is not a collision at all and is no longer counted as one.
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
   * **Both figures predate the per-type namespace and are the FLAT-SET reading.** Removing a
   * namespace dimension can only make fewer pairs collide, so the namespaced count is at most
   * these numbers and may be lower by however many of the 9 were cross-type -- which was not
   * measured. An upper bound, then, and not re-measured here: the spurious ids were counted on the
   * live store instead, 2026-10-07 -- 8 of 24 suffixes, every one a `verification_run` whose bare
   * key a `tool_denial` also holds, every one at `verification_run` v1 while the rule is at v4
   * (`derived-types.ts:146`, read 2026-10-07), so a re-ingest re-ids them through the ordinary
   * version mechanism and no migration is owed. Regenerable with `node
   * spike/asc-77b7-suffix-namespace.mjs`.
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
  /**
   * `ReportFindings` findings whose `category` is not one of the nine lens slugs
   * (`FINDING_LENSES`, `derived-types.ts`). An ABSENT `category` is counted here too rather than
   * under `unreportableFindings`: "not a value we accept" is one condition, and splitting it by
   * absent-versus-wrong would make this counter incomparable with the normalizer's
   * `offVocabularyFindings`, which sees the same two cases and has one number for both.
   *
   * NO ENTRY IS WRITTEN for these, for the reason `context_compaction`'s required-fields branch
   * gives above: the `class` property is an `enum`, so an entry carrying a tenth value fails
   * validation downstream and is rejected at write time -- which is a rejected write rather than
   * a record. Emitting it anyway would trade a count for a crash report.
   *
   * The value is NOT lost, and that is the point of counting it here rather than filtering it
   * here: `normalize.ts` puts the raw `category` on the `review.finding` EVENT unconditionally,
   * so the replay log shows the reviewer used a word outside the nine whether or not the store
   * would take it. The store and the log answer different questions, and this counter is the
   * one that says how often they disagree.
   *
   * Should be zero for as long as the reviewer instruction is the only thing naming a category.
   * MEASURED 2026-09-26: 0, because `ReportFindings` has been called 0 times -- so this is the
   * counter's value on an EMPTY population, not evidence that the vocabulary holds.
   */
  offVocabularyFindings: number;
  /**
   * `ReportFindings` findings missing a field their own type requires -- `file` or `summary`,
   * both of which the tool's schema declares. Counted here rather than emitted, for the same
   * reason as `offVocabularyFindings`, and named in the same `-able` family as `unkeyable` and
   * `unverdictable`: the finding cannot be reported.
   *
   * `line` is deliberately NOT in this set. It is optional in the type because a finding is not
   * always line-anchored, so an absent one is the transcript saying nothing -- omitted, never
   * `0`. Only a field the type REQUIRES can make a finding unreportable.
   *
   * Should be zero. MEASURED 2026-09-26: 0, on the same empty population as the counter above.
   */
  unreportableFindings: number;
  /**
   * `ReportFindings` findings carried by a call the harness REFUSED. NO ENTRY IS WRITTEN for
   * these, and that is deliberately a change of behaviour rather than a description of one
   * (`asc-2uov`).
   *
   * The findings are an ARGUMENT to the call, so they are readable whether or not the call was
   * accepted -- and until this rule existed the deriver read the input and never the result, so a
   * refused call contributed its findings to the store. `ReportFindings` is the instrument a
   * finding is recorded BY (the type's own sentence is "Never by hand"), so a call the instrument
   * rejected is not a reading, and counting it is the "reports success wrongly" class: a per-lens
   * count asserting a finding the reviewer's tool refused to accept.
   *
   * What makes this a COUNT rather than a note. A refusal is followed by a corrected retry
   * carrying the SAME findings, so the defect doubled counts rather than adding a stray row.
   * MEASURED 2026-09-30 on this store: 18 `reported` entries for 9 distinct findings --
   * `call_0o92cyc2` (refused; 6 `short_summary` values over the tool's 60-character maximum,
   * longest 79) and `call_p374n0av` (accepted) differ in ZERO of the 9 `(file, line, summary)`
   * triples and in zero lens values -- so every per-lens count for that session read exactly
   * doubled. MEASURED 2026-10-01 across every transcript on the machine: 35 calls, 3 refused
   * (8.6%), 26 findings carried by them; 25 of the 26 (96.2%) are duplicated by a later accepted
   * call, and the single one that is not sits in an ephemeral project ingest never reads.
   *
   * So this number OVERSTATES what was lost, deliberately and in the safe direction: it counts
   * what the store did not take, not what the corpus does not know. A refusal that is retried
   * loses nothing, which is 96.2% of every refusal measured. Read beside the same type's entry
   * count, not instead of it.
   *
   * A call whose result the transcript never showed is NOT counted here and IS emitted -- this
   * rule suppresses only a refusal it can see, because the alternative is dropping a real finding
   * to punish a missing record. Neither is a result whose `is_error` is absent: an unstated
   * verdict is not a refusal.
   */
  refusedFindings: number;
  /**
   * Attributed runs in a SUBAGENT stream that invoked no skill of its own: the subagent was
   * spawned while its parent's skill was active and inherited the parent's `attributionSkill`.
   * NO ENTRY IS WRITTEN, because the activation is the parent's and is already counted there
   * (`asc-gtnu.17`, dogfood/0020).
   *
   * NOT expected to be zero. It is the number of streams a skill fanned out into. MEASURED
   * 2026-09-27, per (stream, skill) on the live corpus: 52. Under the first rule each of these
   * was an activation, which is how 24 bug-hunt "activations" came from 7 requests.
   */
  inheritedSkillRuns: number;
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
 * is a copy, not a lookup. The sixth type `review_finding` reaches the store through this same
 * `emit`, so it inherits the copy -- but it has 0 entries, so this measurement does not cover it
 * and nothing here should be read as having observed it.
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

/**
 * Runners that are a check only in some modes, and the flags that select one (asc-6ola.15).
 *
 * `prettier --write` rewrites files and exits 0; counting it made a formatting step a passed
 * verification. Measured on the frozen corpus (dogfood/0015): of 231 prettier segments, 138
 * were `--write`, 92 a check mode and 1 neither -- and without a check flag prettier prints the
 * formatted text, which checks nothing either. So prettier counts only with a flag listed here.
 *
 * `eslint --fix` is NOT here: it still exits non-zero on what it cannot fix, so it is a check.
 * `ruff format` would belong here and is left out because the corpus runs ruff zero times.
 */
const CHECK_MODE: Readonly<Record<string, ReadonlySet<string>>> = {
  prettier: new Set(['--check', '-c', '--list-different', '-l']),
};

/** Whether `runner`, given `args`, runs in a mode that checks rather than one that rewrites. */
function inCheckMode(runner: string, args: readonly string[]): boolean {
  const modes = CHECK_MODE[runner];
  return modes === undefined || args.some((arg) => modes.has(arg));
}
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
  /** The same tokens with their directories kept: a check's targets are paths (asc-gtnu.10). */
  readonly words: readonly string[] | undefined;
  readonly next: string | undefined;
}

/** A step from its raw text: its words from the real head on, and those words basenamed. */
function stepOf(raw: string, next: string | undefined): ExecStep {
  const words = strippedWords(raw);
  return { segment: words?.map((one) => one.split('/').pop() ?? one), words, next };
}

type Quote = "'" | '"' | undefined;

/**
 * One physical line with its quoted text MASKED -- every character inside quotes, and every
 * character a backslash escapes, becomes `_` -- so a newline or an operator in an argument cannot
 * be read as a boundary (asc-7gz2). The mask has the line's length, so a position found in it is
 * a position in the line. A comment is CUT, not masked: `#` at the start of a word ends the line,
 * which keeps an apostrophe in `# it's` from opening a quote. `quote` is the state the line opens
 * in and the state it leaves; a quote still open at the line's end continues onto the next.
 *
 * Not a shell parser, and deliberately so: no `$'...'`, backticks or `$(...)`. The measured
 * damage was quoted program text (`node -e`, `python3 -c`), and quotes are what this reads.
 */
function maskLine(line: string, quote: Quote): { text: string; mask: string; quote: Quote } {
  let mask = '';
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] ?? '';
    if (quote === "'") {
      if (char === "'") quote = undefined;
      mask += char === "'" ? char : '_';
    } else if (char === '\\' && quote === '"') {
      mask += '__';
      at += 1;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      mask += char === '"' ? char : '_';
    } else if (char === '\\') {
      mask += '__';
      at += 1;
    } else if (char === '#' && (at === 0 || /\s/.test(line[at - 1] ?? ''))) {
      return { text: line.slice(0, at), mask, quote };
    } else {
      if (char === "'" || char === '"') quote = char;
      mask += char;
    }
  }
  return { text: line, mask: mask.slice(0, line.length), quote };
}

/** `text` cut at each operator the MASK shows, as alternating parts and operators. */
function splitOperators(text: string, mask: string): string[] {
  const parts: string[] = [];
  const operators = new RegExp(OPERATOR.source, 'g');
  let from = 0;
  for (const found of mask.matchAll(operators)) {
    parts.push(text.slice(from, found.index), found[0]);
    from = found.index + found[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

/** `sh -c`, `bash -lc`, `zsh -ec`...: a shell handed a script, and the quote the script opens with. */
const SHELL_SCRIPT = /(?:^|\s)(?:\S*\/)?(?:ba|z)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+(['"])/;

/**
 * The script a step hands to `sh -c`, unquoted, or `undefined`.
 *
 * Masking quotes (asc-7gz2) makes a quoted argument opaque, and the script of `sh -c` is the one
 * quoted argument that IS commands: measured on the frozen corpus, 6 of the 55 checks that
 * quote-awareness removed were real runs inside one, from 148 commands that use the form.
 */
function shellScript(raw: string): string | undefined {
  const found = SHELL_SCRIPT.exec(raw);
  if (found === null) return undefined;
  const quote = found[1];
  const from = found.index + found[0].length;
  if (quote === "'") {
    const to = raw.indexOf("'", from);
    return to === -1 ? undefined : raw.slice(from, to);
  }
  for (let at = from; at < raw.length; at += 1) {
    if (raw[at] === '\\') at += 1;
    else if (raw[at] === '"') return raw.slice(from, at).replace(/\\(["\\$`])/g, '$1');
  }
  return undefined;
}

function execSteps(command: string): readonly ExecStep[] {
  const steps: {
    segment: readonly string[] | undefined;
    words: readonly string[] | undefined;
    next: string | undefined;
  }[] = [];
  let heredoc: string | undefined;
  let quote: Quote;
  // A logical line: physical lines joined while a quote is open across them.
  let text = '';
  let mask = '';
  let open = false;

  for (const line of command.split('\n')) {
    if (heredoc !== undefined) {
      // `<<-` allows the terminator to be indented, and so does this.
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const read = maskLine(line, quote);
    // The newline joining two physical lines is inside a quote, so the mask hides it too.
    text = open ? `${text}\n${read.text}` : read.text;
    mask = open ? `${mask}_${read.mask}` : read.mask;
    quote = read.quote;
    open = quote !== undefined;
    if (open) continue;

    // The opener is found in the mask, so `<<` inside quotes opens nothing; its tag is read from
    // the text, because a quoted tag (`<<'EOF'`) is masked.
    const opener = mask.indexOf('<<');
    const opened = opener === -1 ? null : HEREDOC.exec(text.slice(opener));
    const parts = splitOperators(text, mask);
    for (let at = 0; at < parts.length; at += 2) {
      const raw = parts[at] ?? '';
      if (raw.trim().length === 0) continue;
      const next = parts[at + 1] ?? '\n';
      const script = shellScript(raw);
      const inner = script === undefined ? [] : execSteps(script).map((step) => ({ ...step }));
      const last = inner.at(-1);
      if (last === undefined) {
        steps.push(stepOf(raw, next));
      } else {
        // The shell's status is its script's last step's, so that step inherits what follows.
        last.next = next;
        steps.push(...inner);
      }
    }

    // After the line's own segments: the body starts on the NEXT line.
    if (opened !== null) heredoc = opened[1];
  }
  // A quote never closed: what was read is one argument, as the shell would refuse to run it.
  if (open && text.trim().length > 0) steps.push(stepOf(text, '\n'));

  // A trailing `;` or line end is no operator: nothing follows it. A trailing `&` still is --
  // it backgrounds the step, and the command's status becomes 0 at once.
  const last = steps.at(-1);
  if (last !== undefined && last.next !== '&') last.next = undefined;
  return steps;
}

/** The step's tokens from its real head on, or `undefined` if stripping consumes them all. */
function strippedWords(raw: string): readonly string[] | undefined {
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
    return tokens.slice(at);
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

  if (BARE_RUNNERS.has(head)) return inCheckMode(head, segment.slice(1)) ? head : undefined;
  if (head === 'cargo') {
    const verb = segment[1];
    return verb === 'test' || verb === 'clippy' || verb === 'check' ? `${head} ${verb}` : undefined;
  }
  if (head === 'go') return segment[1] === 'test' ? `${head} test` : undefined;
  if (RUN_VIA.has(head)) {
    const verb = segment[1];
    if (verb === undefined) return undefined;
    if (!inCheckMode(verb, segment.slice(2))) return undefined;
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
export function checkRun(command: string):
  | {
      readonly runner: string;
      readonly exitStatusIsCheck: boolean;
      readonly paths: readonly string[];
    }
  | undefined {
  const steps = execSteps(command);
  for (const [at, step] of steps.entries()) {
    const label = step.segment === undefined ? undefined : checkLabel(step.segment);
    if (label === undefined || step.words === undefined) continue;
    const exitStatusIsCheck = steps
      .slice(at)
      .every((later) => later.next === undefined || later.next === '&&');
    return { runner: label.slice(0, 60), exitStatusIsCheck, paths: targetPaths(step.words) };
  }
  return undefined;
}

/** A redirection operator standing alone, whose file is the next word. */
const REDIRECT = /^\d*(?:[<>]{1,2}|&>{1,2}|>\|)$/;

/** A path with a directory in it, or a file name with a source-like extension. */
const PATH_SHAPED =
  /^(?:\.{0,2}\/)?[\w@.*-]+(?:\/[\w@.*-]+)+\/?$|^[\w@.-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|rb)$/;

/**
 * The files a check names as its targets (asc-gtnu.10): its path-shaped arguments, read from the
 * words with their directories kept. A check that names none ran over whatever its config
 * covers, and that is a different fact, so the list is then empty rather than guessed. Two
 * arguments are never targets: one right after a flag is taken as the flag's value
 * (`-p packages/cli/tsconfig.json`), and a redirect's file is where the output went. The cost is
 * an undercount after a boolean flag (`--watch src/a.ts`): a missing path, never a wrong one.
 *
 * Measured over 99,553 frozen Bash commands, 2026-09-28: 1,335 of 8,638 check runs name a
 * target, 1,019 of them `npx vitest` (of its 1,292 runs); 1,932 of the 1,945 paths named carry a
 * directory.
 */
function targetPaths(words: readonly string[]): string[] {
  return words.filter(
    (token, at) =>
      at > 0 &&
      !token.startsWith('-') &&
      !(words[at - 1] ?? '').startsWith('-') &&
      // A redirect's file is where output went, not what was checked: `> x.log`, `2>x.log`.
      !/[<>]/.test(token) &&
      !REDIRECT.test(words[at - 1] ?? '') &&
      !token.includes('://') &&
      PATH_SHAPED.test(token),
  );
}

/**
 * A check run's verdict and where it was read from, or why none could be read.
 *
 * `exitStatusIsCheck` decides the source, and there is no fallback between the two. An owned
 * run reads `is_error`; a masked run reads its output, and never `is_error`, because masked is
 * exactly the case where `is_error` belongs to something else.
 */
export function readVerdict(
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
export function resultText(content: unknown): string {
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

/**
 * The harness's typed findings tool, which is where a review finding comes from (asc-gtnu).
 *
 * The COMPETING source was a reviewer running `asc record` by hand, and it is the mechanism
 * `EV-16` already measured at 0 of 15 sessions -- "not one invoked `asc` in any form". A design
 * that depends on a model choosing to run a CLI is a design whose mechanism is known not to
 * fire, so the finding is derived from the tool call the harness already hands a reviewer.
 *
 * The NAME and the `findings[]` shape are carried from reconnaissance of the harness's tool
 * schema on 2026-09-26 and NOT from an event anyone has seen: measured the same day, the tool
 * has been called 0 times across 1,236 transcript files. This string is therefore an untested
 * assumption with a test below it -- the fixture is the only thing that has ever exercised the
 * branch, and if the real tool is spelled differently the derivation reports 0 rows and says so.
 */
const REPORT_FINDINGS_TOOL = 'ReportFindings';

/**
 * The harness tool that loads a skill, `input.skill` naming it. A call to it is an activation
 * whether or not the records after it carry `attributionSkill`: inside a subagent they almost
 * never do (77 of 84 measured calls, `asc-gtnu.17`).
 */
const SKILL_TOOL = 'Skill';

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
  /**
   * False when the run is not an activation of its own: it was claimed by the `Skill` call
   * that started it, or it was inherited by a subagent. The run is still TRACKED either way,
   * so that its continuation records do not each start another run.
   */
  readonly emits: boolean;
}

/**
 * A `ReportFindings` call that has been read but not yet judged, held until its result arrives.
 *
 * The findings are carried HERE, already filtered and shaped into the properties they will be
 * written with, rather than re-read at the result: the call is where they exist, and the result
 * record holds no copy of them. Every field below is captured at the CALL for the reason
 * `SkillRun`'s are -- `occurred_at` and the locality belong to the moment the reviewer reported,
 * not to the moment the harness answered (`asc-2uov`).
 */
interface PendingReport {
  readonly reportKey: string;
  readonly sessionId: string;
  readonly project: string;
  readonly occurredAt: string | undefined;
  readonly locality: Locality;
  /** One per finding that will be WRITTEN, in the order the call carried them. */
  readonly ready: readonly {
    readonly index: number;
    readonly properties: Record<string, unknown>;
  }[];
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
   * Keys already issued for THIS SWEEP, per TYPE, so a repeat within a type is suffixed rather than
   * lost.
   *
   * Per type since asc-77b7: the members are namespaced `type\u0000key` because the ids they become
   * are namespaced by type (`derived-types.ts:122`). See `key` below for what the flat set used to
   * do to a cross-type pair.
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
   * skill name -> `Skill` calls in THIS file not yet matched to the attributed run they start.
   *
   * A main-stream `Skill` call is followed by records carrying `attributionSkill` (31 of the
   * measured invocations). Both are the same activation, so the call writes the entry and the
   * run it starts is claimed rather than written again. One call claims ONE run. A later run of
   * the same skill with nothing left to claim is a new activation, as it always was.
   */
  let claims = new Map<string, number>();
  /**
   * The last check verdict in this file, which is what "a verdict change" is measured
   * against. Deliberately advanced by EVERY check run, including the ones that produce no
   * entry: a filter that only remembered the emitted runs would compare each green against
   * the last green and find no change at all.
   */
  let lastVerdict: boolean | undefined;
  /**
   * `ReportFindings` calls seen in THIS file whose result has not arrived yet, keyed by the call's
   * own tool_use id. Per FILE, for the reason the `invocations` map above is: a sweep reads one
   * file at a time, so a result in the next file cannot belong to the same stream, and letting it
   * resolve this one would hand one transcript's verdict to another transcript's finding.
   *
   * A call's findings are an ARGUMENT to it, so they are readable the moment the call is read --
   * whether the call was ACCEPTED is a property of its RESULT, which lands on a later record.
   * Holding the findings here until that record arrives is what makes the refusal readable at all;
   * it is the same shape as `invocations`, one level up (`asc-2uov`).
   */
  let pendingReports = new Map<string, PendingReport>();

  const counters: DeriveCounters = {
    records: 0,
    entries: 0,
    keyCollisions: 0,
    unkeyable: 0,
    unverdictable: 0,
    masked: 0,
    unquotable: 0,
    offVocabularyFindings: 0,
    unreportableFindings: 0,
    refusedFindings: 0,
    inheritedSkillRuns: 0,
  };

  /**
   * A key unique WITHIN ITS TYPE, suffixed when that type has already issued it this sweep.
   *
   * **The namespace is the type, because the id's is.** A derived entry's id is
   * `derived:claude-code:<type>@<n>:<key>` (`derived-types.ts:122`), so the same key under two types
   * was always two ids. `issued` did not know that: one flat `Set<string>` spanned every type, so a
   * denied `Bash` check -- which produces both a `tool_denial` and a `verification_run` for one
   * `toolu_...` -- took `sess:t1` for the first and minted `sess:t1#2` for the second, resolving a
   * collision the store's own namespacing had already resolved.
   *
   * Two things were wrong with that, and only the first is cosmetic. `keyCollisions` over-counted,
   * and the warning it feeds says *"event key(s) repeated within a transcript"*, which is false of
   * a cross-type pair. And the meaningless `#2` was written into a STORED id, so it travelled into
   * every fingerprint comparison on re-ingest. The docblock above reasons entirely about same-type
   * collisions between sibling subagent transcripts -- which is what this suffix is for -- so the
   * cross-type case is a gap rather than a deliberate narrowing.
   *
   * **Version is deliberately not part of the namespace**, though the id carries it. `type_version`
   * is a static property of the rule, constant within a sweep (`derived-types.ts`), so it cannot
   * separate two keys that `type` does not.
   *
   * This does NOT make the suffix stable across runs: it is still assigned in sweep order, so a run
   * that skips a transcript with a cursor mints different suffixes. That is asc-hbxl, a separate
   * defect, still open -- and fixed here only in the sense that it no longer fires cross-type.
   */
  const key = (type: string, raw: string): string => {
    const namespace = `${type}\u0000`;
    let candidate = raw;
    let suffix = 2;
    while (issued.has(`${namespace}${candidate}`)) {
      candidate = `${raw}#${String(suffix)}`;
      suffix += 1;
    }
    if (candidate !== raw) counters.keyCollisions += 1;
    issued.add(`${namespace}${candidate}`);
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
      key: key(type, rawKey),
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
    if (pending === undefined || !pending.emits) return;
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

  /** Write one judged-and-accepted report's findings, which is `emit` plus the buffered context. */
  const emitReport = (out: DerivedEntry[], report: PendingReport): void => {
    for (const finding of report.ready) {
      emit(
        out,
        'review_finding',
        // The key is unchanged from when this rule read the call and wrote at once: the call id
        // names the CALL and the index names the finding within it. Deferring the write must not
        // move an id, or every existing `review_finding` would be re-minted under a new one.
        `${report.reportKey}:${String(finding.index)}`,
        report.sessionId,
        report.project,
        report.occurredAt,
        report.locality,
        finding.properties,
      );
    }
  };

  /**
   * Close every report still waiting for a result, in the file being left.
   *
   * Each is EMITTED, not dropped. Only a refusal the rule can SEE is suppressed, and an
   * unresolved call is not one: dropping it would lose a real finding to punish a missing
   * record, and treating "no result yet" as a refusal would make a live transcript lose findings
   * it had earned. Waiting is also harmless, because a re-ingest reads the same file again and
   * writes the entry under the same key once the result is there.
   */
  const flushReports = (out: DerivedEntry[]): void => {
    for (const report of pendingReports.values()) emitReport(out, report);
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
    claims = new Map();
    pendingReports = new Map();
    lastVerdict = undefined;
  };

  /**
   * What `accept` reads off ONE record, and every branch below shares.
   *
   * Each branch used to pull these off `record` where it stood, which made the record's shape and
   * the file it came from ambient to nine separate readers. Gathering them once and naming the
   * shape is what lets a branch be read on its own -- and a positional list this long is where the
   * next argument lands in the wrong slot.
   */
  interface Accepted {
    readonly record: TranscriptRecord;
    readonly file: TranscriptFile;
    readonly out: DerivedEntry[];
    readonly sessionId: string | undefined;
    readonly occurredAt: string | undefined;
    readonly uuid: string | undefined;
    readonly locality: Locality;
    readonly blocksIn: readonly Record<string, unknown>[];
  }

  /**
   * Index this record's tool invocations before anything reads its results, and write
   * `skill_activation` for a `Skill` call as it goes past.
   *
   * The index is the reason this runs FIRST: a denial and the invocation it refused are on
   * DIFFERENT records, so the name is only knowable from a map built as the file streams past.
   */
  const acceptToolUseBlocks = (a: Accepted): void => {
    const { record, file, out, sessionId, occurredAt, locality, blocksIn } = a;
    for (const block of blocksIn) {
      if (block['type'] !== 'tool_use') continue;
      const id = str(block['id']);
      const name = str(block['name']);
      if (id === undefined || name === undefined) continue;
      const input = rec(block['input']);
      const command = input === undefined ? undefined : str(input['command']);
      invocations.set(id, { name, command });

      // ---- skill_activation, by invocation -------------------------------
      // The call IS the activation, in any stream. Written here, at the call, rather than at
      // its result: the attributed run it starts can begin on the result's own record, and
      // that run must find its claim already registered. MEASURED 2026-09-27: 105 of 105
      // `Skill` results on the live corpus were not errors, so waiting for the result would
      // buy nothing it has ever been asked for.
      if (name === SKILL_TOOL) {
        const invoked = input === undefined ? undefined : str(input['skill']);
        if (sessionId === undefined || invoked === undefined) {
          counters.unkeyable += 1;
        } else {
          // A call made while the same skill's run is already open continues that run, so it
          // leaves no claim behind: an unconsumed claim would swallow the NEXT real run.
          if (run?.skill !== invoked) claims.set(invoked, (claims.get(invoked) ?? 0) + 1);
          const agent = str(record['attributionAgent']);
          emit(
            out,
            'skill_activation',
            `${sessionId}:${id}`,
            sessionId,
            file.project,
            occurredAt,
            locality,
            {
              skill: invoked,
              ...(agent === undefined ? {} : { agent }),
            },
          );
        }
      }
    }
  };

  /** `tool_denial` -- a refusal the harness recorded, named by the invocation it refused. */
  const acceptToolDenial = (a: Accepted): void => {
    const { record, file, out, sessionId, occurredAt, locality, blocksIn } = a;
    const denialKind = str(record['toolDenialKind']);
    if (denialKind === undefined) return;
    const useId = toolUseId(blocksIn);
    if (sessionId === undefined || useId === undefined) {
      counters.unkeyable += 1;
      return;
    }
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
  };

  /** `context_compaction` -- one entry per compaction, keyed by the record's own uuid. */
  const acceptCompaction = (a: Accepted): void => {
    const { record, file, out, sessionId, uuid, occurredAt, locality } = a;
    const metadata = rec(record['compactMetadata']);
    if (metadata === undefined) return;
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
      return;
    }
    if (
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
      return;
    }
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
  };

  /**
   * `skill_activation`'s attributed half -- the run a `Skill` call starts, opened by the records
   * carrying `attributionSkill`.
   *
   * A run is HELD rather than written (`SkillRun`), because its facts are spread across the records
   * it spans; `flushRun` writes it when the next run opens or the file ends.
   */
  const acceptSkillAttribution = (a: Accepted): void => {
    const { record, file, out, sessionId, uuid, occurredAt, locality } = a;
    const skill = str(record['attributionSkill']);
    if (skill === undefined) return;
    if (run !== undefined && run.skill === skill) {
      // Same activation, still running. The FIRST record's facts stand.
      return;
    }
    flushRun(out);
    const claimed = claims.get(skill) ?? 0;
    if (claimed > 0) claims.set(skill, claimed - 1);
    const inherited = claimed === 0 && file.kind === 'subagent';
    if (inherited) counters.inheritedSkillRuns += 1;
    if (sessionId === undefined || uuid === undefined) {
      // Only a run that would have been WRITTEN is a lost entry. A claimed or inherited one
      // is already counted elsewhere, so an unkeyable record there loses nothing.
      if (claimed === 0 && !inherited) counters.unkeyable += 1;
      return;
    }
    run = {
      emits: claimed === 0 && !inherited,
      skill,
      agent: str(record['attributionAgent']),
      sessionId,
      project: file.project,
      occurredAt,
      locality,
      uuid,
    };
  };

  /**
   * `verification_run` -- a check command's verdict, written when it CHANGES.
   *
   * The filter is a filter rather than a preference, and the numbers are in the comment below: the
   * corpus holds 6,826 commands that run a check, of which 486 are the moments the gate moved.
   */
  const acceptVerification = (a: Accepted): void => {
    const { file, out, sessionId, occurredAt, locality, blocksIn } = a;
    for (const block of blocksIn) {
      if (block['type'] !== 'tool_result') continue;
      const resultId = str(block['tool_use_id']);
      if (resultId === undefined) continue;

      const invocation = invocations.get(resultId);
      if (invocation?.name !== 'Bash') continue;
      const command = invocation.command;
      if (command === undefined) continue;
      const run = checkRun(command);
      if (run === undefined) continue;

      const reading = readVerdict(run.exitStatusIsCheck, block);
      if (reading === 'unverdictable') {
        counters.unverdictable += 1;
        continue;
      }
      if (reading === 'masked') {
        counters.masked += 1;
        continue;
      }
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
        continue;
      }
      lastVerdict = verdict;
      if (!firstPass && !changed) continue;
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
          ...(previous === undefined ? {} : { previous_verdict: previous ? 'passed' : 'failed' }),
        },
      );
    }
  };

  /** `user_correction` -- the user's own words, when the transcript carries them. */
  const acceptCorrection = (a: Accepted): void => {
    const { record, file, out, sessionId, uuid, occurredAt, locality, blocksIn } = a;
    const feedback = str(record['userFeedback']);
    if (feedback === undefined) return;
    if (sessionId === undefined || uuid === undefined) {
      counters.unkeyable += 1;
      return;
    }
    const useId = toolUseId(blocksIn);
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
  };

  /**
   * One element of a `ReportFindings` call's `findings[]`, shaped into the properties to store -- or
   * `undefined`, having counted why it cannot be.
   *
   * Two DIFFERENT refusals, kept apart because conflating them would blur which one fired: a value
   * outside our closed vocabulary, and a field the tool's own schema requires. Neither emits.
   */
  const shapeFinding = (
    index: number,
    raw: unknown,
    reportId: string,
    model: string | undefined,
  ): { index: number; properties: Record<string, unknown> } | undefined => {
    const finding = rec(raw);
    const category = finding === undefined ? undefined : str(finding['category']);
    const filePath = finding === undefined ? undefined : str(finding['file']);
    const summary = finding === undefined ? undefined : str(finding['summary']);

    if (!isFindingLens(category)) {
      counters.offVocabularyFindings += 1;
      return undefined;
    }
    if (filePath === undefined || summary === undefined) {
      counters.unreportableFindings += 1;
      return undefined;
    }

    const line = finding === undefined ? undefined : num(finding['line']);
    const scenario = finding === undefined ? undefined : str(finding['failure_scenario']);
    const verdict = finding === undefined ? undefined : str(finding['verdict']);
    return {
      index,
      properties: {
        class: category,
        file: filePath,
        summary,
        tool_use_id: reportId,
        captured_by: 'reported',
        // ABSENT, never 0: a finding is not always line-anchored, and `0` is a line number
        // a reader would believe.
        ...(line === undefined ? {} : { line }),
        ...(scenario === undefined ? {} : { failure_scenario: scenario }),
        ...(verdict === undefined ? {} : { verdict }),
        // The model that produced the RECORD, which is the reviewer's own stream. Absent
        // when the transcript named none -- and NOT special-cased for `<synthetic>` the way
        // `normalize.ts`'s `model.context` is: over every project on 2026-09-28, 33
        // `ReportFindings` calls, 0 from a synthetic record. The failure mode if one ever
        // appears is a visible `reviewer_model: '<synthetic>'`, a wrong value someone can see
        // rather than a drop nobody can. `review.finding` carries the same value
        // (asc-gtnu.11), so the log and the store agree.
        ...(model === undefined ? {} : { reviewer_model: model }),
      },
    };
  };

  /**
   * `review_finding`'s CALL half: shape every finding a `ReportFindings` call carries, and HOLD it.
   *
   * ONE ENTRY PER ELEMENT of `findings[]`, and the identity is `(tool_use id, index)`: a report is one
   * call carrying N findings, so the id names the CALL and the index names the finding within it.
   * `context_compaction`'s precedent, one level down -- there the record uuid was the identity and
   * the position was implicit; here it cannot be, because N findings share both the record and the
   * tool_use id.
   *
   * Read from THIS record's own tool_use block, and HELD there rather than written: the findings are
   * an ARGUMENT to the call, not a result of it, so they are on the same record that names the call
   * -- but whether the call was ACCEPTED is on its RESULT, which is a LATER record. Writing at the
   * call meant a call the harness REFUSED still contributed its findings, and a refusal is followed
   * by a corrected retry carrying the SAME ones, so the count doubled rather than gaining a stray
   * row (`asc-2uov`). This is the pending-result machinery the sentence that used to sit here said
   * it was avoiding, and for the reason it gave.
   */
  const acceptReviewCall = (a: Accepted): void => {
    const { record, file, sessionId, occurredAt, locality, blocksIn } = a;
    for (const block of blocksIn) {
      if (block['type'] !== 'tool_use' || str(block['name']) !== REPORT_FINDINGS_TOOL) continue;
      const reportId = str(block['id']);
      const input = rec(block['input']);
      const findings = input === undefined ? undefined : list(input['findings']);
      const model = str(rec(record['message'])?.['model']);
      // `input['level']` is deliberately NOT read here, and the linter's `no-unused-vars` is what
      // said so rather than a review: it is the CALL's declared thoroughness, not the finding's,
      // so it is not a property of this entry at all. `normalize.ts` carries it on each
      // `review.finding` event, which is where the handler reads it from.

      // A `ReportFindings` call with no id, no findings array, or no session has nothing to key
      // against. Counted, never guessed.
      if (sessionId === undefined || reportId === undefined || findings === undefined) {
        counters.unkeyable += 1;
        continue;
      }

      // Everything that WILL be written, shaped here because this is the only record that holds
      // it. A refused call writes NONE of it; an accepted one writes all of it unchanged.
      const ready: { index: number; properties: Record<string, unknown> }[] = [];

      for (const [index, raw] of findings.entries()) {
        const shaped = shapeFinding(index, raw, reportId, model);
        if (shaped !== undefined) ready.push(shaped);
      }

      // Held, not written: the result record decides. The result branch below resolves this the
      // moment the call's own `tool_result` arrives, and `flushReports` writes it if the file ends
      // first -- so a call this rule can SEE was refused is the only one that ever disappears.
      pendingReports.set(reportId, {
        reportKey: `${sessionId}:${reportId}`,
        sessionId,
        project: file.project,
        occurredAt,
        locality,
        ready,
      });
    }
  };

  /**
   * `review_finding`'s RESULT half: the call's own `tool_result` decides whether it counted.
   *
   * A separate walk from the tool_use loop above, because a call's own result is only readable once
   * the call has been buffered -- if a transcript ever carried both blocks on one record, resolving
   * in the earlier loop would run before there was anything to resolve.
   *
   * `is_error === true` is the ONLY value that suppresses. An absent `is_error` is an unstated
   * verdict, not a refusal, and writes the findings rather than quietly dropping them.
   */
  const resolveReviewResults = (a: Accepted): void => {
    const { out, blocksIn } = a;
    for (const block of blocksIn) {
      if (block['type'] !== 'tool_result') continue;
      const resultId = str(block['tool_use_id']);
      if (resultId === undefined) continue;
      const report = pendingReports.get(resultId);
      if (report === undefined) continue;
      pendingReports.delete(resultId);
      if (block['is_error'] === true) counters.refusedFindings += report.ready.length;
      else emitReport(out, report);
    }
  };

  const accept = (record: TranscriptRecord, file: TranscriptFile): readonly DerivedEntry[] => {
    const out: DerivedEntry[] = [];

    if (path !== file.path) {
      // The pending run and the pending reports belong to the file being left, so both are
      // flushed BEFORE the reset.
      flushRun(out);
      flushReports(out);
      begin();
      path = file.path;
    }

    counters.records += 1;

    const sessionId = str(record['sessionId']);
    const occurredAt = str(record['timestamp']);
    const uuid = str(record['uuid']);
    const locality = localityOf(record, file.project);
    const blocksIn = blocks(record);
    const accepted: Accepted = {
      record,
      file,
      out,
      sessionId,
      occurredAt,
      uuid,
      locality,
      blocksIn,
    };

    // A plain sequence, and the order is load-bearing rather than incidental. The tool_use walk
    // indexes the invocations every later branch reads; a review call's result can only resolve
    // once the call itself has been buffered; and the skill run is flushed by whichever branch
    // opens the NEXT run. Each branch is now readable on its own, which is the point -- this
    // function is the list of what a record can mean, and nothing else.
    acceptToolUseBlocks(accepted);
    acceptToolDenial(accepted);
    acceptCompaction(accepted);
    acceptSkillAttribution(accepted);
    acceptVerification(accepted);
    acceptCorrection(accepted);
    acceptReviewCall(accepted);
    resolveReviewResults(accepted);

    return out;
  };

  return {
    accept,
    drain: (): readonly DerivedEntry[] => {
      const out: DerivedEntry[] = [];
      flushRun(out);
      flushReports(out);
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
