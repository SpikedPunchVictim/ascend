// asc-x1gw (throwaway). Bytes per JSONL line by record type, projected to a file of CAP records.
//   node spike/git-layout/linesize.mjs <export.jsonl> [cap=5000]
import { readFileSync } from 'node:fs';

const [path, capArg] = process.argv.slice(2);
const cap = Number(capArg ?? 5000);
const byType = new Map();
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  const t = r.kind === 'annotation' ? `annotation:${r.scheme}` : (r.kind === 'entry' ? r.type_name : r.kind);
  const b = Buffer.byteLength(line) + 1;
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t).push(b);
}
const mb = (x) => (x / 1e6).toFixed(1);
const rows = [...byType].map(([t, s]) => {
  s.sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { t, n: s.length, avg: Math.round(avg), p99: s[Math.min(s.length - 1, Math.floor(s.length * 0.99))], max: s.at(-1) };
}).sort((a, b) => b.avg - a.avg);
console.log(`type\tn\tavgB\tp99B\tmaxB\tMB@${cap}avg\tMB@${cap}max`);
for (const r of rows) console.log(`${r.t}\t${r.n}\t${r.avg}\t${r.p99}\t${r.max}\t${mb(r.avg * cap)}\t${mb(r.max * cap)}`);
const all = rows.flatMap((r) => byType.get(r.t));
console.log(`lines ${all.length}; over ${1e8 / cap} B: ${all.filter((b) => b > 1e8 / cap).length}; over ${5e7 / cap} B: ${all.filter((b) => b > 5e7 / cap).length}; largest ${Math.max(...all)} B`);
