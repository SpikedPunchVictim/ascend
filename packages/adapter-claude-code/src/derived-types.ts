/**
 * The five entry types `asc ingest claude-code` derives from transcripts.
 *
 * These are ordinary definitions -- registered through the ordinary `registerType` path, so
 * they version, diff and export exactly like anything a user defines. Nothing about them is
 * special-cased. What makes them "derived" is one column: their entries carry
 * `source = 'derived:claude-code'`, which is the claim that a machine read this off disk
 * rather than a model reporting it about itself.
 *
 * WHY THEY ARE DERIVED AND NOT SELF-REPORTED. `ARCHITECTURE.md`, "Starter types": anything
 * mechanically derivable should be derived. A transcript already records which tools were
 * denied, when a skill was active, when the context was compacted. Asking a model to
 * self-report a fact that is already on disk spends its attention to get a worse copy --
 * and the copy is worse in a specific way, because a model reporting on itself is reporting
 * from memory, while the transcript is the record.
 *
 * `record_when` IS INVERTED FOR THESE, and that is deliberate. `asc types brief` prints
 * `name -- record_when` for every active type and is what a model reads before recording
 * anything. A derived type in that list would otherwise read as an instruction to record it
 * by hand, which is the one thing that must not happen: hand-recorded duplicates of derived
 * entries would be indistinguishable from them except by `source`, and would double every
 * count. So each of these says, in the field the model actually reads, that it is never
 * recorded by hand.
 *
 * MEASURED, on `~/.claude/projects` (read-only), 2026-09-15 -- 843 files, 431,039 records,
 * 1.19 GiB, a 5.2 s sweep. The reader's own re-measurement is in `docs/evidence/EV-corpus.md`, and
 * the record for these types -- the rules, the five-way `verification_run` comparison, and the
 * controlled A/B that settled the heredoc question -- is `docs/evidence/EV-derived.md`;
 * these are the
 * counts of the thing each type produces, which is a different number from the count of
 * transcript lines that mention it:
 *
 *   type                 entries   per-event identity            shape
 *   verification_run         486   session + tool_use_id         EVENT
 *   tool_denial              457   session + tool_use_id         EVENT
 *   context_compaction       438   session + record uuid         EVENT
 *   skill_activation          87   session + first record uuid   EVENT
 *   user_correction           20   session + record uuid         EVENT
 *
 * Those are counts produced by driving the deriver over the whole corpus and validating every
 * entry against the spec below: 1,488 entries, 0 rejected, 0 warnings, 0 duplicate keys, 0
 * unkeyable, 0 unverdictable, 6 key collisions. The
 * check is `derive-real-corpus.test.ts`, and it is the reason these definitions can be trusted
 * to match what the transcript actually contains. The counts are a live corpus, not a fixture:
 * this session's own transcript is in there, which is why `tool_denial` rose by one between
 * two runs minutes apart. Treat every number here as a measurement with a date, not a constant.
 *
 * A DERIVED TYPE'S N IS ITS COUNT OF DISTINCT PER-EVENT IDENTITIES, never its line count.
 * The gap is not small and it runs both ways. `attributionSkill` appears on 6,395 transcript
 * records and yields 87 activations, because a skill that stays active across 54 consecutive
 * messages is ONE activation -- a line count inflates it 73-fold. And `verification-run` is
 * the type where the judgement has to be made at all: the same corpus yields 6,940 "check
 * runs" if a newline always ends a command, 16,352 under a rule that counts `node -e` probes,
 * 4,456 under the narrowest, and 486 entries under the rule this ships with (6,826 candidates
 * once heredoc bodies are skipped rather than read as commands). Five numbers, one corpus, and
 * nothing in the data picks between them -- the filter does.
 *
 * EVERY NUMBER ABOVE IS THE OUTPUT OF A RULE STATED IN `derive.ts`, and none is a count of
 * lines. Where a rule is a judgement it says so, and says what it cost.
 *
 * WHAT IS DELIBERATELY NOT HERE: transcript prose. The reader's contract is that no raw
 * transcript text is returned to a caller that prints, so a sweep never puts user content
 * into an agent's context. The one exception is `user_correction`, whose whole value IS the
 * text, and it travels in the envelope's `evidence_text` -- the field ARCHITECTURE.md
 * designates for exactly this: raw unstructured text beside the typed properties.
 *
 * PROVENANCE IS FOUR PROPERTIES, repeated on every type rather than modelled once.
 * `session_id`, `project`, `occurred_at` and a per-event identifier. The envelope cannot
 * carry them: `recorded_at` is when ascend INGESTED the entry, which during a backfill of two
 * years of transcripts is wildly different from when the event happened, and there is no
 * envelope column for the transcript at all. Repeating them is the price of the envelope
 * being fixed, and it is worth paying -- without `occurred_at` every derived corpus would be
 * a single point in time and every question about trend would be unanswerable.
 *
 * WHERE THE EVENT HAPPENED IS THE ENVELOPE'S, NOT A PROPERTY (`asc-5hs`), and the split is
 * not arbitrary -- it is where a name is available. `entries` already carries `cwd` and
 * `branch` columns, and a generated view already projects them, so a derived entry populates
 * those columns from the record's own `cwd` and `gitBranch` and is queryable through
 * `v_<type>_v<version>` with no join. Declaring them as *properties* instead is not merely
 * redundant, it is refused: `reservedPropertyName` in `@ascend/core` rejects a property whose
 * name an envelope column already occupies, because SQLite does not error on the collision --
 * it keeps the envelope's column and renames the loser, so the query ARCHITECTURE.md
 * prescribes would return the envelope value under the property's name. Measured, not
 * assumed: `asc types define` refuses a `cwd` property outright.
 *
 * The consequence is worth stating because it makes this a small change rather than a
 * versioned one: `definitionShape` hashes the DECLARED PROPERTIES, and this adds none, so no
 * type mints a new version and no count splits across a version boundary. What the entries
 * gained is a column that was always there and was always NULL.
 *
 * The reason to care is the size of what the label loses. `project` is one encoded directory
 * per project, and an agent works in subdirectories and worktrees under one: re-measured
 * 2026-09-16 over every record, **20 encoded directories hold 301 distinct real working
 * directories** (15.1:1), the largest collapsing 123:1. Over the derived entries themselves --
 * 1,607 of them, the population this module produces -- 14 projects hold 84 real working
 * directories, 6.0:1, and every one of those entries carries a `cwd` and a `branch`.
 *
 * A prior measurement of the same quantity on 2026-09-15 read 15 / 282 / 115:1. The corpus is
 * live, so those are a date, not a constant; what is stable across both is the direction and the
 * order of magnitude. `cwd` is the value the directory name cannot express, and `branch` is the
 * other -- 10 distinct values including `HEAD` and real feature branches, so "before or after
 * the branch moved" is answerable from here and was not before.
 */

