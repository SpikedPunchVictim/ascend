// asc-6ola.15: retire verification_run derivation-2 entries after the v3 re-ingest.
//
//   node spike/verdict/retire-v2.mjs <old-rule-worktree>            # classify; invalidate in a rollback
//   node spike/verdict/retire-v2.mjs <old-rule-worktree> --write    # the same, in one transaction
//
// <old-rule-worktree> is a checkout of the commit before the v3 rule, with its adapter built. Both
// rules derive the live corpus, so a v2 row with no v3 sibling is classified by what changed
// rather than guessed at.
//
// Classes, following the v1 -> v2 precedent (dogfood/0012):
//   - a v3 sibling exists (same event key): `superseded`, linked to it;
//   - no sibling, the old rule still derives it and the new one does not, and the event is
//     `prettier --write`: `wrong_value`;
//   - the same, but the event is another check: its transition came from a `prettier --write`
//     earlier in its file's verdict chain and no longer reproduces: `wrong_value`;
//   - no sibling, transcript gone: left alone -- nothing can re-derive it;
//   - anything else: unexpected, so the script refuses.
import { openStore, recordInvalidation, withRollback, withTransaction } from '../../packages/store/dist/index.js';
import { createDeriver, streamCorpus } from '../../packages/adapter-claude-code/dist/index.js';

const write = process.argv.includes('--write');
const oldRule = await import(`${process.argv[2]}/packages/adapter-claude-code/dist/index.js`);
const derivedKeys = async (make) => {
  const deriver = make();
  const keys = new Set();
  const take = (entries) => { for (const e of entries) if (e.type === 'verification_run') keys.add(e.key); };
  await streamCorpus((record, file) => take(deriver.accept(record, file)));
  take(deriver.drain());
  return keys;
};
const oldKeys = await derivedKeys(oldRule.createDeriver);
const newKeys = await derivedKeys(createDeriver);
const store = openStore({ dir: '.ascend', ascendVersion: '0.0.0' });
const rows = (sql) => store.db.prepare(sql).all();
const PREFIX = 'derived:claude-code:verification_run@';
const keyOf = (id) => id.slice(id.indexOf(':', PREFIX.length) + 1);

const v2 = rows(`select e.id, v.runner, v.verdict, v.previous_verdict from entries e join v_verification_run_v2 v on v.id = e.id
  where e.id like '${PREFIX}2:%' and v.invalidated is null`);
const v3 = new Map(rows(`select id, runner, verdict, previous_verdict from v_verification_run_v2 where id like '${PREFIX}3:%'`).map((r) => [keyOf(r.id), r]));

// The key is `<session>:<tool call id>`, with `#N` when a sweep repeated it; ids are not all `toolu_`.
const tool = (id) => id.slice(id.lastIndexOf(':') + 1).replace(/#\d+$/, '');
const want = new Set(v2.filter((r) => !v3.has(keyOf(r.id))).map((r) => tool(r.id)));
const command = new Map();
await streamCorpus((rec) => {
  for (const b of rec.message?.content ?? []) if (b?.type === 'tool_use' && want.has(b.id)) command.set(b.id, String(b.input?.command ?? ''));
}, { includeEphemeral: true });

const WRITE = /(^|\s)(npx\s+|bunx\s+)?prettier\s[^|;&\n]*(--write|-w)(\s|$)/;
const plan = [];
const counts = { superseded_same: 0, superseded_changed: 0, wrong_value: 0, chain_changed: 0, transcript_gone: 0, unexpected: 0 };
for (const r of v2) {
  const sib = v3.get(keyOf(r.id));
  if (sib) {
    const same = sib.runner === r.runner && sib.verdict === r.verdict && sib.previous_verdict === r.previous_verdict;
    counts[same ? 'superseded_same' : 'superseded_changed'] += 1;
    plan.push({ entryId: r.id, label: 'superseded', supersededBy: sib.id,
      reason: 'verification_run derivation 3 (asc-6ola.15): prettier counts as a check only in a check mode. Re-derived from the same event; replaced by its v3 sibling.' });
    continue;
  }
  const cmd = command.get(tool(r.id));
  if (cmd === undefined) { counts.transcript_gone += 1; continue; }
  const key = keyOf(r.id);
  if (!oldKeys.has(key) || newKeys.has(key)) {
    counts.unexpected += 1;
    console.log('UNEXPECTED (not a rule difference)', r.id, r.runner);
    continue;
  }
  if (/prettier/.test(r.runner) && WRITE.test(cmd)) {
    counts.wrong_value += 1;
    plan.push({ entryId: r.id, label: 'wrong_value',
      reason: 'Derived from prettier --write, which formats files and checks nothing (asc-6ola.15, dogfood/0015). The v3 rule derives no verification_run for this event.' });
    continue;
  }
  counts.chain_changed += 1;
  plan.push({ entryId: r.id, label: 'wrong_value',
    reason: `Its recorded transition (previous_verdict ${r.previous_verdict}) came from a prettier --write earlier in the same file's verdict chain; under verification_run derivation 3 (asc-6ola.15) the transition does not reproduce and no entry is derived.` });
}
console.log(`v2 open ${v2.length}, v3 ${v3.size}`, JSON.stringify(counts));
if (counts.unexpected > 0) { console.log('refusing: unexpected rows'); process.exit(1); }

const createdAt = new Date().toISOString();
const strike = () => plan.map((p) => recordInvalidation(store.db, { ...p, createdBy: 'claude-opus-5-5', createdAt }).created);
const created = (write ? withTransaction : withRollback)(store.db, strike);
console.log(`${write ? 'wrote' : 'would write'} ${created.filter(Boolean).length} of ${plan.length} invalidation(s)`);
store.close();
