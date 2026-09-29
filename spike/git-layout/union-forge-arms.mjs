/**
 * asc-3ow4: does a FORGE's server-side PR merge honour `merge=union`?
 *
 * **This drives a local Forgejo, NOT GitHub.** Forgejo is a different implementation, and that
 * decides what the numbers can conclude: Gitea/Forgejo shell out to the `git` binary for merge
 * work, so a clean result here is evidence that a server-side forge merge CAN honour the driver --
 * it is NOT evidence that GitHub does, because GitHub's merge is not the git binary. Do not read the
 * output as a GitHub answer.
 *
 * Every (base, strategy) cell is independent: open PRs are closed, `main` is force-reset to the base
 * commit, and the two head branches are force-pushed from that base before the cell starts. Cells
 * are run against BOTH bases, because "the second PR conflicted" says nothing on its own:
 *
 *   base-union  .gitattributes has `records.jsonl merge=union`
 *   base-plain  no .gitattributes -- the control
 *
 * If both bases refuse, the attribute had no effect on this path; if only the plain one refuses,
 * the driver is what saved the union cell. `union-fixture.sh` already proved the two bases differ
 * under command-line git (clean vs CONFLICT), so the local arm is the baseline these cells are read
 * against.
 *
 * Run: FORGE_PASS=... node union-forge-arms.mjs [fixture-dir]
 */
import { execFileSync } from 'node:child_process';

const FORGE = process.env.FORGE_URL ?? 'http://localhost:3000';
const OWNER = 'probe';
const REPO = 'union-probe';
const PASS = process.env.FORGE_PASS ?? '';
const AUTH = 'Basic ' + Buffer.from(`probe:${PASS}`).toString('base64');
const DIR = process.argv[2];
if (!DIR) throw new Error('usage: FORGE_PASS=... node union-forge-arms.mjs <fixture-dir>');

