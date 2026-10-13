#!/usr/bin/env node
// SessionStart hook: the beads rules and an INDEX of the persistent memories, under a byte cap.
//
// Replaces `bd prime --hook-json`, whose output prints every memory in full. Measured 2026-10-13
// (docs/evidence/EV-54.md): that output was about 48KB, the harness does not inline hook output
// that large, and in 309 deliveries the model received the first 2KB and a file path instead.
// Eight tool calls ever opened one of those files, so the memories were written and not read.
//
// The cap is the one `packages/cli/src/brief-text.ts` already uses for ascend's own brief
// (`BRIEF_CAP_BYTES`), for the same measured reason; it is restated here because this file must
// run with no build. The unit is BYTES, which is what the harness counts.
//
// Plain stdout, not the `hookSpecificOutput` JSON envelope: both are accepted, and plain text is
// what the other SessionStart hook in this repository prints (bd memory `sessionstart-hook-contract`).
//
// A failure prints one line saying so. It never exits non-zero and never prints nothing, because
// a session that silently has no memories looks the same as a project that has none.
import { execFileSync } from 'node:child_process';

const CAP_BYTES = 8_000;
const MAX_SUMMARY = 160;
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const bd = (...args) =>
  execFileSync('bd', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 20_000,
  });

function coreRules() {
  try {
    const m = /^## Core Rules\n([\s\S]*?)(?=^## )/m.exec(bd('prime'));
    if (m) return m[1].trim();
  } catch {
    // Fall through: the rules are a convenience here, the index is the point.
  }
  return '- Use `bd` for ALL task tracking. Run `bd prime` for the full rules.';
}

function cut(text, width) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width).trimEnd()}...`;
}

function render(memories, rules, width, shown) {
  const keys = Object.keys(memories);
  const lines = keys
    .slice(0, shown)
    .map((k) => (width > 0 ? `- ${k}: ${cut(memories[k], width)}` : `- ${k}`));
  const hidden = keys.length - shown;
  if (hidden > 0) lines.push(`- (+${hidden} more not listed: run \`bd memories\`)`);
  return [
    '# Beads',
    '',
    rules,
    '- Command flags: `bd <command> --help`. Full reference: `bd prime` (large).',
    '',
    `## Persistent memories (${keys.length}): INDEX ONLY`,
    '',
    'Each line below is the START of a memory, cut short. The memory itself holds the measured',
    'facts. Before you act on anything a key names, run `bd recall <key>` and read all of it.',
    'Search with `bd memories <keyword>`. Store with `bd remember --key <key> "text"`.',
    '',
    ...lines,
    '',
  ].join('\n');
}

try {
  // The JSON carries its own bookkeeping (`schema_version`) beside the memories; a memory is text.
  const memories = Object.fromEntries(
    Object.entries(JSON.parse(bd('memories', '--json'))).filter(([, v]) => typeof v === 'string'),
  );
  const rules = coreRules();
  const count = Object.keys(memories).length;
  let out = '';
  // Shrink the summaries first, and drop keys only when bare keys alone do not fit.
  let shown = count;
  for (let width = MAX_SUMMARY; ; width -= 10) {
    out = render(memories, rules, Math.max(width, 0), shown);
    if (bytes(out) <= CAP_BYTES) break;
    if (width <= 0) {
      if (shown === 0) break;
      shown -= 1;
    }
  }
  process.stdout.write(out);
} catch (error) {
  const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
  process.stdout.write(
    `[beads] The memory index could not be built (${why}). This project has persistent memories: run \`bd memories\` before relying on what you remember.\n`,
  );
}
