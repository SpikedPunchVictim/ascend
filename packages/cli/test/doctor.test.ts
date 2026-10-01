import { describe, expect, it } from 'vitest';
import type { PropertyProfile, TypeProfile, TypeSummary } from '@ascend/store';
import {
  BRIEF_TOKEN_CAP,
  briefSize,
  deadTypes,
  exportStatus,
  nearDuplicates,
  propertyStates,
  runDoctor,
  versionDrift,
} from '../src/doctor.js';

/** `asc doctor`'s checks (asc-12a), over hand-built registry summaries and profiles. */

function summary(name: string, overrides: Partial<TypeSummary> = {}): TypeSummary {
  return {
    name,
    latestVersion: 1,
    major: 1,
    versionCount: 1,
    typeHash: 'h',
    status: 'active',
    propertyCount: 1,
    entryCount: 5,
    // Nothing struck by default, so every existing case in this file keeps the meaning it had:
    // `entryCount` is the live count and `struckCount` says how many rows were taken out of it.
    // A test that wants the all-struck shape overrides both (asc-9xi0).
    struckCount: 0,
    description: null,
    recordWhen: 'something happens',
    reviewAfter: null,
    ...overrides,
  };
}

function property(
  name: string,
  states: { measured: number; not_applicable?: number; not_measured?: number },
  overrides: Partial<PropertyProfile> = {},
): PropertyProfile {
  return {
    name,
    declaredTypes: ['string'],
    required: false,
    declaringVersions: [1],
    states: {
      measured: states.measured,
      not_applicable: states.not_applicable ?? 0,
      not_measured: states.not_measured ?? 0,
      not_declared: 0,
    },
    distinct: 0,
    top: [],
    min: null,
    max: null,
    ...overrides,
  } as PropertyProfile;
}

function profile(
  type: string,
  properties: readonly PropertyProfile[],
  versions: readonly { version: number; entries: number }[] = [{ version: 1, entries: 5 }],
): TypeProfile {
  return {
    type,
    count: versions.reduce((sum, version) => sum + version.entries, 0),
    properties,
    versions: versions.map((version) => ({
      ...version,
      major: 1,
      typeHash: 'h',
      status: 'active',
    })),
  } as unknown as TypeProfile;
}

describe('deadTypes', () => {
  it('warns on an active type with no entries', () => {
    const findings = deadTypes([summary('used'), summary('unused', { entryCount: 0 })]);
    expect(findings.map((finding) => [finding.status, finding.subject])).toEqual([
      ['warn', 'unused'],
    ]);
  });

  it('does not call a deprecated type dead', () => {
    const findings = deadTypes([summary('retired', { entryCount: 0, status: 'deprecated' })]);
    expect(findings[0]?.status).toBe('ok');
  });

  it('says so when every active type has entries, rather than printing nothing', () => {
    expect(deadTypes([summary('used')])).toEqual([
      {
        check: 'dead_type',
        status: 'ok',
        subject: '(all)',
        detail: 'all 1 active types have entries',
      },
    ]);
  });
});

describe('nearDuplicates', () => {
  it('reports each pair of names sharing a token once, with the token', () => {
    const findings = nearDuplicates([
      summary('review_finding'),
      summary('review_completed'),
      summary('note'),
    ]);
    expect(findings.map((finding) => [finding.subject, finding.detail])).toEqual([
      ['review_completed ~ review_finding', "share 'review'"],
    ]);
  });

  it('ignores deprecated types', () => {
    const findings = nearDuplicates([
      summary('review_finding'),
      summary('review_completed', { status: 'deprecated' }),
    ]);
    expect(findings[0]?.status).toBe('ok');
  });
});

describe('versionDrift', () => {
  it('names a property not declared by every version that carries entries', () => {
    const findings = versionDrift([
      profile(
        'run',
        [
          property('verdict', { measured: 8 }, { declaringVersions: [1, 2] }),
          property('source', { measured: 3 }, { declaringVersions: [2] }),
        ],
        [
          { version: 1, entries: 5 },
          { version: 2, entries: 3 },
        ],
      ),
    ]);
    expect(findings).toEqual([
      {
        check: 'version_drift',
        status: 'warn',
        subject: 'run',
        detail: 'entries span v1: 5, v2: 3; not declared by every version: source',
      },
    ]);
  });

  it('is info, not a warning, when the versions agree on every property', () => {
    const findings = versionDrift([
      profile(
        'run',
        [property('verdict', { measured: 8 }, { declaringVersions: [1, 2] })],
        [
          { version: 1, entries: 5 },
          { version: 2, entries: 3 },
        ],
      ),
    ]);
    expect(findings[0]?.status).toBe('info');
  });

  it('ignores a version no entry was recorded under', () => {
    const findings = versionDrift([
      profile(
        'run',
        [property('verdict', { measured: 5 })],
        [
          { version: 1, entries: 5 },
          { version: 2, entries: 0 },
        ],
      ),
    ]);
    expect(findings[0]?.status).toBe('ok');
  });
});

