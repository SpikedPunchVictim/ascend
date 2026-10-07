import { describe, expect, it } from 'vitest';
import { reservedPropertyName } from '@ascend/core';
import type { RecordedEntry } from '@ascend/store';
import {
  LOCALITY_COLUMNS,
  categoricalItems,
  isLocalityColumn,
  valueColumn,
} from '../src/stats-text.js';

/**
 * The column vocabulary of `asc stats`, pinned where the design's ONE structural claim lives.
 *
 * **Unit tests rather than binary tests, because of what is being pinned.** `stats-text.ts` decides
 * which NAMES are read off the entry's envelope rather than off its properties, and that design is
 * collision-free only while every one of those names is a name core already reserves against
 * declaration (`ENVELOPE_PROPERTY_NAMES`, `packages/core/src/spec.ts`). No run of the binary can
 * fail when that stops being true: the code would read an envelope field where it meant a property
 * (or the reverse), silently, on the one corpus whose spec happened to declare the name. So the
 * invariant is asserted against core directly -- `spec.test.ts` pins that the envelope list is
 * reserved; this pins that the CLI's list is a SUBSET of it, which is the join neither file's own
 * suite can see.
 *
 * The second half tests `valueColumn`'s envelope branch on hand-built entries, which is the only
 * way to reach a varying locality without a transcript corpus: `asc record` deliberately does not
 * derive `branch` (`packages/cli/src/commands/record.ts:52-54`), so the binary can produce those
 * rows only through `asc ingest claude-code`.
 */

function entry(overrides: Partial<RecordedEntry> = {}): RecordedEntry {
  return {
    id: 'e1',
    typeName: 'finding',
    typeVersion: 1,
    typeHash: 'hash',
    recordedAt: '2026-10-05T00:00:00.000Z',
    source: 'self',
    properties: {},
    na: [],
    states: {},
    runId: null,
    workflow: null,
    actor: null,
    cwd: null,
    repo: null,
    gitSha: null,
    branch: null,
    evidenceText: null,
    ascendVersion: '0.0.0',
    schemaVersion: 1,
    ...overrides,
  };
}

describe('the envelope columns `asc stats` can name', () => {
  it('every locality column is a name core refuses to let a spec declare', () => {
    for (const name of LOCALITY_COLUMNS) {
      const reserved = reservedPropertyName(name);
      expect(reserved, `${name} must be reserved, or a spec can shadow the envelope`).toBeDefined();
      expect(reserved?.name).toBe(name);
      expect(reserved?.reason).toContain(name);
    }
  });

  it('keeps `git_sha` out, because it is an identifier rather than a locality', () => {
    // Named as a test rather than left to the comment, because the reason it is out is a reason
    // someone will later want to put it in: on a store that carries commits it is all but unique
    // per entry, so every pair containing it is suppressed as definitional and the ranking pays
    // for the noise without reporting anything.
    expect(isLocalityColumn('git_sha')).toBe(false);
    expect(isLocalityColumn('branch')).toBe(true);
    expect(isLocalityColumn('topic')).toBe(false);
  });

  it('reads an envelope name off the envelope, never off a property', () => {
    // A state core refuses to create (`ENVELOPE_PROPERTY_NAMES`), reached here only to pin WHICH
    // side wins if it ever became reachable: the envelope, because that is the column the store
    // projects and the one a query would select. If this ever inverts, the collision rule the
    // design does without would have become necessary without anyone noticing.
    const rows = [entry({ branch: 'feat/x', properties: { branch: 'from-a-property' } })];
    expect(valueColumn(rows, 'branch')).toEqual(['feat/x']);
  });

  it('carries an absent, null or empty locality as `null`, the same as a missing property', () => {
    const rows = [entry({ branch: 'feat/x' }), entry({ branch: null }), entry({ branch: '' })];
    // `null` rather than a dropped row, for `valueColumn`'s existing reason: both columns of a
    // crosstab have to align by entry, and "nobody looked" is a level worth seeing.
    expect(valueColumn(rows, 'branch')).toEqual(['feat/x', null, null]);
    expect(valueColumn(rows, 'repo')).toEqual([null, null, null]);
  });

  it('still reads a declared property through the same function', () => {
    const rows = [entry({ properties: { topic: 'alpha' } }), entry({ properties: { topic: '' } })];
    expect(valueColumn(rows, 'topic')).toEqual(['alpha', null]);
  });

  it('carries an envelope name into a mined item the same way', () => {
    // `--rules` mines `name=value` items. A name the command ACCEPTS and the miner then cannot read
    // is a rule that silently never forms -- an empty answer to a question the tool said it would
    // answer, which is the one failure this repository treats as severity-zero.
    const inCore = entry({
      cwd: 'packages/core',
      branch: 'feat/x',
      properties: { topic: 'alpha' },
    });
    const atRoot = entry({ cwd: '.', branch: 'feat/x', properties: { topic: 'beta' } });
    expect(categoricalItems(inCore, ['cwd', 'topic'])).toEqual([
      'cwd=packages/core',
      'topic=alpha',
    ]);
    // The caller's order is kept, and an absent locality contributes NO item rather than one with
    // nothing after the `=`: `repo=null` would be a level the corpus never had.
    expect(categoricalItems(atRoot, ['repo', 'branch'])).toEqual(['branch=feat/x']);
  });
});
