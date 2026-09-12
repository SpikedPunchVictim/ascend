import { describe, expect, it } from 'vitest';
import { canonicalName, confusableNames, nameTokens } from '../src/index.js';

/**
 * The define-time vocabulary check, tested against the corpus that motivated it.
 *
 * **The fixture is the real one.** `DRIFT` below is every property name the five independently
 * authored `review-completed` specs in `spike/drift/spec-{1..5}.json` actually contain -- 52
 * distinct spellings -- carried here verbatim rather than replaced with invented names like
 * `foo_bar`. Two reasons, and the second is the load-bearing one: invented names would let the
 * check pass on a corpus that does not contain the drift it exists to catch, and the corpus is
 * also the only place the numbers in this module's doc comment can be *re-derived* rather than
 * quoted. The first `describe` block does exactly that, so if `canonicalName` ever stops folding
 * the way EV-drift assumed, the module's stated justification fails here instead of quietly
 * becoming false.
 */

/** The 52 real property-name spellings, from `spike/drift/spec-{1..5}.json`. */
const DRIFT = [
  'stage',
  'reviewed_artifact',
  'reviewer',
  'review_method',
  'completed_at',
  'duration',
  'verdict',
  'verdict_rationale',
  'findings_count',
  'blocking_findings_count',
  'max_severity',
  'confidence',
  'follow_up_required',
  'scope_notes',
  'reviewId',
  'workflowStage',
  'reviewTarget',
  'reviewerKind',
  'startedAt',
  'completedAt',
  'outcome',
  'maxSeverity',
  'findingsCount',
  'blockingFindingsCount',
  'scopeFilesCount',
  'scopeLinesChanged',
  'automatedChecksPassed',
  'followUpRequired',
  'evidence',
  'notes',
  'review_stage',
  'artifact_ref',
  'artifact_kind',
  'head_revision',
  'reviewer_ref',
  'reviewer_kind',
  'highest_severity',
  'scope_covered',
  'findings_summary',
  'follow_up_estimate',
  'target_ref',
  'coverage',
  'next_action',
  'follow_up_ref',
  'reviewType',
  'reviewerModel',
  'artifactRef',
  'artifactRevision',
  'criteriaRef',
  'reworkRequired',
  'summary',
  'followUpRef',
] as const;

const shared = (name: string, known: readonly string[]): readonly string[] =>
  confusableNames(name, known).map((match) => match.name);

/**
 * The same, folded -- for the tests whose claim is about the CONCEPT found rather than about which
 * spelling of it was reported. The corpus holds `max_severity` and `maxSeverity`; both are one name
 * after folding, and which of the two a warning prints is a separate (and separately tested) choice.
 * Asserting a raw spelling here would make this test fail over a change that is not a defect.
 */
const sharedFolded = (name: string, known: readonly string[]): readonly string[] =>
  shared(name, known).map(canonicalName);

describe('the real corpus, re-derived', () => {
  it('folds 52 real spellings to the 44 names EV-drift measured', () => {
    // EV-drift's table says "44 distinct property names" and "4 shared by all five" -- a 0.091
    // intersection/union. Every one of those three figures came from a corpus that had NOT been
    // through this code. Re-deriving them here is what ties the module's doc comment to a fact
    // that fails loudly if the folding changes.
    const canonical = [...new Set(DRIFT.map(canonicalName))];

    expect(DRIFT.length).toBe(52);
    expect(canonical.length).toBe(44);
    expect(4 / canonical.length).toBeCloseTo(0.091, 3);
  });

  it('tokenizes the convention split into one name, which is half the drift already gone', () => {
    // EV-drift recorded "3 snake_case vs 2 camelCase" as a separate failure mode. It is not a
    // separate one here: both spellings reach the same tokens before anything is compared.
    expect(nameTokens('reviewerKind')).toEqual(['reviewer', 'kind']);
    expect(nameTokens('reviewer_kind')).toEqual(['reviewer', 'kind']);
    expect(nameTokens('blockingFindingsCount')).toEqual(nameTokens('blocking_findings_count'));
  });
});

describe('nameTokens', () => {
  it('splits on the fold, not on the raw spelling', () => {
    // The order is the whole point: tokenizing raw would make `workflowStage` ONE token and
    // `workflow_stage` two, so the two spellings of one name would look maximally dissimilar.
    expect(nameTokens('workflowStage')).toEqual(['workflow', 'stage']);
  });

  it('yields nothing for a name with no alphanumerics', () => {
    // `canonicalName` folds punctuation-only input to the empty string, so this is reachable from
    // an author who typed only separators.
    expect(nameTokens('---')).toEqual([]);
    expect(nameTokens('')).toEqual([]);
  });
});

