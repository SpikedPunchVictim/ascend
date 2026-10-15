/**
 * The five types `asc init` installs. Shapes settled in ARCHITECTURE.md, "Starter types".
 *
 * **The governing principle is that anything mechanically derivable is not here.** A transcript
 * already records which tools ran, which skills activated, which commands failed -- `adapter-claude-code`
 * (E5) reads all of it off disk, retroactively and more reliably than an LLM reporting on itself.
 * So the shipped set covers only what a transcript cannot see: judgment. A review's verdict, what
 * was tried before giving up, why one approach beat another. Asking a model to self-report a fact
 * that is already on disk spends its attention to get a worse copy.
 *
 * **`intervention` HALF VIOLATES THAT PRINCIPLE, AND SAYING SO IS CHEAPER THAN HIDING IT.** It is the
 * first starter with a machine writer: `applied_at` and the content hashes come from the capture
 * mechanism that hashes watched files, not from a model reporting on itself. The other half obeys
 * the principle completely -- `reason`, `metric`, `prediction`, `rule` and `grading_point` are
 * judgment about a future nobody can read off disk. The resolution is that ONE row carries both, the
 * machine filling the mechanical properties and a person or agent filling the judgment ones. The
 * alternative -- two types, or a project-defined type -- was rejected because the CLI's own readers
 * (`asc handlers compare`, the brief line, the end-of-life rule) cannot read a type a project may
 * not have defined, and because a project-defined type hashes differently in every project, which
 * would make two projects' ledgers incomparable.
 *
 * **A conditional rule on one of these properties lives in `starterEntryIssue`, below, and not
 * here.** `PropertySpec` can say "required" and nothing finer, and it says "must have a decision on
 * EVERY row" -- which for `intervention` would make the capture mechanism's own rows unwritable,
 * since they carry no metric and no rule. The condition this type needs is "a `rule` whenever there
 * is a `metric`", and that shape has no home in the definition language. It is not a gap in this
 * type; it is a gap the type is honest about.
 *
 * **These are a starting point, not a schema.** They are ordinary definitions installed through the
 * ordinary `registerType` path, so they version, diff and export exactly like anything a user
 * defines. A project that wants different enum values edits them; nothing depends on these five
 * existing.
 *
 * **Names are written in canonical form** (`review_completed`, not `review-completed`).
 * `canonicalName` lowercases and converts every separator run to an underscore, so the hyphenated
 * spelling ARCHITECTURE.md uses in prose is not the stored name -- and writing it here would make
 * every `asc init` report a rename it did not need to make.
 *
 * Prose is free. `definitionShape` drops `description` and `record_when` before hashing, so the
 * wording below can be improved in a later ascend without minting a version or making two projects
 * incomparable. That is deliberate: the descriptions are written for an LLM to read at record time,
 * which means they should be free to get better.
 */

import type { TypeSpec, ValidationIssue } from '@ascend/core';

/**
 * The one convention `json` cannot express, repeated wherever a list-shaped property appears.
 *
 * `json` validates the container -- array or object -- and says nothing about what is inside it
 * (`spec.ts` explains why: a nested definition language would not stay small enough for an LLM to
 * invent correctly). So the inner shape is convention, and the only place to state it is the
 * property's `description`, which `asc types brief` shows to whoever is recording.
 *
 * The empty-list rule is the load-bearing half and is stated in full at each use, because it is the
 * one an LLM gets wrong: an empty array is a MEASUREMENT ("reviewed, found nothing") and omitting the
 * property is the absence of one ("did not review"). Collapsing the two is the failure mode the
 * whole three-state model exists to prevent, and it is invisible in the data afterwards.
 */
const EMPTY_IS_A_MEASUREMENT =
  ' An EMPTY array is a real measurement meaning "looked and found nothing" -- leave the property ' +
  'out entirely to say nobody looked.';

/**
 * Severity, shared by the two types that classify a finding.
 *
 * Four levels, ordered, and deliberately not a scale: `critical` is "this is wrong and it is going
 * to hurt", `low` is "worth knowing". Nothing derives a number from these, and no threshold is
 * defined on them, so there is no calibration for a model to guess at.
 */
const SEVERITY = ['critical', 'high', 'medium', 'low'] as const;

/** The kinds of problem a review can surface. Closed so counts across reviews are comparable. */
const CATEGORY = ['bug', 'security', 'design', 'style', 'docs', 'test'] as const;