const git = (...args) =>
  execFileSync('git', args, {
    cwd: DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

try {
  git('remote', 'get-url', 'forge');
} catch {
  git('remote', 'add', 'forge', `${FORGE.replace('://', `://probe:${PASS}@`)}/${OWNER}/${REPO}.git`);
}

async function api(path, init = {}) {
  const r = await fetch(`${FORGE}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: AUTH, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { ok: r.ok, status: r.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_BRANCH = { union: 'base-union', plain: 'base-plain' };
const baseSha = { union: git('rev-parse', 'base-union'), plain: git('rev-parse', 'base-plain') };

/**
 * Forgejo computes mergeability lazily: a just-created or just-rebased PR reports
 * `mergeable: false` (or null) for a moment before it has been evaluated. Believe only a settled
 * read -- an un-polled false is a conflict that never happened.
 */
async function settledPr(index) {
  for (let i = 0; i < 40; i++) {
    const { json } = await api(`/repos/${OWNER}/${REPO}/pulls/${index}`);
    if (json?.mergeable !== undefined && json.mergeable !== null) return json;
    await sleep(250);
  }
  return null;
}

/** Close every open PR. Head branch names are fixed per cell, so a leaked PR blocks the next one. */
async function closeAllPrs() {
  const { json } = await api(`/repos/${OWNER}/${REPO}/pulls?state=open&limit=50`);
  if (!Array.isArray(json)) return 0;
  for (const pr of json) {
    await api(`/repos/${OWNER}/${REPO}/pulls/${pr.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }
  return json.length;
}

async function openPr(head, title) {
  const { ok, json } = await api(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ head, base: 'main', title }),
  });
  if (!ok) return { created: false, error: json };
  return { created: true, index: json.number };
}

async function mergePr(index, strategy) {
  const { ok, json } = await api(`/repos/${OWNER}/${REPO}/pulls/${index}/merge`, {
    method: 'POST',
    body: JSON.stringify({ Do: strategy }),
  });
  return { ok, message: json?.message ?? (ok ? 'merged' : JSON.stringify(json).slice(0, 160)) };
}

async function mainFile() {
  const { ok, json } = await api(`/repos/${OWNER}/${REPO}/contents/records.jsonl?ref=main`);
  if (!ok) return null;
  return Buffer.from(json.content, 'base64').toString('utf8');
}

/** Read the state of main from the SERVER. Never infer landed content from a merge command's report. */
function assess(text) {
  if (text === null) return { records: null, note: 'records.jsonl ABSENT from main' };
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const unparseable = lines.filter((l) => {
    try {
      JSON.parse(l);
      return false;
    } catch {
      return true;
    }
  }).length;
  return {
    records: lines.length,
    ra0: text.includes('"ra0"'),
    rb0: text.includes('"rb0"'),
    markers: text.includes('<<<<<<<'),
    unparseable,
  };
}

function describe(s) {
  if (s.records === null) return s.note;
  return (
    `${String(s.records)} records, ra0 ${s.ra0 ? 'present' : 'ABSENT'}, ` +
    `rb0 ${s.rb0 ? 'present' : 'ABSENT'}, ` +
    `markers ${s.markers ? 'PRESENT' : 'none'}, unparseable lines ${String(s.unparseable)}`
  );
}

const STRATEGIES = ['merge', 'squash', 'rebase'];
const rows = [];

for (const base of ['union', 'plain']) {
  for (const strategy of STRATEGIES) {
    const closed = await closeAllPrs();
    git('push', '-q', '--force', 'forge', `${baseSha[base]}:refs/heads/main`);
    git('push', '-q', '--force', 'forge', `refs/heads/a-${BASE_BRANCH[base]}:refs/heads/pr-a`);
    git('push', '-q', '--force', 'forge', `refs/heads/b-${BASE_BRANCH[base]}:refs/heads/pr-b`);

    const label = `${base}/${strategy}`;
    const a = await openPr('pr-a', `arm ${label}: append ra0`);
    if (!a.created) {
      console.log(`${label.padEnd(14)} COULD NOT OPEN PR a: ${JSON.stringify(a.error)}`);
      continue;
    }
    const b = await openPr('pr-b', `arm ${label}: append rb0`);
    if (!b.created) {
      console.log(`${label.padEnd(14)} COULD NOT OPEN PR b: ${JSON.stringify(b.error)}`);
      continue;
    }

    const first = await mergePr(a.index, strategy);
    const bState = await settledPr(b.index);
    const second = await mergePr(b.index, strategy);
    const main = await mainFile();
    const s = assess(main);

    // P4: a refusal is a loud failure and loses nothing -- the record is still on its branch. The
    // claim to falsify is the SILENT one: a merge that reports success while a record is gone.
    // Checked on EVERY cell, the control included -- gating it on base==='union' would disable the
    // instrument exactly where it is least expected to matter, which is how a false green is built.
    // Flags accumulate rather than overwrite, so one failure cannot mask another.
    const flags = [];
    if (second.ok && !(s.ra0 && s.rb0)) flags.push('SILENT LOSS');
    if (second.ok && s.unparseable > 0) flags.push('SILENT CORRUPTION');
    if (second.ok && s.markers) flags.push('MERGED WITH MARKERS');
    const lost = flags.length ? flags.join(' + ') : 'none';

    rows.push({ label, first, bState, second, s, lost });

    console.log(`\n=== ${label}   (Do="${strategy}", base ${BASE_BRANCH[base]})`);
    console.log(`  PRs closed before this cell : ${String(closed)}`);
    console.log(`  PR a      : ${first.ok ? 'MERGED' : 'REFUSED'} -- ${first.message}`);
    console.log(
      `  PR b prep : mergeable=${String(bState?.mergeable)} (PR b alone vs main)`,
    );
    console.log(`  PR b      : ${second.ok ? 'MERGED' : 'REFUSED'} -- ${second.message}`);
    console.log(`  main      : ${describe(s)}`);
    console.log(`  silent loss: ${lost}`);
  }
}

console.log('\n\n=== SUMMARY (read `main` back from the server after each cell)');
console.log('base   strategy  PRa      PRb      rb0 on main  silent loss   note');
for (const r of rows) {
  console.log(
    [
      r.label.split('/')[0].padEnd(6),
      r.label.split('/')[1].padEnd(9),
      (r.first.ok ? 'MERGED' : 'REFUSED').padEnd(8),
      (r.second.ok ? 'MERGED' : 'REFUSED').padEnd(8),
      (r.s.records === null ? 'n/a' : r.s.rb0 ? 'present' : 'absent').padEnd(12),
      r.lost.padEnd(13),
      r.lost === 'none' && !r.second.ok ? '(refused: record still on pr-b)' : '',
    ].join(' '),
  );
}
