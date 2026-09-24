// Spike asc-x1gw (throwaway). Which JSONL layout survives git without clobbering records?
// Design and predictions: PREREG.md. Builds throwaway repositories under <scratch>; commits nothing here.
//
//   node spike/git-layout/run.mjs <export.jsonl> <scratch-dir>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const [exportPath, scratch] = process.argv.slice(2);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const ID = ['-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null'];
function git(cwd, ...args) {
  const r = spawnSync('git', [...ID, ...args], { cwd, env: ENV, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function must(cwd, ...args) { const r = git(cwd, ...args); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.out}`); return r.out; }

// ---------- records ----------
const lines = readFileSync(exportPath, 'utf8').trim().split('\n');
const header = lines.filter((l) => /^\{"kind":"(type|scheme)"/.test(l));
const base = lines.filter((l) => !/^\{"kind":"(type|scheme)"/.test(l)).map((l) => JSON.parse(l));
const ts = (r) => r.recorded_at ?? r.created_at;
const line = (r) => JSON.stringify(r);
const baseMax = base.map(ts).sort().at(-1);
const hand = base.find((r) => r.kind === 'entry' && !r.id.startsWith('derived:'));
const derived = base.find((r) => r.kind === 'entry' && r.id.startsWith('derived:'));

function uuidv7(ms) {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const nextDayNoon = Date.parse(baseMax.slice(0, 10) + 'T12:00:00.000Z') + 86400000;
const mkHand = (ms) => ({ ...hand, id: uuidv7(ms), recorded_at: new Date(ms).toISOString() });
const mkDerived = (key, ms, variant = 0) => ({ ...derived, id: `derived:claude-code:spike_type:${key}`, recorded_at: new Date(ms).toISOString(),
  properties: { ...derived.properties, spike_variant: variant } });

function scenario(name) {
  const t = (i, off = 0) => nextDayNoon + i * 60000 + off;
  switch (name) {
    case 'S1': return { A: Array.from({ length: 20 }, (_, i) => mkHand(t(i))), B: Array.from({ length: 20 }, (_, i) => mkHand(t(i, 30000))) };
    case 'S2': {
      const shared = Array.from({ length: 30 }, (_, i) => mkDerived(`sess-shared:${i}`, t(100 + i)));
      return { A: [...Array.from({ length: 10 }, (_, i) => mkHand(t(i))), ...shared], B: [...shared, ...Array.from({ length: 10 }, (_, i) => mkHand(t(i, 30000)))] };
    }
    case 'S3': return {
      A: [...Array.from({ length: 5 }, (_, i) => mkHand(t(i))), mkDerived('sess-x:1', t(50), 1)],
      B: [...Array.from({ length: 5 }, (_, i) => mkHand(t(i, 30000))), mkDerived('sess-x:1', t(50), 2)],
    };
    case 'S4': {
      const sorted = base.map(ts).sort();
      const inside = [0.1, 0.3, 0.5, 0.7, 0.9].map((q) => Date.parse(sorted[Math.floor(q * sorted.length)]) + 1);
      return { A: inside.map((ms) => mkHand(ms)), B: Array.from({ length: 5 }, (_, i) => mkHand(t(i))) };
    }
  }
}

// ---------- layouts: records -> { path: content } ----------
const dayOf = (r) => ts(r).slice(0, 10);
const shard = (id) => createHash('sha256').update(id).digest('hex');
const LAYOUTS = {
  one: (recs) => ({ 'records.jsonl': recs.map(({ r }) => line(r) + '\n').join('') }),
  'one-union': (recs) => ({ 'records.jsonl': recs.map(({ r }) => line(r) + '\n').join(''), '.gitattributes': 'records.jsonl merge=union\n' }),
  sorted: (recs) => ({ 'records.jsonl': [...recs].sort((x, y) => (ts(x.r) < ts(y.r) ? -1 : ts(x.r) > ts(y.r) ? 1 : x.r.id < y.r.id ? -1 : 1)).map(({ r }) => line(r) + '\n').join('') }),
  day: (recs) => group(recs, ({ r }) => `records/${dayOf(r)}.jsonl`),
  writer: (recs) => group(recs, ({ w }) => `records/${w}.jsonl`),
  entry: (recs) => Object.fromEntries(recs.map(({ r }) => { const h = shard(r.id); return [`records/${h.slice(0, 2)}/${h}.json`, line(r) + '\n']; })),
};
function group(recs, pathOf) {
  const out = {};
  for (const x of recs) { const p = pathOf(x); out[p] = (out[p] ?? '') + line(x.r) + '\n'; }
  return out;
}
function materialize(dir, layout, recs) {
  for (const [p, c] of Object.entries(LAYOUTS[layout](recs))) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
}

// Every record line in the working tree; lines that are not JSON (conflict markers) are counted.
function readTree(dir) {
  const recs = []; let bad = 0;
  const visit = (p) => {
    for (const n of readdirSync(p)) {
      if (n === '.git' || n === 'types.jsonl' || n === '.gitattributes') continue;
      const q = join(p, n);
      if (statSync(q).isDirectory()) visit(q);
      else for (const l of readFileSync(q, 'utf8').split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { bad++; } }
    }
  };
  visit(dir);
  return { recs, bad };
}
function score(tree, expected) {
  const seen = new Map(); let dupes = 0;
  for (const r of tree.recs) {
    const c = line(r);
    if (!seen.has(r.id)) seen.set(r.id, new Set());
    if (seen.get(r.id).has(c)) dupes++; else seen.get(r.id).add(c);
  }
  const lost = [...expected].filter((id) => !seen.has(id)).length;
  const contradictions = [...seen.values()].filter((s) => s.size > 1).length;
  return { lost, dupes, contradictions, bad: tree.bad };
}

// ---------- run ----------
const out = [];
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
for (const layout of Object.keys(LAYOUTS)) {
  const origin = join(scratch, `${layout}-origin`);
  mkdirSync(origin);
  must(origin, 'init', '-q');
  writeFileSync(join(origin, 'types.jsonl'), header.join('\n') + '\n');
  materialize(origin, layout, base.map((r) => ({ r, w: 'origin' })));
  must(origin, 'add', '-A'); must(origin, 'commit', '-qm', 'base');
  const baseRecs = base.map((r) => ({ r, w: 'origin' }));

  for (const sc of ['S1', 'S2', 'S3', 'S4']) {
    const { A, B } = scenario(sc);
    const expected = new Set([...base, ...A, ...B].map((r) => r.id));
    for (const strategy of ['merge', 'rebase']) {
      const dir = join(scratch, `${layout}-${sc}-${strategy}`);
      must(scratch, 'clone', '-q', origin, dir);
      must(dir, 'checkout', '-qb', 'b');
      materialize(dir, layout, [...baseRecs, ...B.map((r) => ({ r, w: 'b' }))]);
      must(dir, 'add', '-A'); must(dir, 'commit', '-qm', 'B');
      must(dir, 'checkout', '-q', 'main'); must(dir, 'checkout', '-qb', 'a');
      materialize(dir, layout, [...baseRecs, ...A.map((r) => ({ r, w: 'a' }))]);
      must(dir, 'add', '-A'); must(dir, 'commit', '-qm', 'A');
      const [added, deleted, files] = must(dir, 'diff', '--numstat', 'main', 'a').trim().split('\n').filter(Boolean)
        .reduce(([ad, de, f], l) => { const [x, y] = l.split('\t'); return [ad + Number(x), de + Number(y), f + 1]; }, [0, 0, 0]);
      const r = strategy === 'merge' ? git(dir, 'merge', '--no-edit', 'b') : git(dir, 'rebase', 'b');
      const row = { layout, sc, strategy, diffA: `+${added} -${deleted} in ${files} file(s)` };
      if (r.code === 0) {
        Object.assign(row, { conflict: false }, score(readTree(dir), expected));
      } else {
        const unmerged = must(dir, 'diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean);
        row.conflict = `${unmerged.length} file(s)`;
        for (const side of ['ours', 'theirs']) {
          git(dir, 'checkout', `--${side}`, '--', ...unmerged);
          const s = score(readTree(dir), expected);
          row[`lost_if_${side}`] = s.lost;
        }
      }
      out.push(row);
      console.log(JSON.stringify(row));
    }
  }

  // W: uncommitted local records, then an upstream change arrives.
  const bare = join(scratch, `${layout}-bare.git`);
  must(scratch, 'clone', '-q', '--bare', origin, bare);
  const up = join(scratch, `${layout}-W-up`);
  must(scratch, 'clone', '-q', bare, up);
  const { A, B } = scenario('S1');
  materialize(up, layout, [...baseRecs, ...B.map((r) => ({ r, w: 'b' }))]);
  must(up, 'add', '-A'); must(up, 'commit', '-qm', 'upstream B'); must(up, 'push', '-q', 'origin', 'main');
  const expected = new Set([...base, ...A, ...B].map((r) => r.id));
  for (const [w, cmds] of [['W1 pull', [['pull', '-q', '--no-rebase']]], ['W2 stash+pull+pop', [['stash', '-q'], ['pull', '-q', '--no-rebase'], ['stash', 'pop', '-q']]],
    ['W3 pull --rebase --autostash', [['pull', '-q', '--rebase', '--autostash']]]]) {
    const dir = join(scratch, `${layout}-${w.split(' ')[0]}`);
    must(scratch, 'clone', '-q', bare, dir);
    must(dir, 'reset', '-q', '--hard', 'HEAD~1'); // before upstream B
    materialize(dir, layout, [...baseRecs, ...A.map((r) => ({ r, w: 'a' }))]);
    const codes = cmds.map((c) => git(dir, ...c));
    const failed = codes.find((c) => c.code !== 0);
    const tree = readTree(dir);
    const s = score(tree, expected);
    // `lost` above also counts upstream records a refused pull never brought in; the clobber
    // question is whether the LOCAL uncommitted records are still in the working tree.
    const present = new Set(tree.recs.map((x) => x.id));
    s.lostLocal = A.filter((x) => !present.has(x.id)).length;
    const stashLeft = must(dir, 'stash', 'list').trim().split('\n').filter(Boolean).length;
    const row = { layout, sc: w, exit: failed ? failed.out.trim().split('\n')[0].slice(0, 110) : 'ok', ...s, stashLeft };
    out.push(row);
    console.log(JSON.stringify(row));
  }

  // P9: scan every record and filter by type
  const t0 = performance.now();
  const tree = readTree(origin);
  const n = tree.recs.filter((r) => r.kind === 'entry' && r.type_name === 'verification_run').length;
  console.log(JSON.stringify({ layout, scan: `${tree.recs.length} records, ${n} verification_run, ${(performance.now() - t0).toFixed(0)} ms` }));
}
writeFileSync(join(scratch, 'results.json'), JSON.stringify(out, null, 1));
