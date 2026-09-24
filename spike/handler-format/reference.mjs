// Spike asc-6ola.5 (throwaway). The reference: spike/replay's four JS handlers, verbatim in
// logic, including its window (count `tool.use.end` events, stop at the 5th), plus the fifth
// handler (Q3) written in plain JS.
import { basename } from 'node:path';

const BEAD_ID = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/;
const STATUS = /\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)/i;
const norm = (s) => s.toLowerCase().replace(/\s+/g, '_');
export function tokens(p) {
  return String(p).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 4 && !/^(src|dist|test|users|projects|head|type|json|jsonl)$/.test(t));
}

export const handlers = {
  'bead-close': {
    on: 'command.run',
    where: (e) => e.ok && e.head === 'bd' && e.argv[1] === 'close',
    emit: (e) => e.argv.slice(2).filter((a) => BEAD_ID.test(a)).map((id) => ({ stage: id, to_status: 'complete' })),
  },
  'bead-claim': {
    on: 'command.run',
    where: (e) => e.ok && e.head === 'bd' && e.argv[1] === 'update' &&
      (e.argv.includes('--claim') || e.argv.some((a) => /^--status[= ]?in_progress$/.test(a)) ||
        (e.argv.includes('--status') && e.argv[e.argv.indexOf('--status') + 1] === 'in_progress')),
    emit: (e) => e.argv.slice(2).filter((a) => BEAD_ID.test(a)).map((id) => ({ stage: id, to_status: 'in_progress' })),
  },
  'plan-status-edit': {
    on: 'file.changed',
    where: (e) => /IMPLEMENTATION_PLAN\.md$|PLAN\.md$/i.test(e.path) && STATUS.test(e.after) &&
      (e.before.match(STATUS)?.[1] ?? '') !== e.after.match(STATUS)[1],
    emit: (e) => [{ stage: basename(e.path), from_status: e.before.match(STATUS)?.[1] && norm(e.before.match(STATUS)[1]),
      to_status: norm(e.after.match(STATUS)[1]) }],
  },
  'search-miss': {
    on: 'search.run',
    window: 5,
    where: (e) => e.hits === 0,
    emit: (e, following) => {
      const terms = new Set(tokens(e.pattern));
      const hit = following.find((f) => f.kind === 'search.run' && f.hits > 0 && tokens(f.pattern).some((t) => terms.has(t)));
      return hit ? [{ pattern: e.pattern, returned: '0', corrected_by: hit.pattern, search_tool: e.via }] : [];
    },
  },
  // Q3: written after the four, not designed into either candidate.
  'repeat-failure': {
    on: 'command.run',
    window: 10,
    where: (e) => e.ok === false,
    emit: (e, following) => {
      const n = following.filter((f) => f.kind === 'command.run' && f.head === e.head && f.ok === false && f.call > e.call).length;
      return n >= 1 ? [{ command: e.head, failed_again: String(n) }] : [];
    },
  },
};

/**
 * Rows `{handler, file, seq, ...fields}`, undefined fields dropped. Window rules:
 *   'ends'    spike/replay's: stop at the Nth following `tool.use.end`.
 *   'literal' PREREG as written: every later event whose call is at most trigger.call + N.
 *   'calls'   what both candidates implement: every later event whose call is in
 *             [trigger.call, trigger.call + N]. Differs from 'literal' only when an event of an
 *             EARLIER call arrives after the trigger; run.mjs counts how often that changes a row.
 */
export function runReference(files, { rule = 'ends', names = Object.keys(handlers) } = {}) {
  const rows = [];
  for (const { events } of files) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      for (const name of names) {
        const h = handlers[name];
        if (h.on !== e.kind || !h.where(e)) continue;
        const following = [];
        if (h.window && rule !== 'ends') {
          const lo = rule === 'calls' ? e.call : -Infinity;
          for (let j = i + 1; j < events.length; j++) {
            const c = events[j].call;
            if (c >= lo && c <= e.call + h.window) following.push(events[j]);
          }
        } else if (h.window) {
          for (let j = i + 1, calls = 0; j < events.length && calls < h.window; j++) {
            if (events[j].kind === 'tool.use.end') calls++;
            following.push(events[j]);
          }
        }
        for (const out of h.emit(e, following)) rows.push(clean({ handler: name, file: e.file, seq: e.seq, ...out }));
      }
    }
  }
  return rows;
}

export function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}
