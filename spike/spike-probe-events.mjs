// Targeted probe: for each event field the adapter will derive from, report
// WHICH record type carries it, which sibling keys are present, and the
// field's structural signature.
//
// Emits structure and categorical enumerations only. Free-text fields
// (userFeedback, command, stdout) are counted, never printed.

import { streamCorpus } from './lib/reader.mjs';

const TARGETS = [
  'userFeedback',
  'toolDenialKind',
  'compactMetadata',
  'attributionSkill',
  'attributionAgent',
];

const stats = new Map(
  TARGETS.map((t) => [t, { count: 0, recordTypes: new Map(), siblingKeys: new Map(), byProject: new Map(), dates: [] }]),
);

// Categorical enumerations worth seeing (labels, not user prose).
const enumValues = new Map([
  ['toolDenialKind', new Map()],
  ['attributionSkill', new Map()],
]);

const projectOf = (path) => {
  const m = path.match(/projects[\\/]([^\\/]+)[\\/]/);
  return m ? m[1] : 'unknown';
};

await streamCorpus((record, _line, path) => {
  for (const target of TARGETS) {
    if (!(target in record)) continue;
    const s = stats.get(target);
    s.count += 1;
    const type = typeof record.type === 'string' ? record.type : '(none)';
    s.recordTypes.set(type, (s.recordTypes.get(type) ?? 0) + 1);
    for (const key of Object.keys(record)) {
      s.siblingKeys.set(key, (s.siblingKeys.get(key) ?? 0) + 1);
    }
    const project = projectOf(path);
    s.byProject.set(project, (s.byProject.get(project) ?? 0) + 1);
    if (typeof record.timestamp === 'string') s.dates.push(record.timestamp.slice(0, 10));

    const enums = enumValues.get(target);
    if (enums && typeof record[target] === 'string') {
      enums.set(record[target], (enums.get(record[target]) ?? 0) + 1);
    }
  }
});

for (const target of TARGETS) {
  const s = stats.get(target);
  console.log(`\n=== ${target}: ${s.count} records ===`);
  if (s.count === 0) continue;
  console.log(`  record.type:   ${[...s.recordTypes].map(([k, v]) => `${k}(${v})`).join(' | ')}`);
  const dates = s.dates.sort();
  if (dates.length) console.log(`  date range:    ${dates[0]} .. ${dates[dates.length - 1]}  (n=${dates.length})`);
  console.log(`  top projects:  ${[...s.byProject].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}(${v})`).join(' | ')}`);
  console.log(`  sibling keys:  ${[...s.siblingKeys].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}(${v})`).join(' | ')}`);
  const enums = enumValues.get(target);
  if (enums) {
    console.log(`  distinct values (categorical):`);
    for (const [value, n] of [...enums].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(n).padStart(6)}  ${value}`);
    }
  }
}
