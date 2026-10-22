#!/usr/bin/env node
/**
 * asc-m3sb.1, check 4: the design's path-level outcomes, run with one definition on both the public
 * clones and our own repositories, so the direction can be compared before any prior is admitted.
 *
 * Design (asc-m3sb section 2), two of its four measures, both computable without line tracing:
 *
 *   touched_again  L touches at least one path C touched, within 14 days. Direction-neutral: it
 *                  counts follow-up work, not damage.
 *   fix_after      L is typed `fix` and touches a path C touched, within 30 days. Needs conventional
 *                  commit types, so it reads nothing on a repository that does not write them.
 *
 * Three choices the design does not spell out, made the same way on both sides:
 *   - Source files only, with EV-57's non-source list (.lock, manifests, changelogs, docs, data,
 *     .ascend/, .beads/), because a re-touched lockfile is not a re-touched change.
 *   - Commits with more than 30 files are dropped (EV-56/EV-62's rule).
 *   - Commits inside the last window before the newest commit are DROPPED, not counted as
 *     not-touched: they have not had the window to be followed up on, and counting them would bias
 *     the rate down by however much the history runs up to today.
 *
 * The feature compared is `size_top_decile`, which is the class EV-60/EV-62/EV-63 measured: a
 * commit whose added source lines are in the repository's own 90th percentile. A group under
 * MIN_N = 20 commits is printed as an anecdote rather than a rate.
 *
 * Read-only: `git log --numstat` inside each named repository. Nothing is built or modified.
 *
 * Usage: node spike/m3sb/touched-again.mjs <repo> [<repo> ...] [--outcome touched_again|fix_after]
 *        [--window N] [--json]
 */
import { spawnSync } from 'node:child_process';

const MIN_N = 20;
const MAX_FILES = 30;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUTCOME = flag('outcome') ?? 'touched_again';
if (!['touched_again', 'fix_after'].includes(OUTCOME)) {
  throw new Error(`unknown outcome ${OUTCOME}: expected touched_again or fix_after`);
}
const WINDOW_DAYS = Number(flag('window') ?? (OUTCOME === 'fix_after' ? 30 : 14));
const AS_JSON = args.includes('--json');
const REPOS = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

const NON_SOURCE_NAMES = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^Cargo\.lock$/,
  /^go\.sum$/,
  /^CHANGELOG/i,
  /^README/i,
  /^LICENSE/i,
];

/** EV-57's list, plus the store's own directories: neither is code a later commit reworks. */
function isSource(path) {
  if (path.startsWith('.ascend/') || path.startsWith('.beads/')) return false;
  const base = path.split('/').pop() ?? '';
  if (NON_SOURCE_NAMES.some((re) => re.test(base))) return false;
  if (/\.(md|jsonl|csv|tsv|log|lock)$/.test(path)) return false;
  if (/^(docs?|examples?)\//.test(path)) return false;
  return true;
}

/** Conventional-commit `fix`, with or without a scope, before the breaking-change bang or colon. */
const isFixType = (subject) => /^fix(\([^)]*\))?!?:/i.test(subject);

function git(repo, argv) {
  const r = spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git -C ${repo} ${argv.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** One pass over the history: every non-merge commit with its files, added lines, time and subject. */
function readHistory(repo) {
  const raw = git(repo, ['log', '--no-merges', '--numstat', '--format=%x01%H%x01%at%x01%s']);
  const commits = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      const [, sha, ts, subject] = line.split('\x01');
      cur = { sha, ts: Number(ts), subject: subject ?? '', added: 0, files: [] };
      commits.push(cur);
      continue;
    }
    if (!line.trim() || cur === null) continue;
    const [add, , path] = line.split('\t');
    if (!path) continue;
    cur.files.push(path);
    if (add !== '-' && isSource(path)) cur.added = cur.added + Number(add);
  }
  for (const c of commits) c.src = c.files.filter(isSource).sort();
  return commits;
}

/**
 * The outcome, by path: a later commit inside the window touches one of C's source paths, and for
 * `fix_after` it also has to be typed `fix`.
 *
 * The path index is built once, so the sweep is (commits x paths x later-commits-per-path) rather
 * than every pair of commits in the repository.
 */
