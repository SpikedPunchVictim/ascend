/**
 * asc-3ow4, second arm: does GITHUB's server-side PR merge honour `merge=union`?
 *
 * This is the arm the bead actually names. It is driven entirely through the GitHub REST API via
 * `gh api` -- no `git push`, no credential helper, no keychain -- so it does not depend on the push
 * credential that blocked the first attempt. The tree, commits, branches, PRs and merges are all
 * built with the git-data API; the only thing that differs from the Forgejo arm is the server.
 *
 * Fixture: identical to `union-fixture.sh` and to `union-forge-arms.mjs`. `main` holds three records
 * (r0, r1, r2); branch `a` appends `{"id":"ra0"}`, branch `b` appends `{"id":"rb0"}`; two PRs, a then
 * b. Two bases, because "the second PR conflicted" means nothing without a control:
 *
 *   base-union  .gitattributes has `records.jsonl merge=union`
 *   base-plain  the same tree with `.gitattributes` removed
 *
 * Command-line git merges the union base CLEAN and the plain base CONFLICTs, so the attribute is the
 * only thing that differs them.
 *
 * Run: node union-github-arms.mjs
 */
import { spawnSync } from 'node:child_process';

const OWNER = 'SpikedPunchVictim';
const REPO = 'asc-union-probe-tmp';

/** `gh api` does the auth. Never prints or handles the token. */
function gh(path, { method = 'GET', body } = {}) {
  const args = ['api', path, '--method', method];
  if (body !== undefined) args.push('--input', '-');
  const r = spawnSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
  });
  const out = (r.stdout ?? '').trim();
  let json = null;
  try {
    json = out ? JSON.parse(out) : null;
  } catch {
    json = out;
  }
  if (r.status !== 0) return { ok: false, status: r.status, json, err: (r.stderr ?? '').trim() };
  return { ok: true, status: 0, json };
}

const must = (label, res) => {
  if (!res.ok) throw new Error(`${label} failed: ${res.err || JSON.stringify(res.json)}`);
  return res.json;
};

