/**
 * asc-kq2f: does the Forgejo WEB CONFLICT EDITOR honour `merge=union`?
 *
 * `union-forge-arms.mjs` measured the server-side PR merge button and found it refuses on both
 * bases. A refusal is loud and loses nothing -- but it leaves a human as the only way such a PR can
 * land, and the human's tool is the web conflict editor. This script builds the same fixture, gets
 * PR b into the conflicted state, and then hands the PR to a real browser.
 *
 * **What is being measured, and what is not.** The failure this bead is about is NOT conflict
 * markers. A one-sided resolution leaves WELL-FORMED JSONL with the other side's appends silently
 * gone -- every line parses, no markers, the file just holds fewer records. So the reading is taken
 * from `records.jsonl` ON THE SERVER after the editor commits, never from the editor's own report.
 *
 * **Forgejo is not GitHub.** Gitea/Forgejo shell out to the `git` binary for merge work; GitHub's
 * merge is not the git binary. A result here is a statement about the Gitea family.
 *
 * Usage:
 *   FORGE_PASS=... node union-forge-editor.mjs <fixture-dir> --setup
 *   FORGE_PASS=... node union-forge-editor.mjs <fixture-dir> --drive
 */
import { execFileSync } from 'node:child_process';

const FORGE = process.env.FORGE_URL ?? 'http://localhost:3301';
const OWNER = 'probe';
const REPO = 'union-probe';
const PASS = process.env.FORGE_PASS ?? '';
const AUTH = 'Basic ' + Buffer.from(`${OWNER}:${PASS}`).toString('base64');
const DIR = process.argv[2];
const MODE = process.argv[3];
if (!DIR || !['--setup', '--drive'].includes(MODE)) {
  throw new Error('usage: FORGE_PASS=... node union-forge-editor.mjs <fixture-dir> --setup|--drive');
}

const git = (...args) =>
  execFileSync('git', args, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

/** A just-created PR reports mergeable=false or null until the forge has evaluated it. */
async function settledPr(index) {
  for (let i = 0; i < 40; i++) {
    const { json } = await api(`/repos/${OWNER}/${REPO}/pulls/${index}`);
    if (json?.mergeable !== undefined && json.mergeable !== null) return json;
    await sleep(250);
  }
  return null;
}

async function mainFile(ref = 'main') {
  const { ok, json } = await api(`/repos/${OWNER}/${REPO}/contents/records.jsonl?ref=${ref}`);
  if (!ok) return null;
  return Buffer.from(json.content, 'base64').toString('utf8');
}

/** Read the state of a ref from the SERVER. Never infer landed content from a command's report. */
function assess(text) {
  if (text === null) return { records: null, note: 'records.jsonl ABSENT' };
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
    `rb0 ${s.rb0 ? 'present' : 'ABSENT'}, markers ${s.markers ? 'PRESENT' : 'none'}, ` +
    `unparseable lines ${String(s.unparseable)}`
  );
}

async function ensureRepo() {
  const { status } = await api(`/repos/${OWNER}/${REPO}`);
  if (status === 200) return;
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({ name: REPO, private: true, auto_init: false, default_branch: 'main' }),
  });
  if (!created.ok) throw new Error(`could not create repo: ${JSON.stringify(created.json)}`);
}

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

const openPr = (head, title) =>
  api(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ head, base: 'main', title }),
  });

const BASE_BRANCH = { union: 'base-union', plain: 'base-plain' };
const baseSha = { union: git('rev-parse', 'base-union'), plain: git('rev-parse', 'base-plain') };

try {
  git('remote', 'get-url', 'forge');
} catch {
  git('remote', 'add', 'forge', `${FORGE.replace('://', `://${OWNER}:${PASS}@`)}/${OWNER}/${REPO}.git`);
}

/** Puts PR b on `base` into the conflicted state and returns the numbers. */
async function stageCell(base) {
  await ensureRepo();
  await closeAllPrs();
  git('push', '-q', '--force', 'forge', `${baseSha[base]}:refs/heads/main`);
  git('push', '-q', '--force', 'forge', `refs/heads/a-${BASE_BRANCH[base]}:refs/heads/pr-a`);
  git('push', '-q', '--force', 'forge', `refs/heads/b-${BASE_BRANCH[base]}:refs/heads/pr-b`);

  const a = await openPr('pr-a', `${base}: append ra0`);
  if (!a.ok) throw new Error(`could not open PR a: ${JSON.stringify(a.json)}`);
  // Settle BEFORE merging. Forgejo evaluates mergeability lazily, so a merge issued against a
  // just-created PR can come back "Please try again later" with the PR simply not merged -- measured
  // once here, which left `main` at the base and made PR b trivially mergeable, so the conflict
  // editor 404'd and the run reported success on a cell that never reached the state under test.
  const aState = await settledPr(a.json.number);
  if (aState?.mergeable === false) {
    throw new Error(`PR a #${String(a.json.number)} is not mergeable on base ${base}; cannot stage`);
  }
  const aMerged = await api(`/repos/${OWNER}/${REPO}/pulls/${a.json.number}/merge`, {
    method: 'POST',
    body: JSON.stringify({ Do: 'merge' }),
  });
  // A refused merge must stop the run: PR a not landing is not the cell this script measures.
  if (!aMerged.ok) {
    throw new Error(
      `PR a #${String(a.json.number)} merge refused on base ${base}: ` +
        JSON.stringify(aMerged.json),
    );
  }

  const b = await openPr('pr-b', `${base}: append rb0`);
  if (!b.ok) throw new Error(`could not open PR b: ${JSON.stringify(b.json)}`);
  const bState = await settledPr(b.json.number);

  return {
    base,
    aNumber: a.json.number,
    aMerged: aMerged.ok,
    aMessage: aMerged.json?.message ?? (aMerged.ok ? 'merged' : JSON.stringify(aMerged.json)),
    bNumber: b.json.number,
    bMergeable: bState?.mergeable,
    bUrl: `${FORGE}/${OWNER}/${REPO}/pulls/${b.json.number}`,
    editorUrl: `${FORGE}/${OWNER}/${REPO}/pulls/${b.json.number}/conflicts`,
    afterA: assess(await mainFile('main')),
  };
}

if (MODE === '--setup') {
  for (const base of ['union', 'plain']) {
    const cell = await stageCell(base);
    console.log(`\n=== ${base}`);
    console.log(`  PR a #${String(cell.aNumber)}: ${cell.aMerged ? 'MERGED' : 'REFUSED'} -- ${cell.aMessage}`);
    console.log(`  main after PR a : ${describe(cell.afterA)}`);
    console.log(`  PR b #${String(cell.bNumber)}: mergeable=${String(cell.bMergeable)}`);
    console.log(`  PR b url        : ${cell.bUrl}`);
    console.log(`  conflict editor : ${cell.editorUrl}`);
    console.log(`  pr-b branch     : ${describe(assess(await mainFile('pr-b')))}`);
  }
} else {
  const base = process.argv[4] ?? 'union';
  const cell = await stageCell(base);
  console.log(JSON.stringify(cell, null, 1));
  const { driveEditor } = await import('./union-forge-editor-drive.mjs');
  await driveEditor({ forge: FORGE, owner: OWNER, repo: REPO, pass: PASS, pull: cell.bNumber });
}