import type { TypeSpec } from '@ascend/core';

/** The `source` value every entry derived here carries. Mirrors the store's CHECK constraint. */
export const DERIVED_SOURCE = 'derived:claude-code';

/**
 * The sentence a model reads in `asc types brief`, and it must stay short: the brief is a
 * context tax on EVERY session in the project. Five of these cost roughly 350 characters,
 * about 90 tokens -- cheaper than the four starter types, and for a fact the model needs,
 * which is "do not record these".
 */
const NEVER_BY_HAND = 'Never by hand -- asc ingest claude-code derives one from each transcript.';

/**
 * Why a machine-emitted vocabulary is a `string` and not an `enum`, stated once because it is
 * the same decision in three places (`denial_kind`, `trigger`).
 *
 * The vocabulary of denial kinds and compaction triggers belongs to Claude Code, not to
 * ascend. An `enum` here would be a closed list of the values that happened to exist on
 * 2026-09-15, and the day a fifth denial kind ships, every entry carrying it would FAIL
 * VALIDATION and be dropped -- a new fact silently lost, caused by our own definition. The
 * known values are named in the property's `description` instead, where they inform a reader
 * without rejecting a record.
 */
const VOCABULARY_IS_NOT_OURS =
  'Deliberately a string rather than an enum: this vocabulary belongs to Claude Code, so a ' +
  'closed list would turn the next new value into a rejected entry rather than a recorded one.';

/**
 * `user_correction` SHIPS, WITH THE LIMITATION STATED IN THE TYPE'S OWN PROSE -- and the
 * limitation is not rarity, it is dependence.
 *
 * It yields 20 entries across 10 sessions, which is thin. But thin is not the disqualifying
 * fact: measured 2026-09-15, ALL 20 corrections carry a `toolDenialKind` on the same record,
 * so every one of them is also a `tool_denial`. The two are not independent corpora, and a
 * finding computed over corrections cannot be corroborated by one computed over denials --
 * they are the same 20 events wearing a different hat. An inter-scheme agreement score
 * between the two would be an artifact of the overlap.
 *
 * It ships anyway, because the entry carries the one thing nothing else in the store does:
 * what the user actually said. `tool_denial` records that a call was refused; it cannot record
 * what was asked for instead. That text is in `evidence_text`, 59 to 2,832 characters of
 * irreplaceable judgement. `description` is the field that reaches a reader here, and it is
 * free: `definitionShape` drops prose before hashing, so this paragraph can be corrected
 * later without minting a version.
 *
 * The alternative -- not shipping it -- was live until the text was looked at, and is
 * recorded so it is not re-litigated from scratch: at N=20 with full overlap on another type,
 * the numbers alone argue for leaving it out.
 */