/**
 * A stage's status, taken from the plan format the projects using this tool already write.
 *
 * `IMPLEMENTATION_PLAN.md` in this repository -- and in the tooling guidance ascend was built
 * against -- spells stages `[Not Started|In Progress|Complete]`. Canonicalized those are the three
 * below, and reusing a vocabulary someone already types is worth more than inventing a tidier one.
 */
const STATUS = ['not_started', 'in_progress', 'complete'] as const;

/**
 * The states one ledger row moves through, in the order `asc-09wx.8`'s design names them.
 *
 * A row is immutable like every entry, so a state change is a NEW entry naming the row it
 * continues (`intervention.continues`). The five below are therefore the values a chain's newest
 * entry carries, not a column anything updates.
 *
 * `ungradeable` is a state and not a failure. A row whose `grading_point` exceeds what the project
 * produces in a reasonable horizon is closed as `ungradeable` at propose time, before effort is
 * spent on it -- which is a result a reader can act on, and a different fact from a row that was
 * simply abandoned.
 */
const INTERVENTION_STATUS = ['proposed', 'applied', 'graded', 'reverted', 'ungradeable'] as const;

/**
 * What happens to a row's handler once the row closes (`asc-09wx.8.5`, decision `1d5cbb28`).
 *
 * **Two values, and only one of them is ever written.** `retired` is DERIVABLE and therefore the
 * default: a handler named by a chain whose newest entry is `graded`, `reverted` or `ungradeable` is
 * retired, and the ledger already shows that without a property saying so. `regression_watch` is the
 * one genuinely new datum -- a choice made at the moment of closing -- and it is a fact about the
 * change, which is what this store holds, rather than a machine-local setting. So `disposition` is
 * optional and is written only to say KEEP WATCHING; an absent one means the row retired its handler
 * or is still open, which a reader tells apart from `status`.
 *
 * **The rejected alternative is worth naming, because it was cheaper.** The watch could have been
 * encoded with no schema change at all, as a new `proposed` row continuing the closed root with a
 * `reason` saying it is a watch -- but then "I am watching this" and "I am proposing a change" are
 * one shape, and only prose tells them apart.
 */
const INTERVENTION_DISPOSITION = ['retired', 'regression_watch'] as const;

/**
 * What a grade said. Deliberately three values, one of which is "nothing happened".
 *
 * `no_change` is the majority outcome of almost any intervention and is the one a ledger that only
 * recorded successes could not report. Excluding it would make the ledger a highlight reel.
 */
const INTERVENTION_OUTCOME = ['helped', 'no_change', 'hurt'] as const;

