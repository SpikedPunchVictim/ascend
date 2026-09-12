/**
 * The four types `asc init` installs. Shapes settled in ARCHITECTURE.md, "Starter types".
 *
 * **The governing principle is that anything mechanically derivable is not here.** A transcript
 * already records which tools ran, which skills activated, which commands failed -- `adapter-claude-code`
 * (E5) reads all of it off disk, retroactively and more reliably than an LLM reporting on itself.
 * So the shipped set covers only what a transcript cannot see: judgment. A review's verdict, what
 * was tried before giving up, why one approach beat another. Asking a model to self-report a fact
 * that is already on disk spends its attention to get a worse copy.
 *
 * **These are a starting point, not a schema.** They are ordinary definitions installed through the
 * ordinary `registerType` path, so they version, diff and export exactly like anything a user
 * defines. A project that wants different enum values edits them; nothing depends on these four
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

import type { TypeSpec } from '@ascend/core';

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
      'and it is the least reconstructable thing in the whole store.',
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
];
