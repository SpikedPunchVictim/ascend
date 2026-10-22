#!/usr/bin/env node
/**
 * asc-m3sb.1, checks 1-3: verify the public-repo corpus before any mining, from the raw files.
 *
 * The design (asc-m3sb section 6) names what has to be true before a prior is admitted:
 *
 *   1. Dataset B's count contradicts itself by one in its README. Recount from the raw files.
 *   2. The (#N) link rate per repo, which is section 3's gate on whether a PR-linked finding may
 *      be pooled (>= 0.80 pool, 0.50-0.80 per repo only, < 0.50 not pooled at all).
 *   3. Dataset A's bot-authored share, reported split by author class rather than pooled.
 *
 * Read-only: it opens the corpus directory and nothing else. No network, no clone.
 *
 * Usage: node spike/m3sb/verify-corpus.mjs [--corpus DIR] [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const AS_JSON = args.includes('--json');
const CORPUS = flag('corpus', join(homedir(), 'temp', 'enterprise-apps', 'pr-research'));
const DATASET_A = join(CORPUS, 'dataset-a-github-pr-comments');
const DATASET_B = join(CORPUS, 'dataset-b-enterprise-git-history', 'raw-commit-subjects');

/** JSONL read by splitting on the newline -- never readline, which breaks on U+2028. */
function readJsonl(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

/**
 * Check 1: the subject count, and what the file actually is.
 *
 * The count is the number of non-empty lines, because that is what any downstream pass will read.
 * Blank lines are counted separately rather than silently absorbed: 288,208 lines minus 11 blanks
 * is a different statement from 288,208 subjects.
 */
function datasetB() {
  const repos = [];
  let subjects = 0;
  let blank = 0;
  let lines = 0;
  let linked = 0;
  for (const name of readdirSync(DATASET_B).filter((f) => f.endsWith('.txt')).sort()) {
    const raw = readFileSync(join(DATASET_B, name), 'utf8').split('\n');
    const nonEmpty = raw.filter((l) => l.trim().length > 0);
    // A squash-merged subject ends with " (#1234)". Measured: matching "anywhere" moves no repo
    // by more than 0.1 points except vscode (27.0 -> 27.1), so the anchor is not where the
    // difference lies; see EV-75's table.
    const withPr = nonEmpty.filter((l) => /\(#\d+\)\s*$/.test(l)).length;
    lines += raw.length;
    blank += raw.length - nonEmpty.length;
    subjects += nonEmpty.length;
    linked += withPr;
    repos.push({
      repo: name.replace(/\.txt$/, ''),
      subjects: nonEmpty.length,
      pr_linked: withPr,
      pr_rate: Number((withPr / nonEmpty.length).toFixed(4)),
      // Section 3's band, stated as a verdict rather than left to the reader.
      pooling: withPr / nonEmpty.length >= 0.8 ? 'poolable' : withPr / nonEmpty.length >= 0.5 ? 'per-repo only' : 'not pooled',
    });
  }
  return {
    files: repos.length,
    lines,
    blank_lines: blank,
    subjects,
    pr_linked: linked,
    pr_rate: Number((linked / subjects).toFixed(4)),
    per_repo: repos,
  };
}

/**
 * Check 3: the bot share, split by author class.
 *
 * A comment is bot-authored when GitHub's own `type` says `Bot`. The `[bot]` login suffix is not a
 * substitute: measured, it catches 421 of the bot rows, because the largest single bot in the
 * corpus (`Copilot`, 721 comments) has no suffix. Rows with no `type` are counted and named, not
 * folded in.
 */
function datasetA() {
  const files = readdirSync(join(DATASET_A, 'raw')).filter((f) => f.endsWith('.jsonl')).sort();
  const perRepo = [];
  const totals = { comments: 0, bot: 0, human: 0, untyped: 0, botBySuffix: 0 };
  for (const name of files) {
    const rows = readJsonl(join(DATASET_A, 'raw', name));
    let bot = 0;
    let human = 0;
    let untyped = 0;
    for (const row of rows) {
      if (row.type === 'Bot') bot += 1;
      else if (row.type === 'User') human += 1;
      else untyped += 1;
      if (/\[bot\]$/i.test(row.user ?? '')) totals.botBySuffix += 1;
    }
    totals.comments += rows.length;
    totals.bot += bot;
    totals.human += human;
    totals.untyped += untyped;
    perRepo.push({
      repo: name.replace(/\.jsonl$/, ''),
      comments: rows.length,
      bot,
      human,
      untyped,
      bot_rate: Number((bot / rows.length).toFixed(4)),
    });
  }
  return {
    ...totals,
    bot_rate: Number((totals.bot / totals.comments).toFixed(4)),
    bot_rate_of_classified: Number((totals.bot / (totals.bot + totals.human)).toFixed(4)),
    per_repo: perRepo,
  };
}

const b = datasetB();
const a = datasetA();
const out = {
  corpus: CORPUS,
  dataset_b: b,
  dataset_a: a,
};

/**
 * Fixed-width lines rather than `console.table`, because this output goes into an evidence record
 * verbatim and a box-drawing table re-wraps in a fenced block.
 */
const pad = (s, n) => String(s).padEnd(n);
const num = (n, w) => String(n).padStart(w);

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`corpus ${CORPUS}`);
  console.log('');
  console.log(
    `check 1  Dataset B subjects ${b.subjects} over ${b.files} files (${b.lines} lines, ${b.blank_lines} blank)`,
  );
  console.log(`  ${pad('repo', 18)}${num('subjects', 10)}${num('pr_linked', 11)}${num('pr_rate', 9)}  pooling`);
  for (const r of b.per_repo) {
    console.log(
      `  ${pad(r.repo, 18)}${num(r.subjects, 10)}${num(r.pr_linked, 11)}${num(r.pr_rate.toFixed(4), 9)}  ${r.pooling}`,
    );
  }
  console.log('');
  console.log(
    `check 2  PR-linked ${b.pr_linked} of ${b.subjects} = ${(b.pr_rate * 100).toFixed(2)}%`,
  );
  const band = (name) => b.per_repo.filter((r) => r.pooling === name).map((r) => r.repo).join(', ');
  console.log(`         poolable      ${band('poolable') || '(none)'}`);
  console.log(`         per-repo only ${band('per-repo only') || '(none)'}`);
  console.log(`         not pooled    ${band('not pooled') || '(none)'}`);
  console.log('');
  console.log(
    `check 3  Dataset A ${a.comments} comments, bot ${a.bot} (${(a.bot_rate * 100).toFixed(2)}%), human ${a.human}, untyped ${a.untyped}`,
  );
  console.log(`         [bot] suffix alone identifies ${a.botBySuffix} of ${a.comments}`);
  console.log(`  ${pad('repo', 22)}${num('comments', 9)}${num('bot', 6)}${num('human', 7)}${num('untyped', 8)}${num('bot_rate', 10)}`);
  for (const r of a.per_repo) {
    console.log(
      `  ${pad(r.repo, 22)}${num(r.comments, 9)}${num(r.bot, 6)}${num(r.human, 7)}${num(r.untyped, 8)}${num(r.bot_rate.toFixed(4), 10)}`,
    );
  }
}
