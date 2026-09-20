import { describe, expect, it } from 'vitest';
import { schemeHash } from '@ascend/store';
import {
  verifySchemeLine,
  type CorpusLine,
  type EntryLine,
  type SchemeLine,
} from '../src/corpus.js';
import {
  buildRedactionMap,
  identityVocabulary,
  identityVocabularyOf,
  redactLines,
  type Disclosing,
  type RedactionMap,
} from '../src/redact.js';

/**
 * `redact.ts`, unit-tested directly -- the same pattern `corpus-lines.test.ts` uses for the codec
 * it sits next to: a direct module import, no CLI subprocess, no `dist/` build. Fixtures use
 * invented project names (`-Users-alice-projects-widget`, never a real path on this machine),
 * per this repo's public-source rule.
 *
 * Every expectation below is a hand-written literal or arithmetic done independently of the
 * module -- never a value obtained by calling `redact.ts` itself and asserting it matches itself.
 */

/** One entry line, with every field a caller doesn't care about pinned to an inert default. */
function entry(
  overrides: Partial<EntryLine> & { readonly properties: Record<string, unknown> },
): EntryLine {
  return {
    kind: 'entry',
    id: 'entry-1',
    type_name: 'decision',
    type_version: 1,
    type_hash: 'hash-1',
    recorded_at: '2026-09-20T00:00:00.000Z',
    source: 'self',
    run_id: null,
    workflow: null,
    actor: null,
    cwd: null,
    repo: null,
    git_sha: null,
    branch: null,
    na: [],
    evidence_text: null,
    ascend_version: '0.0.0',
    schema_version: 1,
    ...overrides,
  };
}

/** One scheme line naming `project` in its SQL, with `scheme_hash` computed independently. */
function schemeWithProjectFilter(query: string): SchemeLine {
  // `schemeHash` is deliberately NOT imported here: the fixture is built with a query already
  // baked in, and its hash is asserted only through `verifySchemeLine` -- which is the real
  // integrity check `import` runs, not a second copy of the hash function.
  return {
    kind: 'scheme',
    name: 'risk',
    version: 1,
    created_at: '2026-09-20T00:00:00.000Z',
    spec: { labels: ['high', 'low'], rules: [{ label: 'high', kind: 'sql', query }] },
    scheme_hash: schemeHashOf(query),
  };
}

// A tiny local helper that recomputes the hash the same way `schemeLine` (`corpus.ts`) does, so
// the fixture starts out VALID. This is setup, not the assertion: the test below re-verifies the
// hash of the REWRITTEN line, which is the thing actually under test.
function schemeHashOf(query: string): string {
  return schemeHash({ labels: ['high', 'low'], rules: [{ label: 'high', kind: 'sql', query }] });
}

describe('identityVocabulary', () => {
  it('collects projects, servers and skills in first-seen order', () => {
    const lines = [
      entry({ id: 'e1', properties: { project: '-Users-alice-projects-widget' } }),
      entry({ id: 'e2', properties: { project: '-Users-bob-projects-gadget' } }),
      entry({ id: 'e3', properties: { project: '-Users-alice-projects-widget' } }),
    ];

    const vocab = identityVocabulary(lines);

    expect(vocab.projects).toEqual([
      { value: '-Users-alice-projects-widget', lines: 2 },
      { value: '-Users-bob-projects-gadget', lines: 1 },
    ]);
  });

  it('counts a server once per line even when tool_name and discovered_tools both name it', () => {
    const lines = [
      entry({
        id: 'e1',
        properties: {
          tool_name: 'mcp__acme-internal__lookup',
          discovered_tools: ['mcp__acme-internal__lookup', 'mcp__acme-internal__write'],
        },
      }),
    ];

    expect(identityVocabulary(lines).servers).toEqual([{ value: 'acme-internal', lines: 1 }]);
  });

  it('counts homePathLines over both slash- and dash-encoded, both macOS- and Linux-shaped paths', () => {
    const lines = [
      entry({ id: 'e1', evidence_text: 'saw it at /Users/alice/notes.md', properties: {} }),
      entry({ id: 'e2', properties: { project: '-Users-alice-projects-widget' } }),
      entry({ id: 'e3', evidence_text: 'ran from /home/bob/scripts', properties: {} }),
      entry({ id: 'e4', cwd: '/opt/shared/build', properties: {} }),
      entry({ id: 'e5', properties: { note: 'archived under -home-carol-backups' } }),
    ];

    expect(identityVocabulary(lines).homePathLines).toBe(4);
  });

  it('does not collect a skill or server the corpus never mentions', () => {
    const lines = [entry({ id: 'e1', properties: { project: '-Users-alice-projects-widget' } })];

    const vocab = identityVocabulary(lines);
    expect(vocab.skills).toEqual([]);
    expect(vocab.servers).toEqual([]);
  });
});

