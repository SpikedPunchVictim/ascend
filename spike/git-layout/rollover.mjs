// asc-x1gw addendum (throwaway). Owner proposal: records in files of 50,000, rolled over, with
// `merge=union`. (1) What does two branches rolling over at once do? (2) What does a 50k-line
// active file cost per commit?
//   node spike/git-layout/rollover.mjs <export.jsonl> <scratch-dir>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const [exportPath, scratch] = process.argv.slice(2);
const CAP = 50000;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const C = ['-c', 'user.name=s', '-c', 'user.email=s@x.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'init.defaultBranch=main'];
const git = (cwd, ...a) => { const t = performance.now(); const r = spawnSync('git', [...C, ...a], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 30 });
  return { code: r.status, out: (r.stdout + r.stderr).trim(), s: +((performance.now() - t) / 1000).toFixed(2) }; };
const must = (cwd, ...a) => { const r = git(cwd, ...a); if (r.code) throw new Error(`git ${a.join(' ')}: ${r.out}`); return r; };

const templates = readFileSync(exportPath, 'utf8').trim().split('\n').filter((l) => l.startsWith('{"kind":"entry"')).map((l) => JSON.parse(l));
const rec = (i) => ({ ...templates[i % templates.length], id: randomBytes(16).toString('hex') });
const fileName = (n) => `records/records-${String(n).padStart(4, '0')}.jsonl`;

// The writer: append to the newest file; roll over when it holds CAP records.
function append(dir, recs) {
  for (const r of recs) {
    const files = readdirSync(join(dir, 'records')).sort();
    let cur = files.at(-1);
    const n = readFileSync(join(dir, 'records', cur), 'utf8').split('\n').filter(Boolean).length;
    if (n >= CAP) cur = `records-${String(files.length + 1).padStart(4, '0')}.jsonl`;
    appendFileSync(join(dir, 'records', cur), JSON.stringify(r) + '\n');
  }
}
function ids(dir) {
  const all = [];
  for (const f of readdirSync(join(dir, 'records'))) for (const l of readFileSync(join(dir, 'records', f), 'utf8').split('\n')) { if (!l) continue; try { all.push(JSON.parse(l).id); } catch { all.push('<bad>'); } }
  return all;
}

rmSync(scratch, { recursive: true, force: true });
const origin = join(scratch, 'origin');
mkdirSync(join(origin, 'records'), { recursive: true });
must(origin, 'init', '-q');
writeFileSync(join(origin, '.gitattributes'), 'records/*.jsonl merge=union\n');
const baseN = CAP - 10;
writeFileSync(join(origin, fileName(1)), Array.from({ length: baseN }, (_, i) => JSON.stringify(rec(i)) + '\n').join(''));
must(origin, 'add', '-A'); must(origin, 'commit', '-qm', 'base');
console.log(`base: ${baseN} records, ${(statSync(join(origin, fileName(1))).size / 1e6).toFixed(1)} MB`);

// (2) cost of one small append to the full-size active file
{
  const dir = join(scratch, 'cost'); must(scratch, 'clone', '-q', origin, dir);
  append(dir, Array.from({ length: 5 }, (_, i) => rec(i)));
  const diff = git(dir, 'diff', '--stat'); const add = git(dir, 'add', '-A'); const commit = git(dir, 'commit', '-qm', 'five');
  const blob = git(dir, 'rev-parse', `HEAD:${fileName(1)}`).out;
  const loose = statSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2))).size;
  const show = git(dir, 'show', '--stat', 'HEAD');
  console.log(`append 5 to the ${baseN}-record file: diff ${diff.s}s (${diff.out.split('\n').at(-1).trim()}), add ${add.s}s, commit ${commit.s}s, new loose blob ${(loose / 1e6).toFixed(1)} MB, show ${show.s}s`);
}

// (1) rollover scenarios
const scenarios = {
  'R1 both roll over (A +30, B +30)': [30, 30],
  'R2 only A rolls over (A +30, B +5)': [30, 5],
  'R3 neither rolls over (A +4, B +4)': [4, 4],
};
for (const [name, [na, nb]] of Object.entries(scenarios)) {
  for (const strategy of ['merge', 'rebase']) {
    const dir = join(scratch, `${name.slice(0, 2)}-${strategy}`); must(scratch, 'clone', '-q', origin, dir);
    must(dir, 'checkout', '-qb', 'b'); const B = Array.from({ length: nb }, (_, i) => rec(i)); append(dir, B); must(dir, 'add', '-A'); must(dir, 'commit', '-qm', 'B');
    must(dir, 'checkout', '-q', 'main'); must(dir, 'checkout', '-qb', 'a'); const A = Array.from({ length: na }, (_, i) => rec(i + 7)); append(dir, A); must(dir, 'add', '-A'); must(dir, 'commit', '-qm', 'A');
    const r = strategy === 'merge' ? git(dir, 'merge', '--no-edit', 'b') : git(dir, 'rebase', 'b');
    const got = ids(dir); const have = new Set(got);
    const lost = [...A, ...B].filter((x) => !have.has(x.id)).length;
    const counts = readdirSync(join(dir, 'records')).sort().map((f) => `${f.slice(8, 12)}:${readFileSync(join(dir, 'records', f), 'utf8').split('\n').filter(Boolean).length}`).join(' ');
    console.log(`${name} ${strategy}: ${r.code ? 'CONFLICT ' + r.out.split('\n').find((l) => /CONFLICT/.test(l)) : 'clean'}; lost ${lost}, bad lines ${got.filter((x) => x === '<bad>').length}, dupes ${got.length - have.size}; files ${counts}`);
  }
}