export const STARTER_TYPES: readonly TypeSpec[] = [
  {
    name: 'review_completed',
    description: 'A review of some work reached a verdict.',
    record_when:
      'a review finishes at any stage -- a code review, a review of a plan or a design, or a ' +
      'self-review before handing work off. Record it when you reach a verdict, not while you are ' +
      'still reading: a review with no verdict is not yet an entry, and an entry recorded mid-review ' +
      'is a claim you may have to contradict.',
    properties: [
      {
        name: 'stage',
        type: 'string',
        description:
          "What the review covered, in the words the plan uses, so it joins `stage_transition`'s " +
          "`stage`. A string rather than an enum because stage names are the project's own.",
      },
      {
        name: 'verdict',
        type: 'enum',
        enum_values: ['approved', 'changes_requested', 'rejected'],
        required: true,
        description:
          '`approved` -- good to proceed. `changes_requested` -- the approach holds, fix these and ' +
          'continue. `rejected` -- the approach itself is wrong, and fixing the findings would not ' +
          'save it. The distinction between the last two is the one worth being careful about.',
      },
      {
        name: 'findings',
        type: 'json',
        description:
          'A JSON array, one object per problem found: `severity` (one of ' +
          `${SEVERITY.join(', ')}), \`category\` (one of ${CATEGORY.join(', ')}), \`file\` for the ` +
          'path it is in, and `note` for anything that does not fit the other three.' +
          EMPTY_IS_A_MEASUREMENT,
      },
    ],
  },

  {
    name: 'stuck_event',
    description: 'A problem resisted repeated attempts and forced a stop.',
    record_when:
      'the three-strike rule fires -- three attempts at the same problem have failed and you are ' +
      'stopping to reassess rather than trying a fourth variation. Record it at the moment you stop, ' +
      'not after you recover: the value of this entry is the state of mind you are about to leave, ' +
      'and it is the least reconstructable thing in the whole store. Keep the failing output as it ' +
      'was printed while you still have it -- `error_text` wants the exact words, and only the exact ' +
      'words are what a later search can find.',
    properties: [
      {
        name: 'attempt_count',
        type: 'integer',
        required: true,
        description:
          'How many attempts were made before stopping. This is the count of attempts MADE, which ' +
          'may exceed the length of `what_was_tried` -- some attempts are not worth writing down.',
      },
      {
        name: 'what_was_tried',
        type: 'json',
        description:
          'A JSON array of what was attempted, in the order tried -- either bare strings, or objects ' +
          'with `attempt` and `result`. Order is the point: the sequence is how a later reader sees ' +
          'which ideas have already been spent.' +
          EMPTY_IS_A_MEASUREMENT,
      },
      {
        name: 'error_text',
        type: 'text',
        description:
          'The failure as it was printed, verbatim. Not a summary -- the exact text is what makes ' +
          'this findable by a later search, and a paraphrase destroys the only part a search matches.',
      },
      {
        name: 'hypothesis',
        type: 'text',
        description:
          'What you believe is actually wrong, stated as a belief rather than a finding. The point ' +
          'is to record the guess that the next attempt was about to test.',
      },
      {
        name: 'resolution',
        type: 'enum',
        enum_values: ['fixed', 'worked_around', 'escalated', 'abandoned', 'unresolved'],
        description:
          'How it ended: `fixed` (the real cause was found), `worked_around` (the symptom is gone ' +
          'and the cause remains), `escalated` (handed to someone or something else), `abandoned` ' +
          '(the goal was dropped), `unresolved` (stopped without a fix and not coming back). Leave ' +
          '`resolution` out ENTIRELY if the problem is still open -- that is a different claim from ' +
          '`unresolved`, which means you stopped for good.',
      },
    ],
  },

  {
    name: 'stage_transition',
    description: 'A stage of a written plan changed status.',
    record_when:
      'a stage in a plan document changes status -- the plan is the trigger, so record the ' +
      'transition when you edit that line, not at the end of the session when you no longer remember ' +
      'what was true at the moment it flipped.',
    properties: [
      {
        name: 'stage',
        type: 'string',
        required: true,
        description:
          'The stage as the plan names it, including its number -- "Stage 2: the store". Matching ' +
          '`review_completed`\'s `stage` makes "what was reviewed while this stage was open" a join ' +
          'rather than a guess.',
      },
      {
        name: 'from_status',
        type: 'enum',
        enum_values: [...STATUS],
        required: true,
        description: 'The status it had. One of the three the plan format allows.',
      },
      {
        name: 'to_status',
        type: 'enum',
        enum_values: [...STATUS],
        required: true,
        description:
          'The status it now has. Equal to `from_status` is legal and usually a mistake -- record ' +
          'the transition, not the state.',
      },
      {
        name: 'tests_passing',
        type: 'boolean',
        description:
          'Whether the whole gate was green at the moment of the transition. Omit it if the gate was ' +
          'not run -- "the tests were failing" and "nobody ran the tests" are different facts, and ' +
          '`false` asserts the first.',
      },
    ],
  },

  {
    name: 'decision',
    description: 'A choice between alternatives that were both genuinely viable.',
    record_when:
      'a choice is made between approaches that were both real options -- the kind worth reopening ' +
      'later. Not every choice: if there was only one reasonable thing to do, it was not a decision, ' +
      'and recording it as one makes the entries that matter harder to find.',
    properties: [
      {
        name: 'options_considered',
        type: 'json',
        description:
          'A JSON array, one entry per alternative that was actually on the table. Each entry is a ' +
          'string naming the option, or an object with `option` plus `pros` and `cons`. Writing the ' +
          'pros and cons is what makes this worth recording -- a list of names with no reasoning is ' +
          'reconstructable from the diff.' +
          EMPTY_IS_A_MEASUREMENT,
      },
      {
        name: 'chosen',
        type: 'string',
        required: true,
        description:
          'The option that was taken, spelled as it appears in `options_considered` so the two can ' +
          'be matched without guessing at paraphrase.',
      },
      {
        name: 'rationale',
        type: 'text',
        required: true,
        description:
          'Why that one and not the others. This is the part that cannot be recovered from the ' +
          'resulting code, which records what was chosen and never what was rejected.',
      },
      {
        name: 'reversibility',
        type: 'enum',
        enum_values: ['reversible', 'costly', 'irreversible'],
        description:
          'What it would cost to change this later. An `irreversible` choice is the one a later ' +
          'reader most needs the reasoning for, so this is what makes the rationale findable.',
      },
    ],
  },

  {
    name: 'intervention',
    description: 'A change to how work is done, with the measurement that will grade it.',
    record_when:
      'you change how work is done -- a hook, a setting, an instruction file, a handler, a ' +
      'practice -- and you want to know afterwards whether it helped. Record it BEFORE the change ' +
      'is applied, with `rule` and `prediction` filled in: a rule chosen after seeing the numbers ' +
      'is not a rule, it is a story about a result. `baseline` and `outcome_measurement` are the ' +
      'exact text a tool printed -- a paraphrase of a number is a new number, and nothing can ever ' +
      'match the original again -- so copy them verbatim, command line included. A change you ' +
      'cannot measure is still worth a row: say so, and close it `ungradeable` with the reason, ' +
      'rather than leaving a row that waits forever. What is not worth anything is a change nobody ' +
      'wrote down, which is what this type exists to stop.',
    properties: [
      {
        name: 'change',
        type: 'string',
        required: true,
        description:
          'What was altered, named so a reader can find it -- a file path, a setting name, a ' +
          'handler name, a practice. The name a person would use, not a description of the effect: ' +
          'the effect is what `prediction` is for, and the two read very differently a year later. ' +
          'A change that is not named precisely cannot be reverted, which is the one thing every ' +
          'row must stay able to do.',
      },
      {
        name: 'applied_at',
        type: 'timestamp',
        description:
          'When the change took effect. Absent on a `proposed` row, and absent is the honest value ' +
          "there rather than `not_measured`: 'when was this applied' has no answer yet, which is a " +
          'different thing from an answer nobody took. Filled by the capture mechanism where one ' +
          'is watching, and by hand where one is not -- and a hand-written date is a claim, which ' +
          'is the whole reason the mechanism exists.',
      },
      {
        name: 'digest',
        type: 'json',
        description:
          'A JSON array, one object per file the change touched: `path`, `before_sha256` and ' +
          '`after_sha256`. Written by the capture mechanism, and absent when the change was made ' +
          'outside anything that hashes -- so its absence describes how the row was recorded ' +
          'rather than casting doubt on the row. The hashes are content, not metadata: a file ' +
          'restored byte-for-byte was not changed, and produces no row at all.' +
          EMPTY_IS_A_MEASUREMENT,
      },
      {
        name: 'reason',
        type: 'text',
        description:
          'What prompted this, as a citation -- an `EV-N` evidence record or a `dogfood/NNNN` ' +
          'finding -- with its number copied verbatim, plus the sentence that made you act. A row ' +
          'with no reason is a change somebody made; a row with one is a change somebody can ' +
          'evaluate, and the difference between those two is this property.',
      },
      {
        name: 'metric',
        type: 'json',
        description:
          'A JSON object naming what will grade this row: `handler` (the file path), `sha256` ' +
          '(the sha256 of the canonical PARSED form of that handler -- `CompiledHandler.hash`, ' +
          'which is `sha256Hex(canonicalJson(parsed))` -- and NOT the sha256 of the file bytes, so ' +
          '`shasum -a 256` on the handler returns a different number, and a comment or a reformat ' +
          'does not move this one), `derive_version` (the event derivation its baseline was read ' +
          'at), `unit` (what one unit is -- a compaction segment, an active day, a commit) and ' +
          '`scope` (the project or projects it covers). All three of `handler`, `sha256` and ' +
          '`derive_version` are re-read at grade time and all three must match, because a handler ' +
          'whose own `where` clause was improved is a DIFFERENT RULER: a number that moved because ' +
          'the ruler moved is not evidence about the change. A metric that cannot be named this ' +
          'precisely is not yet a metric.',
      },
      {
        name: 'rule',
        type: 'text',
        description:
          'The condition that will count as `helped`, fixed here before the change is applied. ' +
          'Not "it felt better" -- a comparison: which direction, over what window, against which ' +
          'control if there is one, and how large a difference is worth calling a change at all. ' +
          'This is the property that makes the ledger a number rather than an impression. It is ' +
          'required on any row whose `metric` has a value: a row with no metric has nothing for ' +
          '"helped" to be measured against and needs no rule, while a row with one and no rule is ' +
          'refused at write time rather than graded loosely. Marking this N/A does not satisfy ' +
          'that -- saying a metric is worth measuring and that it is not worth saying what would ' +
          'count is a contradiction, and it is the one this rule is written to catch.',
      },
      {
        name: 'prediction',
        type: 'text',
        description:
          'The direction and rough size you expect, and when you expect to see it. Written before ' +
          'applying, for the same reason `rule` is: a prediction made afterwards is not a ' +
          'prediction. Being wrong here is the point of the property -- a ledger whose predictions ' +
          'are always right is a ledger whose predictions were written after the fact.',
      },
      {
        name: 'baseline',
        type: 'text',
        description:
          "The metric's value and its n at the moment of filing, as the exact tool output, command " +
          'included so a later reader can re-run it. Verbatim: a paraphrase of a number is a new ' +
          'number, and only the original text is what a re-check can match. `not_measured` when ' +
          'the metric cannot be read yet -- never `0`, which asserts a measurement nobody took.',
      },
      {
        name: 'grading_point',
        type: 'duration',
        unit: 'days',
        description:
          'How long to wait before the metric can be graded, in active days -- the number ' +
          '`asc handlers power` reports for the effect size you would want to detect, against a ' +
          'horizon that defaults to 90. Before this point a reading of the metric is an ANECDOTE, ' +
          'not a comparison: there are too few units to separate the change from the noise, and ' +
          'reporting it as a grade is the false-signal class this whole product exists to ' +
          'prevent. A row whose grading point exceeds what the project produces in a reasonable ' +
          'horizon is closed `ungradeable` when it is proposed, not after waiting. ' +
          '**Do not read this property as the instant a grade falls due.** The `due_at` a reader ' +
          'prints is derived on every read as `applied_at` plus this many CALENDAR days, so it is ' +
          'an EARLIER bound on when the wait is up and never a claim that it is: active days and ' +
          'calendar days agree only where a project records something nearly every day, and on a ' +
          'sparse log the instant arrives well before the active days this property asked for. ' +
          'Read it as "due to become readable" rather than "due". ' +
          'The full argument and the measured divergence are in `dogfood/0106`.',
      },
      {
        name: 'control',
        type: 'string',
        description:
          'Another project, or a holdout arm, left unchanged to compare against. Absent when ' +
          'there is none -- never invented, because a fabricated control turns an anecdote into ' +
          'a number wearing the same clothes as a real one.',
      },
      {
        name: 'status',
        type: 'enum',
        enum_values: [...INTERVENTION_STATUS],
        required: true,
        description:
          'Where the row is now: `proposed` (written, nothing changed yet), `applied` (the change ' +
          'landed), `graded` (the metric was read against its baseline at or after ' +
          '`grading_point`), `reverted` (undone, with the reason carried on that entry), ' +
          '`ungradeable` (no honest grade is possible, and the entry says why rather than waiting ' +
          'forever). A change of state is a NEW entry naming the row it continues in `continues`; ' +
          "this value on the newest entry in a chain is the row's current state.",
      },
      {
        name: 'disposition',
        type: 'enum',
        enum_values: [...INTERVENTION_DISPOSITION],
        description:
          'What happens to the handler this row names once the row closes: `retired` (it did its ' +
          'job and nothing reads it again) or `regression_watch` (keep it, re-read it on a ' +
          "schedule, and raise a new proposed row if its rate returns past this row's baseline). " +
          'Written on the entry that CLOSES the row, because that is the moment the choice exists. ' +
          '**Write it only to say KEEP WATCHING.** `retired` is derivable and needs no writing: a ' +
          'handler named by a chain whose newest entry is `graded`, `reverted` or `ungradeable` is ' +
          'retired by that fact, and an absent `disposition` therefore means either "retired" or ' +
          '"this row is still open", which a reader tells apart from `status`. ' +
          '`asc handlers review` lists both the watches and the handlers that no row covers at ' +
          'all -- the ones neither an open row nor a watch is holding.',
      },
      {
        name: 'outcome',
        type: 'enum',
        enum_values: [...INTERVENTION_OUTCOME],
        description:
          'What the grade said: `helped`, `no_change` or `hurt`. Present only on a `graded` row, ' +
          'and always beside `outcome_measurement`. `no_change` is a real result and usually the ' +
          'common one -- a ledger that can only say `helped` is a highlight reel, not a ' +
          'measurement. ' +
          'NOT `verdict`, which three types already carry with three disjoint value sets -- ' +
          '`approved/changes_requested/rejected`, `failed/passed`, and free text. A fourth meaning ' +
          'on that name is the collision the definition warnings exist to catch, and it is why ' +
          'this one is `outcome`: the word the handler replay already uses for what a metric did.',
      },
      {
        name: 'outcome_measurement',
        type: 'text',
        description:
          'The metric read against its baseline, as the exact tool output, verbatim -- the same ' +
          'rule as `baseline` and for the same reason: this is the number `outcome` claims, and a ' +
          "reader who cannot re-run it has only the outcome's word for it. Absent until a grade " +
          'is taken.',
      },
      {
        name: 'continues',
        type: 'ref',
        description:
          'The entry id of the ROOT row this entry continues, set when this entry records a ' +
          'STATE CHANGE rather than a first sighting. Every entry in a chain carries the same ' +
          'root id, so a chain is one query and the current state is the newest entry in it. ' +
          'Deliberately not an annotation: annotations in this store are the invalidation ' +
          'mechanism, and a state change recorded as one would read to a reader asking "was this ' +
          'entry invalidated" as a retraction of the very row it is describing.',
      },
    ],
  },
];

