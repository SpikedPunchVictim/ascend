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
    // `note -- ` plus 40 characters.
    expect(finding?.detail.startsWith('48 bytes, ~11 tokens of 2000')).toBe(true);
    expect(finding?.status).toBe('ok');
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
    const [finding] = exportStatus(12);
    expect(finding?.status).toBe('info');
    expect(finding?.detail).toContain('cannot tell whether an export exists');
  });

  it('is quiet about an empty store', () => {
    expect(exportStatus(0)[0]?.status).toBe('ok');
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
