import { describe, expect, it } from 'vitest';
import { BacktestError, backtest, type BacktestReport } from '../src/index.js';
import type { Labelled } from '../src/agreement.js';

/**
 * `backtest.ts` -- grading a rule's predictions against a hand-labelled ground truth.
 *
 * EVERY EXPECTED NUMBER BELOW IS COUNTED BY HAND FROM THE FIXTURE, not read off the
 * implementation -- the same discipline `agreement.test.ts` applies to kappa, and for the same
 * reason: a fixture whose expectation came from the code under test proves only that the code
 * agrees with itself.
 */

const label = (id: string, value: string): Labelled => ({ id, label: value });

function measureOf(report: BacktestReport, label: string) {
  const measure = report.measures.find((entry) => entry.label === label);
  if (measure === undefined) throw new Error(`no measure for label '${label}'`);
  return measure;
}

describe('backtest', () => {
  it('reports true positives, false positives and false negatives per label', () => {
    // 6 hand-labelled entries: e1,e2,e3 are 'bug'; e4,e5 are 'docs'; e6 is 'bug'.
    // The rule predicts: e1,e2 'bug' (right), e3 'docs' (wrong -- a bug it called docs), e4 'docs'
    // (right), e5 unpredicted (a docs the rule missed entirely), e6 'bug' (right).
    const truth = [
      label('e1', 'bug'),
      label('e2', 'bug'),
      label('e3', 'bug'),
      label('e4', 'docs'),
      label('e5', 'docs'),
      label('e6', 'bug'),
    ];
    const predicted = [
      label('e1', 'bug'),
      label('e2', 'bug'),
      label('e3', 'docs'),
      label('e4', 'docs'),
      label('e6', 'bug'),
    ];

    const report = backtest(predicted, truth);

    expect(report.compared).toBe(6);
    expect(report.labels).toStrictEqual(['bug', 'docs']);

    const bug = measureOf(report, 'bug');
    // hand said 'bug' for e1,e2,e3,e6 (actual=4); rule said 'bug' for e1,e2,e6 (predicted=3);
    // both agree on e1,e2,e6 (truePositives=3). e3 is a false negative (hand bug, rule missed it
    // by calling it docs). No false positive: the rule never called a non-bug entry 'bug'.
    expect(bug.actual).toBe(4);
    expect(bug.predicted).toBe(3);
    expect(bug.truePositives).toBe(3);
    expect(bug.falseNegatives).toStrictEqual(['e3']);
    expect(bug.falsePositives).toStrictEqual([]);

    const docs = measureOf(report, 'docs');
    // hand said 'docs' for e4,e5 (actual=2); rule said 'docs' for e3,e4 (predicted=2); both agree
    // only on e4 (truePositives=1). e3 is a false positive (rule called it docs, hand said bug).
    // e5 is a false negative (hand said docs, rule never predicted anything for e5).
    expect(docs.actual).toBe(2);
    expect(docs.predicted).toBe(2);
    expect(docs.truePositives).toBe(1);
    expect(docs.falsePositives).toStrictEqual(['e3']);
    expect(docs.falseNegatives).toStrictEqual(['e5']);
  });

  it('computes precision and recall as wilson proportions, not bare ratios', () => {
    const truth = [label('e1', 'bug'), label('e2', 'bug'), label('e3', 'docs')];
    const predicted = [label('e1', 'bug'), label('e2', 'bug')];

    const report = backtest(predicted, truth);
    const bug = measureOf(report, 'bug');

    // Both proportions are 1.0 (2/2), but they are the STRUCTURE wilson() returns, not the number 1
    // -- a caller reading `bug.precision.p` gets 1, but the interval is what says how much that
    // point estimate is worth at n=2.
    expect(bug.precision?.successes).toBe(2);
    expect(bug.precision?.n).toBe(2);
    expect(bug.precision?.p).toBe(1);
    expect(bug.precision?.smallGroup).toBe(true); // n=2 is far below MIN_N=20
    expect(bug.recall?.successes).toBe(2);
    expect(bug.recall?.n).toBe(2);
  });

  it('omits precision when the rule never predicted a label the hand truth used', () => {
    const truth = [label('e1', 'bug'), label('e2', 'docs')];
    const predicted = [label('e1', 'bug')]; // the rule has no rule for 'docs' at all

    const report = backtest(predicted, truth);
    const docs = measureOf(report, 'docs');

    // predicted=0 for 'docs': the rule never claimed it, so precision has no denominator and must
    // be null (an omission), never a fabricated 0.00 -- see proportion.ts, departure 2.
    expect(docs.predicted).toBe(0);
    expect(docs.precision).toBeNull();
    // recall IS defined: the hand truth used 'docs' once, the rule found none of it, so recall is a
    // real 0% over n=1, not an absence.
    expect(docs.recall?.successes).toBe(0);
    expect(docs.recall?.n).toBe(1);
  });

  it('omits recall when the hand truth never used a label the rule predicted', () => {
    const truth = [label('e1', 'bug')];
    const predicted = [label('e1', 'bug'), label('e2', 'chore')]; // e2 is outside the truth universe

    const report = backtest(predicted, truth);

    // 'chore' never appears in the truth, so it is not even in the label set -- there is nothing to
    // grade it against, and e2 is outside the compared universe entirely (only e1 is truth-labelled).
    expect(report.compared).toBe(1);
    expect(report.labels).toStrictEqual(['bug']);
  });

  it('reports a label the rule predicted within the universe but the hand truth never used', () => {
    const truth = [label('e1', 'bug'), label('e2', 'bug')];
    const predicted = [label('e1', 'chore'), label('e2', 'bug')]; // e1: rule says chore, hand says bug

    const report = backtest(predicted, truth);
    const chore = measureOf(report, 'chore');

    // The rule predicted 'chore' for e1, which IS in the universe (truth-labelled, just not as
    // 'chore') -- so precision is defined (0 of 1) and recall is undefined (the hand truth never
    // used 'chore' at all, so there is nothing to recall).
    expect(chore.predicted).toBe(1);
    expect(chore.truePositives).toBe(0);
    expect(chore.precision?.successes).toBe(0);
    expect(chore.precision?.n).toBe(1);
    expect(chore.actual).toBe(0);
    expect(chore.recall).toBeNull();
  });

  it('ignores a predicted entry outside the ground-truth universe entirely', () => {
    const truth = [label('e1', 'bug')];
    const predicted = [label('e1', 'bug'), label('e9', 'bug')]; // e9 has no ground truth

    const report = backtest(predicted, truth);
    const bug = measureOf(report, 'bug');

    // e9 changes nothing: it is not part of what backtest() can grade, because there is no truth to
    // compare it against.
    expect(report.compared).toBe(1);
    expect(bug.predicted).toBe(1);
    expect(bug.truePositives).toBe(1);
  });

  it('reports an empty comparison rather than a fabricated one when the truth is empty', () => {
    const report = backtest([label('e1', 'bug')], []);

    expect(report.compared).toBe(0);
    expect(report.labels).toStrictEqual([]);
    expect(report.measures).toStrictEqual([]);
  });

  it('refuses a duplicate id within one list', () => {
    expect(() => backtest([label('e1', 'bug'), label('e1', 'docs')], [label('e1', 'bug')])).toThrow(
      BacktestError,
    );
    expect(() => backtest([label('e1', 'bug')], [label('e1', 'bug'), label('e1', 'docs')])).toThrow(
      BacktestError,
    );
  });

  it('refuses an empty id or an empty label in either list', () => {
    expect(() => backtest([{ id: '', label: 'bug' }], [label('e1', 'bug')])).toThrow(BacktestError);
    expect(() => backtest([{ id: 'e1', label: '' }], [label('e1', 'bug')])).toThrow(BacktestError);
    expect(() => backtest([label('e1', 'bug')], [{ id: 'e1', label: '' }])).toThrow(BacktestError);
  });
});