/**
 * A reason `asc record` refuses one of the CLI's OWN starter types, which the definition language
 * cannot express.
 *
 * **Two rules live here now, and neither is expressible in a definition.** `stage_transition` refuses
 * a no-op transition that does not say why (`asc-xvz5`). `intervention` refuses a row carrying a
 * `metric` with no `rule` -- the condition `asc-09wx.8.1` settled, "a rule whenever there is a
 * metric". `PropertySpec` can say `required` and nothing finer, and `required` means "must have a
 * decision on EVERY row", which for `intervention` would make the capture mechanism's own
 * metric-less rows unwritable.
 *
 * `stage_transition`'s rule is the shape all of this was worked out on, and its reasoning transfers.
 * Its `to_status` description already says an equal `from_status` is *"legal and usually a mistake --
 * record the transition, not the state"*, and a description is prose: `definitionShape` drops it
 * before hashing and nothing reads it at write time. Expressing either rule in the definition would
 * mean a new `PropertySpec` field, which `definitionShape` would then have to carry -- its own doc
 * pins *"everything a stored value is validated against, and nothing else"*, and a field the
 * validator reads but the shape drops is the drift that doc forbids by construction. So every
 * registered type, in every store, would mint a new `type_hash`: a schema migration to guard one
 * property pair. The rules live here instead, beside the types they are about.
 *
 * **Why the CLI and not `core` or `store`.** Both are generic and neither holds a starter's name.
 * The only type this rule knows is one this package ships, so this package is where the knowledge
 * belongs -- and `record.ts` asks "does any starter object to this entry?" without naming one.
 *
 * **Why the write command and not the validation funnel.** `recordEntry` -> `validateEntry` is
 * shared by `asc record`, `asc import`, `asc ingest` and `asc index build`'s replay
 * (`jsonl-index.ts`), so a refusal raised there would make `asc index build` throw on a tree that
 * already holds a no-op. This repository's tree holds **four**, two of them deliberate -- measured
 * before choosing, and the reason the `asc-4wx6` precedent (whose pre-flight measured zero) does not
 * transfer. Applied where a NEW entry is written and nowhere else, an existing tree stays
 * reindexable and importable exactly as it is.
 *
 * **The rule is conditioned on a reason, and that is measured rather than lenient.** Of the four
 * no-op transitions in this project's own tree, two carry a paragraph explaining why the stage did
 * not move (*"to_status stays in_progress because the bead is 'asc kappa' and no asc kappa command
 * exists yet"*) and exactly one is the mistake. Refusing the no-op outright would have made those two
 * unwritable, which is a claim that a stage cannot be worked without advancing, and that claim is
 * false here. The acknowledgement is `evidence_text` -- the store's own field for "why is this true"
 * -- which is what those two already had and the mistake did not.
 */
