/**
 * The shipped starter types, checked for the one thing the brief cannot tell a recorder.
 *
 * `asc types brief` carries a type's NAME and its `record_when` prose and nothing else
 * (`commands/types/brief.ts`) -- no properties, no descriptions, no flag syntax. That is deliberate:
 * the brief is injected into every session, so `asc-9an` measured its cost at 301 bytes per type and
 * capped it at 2,000 tokens. But it has a consequence that `asc-4so.1` found by driving a real model
 * against the real brief: **a model learns a property exists only at record time**, by running
 * `asc types show`, and for a property whose value is destroyed by paraphrase that is too late to
 * know it had to be preserved.
 *
 * The measured scope was narrow and stays narrow here. Sweeping all four types' property
 * descriptions for verbatim-demanding language (`verbatim`, `raw`, `exact`, `as it was printed`,
 * `not a summary`, `transcript`, `literal`, `quote`) found exactly ONE hit in the whole starter set:
 * `stuck_event.error_text`. Every other property is reconstructible at record time -- `rationale` is
 * "why", which the recorder still holds; `chosen` must match its own `options_considered`, which is
 * in the same document. So this is not "the brief is incomplete"; it is that the brief never tells a
 * recorder that anything must be preserved, and exactly one shipped field needs to be.
 *
 * **These assertions are on the definitions, not on a rendered brief, and that is the point.** The
 * coupling being guarded is between two prose fields in this file: a property description that
 * demands literal text, and the `record_when` of the type that carries it. A test that rendered the
 * brief could only check the second half, and would pass just as happily if a future starter type
 * added an `error_text`-shaped field with no instruction to keep it.
 *
 * **What this cannot check.** Whether a model that IS told to preserve raw output actually does so.
 * `asc-4so.1` records that as unmeasured -- one model-in-the-loop run, one type, one scenario, and
 * the run's own scenario handed the model no raw failure output to preserve, so it never had the
 * chance to fail. The prose is a fix; its effect is unvalidated, and it is filed as `asc-4so.2`.
 */

import { describe, expect, it } from 'vitest';
import { STARTER_TYPES } from '../src/starters.js';

/**
 * Language in a property description that asks for material a paraphrase would destroy.
 *
 * The cue list is lifted from the sweep `asc-4so.1` ran, so the vocabulary that found the defect is
 * the vocabulary that guards against the next one. A cue matching too eagerly is the safe direction:
 * it demands a preservation instruction it may not strictly need, which fails loudly, rather than
 * missing one it did need, which fails silently.
 */
const VERBATIM_CUE = [
  'verbatim',
  'raw',
  'exact',
  'as it was printed',
  'not a summary',
  'transcript',
  'literal',
  'quote',
];

/**
 * Language in a `record_when` that tells a recorder the literal words are what to keep.
 *
 * Naming the exactness is the instruction: a brief line saying "`error_text` wants the exact words"
 * has told the recorder, before the failure happens, that the words are the thing to hold onto.
 */
const PRESERVE_CUE = ['verbatim', 'exact words', 'exact text', 'as it was printed', 'as printed'];

const hasCue = (text: string | undefined, cues: readonly string[]): boolean => {
  const lower = (text ?? '').toLowerCase();
  return cues.some((cue) => lower.includes(cue));
};

/** Every (type, property) pair whose description asks for text a paraphrase would destroy. */
const verbatimProperties = STARTER_TYPES.flatMap((spec) =>
  spec.properties
    .filter((property) => hasCue(property.description, VERBATIM_CUE))
    .map((property) => ({ type: spec.name, property: property.name, spec })),
);

describe('starter types: a verbatim field is announced before it is needed', () => {
  it('finds the verbatim-demanding fields rather than scanning nothing', () => {
    // The negative control, and the reason this suite exists in this shape. A cue list that matches
    // no description would make every assertion below vacuously true -- green while checking nothing,
    // which is the false-green class `packages/core/test/purity-enforcement.test.ts` codifies. If the
    // prose drifts away from this vocabulary, this fails and names the drift instead of going quiet.
    expect(verbatimProperties.map((found) => `${found.type}.${found.property}`)).toContain(
      'stuck_event.error_text',
    );
  });

  it.each(verbatimProperties.map((found) => [found.type, found.property, found.spec] as const))(
    '%s.%s is announced in the brief',
    (type, property, spec) => {
      // `record_when` is the ONLY field of a type that reaches a session before the work starts, so
      // it is the only place this instruction can live. A property description cannot carry it: the
      // brief does not show descriptions, which is the whole finding.
      expect(
        hasCue(spec.record_when, PRESERVE_CUE),
        `${type}.${property} demands literal text, but ${type}'s record_when never says to keep it -- ` +
          'a recorder reads the brief, not the property descriptions, so it learns this too late',
      ).toBe(true);
    },
  );

  it('gives every starter type a record_when, because that is all the brief carries', () => {
    // The brief renders a missing one as "no record_when given", which is honest and useless to a
    // recorder. For a type ascend ships rather than one a user wrote, the prose is the entire point.
    expect(STARTER_TYPES.filter((spec) => !spec.record_when?.trim()).map((s) => s.name)).toEqual(
      [],
    );
  });

  it('leaves the reconstructible properties alone, so the cue list is not simply matching everything', () => {
    // The other half of the control. If `hasCue` matched every description, the suite would demand a
    // preservation clause on all four types and pass for the wrong reason. `decision.rationale` is the
    // clearest case: it is "why", which the recorder is holding at record time, so it needs nothing.
    const rationale = STARTER_TYPES.find((spec) => spec.name === 'decision')?.properties.find(
      (property) => property.name === 'rationale',
    );
    expect(hasCue(rationale?.description, VERBATIM_CUE)).toBe(false);
  });
});