const USER_CORRECTION_LIMITATION =
  ' Every entry of this type also carries a tool_denial for the same event -- measured, 20 ' +
  'of 20 -- so this is NOT an independent corpus: a count over corrections must not be ' +
  'corroborated by a count over denials, because they are the same events. It is kept for ' +
  '`evidence_text`, which holds what the user actually said and which no other type records.';

/** Shared by all five: these three are on every derived entry. */
const PROVENANCE: readonly TypeSpec['properties'][number][] = [
  {
    name: 'session_id',
    type: 'ref',
    required: true,
    description:
      'The transcript’s own session id. Half of this entry’s identity, so it is ' +
      'required: without it the entry has no stable key and re-running an ingest could not ' +
      'recognise it, so the adapter emits nothing rather than an unkeyable entry.',
  },
  {
    name: 'project',
    type: 'string',
    required: true,
    description:
      'The transcript’s project directory under ~/.claude/projects, in ENCODED form ' +
      '("-Users-me-src-app"), which is the name on disk. Not decoded: a "-" in that name ' +
      'stands for both a path separator and a literal hyphen, so decoding is lossy and two ' +
      'projects can collide. The encoded name never does. This is a COARSE label by ' +
      'construction -- one per project, however many directories the work happened in. For ' +
      'the real working directory, select the envelope’s `cwd` column, which this type’s ' +
      'generated view already projects and which is populated from the transcript’s own ' +
      'record.',
  },
  {
    name: 'occurred_at',
    type: 'timestamp',
    description:
      'When the event happened, from the transcript’s own timestamp field. NOT the ' +
      'envelope’s `recorded_at`, which is when ascend ingested it -- during a backfill ' +
      'those differ by years. Present on all 1,488 entries measured 2026-09-15, and still ' +
      'not `required`: a transcript without one is a real state, and omitting is how it ' +
      'stays distinguishable from an event at the epoch.',
  },
];