export function starterEntryIssue(
  typeName: string,
  properties: Readonly<Record<string, unknown>> | undefined,
  evidenceText: string | undefined,
): ValidationIssue | undefined {
  if (typeName === 'stage_transition') return noOpTransitionIssue(properties, evidenceText);
  if (typeName === 'intervention') return metricWithoutRuleIssue(properties);
  return undefined;
}

/** `stage_transition`'s rule: a no-op transition is recorded only when it says why. */
function noOpTransitionIssue(
  properties: Readonly<Record<string, unknown>> | undefined,
  evidenceText: string | undefined,
): ValidationIssue | undefined {
  const from = properties?.['from_status'];
  const to = properties?.['to_status'];

  // Both must be present strings. `undefined === undefined` is two decisions nobody has made, not a
  // transition that goes nowhere, and the required-property rule in `validateEntry` already owns
  // that case -- with a message that names the absent property rather than quoting a value that is
  // not there. A non-string cannot reach here from `asc record` (the schema refuses it first), but
  // this function is not the schema and does not assume its work.
  if (typeof from !== 'string' || typeof to !== 'string' || from !== to) return undefined;

  // A reason, not the shape of one. Whitespace is the `asc-4wx6` defect in miniature -- a value
  // wearing a value's clothes -- and it would be stored as the answer to "why is this a no-op".
  if ((evidenceText ?? '').trim() !== '') return undefined;

  return {
    field: 'to_status',
    problem: `'to_status' is '${to}', the same as 'from_status' -- this entry records no transition`,
    fix:
      `A no-op transition is recorded only when it says why: re-record with ` +
      `--evidence=<why the stage did not move>, or set "evidence_text" in the document. ` +
      `Record the transition, not the state -- if no stage moved, there may be nothing to record.`,
  };
}

