/**
 * Probe: can an invalidation row reach the store with no reason, contradicting listInvalidations' type?
 *
 * `asc-4wx6`. The probe that MEASURED the defect, re-run as its regression check. Originally:
 * annotations.ts's listInvalidations cast `note as string` with the comment "Only recordInvalidation
 * writes this scheme, and it refuses an empty (or all-whitespace) reason before it ever prepares the
 * insert, so `note` is never NULL for a row this scheme wrote." But import.ts writes the reserved
 * scheme through recordAnnotations, which refuses only an EMPTY note (`note === ''`), not an absent
 * one. Measured 2026-09-29: a corpus line put NULL in annotations.note under the reserved scheme and
 * InvalidationRow.reason came back null while typed string.
 *
 * **Both arms must now be REFUSED, and refused by the REASON rule specifically.** That second clause
 * is not ceremony: the first re-run of this probe after the fix exited 1 for an unrelated reason -- a
 * stale versionless `type` line in this fixture, refused by the asc-i5tj.6 rule, which short-circuits
 * before the annotation is ever reached. A probe that reads any exit 1 as its own answer is a false
 * green, so it now asserts the message names the reason. The fixture's `type` line carries its
 * `version` for the same reason, so the reason rule is what is under test and nothing else.
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
let failed = false;

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
    // The assertion this probe exists for. `no reason` is the corpus parser's refusal
    // (`requireInvalidationReason`); any OTHER exit 1 means the probe did not reach the rule it is
    // measuring, and calling that "REFUSED" would be the false green the header warns about.
    if (run.stderr.includes('no reason')) {
      console.log('  -> REFUSED by the reason rule, so this shape is not reachable');
    } else {
      console.log('  -> REFUSED, but NOT by the reason rule -- the probe did not reach it, so this');
      console.log('     run answers nothing. Fix the fixture before reading anything into it.');
      failed = true;
    }
    return;
  }

  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'), { readOnly: true });
  const raw = db.prepare('SELECT note, label FROM annotations WHERE scheme = ?').all(RESERVED_SCHEME);
  console.log(`annotations rows:          ${JSON.stringify(raw)}`);
  const rows = listInvalidations(db);
  const reason = rows[0]?.reason;
  console.log(`InvalidationRow.reason:    ${JSON.stringify(reason)} (typeof ${typeof reason})`);
  // The import SUCCEEDED with a reasonless note, which is the defect this probe exists to detect.
  // Both arms are refused now, so reaching here is a regression, not a "not confirmed".
  console.log('  -> CONFIRMED: the store holds an invalidation with no usable reason, and `asc import`');
  console.log('     exited 0 while writing it.');
  failed = true;
  db.close();
}

function linesWith(note) {
  return [
    // `version` is required: without it the asc-i5tj.6 rule on the `type` branch refuses line 1
    // before the annotation is parsed, and the probe would report a refusal that is not its own.
    // The `document` carries no hash -- a document is a definition, not a row; the `type_hash` is
    // the ENTRY's claim about which definition it was recorded against.
    { kind: 'type', document: { ...NOTE, version: 1 } },
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
    'recordAnnotations rather than recordInvalidation -- so the refusal they must meet is the\n' +
    'corpus parser\'s (requireInvalidationReason, jsonl.ts), which is the door both writers share.',
);
console.log(
  failed
    ? '\nREGRESSION: an arm reached the store with no reason. The parser gate is not holding.'
    : '\nBoth arms refused by the reason rule. The gate holds.',
);
if (failed) process.exitCode = 1;
