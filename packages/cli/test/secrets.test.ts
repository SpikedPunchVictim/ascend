import { describe, expect, it } from 'vitest';
import type { CorpusLine } from '../src/corpus.js';
import { SECRET_PATTERNS, scanSecrets } from '../src/secrets.js';

/**
 * The export's secret scan (asc-4a6.2, asc-4a6.3).
 *
 * Every secret-shaped value below is ASSEMBLED at runtime from harmless parts, never written out
 * whole: this repository is public, and a literal that matched a real key's shape would be the
 * very disclosure the module exists to stop -- and would trip every secret scanner that reads the
 * repo.
 */

const cat = (...parts: string[]): string => parts.join('');

const SHAPES: Readonly<Record<string, string>> = {
  'aws-access-key-id': cat('AK', 'IA', 'Q'.repeat(16)),
  'private-key-block': cat('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  'github-token': cat('gh', 'p_', 'a'.repeat(36)),
  'anthropic-api-key': cat('sk', '-ant-', 'api03-', 'b'.repeat(40)),
  'openai-api-key': cat('sk', '-proj-', 'c'.repeat(40)),
  'slack-token': cat('xo', 'xb-', '1234567890-', 'd'.repeat(20)),
  jwt: cat('ey', 'J', 'e'.repeat(20), '.', 'ey', 'J', 'f'.repeat(20), '.', 'g'.repeat(20)),
  'bearer-token': cat('Authorization: Bear', 'er ', 'h'.repeat(32)),
  'secret-assignment': cat('DB_PASS', 'WORD=', 'hunter2hunter2'),
};

const entry = (id: string, text: string): CorpusLine =>
  ({
    kind: 'entry',
    id,
    type_name: 'note',
    type_version: 1,
    type_hash: 'h',
    recorded_at: '2026-09-28T00:00:00.000Z',
    run_id: null,
    workflow: null,
    actor: null,
    source: 'self',
    cwd: null,
    repo: null,
    git_sha: null,
    branch: null,
    properties: { body: text },
    na: [],
    evidence_text: null,
    ascend_version: '0.0.0',
    schema_version: 6,
  }) as unknown as CorpusLine;

describe('scanSecrets', () => {
  it('has a test shape for every pattern it knows, and no shape for one it does not', () => {
    expect(Object.keys(SHAPES).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort());
  });

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`finds ${name}`, () => {
      const scan = scanSecrets([entry('e1', `before ${shape} after`)]);
      expect(scan.byPattern.find((hit) => hit.name === name)?.lines).toBe(1);
    });
  }

  it('never carries the matched text in its result', () => {
    const shape = SHAPES['aws-access-key-id'] ?? '';
    const scan = scanSecrets([entry('e1', shape)]);
    expect(JSON.stringify(scan)).not.toContain(shape);
  });

  it('counts LINES per pattern, so a line with the shape twice is one', () => {
    const shape = SHAPES['github-token'] ?? '';
    const scan = scanSecrets([entry('e1', `${shape} ${shape}`)]);
    expect(scan.byPattern).toEqual([{ name: 'github-token', lines: 1 }]);
  });

  it('names where each match is, by line identity', () => {
    const scan = scanSecrets([entry('e1', 'clean'), entry('e2', SHAPES['jwt'] ?? '')]);
    expect(scan.where).toEqual(['entry e2']);
  });

  it('reads strings nested anywhere in a line', () => {
    const line = {
      ...(entry('e1', 'clean') as object),
      properties: { deep: [{ deeper: SHAPES['slack-token'] }] },
    } as unknown as CorpusLine;
    expect(scanSecrets([line]).lines).toBe(1);
  });

  it('finds nothing in a clean corpus', () => {
    expect(scanSecrets([entry('e1', 'ran npx vitest run; 12 passed')])).toEqual({
      byPattern: [],
      lines: 0,
      where: [],
    });
  });

  it.each([
    ['an assignment whose value is a variable reference', 'API_TOKEN=${API_TOKEN}'],
    ['an assignment whose value is an env lookup', 'const TOKEN = process.env.TOKEN'],
    ['an assignment whose value is a placeholder', 'PASSWORD=<your-password>'],
    ['a type name that merely contains TOKEN', 'TOKEN_BUDGET is 4096'],
    ['a bearer scheme with no credential', 'uses Bearer auth'],
  ])('does not match %s', (_label, text) => {
    expect(scanSecrets([entry('e1', text)]).lines).toBe(0);
  });
});