/**
 * `intervention`'s rule: a `metric` with no `rule` cannot be graded, so it is refused.
 *
 * **A row with no metric is not refused, and that half is what makes the rule usable at all.** The
 * capture mechanism (`asc-09wx.8.2`) writes rows nobody proposed: it hashes a watched file, sees a
 * difference, and records that something changed on a date. Those rows carry no `metric` and
 * therefore need no `rule`. Refusing them would make the mechanism's own output unwritable, which is
 * the same shape of mistake as demanding a reason for a no-op `stage_transition` -- a rule that
 * cannot be satisfied by the honest case it was written beside.
 *
 * **The rule reads VALUES, and an explicit N/A is the absence of one.** `--na metric` says this row
 * has nothing to be graded against, which is the honest encoding of "no metric" and passes, exactly
 * as omitting the property does. `--na rule` does NOT satisfy the rule, and that asymmetry is
 * deliberate: a row asserting both that the metric is worth measuring and that it is not worth
 * saying what would count has asserted a contradiction, and it is the precise state this rule exists
 * to refuse. Measured against the real binary rather than reasoned about -- the first version of
 * this function treated an N/A `metric` as a decision that a rule was owed, which refused the case
 * its own docblock said it passed.
 *
 * **Why the rule is about `rule` and not about `prediction`.** A row can be graded without a
 * prediction -- the numbers still move and the rule still says which direction counted. A row cannot
 * be graded without a rule: "did the metric improve" has no answer until someone says what improving
 * is, and choosing that after seeing the numbers is the failure mode pre-registration exists to
 * close. The prediction is what makes being wrong informative; the rule is what makes the verdict
 * mean anything at all.
 */
function metricWithoutRuleIssue(
  properties: Readonly<Record<string, unknown>> | undefined,
): ValidationIssue | undefined {
  const hasValue = (name: string): boolean => {
    const value = properties?.[name];
    // `null` counts as nobody having said: JSON has no representation for it in a `json` property,
    // so an entry carrying one is going to be refused by the schema moments later, and this rule
    // should not be the message that gets in front of a clearer one.
    return value !== undefined && value !== null;
  };

  if (!hasValue('metric') || hasValue('rule')) return undefined;

  return {
    field: 'rule',
    problem: 'this entry carries a metric but no rule for what "helped" would mean',
    fix:
      `A metric is a comparison, and the rule is which direction counts: without one the grade is ` +
      `whatever the numbers happened to do, read by someone who already knows the answer they ` +
      `want. Re-record with --prop=rule=<what counts as helped, over what window>, or set "rule" ` +
      `in the document -- or drop the metric, which makes this a captured change rather than a ` +
      `proposed one.`,
  };
}