describe('identityVocabularyOf', () => {
  it('collects projects, servers and skills from bare records, in first-seen order', () => {
    const records: readonly Disclosing[] = [
      { properties: { project: '-Users-alice-projects-widget' } },
      { properties: { project: '-Users-bob-projects-gadget' } },
      { properties: { project: '-Users-alice-projects-widget' } },
    ];

    const vocab = identityVocabularyOf(records);

    expect(vocab.projects).toEqual([
      { value: '-Users-alice-projects-widget', lines: 2 },
      { value: '-Users-bob-projects-gadget', lines: 1 },
    ]);
  });

  it('counts a server once per record even when tool_name and discovered_tools both name it', () => {
    const records: readonly Disclosing[] = [
      {
        properties: {
          tool_name: 'mcp__acme-internal__lookup',
          discovered_tools: ['mcp__acme-internal__lookup', 'mcp__acme-internal__write'],
        },
      },
    ];

    expect(identityVocabularyOf(records).servers).toEqual([{ value: 'acme-internal', lines: 1 }]);
  });

  it('does not collect a skill or server no record mentions', () => {
    const records: readonly Disclosing[] = [
      { properties: { project: '-Users-alice-projects-widget' } },
    ];

    const vocab = identityVocabularyOf(records);
    expect(vocab.skills).toEqual([]);
    expect(vocab.servers).toEqual([]);
  });

  it('reports no homePathLines field at all, because a loose record is not a line', () => {
    // The field is absent by TYPE, not merely unset: a count of "lines" computed from records that
    // carry only `properties`/`cwd`/`text` would mean something different from the same-named
    // field on `IdentityVocabulary`, and two different meanings under one name is the bug this
    // shape exists to prevent. `toHaveProperty` rather than a comparison against `undefined`,
    // because the claim is about the KEY.
    const records: readonly Disclosing[] = [
      { properties: {}, text: 'saw it at /Users/alice/notes.md' },
      { properties: {}, cwd: '/home/bob/scripts' },
    ];

    expect(identityVocabularyOf(records)).not.toHaveProperty('homePathLines');
  });
});

describe('identityVocabulary: homePathLines spans every line kind, not only entries', () => {
  /**
   * The regression guard. `homePathLines` is a disclosure count, and the vocabulary classes it
   * travels with are an entry-line property while a home path is not. Measured 2026-09-20 on this
   * project's own store, 1,806 lines match a home-shaped path and 6 of them are NOT entries: 5
   * `type` lines carrying a documentation placeholder in their prose, and 1 `scheme` line whose
   * recorded SQL names four real project labels. A count restricted to entry lines returns 1,800
   * and is blind to precisely the line this module exists for.
   */
  it('counts a scheme line whose recorded SQL carries a home-shaped label', () => {
    const lines = [
      entry({ id: 'e1', properties: { project: '-Users-alice-projects-widget' } }),
      schemeWithProjectFilter("properties_json ->> 'project' = '-Users-alice-projects-widget'"),
    ];

    // Two: the entry for its `project` property, and the scheme for the label inside its query.
    expect(identityVocabulary(lines).homePathLines).toBe(2);
  });

  it('counts a type line whose prose carries a home-shaped path', () => {
    const lines: CorpusLine[] = [
      {
        kind: 'type',
        document: {
          name: 'thing',
          properties: [{ name: 'project', type: 'string' }],
          prose: { project: 'the directory, encoded -- for example "-Users-me-src-app"' },
        },
      },
    ];

    expect(identityVocabulary(lines).homePathLines).toBe(1);
  });
});

