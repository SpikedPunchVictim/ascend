// Corpus extraction: stream the transcript corpus and persist derived entry
// candidates into a scratch SQLite DB (node:sqlite, built into Node >= 22).
//
// Read-only with respect to ~/.claude/projects. Never writes there.
//
// The five candidate entry types here are exactly those ARCHITECTURE.md names
// as "derived by the adapter in Stage 2", so this is a rehearsal of E5 rather
// than a throwaway invention -- but it is still spike-quality code.

import { DatabaseSync } from 'node:sqlite';
import { streamCorpus } from './reader.mjs';

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  session_id    TEXT,
  project       TEXT,
  cwd           TEXT,
  git_branch    TEXT,
  recorded_at   TEXT,
  tool_name     TEXT,
  denial_kind   TEXT,
  skill_name    TEXT,
  agent_name    TEXT,
  model         TEXT,
  is_error      INTEGER,          -- NULL when genuinely unknown
  duration_ms   INTEGER,
  pre_tokens    INTEGER,
  post_tokens   INTEGER,
  trigger       TEXT,
  has_stdout    INTEGER,
  has_stderr    INTEGER,
  command_head  TEXT,
  source        TEXT NOT NULL,
  UNIQUE (kind, session_id, recorded_at, denial_kind, skill_name, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_kind_tool ON events(kind, tool_name);
`;

const projectOf = (path) => {
  const m = path.match(/projects[\\/]([^\\/]+)[\\/]/);
  return m ? m[1] : 'unknown';
};

/** Reduce a shell command to its leading verb for grouping. Not the full text. */
function commandHead(command) {
  if (typeof command !== 'string') return null;
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (!first) return null;
  return first.split('/').pop().slice(0, 24);
}

export async function buildCorpus({ dbPath, root, onProgress } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(DDL);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      kind, session_id, project, cwd, git_branch, recorded_at, tool_name,
      denial_kind, skill_name, agent_name, model, is_error, duration_ms,
      pre_tokens, post_tokens, trigger, has_stdout, has_stderr, command_head, source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Per-session state, reset per file. tool_use id -> tool name, and the
  // session's git branch (denial records do not carry it themselves).
  let toolNames = new Map();
  let sessionBranch = null;
  let currentFile = null;
  let inserted = 0;

  const rows = (record, path) => {
    const out = [];
    const base = {
      session_id: record.sessionId ?? record.session_id ?? null,
      project: projectOf(path),
      cwd: record.cwd ?? null,
      git_branch: record.gitBranch ?? sessionBranch ?? null,
      recorded_at: record.timestamp ?? null,
      source: 'derived:claude-code',
    };

    // tool-denial: a user record carrying toolDenialKind.
    if (typeof record.toolDenialKind === 'string') {
      const toolUseId = record.message?.content?.[0]?.tool_use_id ?? null;
      out.push({
        ...base,
        kind: 'tool-denial',
        tool_name: toolUseId ? (toolNames.get(toolUseId) ?? null) : null,
        denial_kind: record.toolDenialKind,
      });
    }

    // user-correction: a user record carrying userFeedback.
    if (typeof record.userFeedback === 'string') {
      out.push({ ...base, kind: 'user-correction', tool_name: null });
    }

    // context-compaction: a system record carrying compactMetadata.
    if (record.compactMetadata && typeof record.compactMetadata === 'object') {
      const m = record.compactMetadata;
      out.push({
        ...base,
        kind: 'context-compaction',
        duration_ms: numOrNull(m.durationMs),
        pre_tokens: numOrNull(m.preTokens),
        post_tokens: numOrNull(m.postTokens),
        trigger: typeof m.trigger === 'string' ? m.trigger : null,
      });
    }

    // skill-activation: an assistant record carrying attributionSkill.
    if (typeof record.attributionSkill === 'string') {
      out.push({
        ...base,
        kind: 'skill-activation',
        skill_name: record.attributionSkill,
        agent_name: typeof record.attributionAgent === 'string' ? record.attributionAgent : null,
        model: typeof record.message?.model === 'string' ? record.message.model : null,
      });
    }

    // verification-run: a user record whose toolUseResult is a shell result.
    const tur = record.toolUseResult;
    if (tur && typeof tur === 'object' && ('stdout' in tur || 'stderr' in tur)) {
      const toolUseId = record.message?.content?.[0]?.tool_use_id ?? null;
      out.push({
        ...base,
        kind: 'verification-run',
        tool_name: toolUseId ? (toolNames.get(toolUseId) ?? null) : null,
        is_error: typeof tur.interrupted === 'boolean' ? null : null,
        has_stdout: tur.stdout ? 1 : 0,
        has_stderr: tur.stderr ? 1 : 0,
        command_head: null,
      });
    }

    return out;
  };

  db.exec('BEGIN');
  const totals = await streamCorpus(
    (record, _line, path) => {
      if (path !== currentFile) {
        currentFile = path;
        toolNames = new Map();
        sessionBranch = null;
      }
      if (typeof record.gitBranch === 'string') sessionBranch = record.gitBranch;

      // Record tool_use id -> name for later denial/result joins.
      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.id === 'string') {
            toolNames.set(block.id, typeof block.name === 'string' ? block.name : null);
          }
        }
      }

      for (const row of rows(record, path)) {
        insert.run(
          row.kind, row.session_id, row.project, row.cwd, row.git_branch, row.recorded_at,
          row.tool_name ?? null, row.denial_kind ?? null, row.skill_name ?? null,
          row.agent_name ?? null, row.model ?? null, row.is_error ?? null,
          row.duration_ms ?? null, row.pre_tokens ?? null, row.post_tokens ?? null,
          row.trigger ?? null, row.has_stdout ?? null, row.has_stderr ?? null,
          row.command_head ?? null, row.source,
        );
        inserted += 1;
      }
      if (onProgress && inserted % 25000 === 0) onProgress(inserted);
    },
    { root },
  );
  db.exec('COMMIT');

  const summary = db.prepare(`
    SELECT kind,
           COUNT(*) AS n,
           MIN(recorded_at) AS first_at,
           MAX(recorded_at) AS last_at,
           COUNT(DISTINCT project) AS projects,
           COUNT(DISTINCT session_id) AS sessions
    FROM events GROUP BY kind ORDER BY n DESC
  `).all();

  db.close();
  return { totals, inserted, summary };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
