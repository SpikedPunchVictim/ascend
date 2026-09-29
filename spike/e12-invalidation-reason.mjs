/**
 * Probe: can an invalidation row reach the store with no reason, contradicting listInvalidations' type?
 *
 * annotations.ts's listInvalidations casts `note as string` with the comment "Only recordInvalidation
 * writes this scheme, and it refuses an empty (or all-whitespace) reason before it ever prepares the
 * insert, so `note` is never NULL for a row this scheme wrote." But import.ts:262 writes the reserved
 * scheme through recordAnnotations, which refuses only an EMPTY note (`note === ''`), not an absent
 * one. If that gap is real, a corpus line can put NULL in annotations.note under the reserved scheme
 * and InvalidationRow.reason comes back null while typed string.
 *
 * Run: node spike/e12-invalidation-reason.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  documentSpec,
  INVALIDATION_LABELS,
  listInvalidations,
  RESERVED_SCHEME,
  schemeHash,
  serializeCorpus,
  specHash,
} from '../packages/store/dist/index.js';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

const NOTE = {
  name: 'note',
  properties: [{ name: 'body', type: 'text' }],
  description: 'a note',
};
const ID = '0192f000-0000-7000-8000-000000000001';
const typeHash = specHash(documentSpec(NOTE));

// Structurally identical to the module-private INVALIDATION_SCHEME_SPEC (labels + no rules), which
// restoreInvalidationScheme compares by hash.
const invalidationSpec = { labels: [...INVALIDATION_LABELS], rules: [] };

/**
 * Import one corpus carrying a single invalidation whose `note` is `note`, and report what the store
 * holds. Each arm gets its own scratch project so neither can see the other's rows.
 */
function arm(name, note) {
  const dir = mkdtempSync(join(tmpdir(), 'e12-inv-reason-'));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.ascend'));
  const corpusFile = join(dir, 'corpus.jsonl');
  writeFileSync(corpusFile, `${serializeCorpus(linesWith(note))}\n`);

  const run = spawnSync(process.execPath, [bin, 'import', corpusFile], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_CACHE_HOME: join(dir, '.cache') },
  });
  console.log(`\n=== ${name} ===`);
  console.log(`asc import   exit=${String(run.status)}`);
  if (run.status !== 0) {
    console.log(`  stderr: ${run.stderr.trim().split('\n').slice(0, 6).join('\n  ')}`);
    console.log('  -> REFUSED, so this shape is not reachable');
    return;
  }

  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'), { readOnly: true });
  const raw = db.prepare('SELECT note, label FROM annotations WHERE scheme = ?').all(RESERVED_SCHEME);
  console.log(`annotations rows:          ${JSON.stringify(raw)}`);
  const rows = listInvalidations(db);
  const reason = rows[0]?.reason;
  console.log(`InvalidationRow.reason:    ${JSON.stringify(reason)} (typeof ${typeof reason})`);
  console.log(
    reason === null || reason === undefined || String(reason).trim() === ''
      ? '  -> CONFIRMED: the store holds an invalidation with no usable reason'
      : '  -> not confirmed',
  );
  db.close();
}

function linesWith(note) {
  return [
    { kind: 'type', document: { ...NOTE, type_hash: typeHash } },
    {
      kind: 'entry',
      id: ID,
      type_name: 'note',
      type_version: 1,
      type_hash: typeHash,
      recorded_at: '2026-09-02T10:00:00.000Z',
      source: 'self',
      run_id: null,
      workflow: null,
      actor: null,
      cwd: '.',
      repo: null,
      git_sha: null,
      branch: null,
      properties: { body: 'first' },
      na: [],
      evidence_text: null,
      ascend_version: '0.1.0',
      schema_version: 1,
    },
    {
      kind: 'scheme',
      name: RESERVED_SCHEME,
      version: 1,
      created_at: '2026-09-05T00:00:00.000Z',
      spec: invalidationSpec,
      scheme_hash: schemeHash(invalidationSpec),
    },
    {
      kind: 'annotation',
      id: 'inv-probe',
      entry_id: ID,
      scheme: RESERVED_SCHEME,
      scheme_version: 1,
      label: 'wrong_value',
      // `note` is the invalidation's REASON. `recordInvalidation` refuses an absent or all-whitespace
      // one; the question is whether this path does.
      confidence: null,
      note,
      created_by: 'probe',
      created_at: '2026-09-05T00:00:00.000Z',
    },
  ];
}

arm('arm 1: note is absent (null)', null);
arm("arm 2: note is whitespace only ('   ')", '   ');

console.log(
  '\nBoth arms reach the store through asc import, which writes the reserved scheme via\n' +
    'recordAnnotations (import.ts:262) rather than recordInvalidation (annotations.ts:1056).',
);