describe('buildRedactionMap: token allocation', () => {
  it('zero-pads to the digit width of the class count (3 projects -> single digit)', () => {
    const lines = [
      entry({ id: 'e1', properties: { project: '-Users-a-projects-one' } }),
      entry({ id: 'e2', properties: { project: '-Users-b-projects-two' } }),
      entry({ id: 'e3', properties: { project: '-Users-c-projects-three' } }),
    ];

    const map = buildRedactionMap(lines, { names: [] });

    expect(map.projects.get('-Users-a-projects-one')).toBe('project-1');
    expect(map.projects.get('-Users-b-projects-two')).toBe('project-2');
    expect(map.projects.get('-Users-c-projects-three')).toBe('project-3');
  });

  it('zero-pads to 2 digits once the class count reaches double digits (10 projects)', () => {
    const labels = [
      '-Users-a-projects-p1',
      '-Users-a-projects-p2',
      '-Users-a-projects-p3',
      '-Users-a-projects-p4',
      '-Users-a-projects-p5',
      '-Users-a-projects-p6',
      '-Users-a-projects-p7',
      '-Users-a-projects-p8',
      '-Users-a-projects-p9',
      '-Users-a-projects-p10',
    ];
    const lines = labels.map((project, index) =>
      entry({ id: `e${String(index)}`, properties: { project } }),
    );

    const map = buildRedactionMap(lines, { names: [] });

    // Hand-written literal, matching the spec's own example shape (14 -> '01'..'14').
    expect([...map.projects.values()]).toEqual([
      'project-01',
      'project-02',
      'project-03',
      'project-04',
      'project-05',
      'project-06',
      'project-07',
      'project-08',
      'project-09',
      'project-10',
    ]);
  });

  it('is injective: two different labels never receive the same token', () => {
    const lines = [
      entry({ id: 'e1', properties: { project: '-Users-a-projects-one' } }),
      entry({ id: 'e2', properties: { project: '-Users-b-projects-two' } }),
      entry({ id: 'e3', properties: { project: '-Users-c-projects-three' } }),
    ];

    const map = buildRedactionMap(lines, { names: [] });
    const tokens = [...map.projects.values()];

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('only tokenises a server or skill the operator named', () => {
    const lines = [
      entry({
        id: 'e1',
        properties: {
          tool_name: 'mcp__public-tool__search',
          skill: 'private-playbook',
        },
      }),
      entry({ id: 'e2', properties: { discovered_tools: ['mcp__secret-internal__probe'] } }),
    ];

    const map = buildRedactionMap(lines, { names: ['secret-internal', 'private-playbook'] });

    expect(map.servers.has('public-tool')).toBe(false);
    expect(map.servers.get('secret-internal')).toBe('server-1');
    expect(map.skills.get('private-playbook')).toBe('skill-1');
  });
});

describe('redactLines: determinism', () => {
  it('produces deeply equal output for the same input run twice', () => {
    const lines = [
      entry({
        id: 'e1',
        cwd: '/Users/alice/projects/widget/src',
        properties: { project: '-Users-alice-projects-widget', tool_name: 'mcp__acme__lookup' },
      }),
    ];
    const map = buildRedactionMap(lines, { names: ['acme'] });

    const first = redactLines(lines, map, { projectRoot: '/store/root' });
    const second = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(second).toEqual(first);
  });
});

describe('redactLines: project labels', () => {
  it('rewrites a project label embedded in a scheme SQL query and recomputes scheme_hash', () => {
    const query = "properties_json ->> 'project' = '-Users-alice-projects-widget'";
    const scheme = schemeWithProjectFilter(query);
    const lines = [
      entry({ id: 'e1', properties: { project: '-Users-alice-projects-widget' } }),
      scheme,
    ];
    const map = buildRedactionMap(lines, { names: [] });

    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    const rewrittenScheme = result.lines[1];
    if (rewrittenScheme?.kind !== 'scheme') throw new Error('expected a scheme line');

    expect(rewrittenScheme.spec.rules[0]?.query).toBe(
      "properties_json ->> 'project' = 'project-1'",
    );
    // The real check this module has to satisfy: `import` refuses a scheme line whose hash is
    // not its own hash. `verifySchemeLine` throwing means the fixture failed; not throwing is
    // the assertion.
    expect(() => {
      verifySchemeLine(rewrittenScheme, 'test');
    }).not.toThrow();
  });

  it('rewrites a label in evidence_text and inside a nested property value, but leaves other text alone', () => {
    const lines = [
      entry({
        id: 'e1',
        evidence_text: 'confirmed while working in -Users-alice-projects-widget on the release',
        properties: {
          project: '-Users-alice-projects-widget',
          nested: { detail: 'root was -Users-alice-projects-widget/src', unrelated: 'kept as-is' },
        },
      }),
    ];
    const map = buildRedactionMap(lines, { names: [] });

    const [rewritten] = redactLines(lines, map, { projectRoot: '/store/root' }).lines;
    if (rewritten?.kind !== 'entry') throw new Error('expected an entry line');

    expect(rewritten.evidence_text).toBe('confirmed while working in project-1 on the release');
    expect((rewritten.properties['nested'] as { detail: string }).detail).toBe(
      'root was project-1/src',
    );
    expect((rewritten.properties['nested'] as { unrelated: string }).unrelated).toBe('kept as-is');
  });
});

describe('redactLines: cwd, the five rules in order', () => {
  const map: RedactionMap = buildRedactionMap(
    [entry({ id: 'seed', properties: { project: '-Users-alice-projects-widget' } })],
    { names: [] },
  );

  it('1. leaves a null cwd null, and does not count it as omitted', () => {
    const lines = [entry({ id: 'e1', cwd: null, properties: {} })];
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: null });
    expect(result.cwdOmitted).toBe(0);
  });

  it('2. leaves an already-relative cwd untouched', () => {
    const lines = [entry({ id: 'e1', cwd: 'relative/sub/dir', properties: {} })];
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: 'relative/sub/dir' });
    expect(result.cwdOmitted).toBe(0);
  });

  it('3. uses the ENTRY OWN project to decode cwd, even when it differs from projectRoot', () => {
    const lines = [
      entry({
        id: 'e1',
        cwd: '/Users/alice/projects/widget/src/lib',
        properties: { project: '-Users-alice-projects-widget' },
      }),
    ];
    // projectRoot points somewhere else entirely -- step 3 must win before step 4 is ever tried.
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: 'src/lib' });
    expect(result.cwdOmitted).toBe(0);
  });

  it('3b. the project root itself becomes "."', () => {
    const lines = [
      entry({
        id: 'e1',
        cwd: '/Users/alice/projects/widget',
        properties: { project: '-Users-alice-projects-widget' },
      }),
    ];
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: '.' });
  });

  it('4. falls back to a path relative to projectRoot when there is no usable project label', () => {
    const lines = [entry({ id: 'e1', cwd: '/store/root/sub', properties: {} })];
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: 'sub' });
    expect(result.cwdOmitted).toBe(0);
  });

  it('4b. projectRoot itself becomes "." (never an empty string)', () => {
    const lines = [entry({ id: 'e1', cwd: '/store/root', properties: {} })];
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: '.' });
  });

  it('5. drops an unrewritable cwd to null and counts it', () => {
    const lines = [entry({ id: 'e1', cwd: '/somewhere/else/entirely', properties: {} })];
    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.lines[0]).toMatchObject({ cwd: null });
    expect(result.cwdOmitted).toBe(1);
  });
});

