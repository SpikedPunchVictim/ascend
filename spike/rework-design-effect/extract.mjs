// asc-lspj (throwaway): the trigger rows and the raw facts the join needs.
//
// The handler replay keeps the unit key and the argv, and drops the two things EV-61's join
// reads -- the call's `cwd` and the tool result's text. This streams the same corpus through the
// same normalizer and keeps both, keyed to the unit the normalizer assigns.
//
// Read-only: it only ever reads the transcripts.
//
//   node spike/rework-design-effect/extract.mjs > spike/rework-design-effect/out/triggers.jsonl

import { createNormalizer, streamCorpus, defaultTranscriptRoot } from '../../packages/adapter-claude-code/dist/index.js';
import { unitKey } from '../../packages/cli/dist/handler-replay.js';

const normalizer = createNormalizer();

/** One entry per Bash tool_use seen, for pairing with the later tool_result. */
const uses = new Map(); // `${rawSessionId}\u0000${toolUseId}` -> { command, cwd, startTs }
const triggers = [];
const horizon = { events: 0, first_ts: undefined, last_ts: undefined };

/** The commit predicate, EV-61's: a `command.run` segment whose head is `git` and whose argv holds `commit`. */
const isCommitSegment = (event) =>
  event.kind === 'command.run' &&
  event.head === 'git' &&
  Array.isArray(event.argv) &&
  event.argv.includes('commit');

const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
};

const totals = await streamCorpus(
  (record, file) => {
    const message = record.message;
    const rawSession = typeof record.sessionId === 'string' ? record.sessionId : '';
    if (message !== null && typeof message === 'object' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && block.name === 'Bash' && block.input !== null && typeof block.input === 'object') {
          uses.set(`${rawSession}\u0000${block.id}`, {
            command: typeof block.input.command === 'string' ? block.input.command : '',
            cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
            startTs: typeof record.timestamp === 'string' ? record.timestamp : undefined,
          });
        } else if (block.type === 'tool_result') {
          const key = `${rawSession}\u0000${block.tool_use_id}`;
          const use = uses.get(key);
          if (use !== undefined) {
            use.endTs = typeof record.timestamp === 'string' ? record.timestamp : undefined;
            use.endCwd = typeof record.cwd === 'string' ? record.cwd : undefined;
            use.isError = block.is_error === true;
            // Only the git-commit calls can be triggers, and only their result text is large enough
            // to matter; a plain marker keeps memory bounded.
            use.resultMarker = use.command.includes('commit')
              ? resultText(block.content)
              : undefined;
          }
        }
      }
    }
    for (const event of normalizer.accept(record, file)) {
      horizon.events += 1;
      if (typeof event.ts === 'string') {
        if (horizon.first_ts === undefined || event.ts < horizon.first_ts) horizon.first_ts = event.ts;
        if (horizon.last_ts === undefined || event.ts > horizon.last_ts) horizon.last_ts = event.ts;
      }
      if (!isCommitSegment(event)) continue;
      triggers.push({
        unit: unitKey(event.session_id, event.agent_id, event.segment),
        session: event.session_id,
        agent: event.agent_id,
        segment: event.segment,
        seq: event.seq,
        call: event.call,
        id: event.id,
        index: event.index,
        argv: event.argv.join(' '),
        ts: typeof event.ts === 'string' ? event.ts : undefined,
        is_error: event.is_error,
        raw_session: rawSession,
      });
    }
  },
  { root: defaultTranscriptRoot(), includeEphemeral: false },
);

for (const event of normalizer.drain()) {
  horizon.events += 1;
  if (!isCommitSegment(event)) continue;
  triggers.push({
    unit: unitKey(event.session_id, event.agent_id, event.segment),
    session: event.session_id,
    agent: event.agent_id,
    segment: event.segment,
    seq: event.seq,
    call: event.call,
    id: event.id,
    index: event.index,
    argv: event.argv.join(' '),
    ts: typeof event.ts === 'string' ? event.ts : undefined,
    is_error: event.is_error,
    raw_session: '',
  });
}

const out = triggers.map((trigger) => {
  const use = uses.get(`${trigger.raw_session}\u0000${trigger.id}`) ?? {};
  return {
    ...trigger,
    cwd: use.endCwd ?? use.cwd ?? null,
    command: use.command ?? null,
    start_ts: use.startTs ?? trigger.ts ?? null,
    end_ts: use.endTs ?? null,
    call_error: use.isError === true,
    result: use.resultMarker ?? null,
  };
});

for (const row of out) process.stdout.write(`${JSON.stringify(row)}\n`);
process.stderr.write(
  `\ntriggers ${out.length}\nfiles ${totals.files}\nevents ${horizon.events}\n` +
    `first_ts ${horizon.first_ts}\nlast_ts ${horizon.last_ts}\nmalformed ${totals.malformed}\n`,
);