const blob = (content) =>
  must('blob', gh(`/repos/${OWNER}/${REPO}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf8' } })).sha;

const tree = (entries, baseTree) =>
  must(
    'tree',
    gh(`/repos/${OWNER}/${REPO}/git/trees`, {
      method: 'POST',
      body: {
        tree: entries.map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })),
        ...(baseTree ? { base_tree: baseTree } : {}),
      },
    }),
  ).sha;

const commit = (message, treeSha, parents) =>
  must(
    'commit',
    gh(`/repos/${OWNER}/${REPO}/git/commits`, {
      method: 'POST',
      body: { message, tree: treeSha, parents },
    }),
  ).sha;

const setRef = (ref, sha) => {
  const created = gh(`/repos/${OWNER}/${REPO}/git/refs`, { method: 'POST', body: { ref, sha } });
  if (created.ok) return sha;
  must(
    'ref update',
    gh(`/repos/${OWNER}/${REPO}/git/refs/${ref.replace('refs/', '')}`, {
      method: 'PATCH',
      body: { sha, force: true },
    }),
  );
  return sha;
};

const RECORDS = (extra = []) =>
  ['{"id":"r0"}', '{"id":"r1"}', '{"id":"r2"}', ...extra].map((l) => l + '\n').join('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GitHub returns `mergeable: null` while it computes. That is the sentinel -- not `false`.
 *
 * The value is then SAMPLED repeatedly rather than read once, because a single read is not
 * trustworthy: in the first run this flag came back `false`, `false` and `true` across three cells
 * whose inputs were byte-identical, and read `true`/`clean` on the union base immediately before the
 * merge endpoint refused that same PR for conflicts. The distinct values observed are reported so
 * the flakiness is a measurement rather than an impression.
 */
async function settledPr(number, tries = 40) {
  let first = null;
  for (let i = 0; i < tries; i++) {
    const { json } = gh(`/repos/${OWNER}/${REPO}/pulls/${number}`);
    if (json?.mergeable !== null && json?.mergeable !== undefined) {
      first = json;
      break;
    }
    await sleep(500);
  }
  if (!first) return { pr: null, samples: [] };
  const seen = [`${String(first.mergeable)}/${String(first.mergeable_state)}`];
  for (let i = 0; i < 4; i++) {
    await sleep(1000);
    const { json } = gh(`/repos/${OWNER}/${REPO}/pulls/${number}`);
    seen.push(`${String(json?.mergeable)}/${String(json?.mergeable_state)}`);
  }
  return { pr: first, samples: seen };
}

function closeAllPrs() {
  const open = gh(`/repos/${OWNER}/${REPO}/pulls?state=open&limit=50`);
  const list = Array.isArray(open.json) ? open.json : [];
  for (const pr of list) {
    gh(`/repos/${OWNER}/${REPO}/pulls/${pr.number}`, { method: 'PATCH', body: { state: 'closed' } });
  }
  return list.length;
}

function mainRecords() {
  const r = gh(`/repos/${OWNER}/${REPO}/contents/records.jsonl?ref=main`);
  if (!r.ok) return null;
  return Buffer.from(r.json.content, 'base64').toString('utf8');
}

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

const describe = (s) =>
  s.records === null
    ? s.note
    : `${String(s.records)} records, ra0 ${s.ra0 ? 'present' : 'ABSENT'}, rb0 ${s.rb0 ? 'present' : 'ABSENT'}, markers ${s.markers ? 'PRESENT' : 'none'}, unparseable lines ${String(s.unparseable)}`;

// ---------------------------------------------------------------- build the fixture
// GitHub refuses the git-data API on a repo with no commits ("Git Repository is empty"), so the
// first commit has to be made through the Contents API. Once `main` exists, everything else is built
// from that root. Re-running just re-roots from whatever is already there.
let bootSha;
let bootTree;
{
  const ref = gh(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  if (ref.ok) {
    bootSha = ref.json.object.sha;
    bootTree = must('root commit', gh(`/repos/${OWNER}/${REPO}/git/commits/${bootSha}`)).tree.sha;
  } else {
    const boot = must(
      'bootstrap',
      gh(`/repos/${OWNER}/${REPO}/contents/README.md`, {
        method: 'PUT',
        body: {
          message: 'bootstrap (throwaway probe for asc-3ow4)',
          content: Buffer.from('# throwaway probe for asc-3ow4 (merge=union)\n').toString('base64'),
        },
      }),
    );
    bootSha = boot.commit.sha;
    bootTree = boot.commit.tree.sha;
  }
}

const attrSha = blob('records.jsonl merge=union\n');

const unionTree = tree(
  [
    ['.gitattributes', attrSha],
    ['records.jsonl', blob(RECORDS())],
  ],
  bootTree,
);
// The plain base is the SAME tree with `.gitattributes` removed -- built from unionTree rather than
// from scratch, so the attribute really is the only difference.
const plainTree = tree([['records.jsonl', blob(RECORDS())]], unionTree);

const unionCommit = commit('base-union: .gitattributes records.jsonl merge=union', unionTree, [bootSha]);
const baseSha = {
  union: unionCommit,
  plain: commit('base-plain: same tree, no .gitattributes', plainTree, [unionCommit]),
};

const headSha = {};
for (const base of ['union', 'plain']) {
  for (const [side, extra] of [
    ['a', ['{"id":"ra0"}']],
    ['b', ['{"id":"rb0"}']],
  ]) {
    const t = tree([['records.jsonl', blob(RECORDS(extra))]], baseSha[base]);
    headSha[`${side}-${base}`] = commit(`append from ${side}`, t, [baseSha[base]]);
  }
}
setRef('refs/heads/main', baseSha.union);
setRef('refs/heads/base-union', baseSha.union);
setRef('refs/heads/base-plain', baseSha.plain);
for (const [name, sha] of Object.entries(headSha)) setRef(`refs/heads/${name}`, sha);

console.log(`repo ${OWNER}/${REPO}`);
console.log(`  base-union ${baseSha.union.slice(0, 8)}   base-plain ${baseSha.plain.slice(0, 8)}`);

// ---------------------------------------------------------------- control: is `mergeable` a verdict?
{
  closeAllPrs();
  // An empty commit: same tree, one more parent. (GitHub rejects a tree request with no entries,
  // so reuse the tree rather than asking for nothing.)
  const advanced = commit('advance main (empty commit, forces a non-fast-forward)', unionTree, [baseSha.union]);
  const cTree = tree([['extra.txt', blob('hello\n')]], baseSha.union);
  const cSha = commit('add extra.txt (cannot conflict with records.jsonl)', cTree, [baseSha.union]);
  setRef('refs/heads/pr-c', cSha);
  setRef('refs/heads/main', advanced);

  const pr = must('control pr', gh(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: { title: 'CONTROL: adds extra.txt, cannot conflict', head: 'pr-c', base: 'main' },
  }));
  const st = await settledPr(pr.number);
  // Merge the control. Without this, "PR b was refused" could mean no non-fast-forward merge works
  // in this repo at all; with it, the refusals are attributable to the records.jsonl overlap.
  const ctlMerge = gh(`/repos/${OWNER}/${REPO}/pulls/${pr.number}/merge`, {
    method: 'PUT',
    body: { merge_method: 'merge' },
  });
  console.log(
    `  CONTROL PR #${pr.number} (no possible conflict): samples ${st.samples.join(' ')} | merge ${ctlMerge.ok ? 'MERGED' : `REFUSED -- ${ctlMerge.json?.message ?? ctlMerge.err}`}`,
  );
  console.log(`  control changed records.jsonl? ${mainRecords() === RECORDS() ? 'no (records intact)' : 'YES'}`);
}