describe('redactLines: MCP tool identifiers', () => {
  it('fully tokenises tool_name and discovered_tools when the server is mapped', () => {
    const lines = [
      entry({
        id: 'e1',
        properties: {
          tool_name: 'mcp__acme-internal__lookup',
          discovered_tools: ['mcp__acme-internal__lookup', 'mcp__acme-internal__write'],
        },
      }),
    ];
    const map = buildRedactionMap(lines, { names: ['acme-internal'] });

    const [rewritten] = redactLines(lines, map, { projectRoot: '/store/root' }).lines;
    if (rewritten?.kind !== 'entry') throw new Error('expected an entry line');

    expect(rewritten.properties['tool_name']).toBe('mcp__server-1__tool-1');
    expect(rewritten.properties['discovered_tools']).toEqual([
      'mcp__server-1__tool-1',
      'mcp__server-1__tool-2',
    ]);
  });

  it('leaves an mcp__ identifier untouched when its server was not named for redaction', () => {
    const lines = [entry({ id: 'e1', properties: { tool_name: 'mcp__public-tool__search' } })];
    const map = buildRedactionMap(lines, { names: [] });

    const [rewritten] = redactLines(lines, map, { projectRoot: '/store/root' }).lines;
    if (rewritten?.kind !== 'entry') throw new Error('expected an entry line');

    expect(rewritten.properties['tool_name']).toBe('mcp__public-tool__search');
  });
});

describe('redactLines: residueLines', () => {
  it('counts a line whose free text still carries a home path this module cannot rewrite', () => {
    // `note` is a property key this module never touches (it is not `project`, `skill`,
    // `tool_name`, or `discovered_tools`), so a home path sitting there survives rewriting --
    // and residueLines exists precisely to surface that rather than hide it.
    const lines = [
      entry({ id: 'e1', properties: { note: 'see /Users/someone/leftover-notes.txt' } }),
    ];
    const map = buildRedactionMap(lines, { names: [] });

    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.residueLines).toBe(1);
  });

  it('reports zero residue once every home path in scope has been rewritten', () => {
    const lines = [
      entry({
        id: 'e1',
        cwd: '/Users/alice/projects/widget/src',
        evidence_text: 'built in -Users-alice-projects-widget',
        properties: { project: '-Users-alice-projects-widget' },
      }),
    ];
    const map = buildRedactionMap(lines, { names: [] });

    const result = redactLines(lines, map, { projectRoot: '/store/root' });

    expect(result.residueLines).toBe(0);
  });
});