describe('confusableNames', () => {
  it('finds the real same-concept pairs the corpus contains', () => {
    // `stage` vs `review_stage` is the marquee case: the same concept, named with and without a
    // qualifier, by different authors. This is the drift, and whole-token sharing catches it
    // with no threshold to tune.
    expect(shared('stage', DRIFT)).toContain('review_stage');
    // `highest_severity` vs `max_severity` -- same slot in the spec, different adjective.
    expect(sharedFolded('highest_severity', DRIFT)).toContain('max_severity');
    // `follow_up_required` vs `reworkRequired` -- same boolean, different verb.
    expect(sharedFolded('follow_up_required', DRIFT)).toContain('rework_required');
  });

  it('reports the shared tokens, because the reason is checkable and a score is not', () => {
    const found = confusableNames('stage', DRIFT).find((match) => match.name === 'review_stage');

    expect(found?.shared).toEqual(['stage']);
    // Not merely "a match": `artifact_ref` must NOT be reported for `stage`, so a bug that
    // matched on anything would fail here rather than look successful.
    expect(shared('stage', DRIFT)).not.toContain('artifact_ref');
  });

  it('does not report a name that is the same name, only one that is a similar one', () => {
    // An exact match after folding means "this is the same name", which `registerType` answers
    // separately -- as `unchanged`, or as the next version. Reporting it here would bury the
    // real signal under a match that means the opposite.
    expect(confusableNames('completed_at', DRIFT).map((m) => canonicalName(m.name))).not.toContain(
      'completed_at',
    );
    // `completedAt` is the same name as `completed_at` after folding, so neither spelling
    // appears for the other.
    expect(shared('completedAt', DRIFT)).not.toContain('completed_at');
    expect(shared('completed_at', DRIFT)).not.toContain('completedAt');
  });

  it('reports each folded name once, not once per spelling', () => {
    // The corpus holds both `max_severity` and `maxSeverity`, so a pass without dedup would emit
    // one concept twice under two spellings and read as two findings. Exactly one appears.
    expect(confusableNames('highest_severity', DRIFT).map((m) => m.name)).toEqual(['maxSeverity']);

    // And exactly one spelling of `findings_count`/`findingsCount` appears, on the real corpus
    // rather than a constructed pair -- asserted as presence-and-absence so a result that
    // reported neither would fail rather than pass quietly.
    const matches = confusableNames('blocking_findings_count', DRIFT).map((m) => m.name);
    expect(matches).toContain('findingsCount');
    expect(matches).not.toContain('findings_count');
  });

  it('picks one spelling deterministically, from the name set alone', () => {
    // This assertion is what caught the reported spelling being decided by the caller's array
    // order -- a real instability, not a hypothetical: the same names in reverse order reported
    // `started_at` instead of `startedAt`. Both spellings fold to one name, so the choice has to
    // come from somewhere, and it must not come from the caller.
    const forward = confusableNames('completed_at', ['startedAt', 'started_at']).map((m) => m.name);
    const reversed = confusableNames('completed_at', ['started_at', 'startedAt']).map(
      (m) => m.name,
    );

    expect(forward).toEqual(['startedAt']);
    expect(reversed).toEqual(forward);
  });

  it('misses a synonym that shares no token, and that miss is the documented limit', () => {
    // `verdict` (one author) and `outcome` (three authors) are the same slot with no token in
    // common. No token-sharing check can reach it, and a similarity threshold that could would
    // sit above the 0.300 same-concept agreement EV-drift measured, i.e. would refuse
    // legitimate definitions. Asserting the miss keeps it a known boundary rather than a
    // surprise -- and pins the behaviour so a later change has to be deliberate.
    expect(shared('verdict', DRIFT)).not.toContain('outcome');
    // The same call does find the true positive, so the negative above is a limit of the
    // method and not an empty result standing in for one.
    expect(shared('verdict', DRIFT)).toContain('verdict_rationale');
  });

  it('orders by how much is shared, then by name, so the list is stable across runs', () => {
    // `followUpRequired` and `follow_up_estimate` each share two tokens with `follow_up_ref`; the
    // four `*_ref` names share one each. Real names from the corpus, and chosen because they make
    // the two orderings DISAGREE: sorted by name alone, `artifactRef` would come FIRST, so this
    // assertion is what distinguishes most-shared-first from alphabetical. The earlier version of
    // this test asserted an order the two sortings happened to agree on, and a mutation that
    // dropped the primary sort survived it.
    //
    // The whole list is asserted, so the tiebreak among the four equal-scoring names is pinned too
    // -- a set, not a list, would let the output reshuffle between two runs.
    expect(confusableNames('follow_up_ref', DRIFT).map((m) => m.name)).toEqual([
      'followUpRequired',
      'follow_up_estimate',
      'artifactRef',
      'criteriaRef',
      'reviewer_ref',
      'target_ref',
    ]);

    // A second real case, where the two orderings agree -- kept because agreement is also a
    // property worth pinning, and it is the case the corpus produces most often.
    expect(confusableNames('blocking_findings_count', DRIFT).map((m) => m.name)).toEqual([
      'findingsCount',
      'findings_summary',
      'scopeFilesCount',
    ]);

    // And the ordering must not depend on input order, or two invocations cannot be diffed.
    // Built by REVERSING the corpus.
    const forward = confusableNames('blocking_findings_count', DRIFT);
    const reversed = confusableNames('blocking_findings_count', [...DRIFT].reverse());

    expect(reversed).toEqual(forward);
  });

  it('returns every match rather than a page, so a caller can report what it did not show', () => {
    // Deliberately uncapped. An earlier version took a `limit` and sliced here, which left the one
    // caller that formats a message unable to distinguish "three matches" from "three shown, more
    // found" -- and its warning then named three of six. How many to print is a presentation
    // decision, so it belongs to the presenter, which can also say that it truncated.
    expect(confusableNames('review_stage', DRIFT).length).toBeGreaterThan(3);
    // The widest match set the real corpus produces, measured rather than assumed -- the reason an
    // uncapped list is affordable here.
    expect(confusableNames('follow_up_required', DRIFT).length).toBeLessThanOrEqual(6);
  });

  it('returns nothing when there is nothing to compare against', () => {
    expect(confusableNames('stage', [])).toEqual([]);
    // A punctuation-only name yields no tokens, so it matches nothing. It would match nothing with
    // or without the early return above -- both were run -- so this asserts the OUTCOME and does not
    // claim to test that line.
    expect(confusableNames('---', DRIFT)).toEqual([]);
  });

  it('finds nothing confusable in a corpus with no shared tokens', () => {
    // The negative control. Without it, every assertion above would also pass if the function
    // returned matches for everything.
    expect(confusableNames('unrelated', ['alpha', 'beta', 'gamma'])).toEqual([]);
  });
});