// ---------------------------------------------------------------- the six cells
const STRATEGIES = ['merge', 'squash', 'rebase'];
const rows = [];

for (const base of ['union', 'plain']) {
  for (const strategy of STRATEGIES) {
    closeAllPrs();
    setRef('refs/heads/main', baseSha[base]);
    setRef('refs/heads/pr-a', headSha[`a-${base}`]);
    setRef('refs/heads/pr-b', headSha[`b-${base}`]);

    const label = `${base}/${strategy}`;
    const a = gh(`/repos/${OWNER}/${REPO}/pulls`, {
      method: 'POST',
      body: { title: `arm ${label}: append ra0`, head: 'pr-a', base: 'main' },
    });
    const b = gh(`/repos/${OWNER}/${REPO}/pulls`, {
      method: 'POST',
      body: { title: `arm ${label}: append rb0`, head: 'pr-b', base: 'main' },
    });
    if (!a.ok || !b.ok) {
      console.log(`\n=== ${label}\n  COULD NOT OPEN PRs: ${a.err ?? ''} ${b.err ?? ''}`);
      continue;
    }

    const first = gh(`/repos/${OWNER}/${REPO}/pulls/${a.json.number}/merge`, {
      method: 'PUT',
      body: { merge_method: strategy },
    });
    const bState = await settledPr(b.json.number);
    const second = gh(`/repos/${OWNER}/${REPO}/pulls/${b.json.number}/merge`, {
      method: 'PUT',
      body: { merge_method: strategy },
    });
    const s = assess(mainRecords());

    const flags = [];
    if (second.ok && !(s.ra0 && s.rb0)) flags.push('SILENT LOSS');
    if (second.ok && s.unparseable > 0) flags.push('SILENT CORRUPTION');
    if (second.ok && s.markers) flags.push('MERGED WITH MARKERS');
    const lost = flags.length ? flags.join(' + ') : 'none';

    rows.push({ base, strategy, first, bState, second, s, lost });

    console.log(`\n=== ${label}   (merge_method="${strategy}", base base-${base})`);
    console.log(`  PR a      : ${first.ok ? 'MERGED' : 'REFUSED'} -- ${first.ok ? 'merged' : (first.json?.message ?? first.err)}`);
    console.log(`  PR b prep : mergeable/state samples ${bState.samples.join(' ')}`);
    console.log(`  PR b      : ${second.ok ? 'MERGED' : 'REFUSED'} -- ${second.ok ? 'merged' : (second.json?.message ?? second.err)}`);
    console.log(`  main      : ${describe(s)}`);
    console.log(`  silent loss: ${lost}`);
  }
}

console.log('\n\n=== SUMMARY (read `main` back from the server after each cell)');
console.log('base   strategy  PRa      PRb      rb0 on main  mergeable/state samples          silent loss');
for (const r of rows) {
  console.log(
    [
      r.base.padEnd(6),
      r.strategy.padEnd(9),
      (r.first.ok ? 'MERGED' : 'REFUSED').padEnd(8),
      (r.second.ok ? 'MERGED' : 'REFUSED').padEnd(8),
      (r.s.records === null ? 'n/a' : r.s.rb0 ? 'present' : 'absent').padEnd(12),
      r.bState.samples.join(' ').padEnd(32),
      r.lost,
    ].join(' '),
  );
}
