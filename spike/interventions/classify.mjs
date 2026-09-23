// asc-6ola.1 (throwaway). One rater's classification of the 33 bd memories under the sealed scheme
// in PREREG.md, and the tallies it produces. The labels are data; the tallies are computed.
//   node spike/interventions/classify.mjs
// check=exists means an enforcing test/guard was found on disk (paths in `where`), 2026-09-23.

const L = (kind, cls, trigger, check, multi, where = '') => ({ kind, cls, trigger, check, multi, where });
const rows = {
  'ascend-store-open-contention':          L('lesson', 'premise-of-limitation', 'none', 'no', false),
  'begin-immediate-does-not-cover-a-pre-read': L('lesson', 'concurrency', 'event', 'exists', true, 'store/test/registry.test.ts'),
  'boundary-package-tsconfig':             L('lesson', 'false-green', 'event', 'exists', true, 'package.json typecheck: tsc -p tsconfig.eslint.json'),
  'brief-cost-curve':                      L('fact'),
  'bug-hunt-2026-09-12-progress':          L('record'),
  'concurrent-open-contention-asc-51t':    L('lesson', 'false-green', 'none', 'exists', true, 'store/test/busy.test.ts'),
  'corpus-counting-rules':                 L('lesson', 'measurement-validity', 'none', 'no', false),
  'derived-type-n-is-a-rule-not-a-reading': L('lesson', 'measurement-validity', 'none', 'possible', false),
  'derived-type-n-is-not-line-count':      L('lesson', 'measurement-validity', 'none', 'no', false),
  'git-hooks-in-this-repo-core-hookspath-in': L('lesson', 'tool-integration', 'event', 'possible', false),
  'invisible-character-hygiene':           L('lesson', 'encoding-terminator', 'event', 'exists', false, 'core/test/purity-enforcement.test.ts'),
  'journal-mode-change-is-not-dependably-busy-governed': L('lesson', 'concurrency', 'event', 'exists', true, 'store/test/busy.test.ts'),
  'kysely-rejected':                       L('record'),
  'mutation-harness-must-distinguish':     L('lesson', 'false-green', 'window', 'possible', true),
  'mutation-harness-stale-dist':           L('lesson', 'stale-build', 'window', 'possible', false),
  'mutation-survivors-point-at-the-fixture': L('lesson', 'false-green', 'window', 'no', false),
  'oclif-entry-point-facts':               L('fact'),
  'oclif-fills-missing-positional-from-stdin': L('lesson', 'false-green', 'event', 'exists', true, 'cli/test/explore.test.ts, query.test.ts (ignoreStdin)'),
  'oclif-flag-parsing':                    L('lesson', 'framework-contract', 'event', 'exists', true, 'cli/test/record.test.ts (dry_run)'),
  'oclif-masks-ascend-pipe-guard':         L('fact'),
  'open-lock-races-in-the-store':          L('record'),
  'pagination-order-key':                  L('fact'),
  'property-name-reservation':             L('fact'),
  'readline-is-not-a-jsonl-reader':        L('lesson', 'encoding-terminator', 'event', 'exists', true, 'adapter-claude-code/test/reader-real-corpus.test.ts'),
  'real-path-not-synthetic-writer':        L('lesson', 'false-green', 'none', 'possible', false),
  'sessionstart-hook-contract':            L('fact'),
  'shell-gotcha-that-produced-a-false-green-in': L('lesson', 'false-green', 'event', 'exists', true, 'cli/test/dev-hooks.test.ts'),
  'sqlite-driver-facts':                   L('fact'),
  'stderr-pipe-truncated-by-process-exit': L('fact'),
  'stdin-pipe-eagain':                     L('lesson', 'false-green', 'event', 'exists', true, 'cli/test/types.test.ts, query.test.ts (delayed producer)'),
  'transaction-tests-must-cover-the-owni': L('lesson', 'false-green', 'none', 'exists', false, 'store/test/views.test.ts (DROP TABLE)'),
  'vitest-cannot-import-node-only-builtins': L('fact'),
  'work-sequencing-2026-09-15':            L('record'),
};

const all = Object.values(rows);
const lessons = all.filter((r) => r.kind === 'lesson');
const pct = (a, b) => `${a}/${b} = ${((100 * a) / b).toFixed(0)}%`;
const count = (xs, f) => xs.filter(f).length;
const tally = (xs, k) => Object.entries(xs.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);

console.log('memories', all.length, 'kinds', JSON.stringify(tally(all, 'kind')));
console.log('I1 not lessons           ', pct(all.length - lessons.length, all.length), '(pred >= 25%)');
console.log('I2 trigger = event       ', pct(count(lessons, (r) => r.trigger === 'event'), lessons.length), '(pred >= 50%)');
console.log('I3 check exists          ', pct(count(lessons, (r) => r.check === 'exists'), lessons.length), '(pred >= 30%)');
console.log('I4 classes               ', JSON.stringify(tally(lessons, 'cls')), '(pred: one class >= 5)');
console.log('I5 needs > 1 intervention', pct(count(lessons, (r) => r.multi), lessons.length), '(pred >= 20%)');
console.log('I6 trigger = none        ', pct(count(lessons, (r) => r.trigger === 'none'), lessons.length), '(pred >= 25%)');
const fg = lessons.filter((r) => r.cls === 'false-green');
console.log('false-green: triggers', JSON.stringify(tally(fg, 'trigger')), 'checks', JSON.stringify(tally(fg, 'check')));
