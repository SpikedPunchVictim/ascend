/**
 * Build the `asc-asq` corpus: every finding a reviewer reported through `ReportFindings`, read
 * from the raw transcripts rather than from a store.
 *
 * WHY THE RAW TRANSCRIPTS AND NOT THE STORE. The store holds the non-ephemeral reviews (157
 * `review_finding` entries on 2026-10-20); the experiment needs a RARE class with enough instances
 * to seed a prompt AND hold some out, and no class in the store's set reaches that. The reported
 * route's findings exist in the transcripts for every project, including the probe projects ingest
 * skips by design, and every one of them carries both `summary` and `failure_scenario`.
 *
 * The corpus is deduplicated by (class, summary), because a session that was resumed writes its
 * findings twice into two transcript files -- 43 of 422 rows are that duplicate.
 *
 *   node spike/asq/extract.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = join(homedir(), '.claude', 'projects');
const OUT = new URL('./corpus.json', import.meta.url);
const raw = [];

for (const project of readdirSync(ROOT)) {
  const dir = join(ROOT, project);
  let names;
  try {
    if (!statSync(dir).isDirectory()) continue;
    names = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    // Split on "\n" rather than readline: readline treats U+2028/U+2029 as line breaks and a
    // transcript is allowed to contain them.
    for (const line of text.split('\n')) {
      if (line === '' || !line.includes('ReportFindings')) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'tool_use' || block?.name !== 'ReportFindings') continue;
        if (!Array.isArray(block.input?.findings)) continue;
        for (const finding of block.input.findings) {
          if (typeof finding?.summary !== 'string' || typeof finding?.failure_scenario !== 'string') continue;
          if (finding.summary === '' || finding.failure_scenario === '') continue;
          raw.push({
            class: finding.category ?? null,
            file: finding.file ?? null,
            line: finding.line ?? null,
            project,
            session: name.replace(/\.jsonl$/, ''),
            summary: finding.summary,
            failure_scenario: finding.failure_scenario,
          });
        }
      }
    }
  }
}

const seen = new Map();
for (const finding of raw) {
  const key = `${finding.class}\u0000${finding.summary}`;
  if (!seen.has(key)) seen.set(key, finding);
}
const findings = [...seen.values()].sort((a, b) => (a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0));
const byClass = {};
for (const f of findings) byClass[f.class] = (byClass[f.class] ?? 0) + 1;

const doc = {
  source: 'ReportFindings tool_use calls in ~/.claude/projects/**/*.jsonl',
  extracted_at: new Date().toISOString(),
  raw_rows: raw.length,
  duplicate_rows_dropped: raw.length - findings.length,
  n: findings.length,
  by_class: byClass,
  sha256: createHash('sha256').update(JSON.stringify(findings)).digest('hex'),
  findings,
};
writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
console.log(JSON.stringify({ n: doc.n, raw_rows: doc.raw_rows, sha256: doc.sha256, by_class: byClass }, null, 1));
