#!/usr/bin/env node
/**
 * asc-xqf1: does every declared `analysis_questions[i]` have a field behind it?
 *
 * The claim being tested is about the SCHEMA, so it changes whenever a type is edited -- which is why
 * this arm is checked in rather than run once. It reads the registered types through the real CLI
 * (`asc types show`), never from the source, because the question is what the STORE holds.
 *
 * It deliberately does NOT classify. Classification is a reading of each question against its type's
 * fields, and a script that scored it by token overlap would produce a number that looks mechanical
 * and is not. The script prints the raw material; the reading is done by hand and reported as one.
 *
 * Usage: node spike/aq-survey.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'packages', 'cli', 'dist', 'bin.js');

const run = (args) =>
  JSON.parse(execFileSync('node', [BIN, ...args, '--json'], { encoding: 'utf8' }));

const list = run(['types', 'list']);

const elided = [];

function read(name, version) {
  const args = ['types', 'show', name];
  if (version !== undefined) args.push('--version', String(version));
  const shown = run(args);

  // The renderer elides rows, so a type with more fields than it prints would silently lose
  // questions or properties -- a false reading of exactly the kind this series hunts.
  if (shown.coverage?.has_more === true) {
    elided.push(`${name} v${String(version)}: shown ${String(shown.coverage.shown)} of ${String(shown.coverage.total)}`);
  }

  // Property rows carry `name`/`type`/`description` at the ROW level, with `value` holding the
  // rendered sentence. Reading them off `value` silently produced `name: '?'` for all 40 fields --
  // a field-type column that was a constant, which is the false-reading class this series hunts.
  return {
    purpose: shown.rows.find((r) => r.field === 'purpose')?.value ?? null,
    questions: shown.rows
      .filter((r) => r.field.startsWith('analysis_questions['))
      .map((r) => r.value),
    fields: shown.rows
      .filter((r) => r.field.startsWith('property.'))
      .map((r) => ({ name: r.name, type: r.type, description: r.description ?? '' })),
  };
}

/**
 * EVERY version, not just the latest. `asc types show NAME` reads the latest, and a question can be
 * dropped between versions: `note` v1 declares "What share of notes should have been another type?"
 * and v2 declares none, while v1 holds 19 of that type's 22 entries. A survey by latest-version
 * silently loses a live question -- measured, 8 questions against 9.
 */
const rows = [];
for (const meta of list.rows) {
  const versions = meta.versions ?? 1;
  for (let v = 1; v <= versions; v++) {
    const r = read(meta.name, v);
    rows.push({ name: meta.name, version: v, latest: v === versions, status: meta.status, ...r });
  }
}

const withQ = rows.filter((r) => r.questions.length > 0);
const totalQ = withQ.reduce((n, r) => n + r.questions.length, 0);
const latestQ = rows.filter((r) => r.latest).reduce((n, r) => n + r.questions.length, 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, elided }, null, 2));
} else {
  console.log(`type versions registered    : ${rows.length} across ${list.rows.length} types`);
  console.log(`versions declaring questions: ${withQ.length}`);
  console.log(`analysis_questions declared : ${totalQ} (all versions)`);
  console.log(`analysis_questions declared : ${latestQ} (latest version only -- the survey by NAME)`);
  console.log(`elided by the renderer      : ${elided.length ? elided.join('; ') : 'none'}`);
  console.log('');

  for (const t of withQ) {
    const tag = t.latest ? 'latest' : 'STALE';
    console.log(`=== ${t.name} v${String(t.version)} [${tag}] -- ${t.fields.length} fields`);
    if (t.purpose) console.log(`    purpose: ${t.purpose.split('\n')[0]}`);
    t.questions.forEach((q, i) => {
      console.log(`    Q[${i}]: ${q}`);
    });
    console.log(`    fields: ${t.fields.map((f) => `${f.name}:${f.type}`).join(', ')}`);
    console.log('');
  }

  const noQ = rows.filter((r) => r.questions.length === 0);
  console.log(`type versions with NO analysis_questions: ${noQ.length}`);
  console.log(`  ${noQ.map((t) => `${t.name}v${String(t.version)}(${String(t.fields.length)}f)`).join(', ')}`);

  if (elided.length) {
    console.error(`\nREFUSING TO BE TRUSTED: ${elided.length} type version(s) elided by the renderer: ${elided.join('; ')}`);
    process.exit(1);
  }
}