describe('propertyStates', () => {
  it('warns on a property never measured by any entry that declared it', () => {
    const findings = propertyStates([
      profile('finding', [property('scenario', { measured: 0, not_measured: 30 })]),
    ]);
    expect(findings[0]).toMatchObject({ status: 'warn', subject: 'finding.scenario' });
  });

  it('reports counts, and names a group under MIN_N as an anecdote', () => {
    const findings = propertyStates([
      profile('stuck', [
        property('hypothesis', { measured: 4, not_applicable: 0, not_measured: 1 }),
      ]),
    ]);
    expect(findings[0]?.detail).toBe(
      'measured 4 of 5, not_applicable 0, not_measured 1 (n<20: an anecdote)',
    );
  });

  it('does not call a group of MIN_N or more an anecdote', () => {
    const findings = propertyStates([
      profile('run', [property('verdict', { measured: 19, not_measured: 1 })]),
    ]);
    expect(findings[0]?.detail).not.toContain('anecdote');
  });

  it('lists nothing for a property measured on every entry', () => {
    const findings = propertyStates([profile('run', [property('verdict', { measured: 5 })])]);
    expect(findings[0]?.status).toBe('ok');
  });
});

describe('briefSize', () => {
  it('measures the brief as `asc types brief` renders it, and passes a small registry', () => {
    const [finding] = briefSize([summary('note', { recordWhen: 'x'.repeat(40) })]);
    // `Record with: asc record TYPE --json -` (37) + newline + `note -- ` + 40 characters = 86.
    // It read `48 bytes` before the recording command existed; the 38-byte difference is the point
    // (`asc-uftd`) -- this check exists to report the size of what the payload prints, so a line
    // the payload prints is a line it has to count.
    expect(finding?.detail.startsWith('86 bytes,')).toBe(true);
    expect(finding?.status).toBe('ok');
  });

  it('counts the command line only when there is a brief to put it on (asc-uftd)', () => {
    // No active types means no brief at all -- `asc types brief` prints nothing rather than a
    // bare command line naming a type that is not there, so the size is zero, not 37.
    const [finding] = briefSize([summary('old', { status: 'deprecated' })]);
    expect(finding?.detail.startsWith('0 bytes,')).toBe(true);
  });

  it('warns past the token cap, and says the brief itself is capped', () => {
    const recordWhen = 'y'.repeat(300);
    const types = Array.from({ length: 40 }, (_, index) =>
      summary(`type_${String(index)}`, { recordWhen }),
    );
    const [finding] = briefSize(types);
    expect(finding?.status).toBe('warn');
    expect(finding?.detail).toContain('prints only the lines that fit');
  });

  it('counts only active types, as the brief does', () => {
    const [finding] = briefSize([
      summary('note'),
      summary('old', { status: 'deprecated', recordWhen: 'z'.repeat(BRIEF_TOKEN_CAP * 10) }),
    ]);
    expect(finding?.status).toBe('ok');
  });
});

describe('exportStatus', () => {
  it('says it cannot see an export, rather than claiming there is none', () => {
    const [finding] = exportStatus(12, 0);
    expect(finding?.status).toBe('info');
    expect(finding?.detail).toContain('cannot tell whether an export exists');
  });

  it('is quiet about an empty store', () => {
    expect(exportStatus(0, 0)[0]?.status).toBe('ok');
  });
});

describe('runDoctor', () => {
  it('runs every check, in report order', () => {
    const findings = runDoctor(
      [summary('note')],
      [profile('note', [property('text', { measured: 5 })])],
    );
    expect(findings.map((finding) => finding.check)).toEqual([
      'dead_type',
      'near_duplicate',
      'version_drift',
      'property_states',
      'brief_size',
      'export',
    ]);
  });
});

/**
 * `asc-9xi0`: a struck entry stops counting, and the two checks that read a count say which zero.
 *
 * The distinction these tests protect is between **nothing recorded** and **everything struck**.
 * Both read a live count of 0, and before this change `deadTypes` and `exportStatus` could only see
 * the first: a type whose every entry had been struck was reported as never used, and a store whose
 * every entry had been struck was reported as having nothing to lose.
 */
describe('a struck entry stops counting, and both zeros are told apart (asc-9xi0)', () => {
  it('names an all-struck type as struck rather than as never recorded', () => {
    const findings = deadTypes([summary('struck_out', { entryCount: 0, struckCount: 3 })]);

    // Still a warning -- a type with nothing standing is worth the same second look -- but the
    // reason is on the line, so a reader is not sent looking for entries that exist.
    expect(findings[0]?.status).toBe('warn');
    expect(findings[0]?.detail).toContain('struck');
    expect(findings[0]?.detail).toContain('3');
    expect(findings[0]?.detail).not.toContain('never recorded');
  });

  it('still says "never recorded" for a type nothing was ever recorded against', () => {
    const findings = deadTypes([summary('unused', { entryCount: 0, struckCount: 0 })]);
    expect(findings[0]?.detail).toBe('registered at v1, never recorded');
  });

  it('does not warn on a type with live entries even when some were struck', () => {
    const findings = deadTypes([summary('used', { entryCount: 2, struckCount: 5 })]);
    expect(findings[0]?.status).toBe('ok');
  });

  it('reports a store of nothing but struck entries as having entries to lose', () => {
    // The zero-guard's whole point: `entries` here is the LIVE count, which is 0, and a guard on it
    // alone would tell someone with 3,000 struck rows and no export that there is nothing at stake.
    const [finding] = exportStatus(0, 3000);

    expect(finding?.status).toBe('info');
    expect(finding?.subject).toContain('3000');
    expect(finding?.detail).not.toContain('no entries to lose');
  });

  it('is still quiet when the store truly holds nothing', () => {
    expect(exportStatus(0, 0)[0]?.status).toBe('ok');
  });

  it('counts live and struck together in the subject, so neither is hidden', () => {
    const [finding] = exportStatus(2, 3);
    expect(finding?.subject).toContain('5');
    expect(finding?.subject).toContain('3 struck');
  });
});