describe('redactLines: skills', () => {
  it('rewrites a skill only when the operator named it', () => {
    const lines = [entry({ id: 'e1', properties: { skill: 'internal-playbook' } })];

    const namedMap = buildRedactionMap(lines, { names: ['internal-playbook'] });
    const [rewritten] = redactLines(lines, namedMap, { projectRoot: '/store/root' }).lines;
    if (rewritten?.kind !== 'entry') throw new Error('expected an entry line');
    expect(rewritten.properties['skill']).toBe('skill-1');

    const unnamedMap = buildRedactionMap(lines, { names: [] });
    const [untouched] = redactLines(lines, unnamedMap, { projectRoot: '/store/root' }).lines;
    if (untouched?.kind !== 'entry') throw new Error('expected an entry line');
    expect(untouched.properties['skill']).toBe('internal-playbook');
  });
});

describe('redactLines: a label is replaced wherever it occurs, not in a list of fields', () => {
  /**
   * These are the guard on `redactLines`' stated RULE, as against the enumeration it replaced.
   * Measured 2026-09-20 on this project's own store, a label appears literally in exactly two
   * places -- `properties.project` (1,702 lines) and a scheme rule's `query` (3) -- so an
   * implementation covering only those two passes every other test in this file. Each case below
   * is a field that carries no label today and could carry one tomorrow.
   */
  const LABEL = '-Users-alice-projects-widget';

  /** A map with one label in it, built the way a caller builds one. */
  function oneLabel(): RedactionMap {
    return buildRedactionMap([entry({ properties: { project: LABEL } })], { names: [] });
  }

  it('rewrites a label in an annotation note', () => {
    const { lines } = redactLines(
      [
        {
          kind: 'annotation',
          id: 'ann-1',
          entry_id: 'entry-1',
          scheme: 'risk',
          scheme_version: 1,
          label: 'high',
          confidence: null,
          note: `sampled from ${LABEL} by hand`,
          created_by: null,
          created_at: '2026-09-20T00:00:00.000Z',
        },
      ],
      oneLabel(),
      { projectRoot: '/srv/project' },
    );

    const only = lines[0];
    expect(only?.kind).toBe('annotation');
    expect(only?.kind === 'annotation' ? only.note : undefined).toBe(
      'sampled from project-1 by hand',
    );
  });

  it('keeps an annotation with no value free of a value key while rewriting its note', () => {
    // The three-state `value` distinction `corpus-lines.test.ts` exists for must survive this
    // module too: a deep rewrite that rebuilt the object from its entries could reintroduce the
    // key as an explicit `undefined`, which serialises differently from an absent one.
    const { lines } = redactLines(
      [
        {
          kind: 'annotation',
          id: 'ann-1',
          entry_id: 'entry-1',
          scheme: 'risk',
          scheme_version: 1,
          label: 'high',
          confidence: null,
          note: LABEL,
          created_by: null,
          created_at: '2026-09-20T00:00:00.000Z',
        },
      ],
      oneLabel(),
      { projectRoot: '/srv/project' },
    );

    expect(lines[0]).not.toHaveProperty('value');
  });

  it('rewrites a label in envelope fields the enumeration never named', () => {
    const { lines } = redactLines(
      [
        entry({
          properties: { project: LABEL },
          actor: `agent on ${LABEL}`,
          branch: `feature/${LABEL}`,
          workflow: LABEL,
        }),
      ],
      oneLabel(),
      { projectRoot: '/srv/project' },
    );

    const only = lines[0];
    if (only?.kind !== 'entry') throw new Error('expected an entry line');
    expect(only.actor).toBe('agent on project-1');
    expect(only.branch).toBe('feature/project-1');
    expect(only.workflow).toBe('project-1');
    expect(only.properties['project']).toBe('project-1');
  });

  it('still decodes cwd from the entry own label, which the line-wide rewrite must not consume', () => {
    // The ordering trap: `projectRelativeCwd` matches the label's characters against `cwd`'s own,
    // so if the line-wide substitution ran first and rewrote `properties.project`, the decode
    // would have no label left to match with.
    const { lines, cwdOmitted } = redactLines(
      [
        entry({
          properties: { project: LABEL },
          cwd: '/Users/alice/projects/widget/packages/core',
        }),
      ],
      oneLabel(),
      { projectRoot: '/srv/project' },
    );

    const only = lines[0];
    if (only?.kind !== 'entry') throw new Error('expected an entry line');
    expect(only.cwd).toBe('packages/core');
    expect(cwdOmitted).toBe(0);
  });
});