function measure(repo, commits, outcome, windowDays) {
  const newest = Math.max(...commits.map((c) => c.ts));
  const horizon = newest - windowDays * 86400;
  const qualifies = (c) => (outcome === 'fix_after' ? isFixType(c.subject) : true);
  const eligible = commits.filter(
    (c) => c.src.length > 0 && c.files.length <= MAX_FILES && c.ts <= horizon,
  );
  const ordered = [...eligible].sort((a, b) => a.ts - b.ts);
  const byPath = new Map();
  for (const c of ordered) {
    for (const p of c.src) {
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(c);
    }
  }
  for (const c of ordered) {
    const limit = c.ts + windowDays * 86400;
    const reworkers = new Set();
    for (const p of c.src) {
      for (const later of byPath.get(p) ?? []) {
        if (later.ts <= c.ts) continue;
        if (later.ts > limit) break;
        if (qualifies(later)) reworkers.add(later.sha);
      }
    }
    c.reworkers = reworkers.size;
    c.touched = reworkers.size > 0;
  }
  const rate = (xs) => (xs.length === 0 ? null : xs.filter((c) => c.touched).length / xs.length);
  const round = (x) => (x === null ? null : Number(x.toFixed(4)));
  const cut =
    [...ordered].sort((a, b) => a.added - b.added)[Math.floor(ordered.length * 0.9)]?.added ?? null;
  const top = cut === null ? [] : ordered.filter((c) => c.added >= cut);
  const rest = cut === null ? [] : ordered.filter((c) => c.added < cut);
  const topRate = rate(top);
  const restRate = rate(rest);
  return {
    repo,
    outcome,
    window_days: windowDays,
    commits: commits.length,
    eligible: ordered.length,
    censored: commits.filter(
      (c) => c.src.length > 0 && c.files.length <= MAX_FILES && c.ts > horizon,
    ).length,
    // Local date, not UTC: a commit made at 17:36 on the 21st is not a commit on the 22nd.
    newest_commit: new Date(newest * 1000 - new Date(newest * 1000).getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10),
    base_rate: round(rate(ordered)),
    size_p90_added: cut,
    top_n: top.length,
    top_rate: round(topRate),
    rest_n: rest.length,
    rest_rate: round(restRate),
    rr: topRate === null || !restRate ? null : Number((topRate / restRate).toFixed(3)),
    // MIN_N applies to the exposed group, which is the one the rate is quoted on.
    verdict:
      top.length < MIN_N
        ? `anecdote (n=${top.length} < ${MIN_N})`
        : topRate > restRate
          ? 'agrees: size top decile is followed up more'
          : 'disagrees: size top decile is followed up no more often',
  };
}

const results = REPOS.map((repo) => measure(repo, readHistory(repo), OUTCOME, WINDOW_DAYS));
if (AS_JSON) {
  console.log(JSON.stringify(results, null, 2));
} else {
  // Fixed-width lines rather than `console.table`: this output goes into an evidence record
  // verbatim, and a box-drawing table re-wraps in a fenced block.
  const pad = (s, n) => String(s).padEnd(n);
  const num = (n, w) => String(n ?? '-').padStart(w);
  const short = (p) => p.split('/').slice(-1)[0];
  console.log(`outcome ${OUTCOME}, window ${WINDOW_DAYS} days, MIN_N ${MIN_N}`);
  console.log(
    `${pad('repo', 18)}${num('eligible', 9)}${num('censored', 9)}${num('p90', 6)}${num('top_n', 7)}${num('top', 8)}${num('rest', 8)}${num('rr', 7)}  verdict`,
  );
  for (const r of results) {
    console.log(
      `${pad(short(r.repo), 18)}${num(r.eligible, 9)}${num(r.censored, 9)}${num(r.size_p90_added, 6)}${num(r.top_n, 7)}${num(r.top_rate, 8)}${num(r.rest_rate, 8)}${num(r.rr, 7)}  ${r.verdict}`,
    );
  }
  const decided = results.filter((r) => !r.verdict.startsWith('anecdote'));
  console.log(
    `agreement (n >= ${MIN_N} in the top decile): ${decided.filter((r) => r.rr > 1).length} of ${decided.length} read > 1`,
  );
}
