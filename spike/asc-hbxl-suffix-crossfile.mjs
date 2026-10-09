#!/usr/bin/env node
/**
 * asc-hbxl, part three -- of the suffixes a real store already holds, how many were minted ACROSS
 * files rather than WITHIN one?
 *
 *   node spike/asc-hbxl-suffix-crossfile.mjs [--root <dir>]
 *
 * EV-45 states the defect and, deliberately, does not size it: the ingest counts `keyCollisions` but
 * does not partition them, so the warning says "repeated within a transcript" and nothing anywhere
 * checks whether that is true. This measures the partition on the real corpus.
 *
 * WHY THE ANSWER IS ORDER-INDEPENDENT. `key()` in derive.ts mints the raw key for whichever entry
 * reaches it first in the sweep and suffixes the rest, so WHICH member of a group gets the suffix
 * depends on sweep order. Classifying a group as cross-file does not: if a group's members come from
 * more than one file, then at most one of them can hold the unsuffixed key, so every other member --
 * whichever one wins -- is a cross-file suffix. So the split can be measured without reproducing the
 * ingest's order, and the number does not move between runs.
 *
 * ONE DERIVER FOR THE WHOLE SWEEP. `issued` is not reset per file (its own doc says so), so a single
 * `createDeriver()` reused across every record is what the ingest does, and is what makes the suffix
 * assignment here match the one a real `--full` run makes.
 *
 * READ-ONLY, AND NOTHING IS COPIED. The corpus is read where it is; this prints counts and redacts
 * every path and key to a short digest, because a transcript filename is a session uuid and a key
 * carries it verbatim.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const { createDeriver, streamCorpus } = await import(
  join(ROOT, 'packages/adapter-claude-code/dist/index.js')
);

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = rootFlag === -1 ? undefined : args[rootFlag + 1];

/** A path or a key, redacted to a stable digest: recognisable across lines, disclosing nothing. */
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);

/** `raw#2` -> `raw`. The suffix is the only place `#` appears in a key this deriver mints. */
const rawOf = (key) => key.replace(/#\d+$/, '');

// ---- 1. Re-derive the whole corpus, one deriver, recording which file each entry came from ----

/** @type {{type: string, key: string, raw: string, file: string}[]} */
const rows = [];
const deriver = createDeriver();

const totals = await streamCorpus(
  (record, file) => {
    for (const entry of deriver.accept(record, file)) {
      rows.push({ type: entry.type, key: entry.key, raw: rawOf(entry.key), file: file.path });
    }
  },
  root === undefined ? {} : { root },
);

console.log(`\nre-derived the corpus: ${String(totals.files)} file(s), ${String(totals.parsed)} record(s)`);
console.log(`${String(rows.length)} derived entry/entries, ${String(totals.skipped.length)} file(s) skipped`);

// ---- 2. Group by (type, raw key) and classify each group ----

/** @type {Map<string, {type: string, raw: string, files: Set<string>, n: number}>} */
const groups = new Map();
/** @type {Map<string, string>} key -> group id, so a stored id can be looked up later */
const keyToGroup = new Map();

for (const row of rows) {
  const id = `${row.type}\u0000${row.raw}`;
  let group = groups.get(id);
  if (group === undefined) {
    group = { type: row.type, raw: row.raw, files: new Set(), n: 0 };
    groups.set(id, group);
  }
  group.files.add(row.file);
  group.n += 1;
  keyToGroup.set(`${row.type}\u0000${row.key}`, id);
}

const repeated = [...groups.values()].filter((group) => group.n > 1);
const crossFile = repeated.filter((group) => group.files.size > 1);
const sameFile = repeated.filter((group) => group.files.size === 1);

// Each group of n mints n-1 suffixes. That is the count the question is about.
const sum = (list) => list.reduce((total, group) => total + group.n - 1, 0);

console.log(`\nraw keys carried by more than one derived entry: ${String(repeated.length)}`);
console.log(`  of those, spanning MORE THAN ONE FILE:        ${String(crossFile.length)}`);
console.log(`  of those, repeating WITHIN ONE FILE:          ${String(sameFile.length)}`);
console.log(`\nsuffixes this sweep mints:                      ${String(sum(repeated))}`);
console.log(`  minted ACROSS files:                          ${String(sum(crossFile))}`);
console.log(`  minted WITHIN one file:                       ${String(sum(sameFile))}`);

const byType = new Map();
for (const group of crossFile) byType.set(group.type, (byType.get(group.type) ?? 0) + group.n - 1);
console.log(`\ncross-file suffixes by type:`);
for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(22)} ${String(n)}`);
}

// ---- 3. Ask the same question of the STORE, not of a fresh sweep ----

const storePath = join(ROOT, '.ascend', 'index.db');
if (!existsSync(storePath)) {
  console.log(`\nno store at ${storePath} -- nothing to cross-check`);
} else {
  const db = new DatabaseSync(storePath);
  let stored;
  try {
    stored = db
      .prepare("SELECT id FROM entries WHERE id LIKE 'derived:%#%' ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }

  // `derived:<source>:<type>:<key>` -- the key is everything after the type, and the type itself may
  // carry an `@<version>` suffix, so the split has to come from the right, not by counting colons.
  const parseId = (id) => {
    const rest = id.slice('derived:'.length);
    const parts = rest.split(':');
    // source, type[@version], session, uuid[#n]
    const type = parts[1] ?? '';
    const key = parts.slice(2).join(':');
    return { type: type.replace(/@\d+$/, ''), key };
  };

  let reproduced = 0;
  let across = 0;
  let within = 0;
  let unclassified = 0;
  /** @type {string[]} */
  const examples = [];

  for (const id of stored) {
    const { type, key } = parseId(id);
    const groupId = keyToGroup.get(`${type}\u0000${key}`);
    const group = groupId === undefined ? undefined : groups.get(groupId);
    if (group === undefined) {
      unclassified += 1;
      continue;
    }
    reproduced += 1;
    if (group.files.size > 1) {
      across += 1;
      if (examples.length < 5) {
        examples.push(
          `    ${type} #${String(group.n)} held by ${String(group.files.size)} files ` +
            `[${[...group.files].map(digest).sort().join(', ')}]`,
        );
      }
    } else {
      within += 1;
    }
  }

  console.log(`\nthe store's own suffixed ids: ${String(stored.length)}`);
  console.log(`  re-derived by this sweep, so classifiable:  ${String(reproduced)}`);
  console.log(`    minted ACROSS files:                       ${String(across)}`);
  console.log(`    minted WITHIN one file:                   ${String(within)}`);
  console.log(`  NOT classifiable (the corpus moved since):  ${String(unclassified)}`);
  if (examples.length > 0) {
    console.log(`\n  cross-file groups behind stored ids, redacted:`);
    for (const example of examples) console.log(example);
  }
}
