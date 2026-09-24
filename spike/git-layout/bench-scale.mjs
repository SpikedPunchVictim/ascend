import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [root, n] = process.argv.slice(2);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => { const t = performance.now(); const r = spawnSync('git', ['-c', 'user.name=s', '-c', 'user.email=s@x.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 }); if (r.status) throw new Error(r.stderr); return { out: r.stdout.trim(), s: ((performance.now() - t) / 1000).toFixed(2) }; };
const line = (h) => `{"kind":"entry","id":"${h}","type_name":"verification_run","recorded_at":"2026-09-24T00:00:00.000Z","properties":{"verdict":"passed","runner":"vitest"}}\n`;
for (const mode of ['flat', 'shard256']) {
  const dir = `${root}/${mode}`; mkdirSync(`${dir}/records`, { recursive: true });
  git(dir, 'init', '-q');
  const path = (h) => (mode === 'flat' ? `records/${h}.json` : `records/${h.slice(0, 2)}/${h}.json`);
  let t = performance.now();
  for (let i = 0; i < Number(n); i++) { const h = createHash('sha256').update(String(i)).digest('hex'); if (mode !== 'flat') mkdirSync(`${dir}/records/${h.slice(0, 2)}`, { recursive: true }); writeFileSync(`${dir}/${path(h)}`, line(h)); }
  const write = ((performance.now() - t) / 1000).toFixed(1);
  const add = git(dir, 'add', '-A').s, commit = git(dir, 'commit', '-qm', 'base').s;
  const h = createHash('sha256').update('new').digest('hex');
  if (mode !== 'flat') mkdirSync(`${dir}/records/${h.slice(0, 2)}`, { recursive: true });
  writeFileSync(`${dir}/${path(h)}`, line(h));
  const status = git(dir, 'status', '--porcelain').s;
  git(dir, 'add', '-A'); const commit1 = git(dir, 'commit', '-qm', 'one').s;
  const tree = git(dir, 'cat-file', '-s', 'HEAD:records').out;
  const shardTree = mode === 'flat' ? '-' : git(dir, 'cat-file', '-s', `HEAD:records/${h.slice(0, 2)}`).out;
  // bytes of NEW objects written by the one-record commit
  const newObjs = git(dir, 'diff-tree', '-r', '-t', 'HEAD~1', 'HEAD').out.split('\n').length;
  git(dir, 'gc', '-q');
  const pack = git(dir, 'count-objects', '-v').out.match(/size-pack: (\d+)/)[1];
  console.log(JSON.stringify({ mode, files: Number(n) + 1, writeFilesS: write, gitAddS: add, commitS: commit, statusS: status, commitOneS: commit1,
    recordsTreeBytes: Number(tree), shardTreeBytes: shardTree, objectsChangedByOneRecord: newObjs, indexBytes: statSync(`${dir}/.git/index`).size, packKB: Number(pack) }));
}
