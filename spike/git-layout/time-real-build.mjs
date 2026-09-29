/**
 * One cold `buildIndex`, and nothing else, so `/usr/bin/time -p` sees only the build.
 *
 * EV-32 timed its proxy with `/usr/bin/time -p` and reported a user/sys split (18.58 s of the
 * 40.27 s was `sys`, writing a 206 MB file). Comparing that number to an in-process
 * `process.hrtime` reading compares two different clocks, so this exists to produce the same
 * shape of number for the real path. Throwaway spike.
 *
 *   node spike/git-layout/time-real-build.mjs <flat-corpus.jsonl> <treeRoot> <dbPath>
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { buildIndex, openRecordWriter, parseCorpus } = await import(
  '../../packages/store/dist/index.js'
);

const [corpus, root, db] = process.argv.slice(2);
mkdirSync(join(root, '..'), { recursive: true });
rmSync(root, { recursive: true, force: true });

// Lay the tree out first, outside the timed region only if you move this file -- it is inside
// `/usr/bin/time` either way, so the layout cost is stated rather than hidden.
const writer = openRecordWriter(root);
for (const { line } of parseCorpus(readFileSync(corpus, 'utf8'), corpus)) writer.append(line);

buildIndex(root, db, { now: '2026-09-29T00:00:00.000Z' });
