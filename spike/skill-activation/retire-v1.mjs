// asc-gtnu.17: retire skill_activation rule-1 entries after the rule-2 re-ingest (dogfood/0020).
//
//   node spike/skill-activation/retire-v1.mjs            # classify, then `asc invalidate --dry-run`
//   node spike/skill-activation/retire-v1.mjs --write    # the same, then write
//
// The live store is touched ONLY through `asc` commands: `asc query` to read it and
// `asc invalidate` to annotate it. Nothing here opens `.ascend/`.
//
// Each open rule-1 row is classified by what rule 2 derives from the same transcript:
//   - rule 2 derives the same key:                       superseded, by its @2 sibling;
//   - the run was claimed by a Skill call in its file:   superseded, by that call's @2 entry;
//   - a subagent run with no Skill call of its own:      wrong_value (inherited, never an activation);
//   - its first record is no longer on disk:             left alone, as the only record of it;
//   - anything else:                                     unexpected, and the script refuses.
import { spawnSync } from 'node:child_process';
import { createDeriver, streamCorpus } from '../../packages/adapter-claude-code/dist/index.js';

const BIN = new URL('../../packages/cli/dist/bin.js', import.meta.url).pathname;
const write = process.argv.includes('--write');
const V1 = 'derived:claude-code:skill_activation:';
const V2 = 'derived:claude-code:skill_activation@2:';

function asc(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`asc ${args.slice(0, 2).join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}
const query = (sql) => JSON.parse(asc(['query', '--json', sql])).rows;

const v1 = query(
  `SELECT id, skill FROM v_skill_activation_v1 WHERE id LIKE '${V1}%' AND invalidated IS NULL`,
);
const v2ids = new Set(query(`SELECT id FROM entries WHERE id LIKE '${V2}%'`).map((r) => r.id));

// One pass over the corpus under rule 2, remembering which file each record uuid and each Skill
// call came from, and which @2 entries each file produced, in order.
const uuidFile = new Map();
const callFile = new Map();
const kindOf = new Map();
const byFile = new Map();
const deriver = createDeriver();
let current;
const take = (entries) => {
  for (const e of entries) {
    if (e.type !== 'skill_activation') continue;
    const tool = e.key.slice(e.key.indexOf(':') + 1);
    const file = callFile.get(tool) ?? uuidFile.get(tool) ?? current;
    const list = byFile.get(file) ?? [];
    list.push({ key: e.key, skill: e.properties.skill, call: callFile.has(tool) });
    byFile.set(file, list);
  }
};
await streamCorpus((record, file) => {
  current = file.path;
  kindOf.set(file.path, file.kind);
  if (typeof record.uuid === 'string') uuidFile.set(record.uuid, file.path);
  for (const block of record.message?.content ?? []) {
    if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.id === 'string') {
      callFile.set(block.id, file.path);
    }
  }
  take(deriver.accept(record, file));
});
take(deriver.drain());

const redacted = (name) => name.startsWith('<');
const used = new Set();
const actions = [];
const counts = { superseded_same: 0, superseded_by_call: 0, inherited: 0, transcript_gone: 0, unexpected: 0 };
for (const row of v1) {
  const key = row.id.slice(V1.length);
  const sibling = `${V2}${key}`;
  if (v2ids.has(sibling)) {
    counts.superseded_same += 1;
    actions.push({ id: row.id, label: 'superseded', by: sibling });
    continue;
  }
  const uuid = key.slice(key.indexOf(':') + 1).replace(/#\d+$/, '');
  const file = uuidFile.get(uuid);
  if (file === undefined) {
    counts.transcript_gone += 1;
    continue;
  }
  const call = (byFile.get(file) ?? []).find(
    (e) => e.call && !used.has(e.key) && (e.skill === row.skill || redacted(row.skill)) && v2ids.has(`${V2}${e.key}`),
  );
  if (call !== undefined) {
    used.add(call.key);
    counts.superseded_by_call += 1;
    actions.push({ id: row.id, label: 'superseded', by: `${V2}${call.key}` });
  } else if (kindOf.get(file) === 'subagent') {
    counts.inherited += 1;
    actions.push({ id: row.id, label: 'wrong_value' });
  } else {
    counts.unexpected += 1;
    console.error(`unexpected: ${row.id} (${row.skill})`);
  }
}
console.log(`rule-1 open ${String(v1.length)}, rule-2 ${String(v2ids.size)} ${JSON.stringify(counts)}`);
if (counts.unexpected > 0) {
  console.error('REFUSING: rows outside every known class; nothing written.');
  process.exit(1);
}

const REASON = {
  superseded:
    'skill_activation rule 2 (asc-gtnu.17, dogfood/0020): the same activation, re-derived under the per-request rule.',
  wrong_value:
    'skill_activation rule 2 (asc-gtnu.17, dogfood/0020): a subagent run that inherited its parent attributionSkill; the activation is the parent’s, so this row is not one.',
};
const run = (args) => JSON.parse(asc(['invalidate', ...args, '--json', '--actor', 'asc-gtnu.17', ...(write ? [] : ['--dry-run'])]));
let rows = 0;
const wrong = actions.filter((a) => a.label === 'wrong_value').map((a) => a.id);
if (wrong.length > 0) rows += run([...wrong, '--label', 'wrong_value', '--reason', REASON.wrong_value]).rows.length;
for (const a of actions.filter((x) => x.label === 'superseded')) {
  rows += run([a.id, '--label', 'superseded', '--superseded-by', a.by, '--reason', REASON.superseded]).rows.length;
}
console.log(`${write ? 'wrote' : 'dry-run'} ${String(rows)} of ${String(actions.length)} invalidation(s)`);