export const DERIVED_TYPES: readonly TypeSpec[] = [
  // ---------------------------------------------------------------------------
  {
    name: 'tool_denial',
    description: 'A tool call was refused before it ran.',
    record_when: NEVER_BY_HAND,
    properties: [
      {
        name: 'denial_kind',
        type: 'string',
        required: true,
        description:
          'Why it was refused. Measured values, 2026-09-15: `permission-rule` (228), ' +
          '`user-rejected` (160), `automode-unavailable` (39), `automode-blocked` (30). ' +
          `The distinction that matters is user-rejected versus the rest: that one is a ` +
          `judgement someone made about this work, and the others are configuration. ` +
          VOCABULARY_IS_NOT_OURS,
      },
      {
        name: 'tool_name',
        type: 'string',
        description:
          'The tool that was refused, resolved by joining the denial back to the `tool_use` ' +
          'block that invoked it. Measured: resolved on 457 of 457 denials, so in practice ' +
          'it is always here -- but it is not `required`, because the join depends on a ' +
          'per-file map and a transcript split across a rotation would break it. Omitted ' +
          'rather than guessed.',
      },
      {
        name: 'tool_use_id',
        type: 'ref',
        required: true,
        description:
          'The refused invocation’s own id from the transcript. Unique within a session ' +
          'and paired with `session_id` to key the entry. Measured: 454 distinct ids over 457 ' +
          'denials, and the three repeats are in DIFFERENT sessions, so the pair is unique ' +
          'where the id alone is not.',
      },
      ...PROVENANCE,
    ],
  },

  // ---------------------------------------------------------------------------
  {
    name: 'context_compaction',
    description: 'The conversation ran out of context and was compacted.',
    record_when: NEVER_BY_HAND,
    properties: [
      {
        name: 'trigger',
        type: 'string',
        required: true,
        description:
          'What caused the compaction, as the transcript records it. ' + VOCABULARY_IS_NOT_OURS,
      },
      {
        name: 'pre_tokens',
        type: 'integer',
        required: true,
        description:
          'Context size immediately BEFORE the compaction, in tokens. Present on every ' +
          'compaction measured (438 of 438). Paired with `post_tokens` it is the only direct ' +
          'measurement of how close a session came to the limit.',
      },
      {
        name: 'post_tokens',
        type: 'integer',
        required: true,
        description: 'Context size immediately AFTER the compaction, in tokens.',
      },
      {
        name: 'cumulative_dropped_tokens',
        type: 'integer',
        required: true,
        description:
          'Tokens dropped CUMULATIVELY across every compaction in this session, not this ' +
          'one’s own drop. The name says so because the trap is real: a per-event reading ' +
          'of this field over-counts the cost of any session compacted more than once. ' +
          '`pre_tokens - post_tokens` is this event’s own drop.',
      },
      {
        name: 'duration_ms',
        type: 'duration',
        unit: 'ms',
        required: true,
        description: 'How long the compaction itself took. Measured present on 438 of 438.',
      },
      {
        name: 'discovered_tools',
        type: 'json',
        description:
          'A JSON array of tools the compaction discovered and kept available. OMITTED when ' +
          'the transcript does not carry it -- measured: present on 282 of 438 compactions, ' +
          'absent on the other 156. The absence is not an empty list; an empty array here ' +
          'means the compaction ran and found none, and the two are different facts.' +
          ' An EMPTY array is a real measurement meaning "looked and found nothing".',
      },
      ...PROVENANCE,
    ],
  },

  // ---------------------------------------------------------------------------
  {
    name: 'verification_run',
    description:
      'A check command was run and the gate changed state. NOT every check invocation: the ' +
      'adapter records a run that produced a verdict CHANGE, or the first verified pass in a ' +
      'transcript. Measured: 6,826 commands in the corpus run a check, and 486 entries survive ' +
      'the filter. Without it every `pnpm test` would be a row, and a red-green loop would ' +
      'fill the store with its own keystrokes.',
    record_when: NEVER_BY_HAND,
    properties: [
      {
        name: 'runner',
        type: 'string',
        required: true,
        description:
          'The check that ran, reduced to its execution head and first argument -- `pnpm ' +
          'test`, `cargo test`, `npx vitest`. NOT the full command: a Bash command can be a ' +
          'heredoc holding an entire file, and storing one would put transcript prose in the ' +
          'store by the back door. Truncated to 60 characters.',
      },
      {
        name: 'verdict',
        type: 'enum',
        enum_values: ['passed', 'failed'],
        required: true,
        description:
          'Whether the run passed, from the tool result’s own `is_error` field rather ' +
          'than from anything in the output text. Measured: `is_error` was a boolean on ' +
          'every check result seen, so this is never inferred from prose. A result without ' +
          'one yields no entry at all rather than a guessed verdict.',
      },
      {
        name: 'previous_verdict',
        type: 'enum',
        enum_values: ['passed', 'failed'],
        description:
          'The verdict of the PREVIOUS check run in the same session, when there was one. ' +
          'OMITTED on a first verified pass, where there is no previous run -- which is a ' +
          'different fact from a run that repeated an earlier verdict, and the reason this ' +
          'type can answer "what was red just before it went green" with no joins.',
      },
      ...PROVENANCE,
    ],
  },

  // ---------------------------------------------------------------------------
  {
    name: 'skill_activation',
    description: 'A skill became active and stayed active.',
    record_when: NEVER_BY_HAND,
    properties: [
      {
        name: 'skill',
        type: 'string',
        required: true,
        description:
          'The skill’s name as the transcript attributes it. Measured: 12 distinct skills ' +
          'across the corpus, so this is a short vocabulary in practice and still a string, ' +
          'because skills are installed and removed by the user.',
      },
      {
        name: 'agent',
        type: 'string',
        description:
          'The agent the skill was attributed to, when the transcript names one. OMITTED on ' +
          'the 3,278 of 6,395 attributed records that name none -- an ordinary state meaning ' +
          'the main thread, not a missing value.',
      },
      ...PROVENANCE,
    ],
  },

  // ---------------------------------------------------------------------------
  {
    name: 'user_correction',
    description: `The user pushed back on what was being done.${USER_CORRECTION_LIMITATION}`,
    record_when: NEVER_BY_HAND,
    properties: [
      {
        name: 'tool_name',
        type: 'string',
        description:
          'The tool being called when the correction arrived, resolved like `tool_denial`’s. ' +
          'Measured: resolvable on all 20 corrections.',
      },
      ...PROVENANCE,
    ],
  },
];

/** A type by name, for a caller that has the name from a transcript. */
export function derivedType(name: string): TypeSpec | undefined {
  return DERIVED_TYPES.find((spec) => spec.name === name);
}
