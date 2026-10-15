import { describe, expect, it } from 'vitest';
import { dueGrades, ledgerRows, gradingPoint, type LedgerEntry } from '../src/intervention.js';

/**
 * The `intervention` state rule (`asc-09wx.8.1`).
 *
 * A row is immutable, so a state change is a new entry naming the root it continues -- and the
 * row's current state is the newest entry in its chain. These tests pin the two halves a reader
 * depends on: which entry is the newest, and when a claim to have graded something was made too
 * early to mean anything.
 */

const entry = (
  id: string,
  recordedAt: string,
  properties: Record<string, unknown>,
): LedgerEntry => ({ id, recorded_at: recordedAt, properties });

/** A row proposed, then applied, then graded -- the three entries one chain typically holds. */
const proposed = (root: string): LedgerEntry =>
  entry(root, '2026-10-01T00:00:00.000Z', {
    change: '.claude/settings.json',
    status: 'proposed',
    grading_point: 10,
  });

describe('ledgerRows: a chain, and the newest entry in it', () => {
  it('treats an entry naming no root as a root, so a lone row is a chain of one', () => {
    const rows = ledgerRows([proposed('a')], new Date('2026-10-02T00:00:00.000Z'));
    expect(rows.map((row) => [row.root, row.head.id, row.chain.length])).toEqual([['a', 'a', 1]]);
  });

  it('gives the current state from the newest entry, not from the root', () => {
    // The whole point of the chain. The root says `proposed` forever -- it is immutable -- so a
    // reader who took the root would report a change that was applied months ago as unstarted.
    const rows = ledgerRows(
      [
        proposed('a'),
        entry('b', '2026-10-02T00:00:00.000Z', { status: 'applied', continues: 'a' }),
        entry('c', '2026-10-20T00:00:00.000Z', { status: 'graded', continues: 'a' }),
      ],
      new Date('2026-10-21T00:00:00.000Z'),
    );
    expect(rows).toHaveLength(1);
    expect([rows[0]?.root, rows[0]?.head.id, rows[0]?.head.properties['status']]).toEqual([
      'a',
      'c',
      'graded',
    ]);
    expect(rows[0]?.chain.map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders by (recorded_at, id), so two entries written in the same instant still have a newest', () => {
    // Ids are random UUIDs, so `id` alone is not an order -- but two entries CAN share a
    // `recorded_at` (`recorded_at` is the ingest clock, and a fused write batches), so the
    // tiebreaker has to exist and has to be total. Without it the head is whichever the sort
    // happened to leave last, and the reported state changes between runs on identical input.
    const same = '2026-10-02T00:00:00.000Z';
    const rows = ledgerRows(
      [
        entry('zz', same, { continues: 'a', status: 'graded' }),
        entry('aa', same, { continues: 'a', status: 'proposed' }),
      ],
      new Date('2026-10-03T00:00:00.000Z'),
    );
    expect(rows[0]?.head.id).toBe('zz');
  });

  it('does not read a blank continues as a root id, which would merge unrelated rows', () => {
    // An empty string is a value wearing a value's clothes. Read as an id, every entry carrying one
    // lands in a single chain named "" -- and their states would overwrite each other's.
    const rows = ledgerRows(
      [
        entry('a', '2026-10-01T00:00:00.000Z', { continues: '   ', status: 'proposed' }),
        entry('b', '2026-10-01T00:00:00.000Z', { continues: '', status: 'applied' }),
      ],
      new Date('2026-10-02T00:00:00.000Z'),
    );
    expect(rows.map((row) => row.root).sort()).toEqual(['a', 'b']);
  });

  it('keeps a chain whose root is not among the entries a caller passed', () => {
    // A reader filtering by date or by project holds the state changes and not necessarily the
    // entry that started the chain. Dropping those rows would lose exactly the recent work the
    // filter was written to find.
    const rows = ledgerRows(
      [entry('b', '2026-10-02T00:00:00.000Z', { continues: 'a', status: 'applied' })],
      new Date('2026-10-03T00:00:00.000Z'),
    );
    expect(rows.map((row) => [row.root, row.head.id])).toEqual([['a', 'b']]);
  });
});

describe('ledgerRows: a grade taken before the row said it could be', () => {
  const graded = (root: string, at: string): LedgerEntry =>
    entry(root, at, { status: 'graded', continues: 'a' });

  /**
   * The state change the capture mechanism writes when the change lands: it carries `continues`,
   * because a row proposed and then applied is one chain, and `applied_at`, which is the fact the
   * proposal could not have known.
   *
   * This helper exists because a version of this fixture left `continues` off, which made the
   * applied entry its OWN root -- two chains, one of them with no `grading_point`, so `dueAt`
   * returned `undefined` and the shortfall was never reported. One assertion in this file passed
   * for exactly that reason (`premature` is `undefined` in both the "on time" case and the
   * "nowhere to tell" case), which is the false-green shape this repository treats as its worst
   * defect class. The fixture is now the realistic one.
   */
  const applied = (at: string): LedgerEntry =>
    entry('b', at, { status: 'applied', continues: 'a', applied_at: at });

  it('reports the shortfall, with the due date and whole days remaining', () => {
    const rows = ledgerRows(
      [proposed('a'), applied('2026-10-01T00:00:00.000Z'), graded('c', '2026-10-05T00:00:00.000Z')],
      new Date('2026-10-05T00:00:00.000Z'),
    );
    expect(rows[0]?.premature).toEqual({ dueAt: '2026-10-11T00:00:00.000Z', daysShort: 6 });
  });

  it('never reports zero days short, so a partial day is still a day', () => {
    // `Math.floor` here would report `daysShort: 0` with the grade still premature -- a row that
    // says it is early and says nothing remains, which a reader skims as "not early".
    const rows = ledgerRows(
      [proposed('a'), applied('2026-10-01T00:00:00.000Z'), graded('c', '2026-10-10T12:00:00.000Z')],
      new Date('2026-10-10T12:00:00.000Z'),
    );
    expect(rows[0]?.premature?.daysShort).toBe(1);
  });

  it('leaves a grade taken on or after the grading point alone', () => {
    const at = (now: string): ReturnType<typeof ledgerRows> =>
      ledgerRows(
        [
          proposed('a'),
          applied('2026-10-01T00:00:00.000Z'),
          graded('c', '2026-10-11T00:00:00.000Z'),
        ],
        new Date(now),
      );
    // On the due date itself, and a day past it. The point of the boundary is that a row graded
    // exactly when it said it would be is not flagged -- an off-by-one here would mark every
    // correctly-timed grade as premature.
    expect(at('2026-10-11T00:00:00.000Z')[0]?.premature).toBeUndefined();
    expect(at('2026-10-12T00:00:00.000Z')[0]?.premature).toBeUndefined();
  });

  it('reads applied_at and grading_point off whichever entry carries them', () => {
    // The two are written at different moments -- `applied_at` arrives with the capture mechanism,
    // `grading_point` with the proposal -- so on the real path they are on DIFFERENT entries, and a
    // rule requiring one entry to carry both would find neither. Reading only the head would lose
    // both and report every premature grade as fine.
    const rows = ledgerRows(
      [proposed('a'), applied('2026-10-01T00:00:00.000Z'), graded('c', '2026-10-05T00:00:00.000Z')],
      new Date('2026-10-05T00:00:00.000Z'),
    );
    expect(rows[0]?.premature?.dueAt).toBe('2026-10-11T00:00:00.000Z');
  });

  it('takes the newest statement of the wait, so a row that restarted its clock is measured from the restart', () => {
    // D1's first exit: a row whose ruler changed takes a fresh baseline, which RESETS `applied_at`
    // and restarts the wait. Reading the oldest statement would compute a due date the row has
    // since abandoned, and an abandoned due date is the earlier one -- so the grade would read as
    // on time when it is not.
    const rows = ledgerRows(
      [
        proposed('a'),
        applied('2026-10-01T00:00:00.000Z'),
        entry('d', '2026-10-08T00:00:00.000Z', {
          status: 'applied',
          continues: 'a',
          applied_at: '2026-10-08T00:00:00.000Z',
        }),
        graded('c', '2026-10-09T00:00:00.000Z'),
      ],
      new Date('2026-10-09T00:00:00.000Z'),
    );
    expect(rows[0]?.premature?.dueAt).toBe('2026-10-18T00:00:00.000Z');
  });

  it('says nothing rather than guessing when the chain declares no grading point', () => {
    // Silence is the honest answer twice over: the chain never said when it could be graded, and
    // the OTHER half of the rule -- how many units the metric actually collected -- lives in the
    // handler replay (`asc-09wx.8.3`) and is not available here at all.
    const rows = ledgerRows(
      [
        entry('a', '2026-10-01T00:00:00.000Z', { status: 'proposed' }),
        graded('c', '2026-10-02T00:00:00.000Z'),
      ],
      new Date('2026-10-03T00:00:00.000Z'),
    );
    expect(rows[0]?.premature).toBeUndefined();
  });

  it('does not compare an unparseable applied_at, which would read as "not premature"', () => {
    // NaN propagates through `>` as false, so a bad date would pass the guard and report a
    // premature grade as fine -- the false-green direction, on the one check that exists to catch
    // a premature grade.
    const rows = ledgerRows(
      [
        entry('a', '2026-10-01T00:00:00.000Z', {
          status: 'proposed',
          grading_point: 10,
          applied_at: 'sometime last week',
        }),
        graded('c', '2026-10-02T00:00:00.000Z'),
      ],
      new Date('2026-10-03T00:00:00.000Z'),
    );
    expect(rows[0]?.premature).toBeUndefined();
  });

  it('does not flag a chain whose head claims no grade, however early it is', () => {
    const rows = ledgerRows(
      [proposed('a'), applied('2026-10-01T00:00:00.000Z')],
      new Date('2026-10-02T00:00:00.000Z'),
    );
    expect(rows[0]?.premature).toBeUndefined();
  });
});

/**
 * `gradingPoint` on its own (`asc-09wx.8.3`).
 *
 * `LedgerRow.premature` answers "was this grade taken too early" and is absent on every row that
 * has not been graded -- which is every row the grader and the brief line care about. They ask the
 * other question, "how long does this row mean to wait, and from when", and this is the function
 * that answers it.
 */
describe('gradingPoint: where a chain says its wait ends', () => {
  const applied = (at: string): LedgerEntry =>
    entry('b', at, { status: 'applied', continues: 'a', applied_at: at });

  it('gathers the two facts from different entries, which is how they are actually written', () => {
    const point = gradingPoint([proposed('a'), applied('2026-10-01T00:00:00.000Z')]);
    expect(point).toEqual({
      appliedAt: '2026-10-01T00:00:00.000Z',
      days: 10,
      dueAt: '2026-10-11T00:00:00.000Z',
    });
  });

  it('returns undefined when the chain states no start, rather than inventing one', () => {
    // `now` is not a stand-in for the moment the change landed, and a due date counted from it
    // would move every time the command ran.
    const only = entry('a', '2026-10-01T00:00:00.000Z', { status: 'proposed', grading_point: 10 });
    expect(gradingPoint([only])).toBeUndefined();
  });

  it('returns undefined when the chain states no wait, rather than reading it as zero days', () => {
    expect(gradingPoint([applied('2026-10-01T00:00:00.000Z')])).toBeUndefined();
  });

  it('takes the newest statement of each fact independently', () => {
    // D1's first exit: a fresh baseline resets `applied_at` while `grading_point` stays where the
    // proposal put it. A rule that took both from one entry -- the newest, say -- would find the
    // restart's entry carrying no `grading_point` and report no point at all.
    const restarted = entry('d', '2026-10-08T00:00:00.000Z', {
      status: 'applied',
      continues: 'a',
      applied_at: '2026-10-08T00:00:00.000Z',
    });
    const restated = entry('e', '2026-10-09T00:00:00.000Z', {
      status: 'applied',
      continues: 'a',
      grading_point: 20,
    });
    expect(gradingPoint([proposed('a'), restarted, restated])).toEqual({
      appliedAt: '2026-10-08T00:00:00.000Z',
      days: 20,
      dueAt: '2026-10-28T00:00:00.000Z',
    });
  });

  it('builds dueAt from CALENDAR days, which is not the unit grading_point is stated in', () => {
    // Pinned deliberately: this is the one assertion here that records a BOUND rather than a rule.
    // The `intervention` type says `grading_point` is in ACTIVE days -- the unit `asc handlers
    // power` reports in -- and a stored instant can only be built from a calendar, so `dueAt` is
    // the earliest moment the wait could be up, never the instant it is.
    //
    // `asc-09wx.8.5` settled the LABEL and left the arithmetic alone (decision `c38bf1a2`):
    // callers print this as an earlier bound and say "due to become readable". The two assertions
    // below are the thing to edit if a caller ever needs an exact instant -- recomputing from the
    // log is that shape, and the docblock on `GradingPoint.dueAt` says so.
    //
    // What the bound is worth, measured over this machine's real corpora: coverage (dates carrying
    // an event over the dates the span could have touched) runs 0.667 to 1.000, so on the sparsest
    // real log a 30-active-day wait lands 14.98 calendar days early and a grade taken at this
    // instant holds 20 of the 30 active days the row asked for -- unflagged by `premature`, which
    // is the false-negative direction. Full table and derivation: `dogfood/0106`.
    const point = gradingPoint([proposed('a'), applied('2026-10-01T00:00:00.000Z')]);
    expect(point?.dueAt).toBe('2026-10-11T00:00:00.000Z');
    expect(Date.parse(point?.dueAt ?? '') - Date.parse(point?.appliedAt ?? '')).toBe(
      (point?.days ?? 0) * 86_400_000,
    );
  });

  it('does not count an unparseable applied_at as a start', () => {
    // NaN propagates through the addition as NaN, and `new Date(NaN).toISOString()` throws a
    // RangeError -- so a bad date would crash the grader and the brief line rather than declining
    // to answer them.
    const bad = entry('a', '2026-10-01T00:00:00.000Z', {
      status: 'proposed',
      grading_point: 10,
      applied_at: 'sometime last week',
    });
    expect(gradingPoint([bad])).toBeUndefined();
  });
});

/**
 * `dueGrades`'s ordering (`asc-09wx.8.5`).
 *
 * **This lives here, beside the ledger, rather than only end-to-end through the brief, because the
 * end-to-end test cannot check the order at all.** `ledgerRows` sorts by root id, and in production a
 * root id is a random UUID -- so an end-to-end fixture that records the older row second comes back
 * in whichever order the two ids happen to sort, and the assertion `owed[0] contains early.root` is a
 * coin flip. Measured: deleting the sort from `dueGrades` left
 * `types.test.ts`'s *"names the longest-waiting first"* **green**, and it would have gone red on a
 * rerun had the ids fallen the other way. A check that passes half the time is worse than no check,
 * because it reports the mutant as killed when it was only lucky. Handing the rows in root order and
 * asserting they come back in date order is the only shape that tests the ordering.
 */
describe('dueGrades: which waits are up, and in what order', () => {
  /** An applied row whose wait began at `appliedAt`, `days` active days long. */
  const waited = (root: string, appliedAt: string, days: number): LedgerEntry =>
    entry(root, '2026-10-01T00:00:00.000Z', {
      change: `handlers/${root}.yaml`,
      status: 'applied',
      applied_at: appliedAt,
      grading_point: days,
      metric: { handler: `handlers/${root}.yaml` },
    });

  it('puts the longest-waiting first, by the bound that passed and not by the row id', () => {
    // Handed in as (`a`, 2021) then (`b`, 2019), which is the order `ledgerRows` returns them in
    // because `a` sorts before `b`. Longest-waiting first means `b` leads.
    const rows = ledgerRows(
      [waited('a', '2021-06-01T00:00:00.000Z', 1), waited('b', '2019-06-01T00:00:00.000Z', 1)],
      new Date('2026-10-02T00:00:00.000Z'),
    );

    expect(rows.map((row) => row.root)).toEqual(['a', 'b']);
    expect(dueGrades(rows, new Date('2026-10-02T00:00:00.000Z')).map((one) => one.root)).toEqual([
      'b',
      'a',
    ]);
  });
});
