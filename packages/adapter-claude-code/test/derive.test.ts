import { describe, expect, it } from 'vitest';
import { checkRunner, createDeriver, execSegments, type DerivedEntry } from '../src/index.js';
import type { TranscriptFile, TranscriptRecord } from '../src/index.js';

/**
 * The derivation rules, tested against OBJECT LITERALS.
 *
 * Every input here is a plain record built by a helper, not a transcript read from disk. That
 * is the whole reason `derive.ts` takes records rather than a file handle: the decisions that
 * give a corpus its numbers -- what counts as one skill activation, what counts as a verdict
 * change, when a value is absent rather than zero -- are testable in milliseconds without a
 * corpus, and are then driven against the real one unchanged by
 * `derive-real-corpus.test.ts`, because it is the same code.
 *
 * EACH RULE HERE WAS MUTATION-TESTED. The invariant this project holds -- "a check must be
 * shown to FAIL before it is trusted to pass" -- was applied by breaking the corresponding
 * branch in `derive.ts` and confirming a named test went red. The cases that carry the most
 * weight are the ones marked, and each records which mutation killed it:
 *
 *   - the tool join across RECORDS (mutation: read the command from the current record)
 *   - the absent-vs-empty distinction on `discovered_tools` (mutation: emit `[]`)
 *   - the first-FAIL case emitting nothing (mutation: drop the `&& verdict`)
 *   - the per-FILE verdict chain (mutation: hoist `lastVerdict` out of `begin()`)
 *   - heredoc bodies not being commands (mutation: delete the skip)
 */

const FILE: TranscriptFile = {
  path: '/root/-Users-me-app/aaa.jsonl',
  project: '-Users-me-app',
  session: 'aaa',
  kind: 'session',
};

const fileAt = (name: string): TranscriptFile => ({
  path: `/root/-Users-me-app/${name}.jsonl`,
  project: '-Users-me-app',
  session: name,
  kind: 'session',
});

/** A record with a `message.content` block list. */
function record(
  blocks: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): TranscriptRecord {
  return {
    sessionId: 'sess-1',
    uuid: 'uuid-1',
    timestamp: '2026-09-15T10:00:00.000Z',
    message: { content: [...blocks] },
    ...extra,
  };
}

/** An assistant record that invokes a tool. */
const invoke = (id: string, name: string, command?: string): TranscriptRecord =>
  record([
    {
      type: 'tool_use',
      id,
      name,
      ...(command === undefined ? {} : { input: { command } }),
    },
  ]);

/** A user record carrying a tool's result. */
const result = (id: string, isError: boolean): TranscriptRecord =>
  record([{ type: 'tool_result', tool_use_id: id, is_error: isError }]);

/** Drive records through a fresh deriver and return everything, including the drain. */
function derive(records: readonly TranscriptRecord[], file: TranscriptFile = FILE): DerivedEntry[] {
  const deriver = createDeriver();
  const out: DerivedEntry[] = [];
  for (const one of records) out.push(...deriver.accept(one, file));
  out.push(...deriver.drain());
  return out;
}

const ofType = (entries: readonly DerivedEntry[], type: string): DerivedEntry[] =>
  entries.filter((entry) => entry.type === type);

// ---------------------------------------------------------------------------

describe('execSegments and checkRunner', () => {
  it('finds a check at the head of a command', () => {
    expect(checkRunner('pnpm test')).toBe('pnpm test');
  });

  it('strips environment prefixes and `cd` to reach the real head', () => {
    expect(checkRunner('VAR=1 cd /tmp && pnpm test')).toBe('pnpm test');
  });

  it('skips a package manager flag that takes a value', () => {
    // `-w pkg` is a flag and its value; `run` is the verb. Without the skip the
    // verb would be read as the flag's value and the run would be missed.
    expect(checkRunner('npm -w packages/core run test')).toBe('npm run test');
  });

  it('LIMITATION: a flag placed AFTER `run` defeats the skip', () => {
    // `npm run -w pkg test` is valid npm and is NOT recognized: the skip looks
    // for flags before the `run`, then reads the next token as the script name.
    // Pinned as a test so the gap is a known limitation rather than a surprise.
    //
    // NOT fixed, and the reason is measured rather than assumed: across the whole
    // corpus's 72,014 Bash commands, ZERO place a flag after `run`. Changing the
    // rule for zero measured impact buys an untested branch, and the rule is the
    // least certain thing in this file already.
    expect(checkRunner('npm run -w packages/core test')).toBeUndefined();
  });

  it('recognizes a bare runner', () => {
    expect(checkRunner('vitest run --reporter=dot')).toBe('vitest');
  });

  it('recognizes a cargo sub-verb', () => {
    expect(checkRunner('cargo test --all')).toBe('cargo test');
  });

  it('does NOT count a token that only appears as an argument', () => {
    // The distinction the whole function exists for: this command echoes the words.
    expect(checkRunner('echo "pnpm test"')).toBeUndefined();
    expect(checkRunner('grep -r "cargo test" .')).toBeUndefined();
  });

  it('does not treat a bare `node` probe as a check', () => {
    expect(checkRunner('node -e "console.log(1)"')).toBeUndefined();
  });

  it('never returns a label longer than 60 characters', () => {
    // The label is bounded BY CONSTRUCTION -- a known head plus at most one
    // known verb -- so the `slice(0, 60)` in `checkRunner` is belt-and-braces
    // rather than a reachable path. Asserting the bound over a spread of real
    // shapes is the honest version of that test; a command long enough to
    // actually trip the slice cannot be built out of the recognized heads.
    const commands = [
      `pnpm test ${'x'.repeat(500)}`,
      `npm run ${'y'.repeat(500)}`,
      `npx ${'z'.repeat(500)}`,
      `cargo test ${'w'.repeat(500)}`,
      `cat > f <<'EOF'\n${'pnpm test\n'.repeat(100)}EOF`,
    ];
    for (const command of commands) {
      const label = checkRunner(command);
      if (label !== undefined) expect(label.length).toBeLessThanOrEqual(60);
    }
  });

  it('matches only EXACT verbs, so an unrecognized script is not a check', () => {
    // `test:unit` is in the verb set because the corpus runs it 746 times, but
    // the match is by exact name rather than by prefix -- a prefix rule would
    // swallow every bespoke script whose name starts with `test`.
    expect(checkRunner('npm run test:unit')).toBe('npm run test:unit');
    expect(checkRunner('npm run typecheck:watch')).toBeUndefined();
    expect(checkRunner('npm run test:e2e:headed')).toBeUndefined();
    expect(checkRunner('npm run testing')).toBeUndefined();
  });

  it('splits on newlines as well as shell separators', () => {
    expect(execSegments('pnpm build\npnpm test').length).toBe(2);
    expect(checkRunner('pnpm build\npnpm test')).toBe('pnpm build');
  });

  // -------------------------------------------------------------------------
  // The heredoc rule. A newline ends a command, so without this the BODY of a
  // heredoc is read as a series of commands, and a body line that says `pnpm
  // test` becomes a verification run that never happened.

  it('does NOT count a check that appears only inside a heredoc BODY', () => {
    const command = ["cat > run.sh <<'EOF'", '#!/bin/bash', 'pnpm test', 'EOF'].join('\n');
    expect(checkRunner(command)).toBeUndefined();
  });

  it('still counts a check that runs AFTER a heredoc closes', () => {
    const command = ["cat > run.sh <<'EOF'", 'pnpm test', 'EOF', 'pnpm build'].join('\n');
    expect(checkRunner(command)).toBe('pnpm build');
  });

  it('still counts a check that runs BEFORE a heredoc opens', () => {
    const command = ['pnpm build', "cat > x <<'EOF'", 'cargo test', 'EOF'].join('\n');
    expect(checkRunner(command)).toBe('pnpm build');
  });

  it('handles an indented terminator, which `<<-` permits', () => {
    const command = ['cat > x <<-EOF', '  cargo test', '  EOF', 'pnpm lint'].join('\n');
    expect(checkRunner(command)).toBe('pnpm lint');
  });

  it('handles a quoted and an unquoted terminator alike', () => {
    for (const tag of ['EOF', "'EOF'", '"EOF"']) {
      const command = [`cat > x <<${tag}`, 'cargo test', tag].join('\n');
      expect(checkRunner(command)).toBeUndefined();
    }
  });

  it('counts a heredoc body as no segments at all', () => {
    const command = ["cat > x <<'EOF'", 'a', 'b', 'c', 'EOF'].join('\n');
    expect(execSegments(command).length).toBe(1); // just the `cat`
  });

  it('LIMITATION: an unterminated heredoc swallows the checks after it', () => {
    // The measured cost of the rule, pinned here so it cannot change silently.
    // 5 of the real corpus's 12,818 openers are in this state.
    const command = ["cat > x <<'EOF'", 'pnpm test'].join('\n');
    expect(checkRunner(command)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('tool_denial', () => {
  it('resolves the tool name from the invoking record, not the denying one', () => {
    // The denial and the invocation it refused are on DIFFERENT records. Reading
    // the current record finds nothing -- measured during development, it did
    // exactly that and named no tool at all.
    const entries = derive([
      invoke('toolu_1', 'Bash', 'rm -rf /'),
      record([{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }], {
        toolDenialKind: 'permission-rule',
      }),
    ]);
    const [denial] = ofType(entries, 'tool_denial');
    expect(denial?.properties['tool_name']).toBe('Bash');
  });

  it('OMITS the tool name when the invocation was never seen', () => {
    const entries = derive([
      record([{ type: 'tool_result', tool_use_id: 'toolu_missing' }], {
        toolDenialKind: 'user-rejected',
      }),
    ]);
    const [denial] = ofType(entries, 'tool_denial');
    expect(denial).toBeDefined();
    expect(denial?.properties).not.toHaveProperty('tool_name');
  });

  it('carries the session and project as properties, not only in the key', () => {
    const entries = derive([
      invoke('toolu_1', 'Bash'),
      record([{ type: 'tool_result', tool_use_id: 'toolu_1' }], {
        toolDenialKind: 'automode-blocked',
      }),
    ]);
    const [denial] = ofType(entries, 'tool_denial');
    expect(denial?.properties['session_id']).toBe('sess-1');
    expect(denial?.properties['project']).toBe('-Users-me-app');
    expect(denial?.properties['occurred_at']).toBe('2026-09-15T10:00:00.000Z');
  });

  it('counts a denial with no tool_use_id as unkeyable rather than emitting it', () => {
    const deriver = createDeriver();
    const out = deriver.accept(record([], { toolDenialKind: 'user-rejected' }), FILE);
    deriver.drain();
    expect(out).toEqual([]);
    expect(deriver.counters.unkeyable).toBe(1);
  });

  it('counts a denial with no sessionId as unkeyable', () => {
    const deriver = createDeriver();
    const out = deriver.accept(
      {
        uuid: 'u',
        message: { content: [{ type: 'tool_result', tool_use_id: 't' }] },
        toolDenialKind: 'user-rejected',
      },
      FILE,
    );
    deriver.drain();
    expect(out).toEqual([]);
    expect(deriver.counters.unkeyable).toBe(1);
  });

  it('FRAGILE no more (asc-ik9): refuses to guess which tool a record with TWO tool_results denies', () => {
    // `toolDenialKind` is a fact about the RECORD, not about either block, so with two
    // candidate invocations there is no way to know which one it names. Before the fix this
    // silently resolved to the FIRST block's id -- indistinguishable from a correct denial
    // unless the first id happened to be the right one.
    const deriver = createDeriver();
    const out = deriver.accept(
      record(
        [
          { type: 'tool_result', tool_use_id: 'toolu_a', is_error: true },
          { type: 'tool_result', tool_use_id: 'toolu_b', is_error: true },
        ],
        { toolDenialKind: 'user-rejected' },
      ),
      FILE,
    );
    deriver.drain();
    expect(out).toEqual([]);
    expect(deriver.counters.unkeyable).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('context_compaction', () => {
  const compaction = (metadata: Record<string, unknown>): TranscriptRecord =>
    record([], { uuid: 'cuuid-1', compactMetadata: metadata });

  const FULL = {
    trigger: 'auto',
    preTokens: 180000,
    postTokens: 20000,
    cumulativeDroppedTokens: 160000,
    durationMs: 45000,
  };

  it('emits the five required token fields', () => {
    const [entry] = ofType(derive([compaction(FULL)]), 'context_compaction');
    expect(entry?.properties).toMatchObject({
      trigger: 'auto',
      pre_tokens: 180000,
      post_tokens: 20000,
      cumulative_dropped_tokens: 160000,
      duration_ms: 45000,
    });
  });

  it('OMITS discovered_tools when the transcript does not carry it', () => {
    // Measured: present on 282 of 436 real compactions, absent on the other 154.
    const [entry] = ofType(derive([compaction(FULL)]), 'context_compaction');
    expect(entry?.properties).not.toHaveProperty('discovered_tools');
  });

  it('EMITS an empty array when the transcript carries one, which is a measurement', () => {
    // The absent-vs-empty distinction, and the reason this is the sharpest
    // assertion in the file: `[]` means "compacted and kept nothing", absence
    // means "the transcript said nothing". A mutation that emitted `[]` for the
    // absent case leaves the test above red.
    const [entry] = ofType(
      derive([compaction({ ...FULL, preCompactDiscoveredTools: [] })]),
      'context_compaction',
    );
    expect(entry?.properties['discovered_tools']).toEqual([]);
    expect(entry?.properties).toHaveProperty('discovered_tools');
  });

  it('keeps a populated discovered_tools list intact', () => {
    const [entry] = ofType(
      derive([compaction({ ...FULL, preCompactDiscoveredTools: ['Bash', 'Read'] })]),
      'context_compaction',
    );
    expect(entry?.properties['discovered_tools']).toEqual(['Bash', 'Read']);
  });

  it('counts a compaction missing a required token field as unkeyable', () => {
    const deriver = createDeriver();
    const out = deriver.accept(compaction({ ...FULL, durationMs: undefined }), FILE);
    deriver.drain();
    expect(out).toEqual([]);
    expect(deriver.counters.unkeyable).toBe(1);
  });

  it('keys on the record uuid, not on the cumulative token count', () => {
    // Two compactions in one session share `cumulativeDroppedTokens` semantics,
    // so keying on it would collide.
    const entries = derive([
      compaction({ ...FULL, cumulativeDroppedTokens: 1 }),
      record([], {
        uuid: 'cuuid-2',
        compactMetadata: { ...FULL, cumulativeDroppedTokens: 1 },
      }),
    ]);
    const keys = ofType(entries, 'context_compaction').map((entry) => entry.key);
    expect(keys).toEqual(['sess-1:cuuid-1', 'sess-1:cuuid-2']);
  });
});

// ---------------------------------------------------------------------------

describe('skill_activation', () => {
  const skill = (name: string, extra: Record<string, unknown> = {}): TranscriptRecord =>
    record([], { attributionSkill: name, ...extra });

  it('emits ONE entry for a run spanning many records', () => {
    // Measured on the real corpus: `attributionSkill` appears on 6,395 records
    // and yields 87 activations. A per-record rule would inflate it 73-fold.
    const entries = derive([
      skill('empirical-planning', { uuid: 'u1' }),
      skill('empirical-planning', { uuid: 'u2' }),
      skill('empirical-planning', { uuid: 'u3' }),
    ]);
    expect(ofType(entries, 'skill_activation').length).toBe(1);
  });

  it('keys on the FIRST record of the run, so a re-ingest matches', () => {
    const entries = derive([
      skill('bug-hunt', { uuid: 'first' }),
      skill('bug-hunt', { uuid: 'second' }),
    ]);
    expect(ofType(entries, 'skill_activation')[0]?.key).toBe('sess-1:first');
  });

  it('starts a NEW activation when the skill changes', () => {
    const entries = derive([
      skill('bug-hunt', { uuid: 'u1' }),
      skill('empirical-planning', { uuid: 'u2' }),
    ]);
    const activations = ofType(entries, 'skill_activation');
    expect(activations.length).toBe(2);
    expect(activations.map((entry) => entry.properties['skill'])).toEqual([
      'bug-hunt',
      'empirical-planning',
    ]);
  });

  it('does NOT break a run across a record with no attribution', () => {
    // A JUDGEMENT, stated because the alternative is defensible and the two
    // differ by a lot. `attributionSkill` appears only on records the skill was
    // used for, so an unattributed record in between is an ordinary turn, not
    // evidence the skill stopped. A run therefore ends when a DIFFERENT skill
    // takes over -- not on every gap.
    //
    // The other rule (break on any gap) would inflate the count, and 87 is the
    // number measured under THIS rule. It is pinned here so that changing it is a
    // visible decision with a number attached rather than a quiet drift.
    const entries = derive([
      skill('bug-hunt', { uuid: 'u1' }),
      record([], { uuid: 'u2' }),
      skill('bug-hunt', { uuid: 'u3' }),
    ]);
    expect(ofType(entries, 'skill_activation').length).toBe(1);
    // And it still keys on the FIRST record, so the gap does not move its identity.
    expect(ofType(entries, 'skill_activation')[0]?.key).toBe('sess-1:u1');
  });

  it('breaks a run when a different skill takes over, and records both', () => {
    const entries = derive([
      skill('bug-hunt', { uuid: 'u1' }),
      record([], { uuid: 'u2' }),
      skill('empirical-planning', { uuid: 'u3' }),
    ]);
    const activations = ofType(entries, 'skill_activation');
    expect(activations.map((entry) => entry.properties['skill'])).toEqual([
      'bug-hunt',
      'empirical-planning',
    ]);
    expect(activations.map((entry) => entry.key)).toEqual(['sess-1:u1', 'sess-1:u3']);
  });

  it('OMITS agent when the transcript names none', () => {
    // Measured: absent on 3,278 of 6,395 attributed records -- the main thread.
    const entries = derive([skill('bug-hunt', { uuid: 'u1' })]);
    const [entry] = ofType(entries, 'skill_activation');
    expect(entry?.properties).not.toHaveProperty('agent');
  });

  it('carries agent when the transcript names one', () => {
    const entries = derive([skill('bug-hunt', { uuid: 'u1', attributionAgent: 'Explore' })]);
    expect(ofType(entries, 'skill_activation')[0]?.properties['agent']).toBe('Explore');
  });

  it('flushes a pending run when the FILE changes, without carrying it across', () => {
    const deriver = createDeriver();
    const first = deriver.accept(skill('bug-hunt', { uuid: 'u1' }), FILE);
    const second = deriver.accept(skill('bug-hunt', { uuid: 'u2' }), fileAt('bbb'));
    expect(first).toEqual([]); // still running
    expect(second.length).toBe(1); // the first file's run closed
    expect(second[0]?.key).toBe('sess-1:u1');
    expect(deriver.drain().length).toBe(1); // and the second is flushed
  });

  it('does not double-emit a run on drain', () => {
    const deriver = createDeriver();
    deriver.accept(skill('bug-hunt', { uuid: 'u1' }), FILE);
    expect(deriver.drain().length).toBe(1);
    expect(deriver.drain().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('verification_run', () => {
  /** A check invocation followed by its result, which is how the transcript records a run. */
  const run = (id: string, isError: boolean, command = 'pnpm test'): TranscriptRecord[] => [
    invoke(id, 'Bash', command),
    result(id, isError),
  ];

  it('emits a first verified PASS, with no previous_verdict', () => {
    const entries = ofType(derive(run('t1', false)), 'verification_run');
    expect(entries.length).toBe(1);
    expect(entries[0]?.properties['verdict']).toBe('passed');
    expect(entries[0]?.properties).not.toHaveProperty('previous_verdict');
  });

  it('emits NOTHING for a first FAILURE', () => {
    // A gate that was already red did not "change state" -- there is no earlier
    // verified pass for it to be a change from. This is the case a mutation that
    // drops the `&& verdict` from `firstPass` kills.
    expect(ofType(derive(run('t1', true)), 'verification_run')).toEqual([]);
  });

  it('emits a change from pass to fail, with previous_verdict', () => {
    const entries = ofType(derive([...run('t1', false), ...run('t2', true)]), 'verification_run');
    expect(entries.length).toBe(2);
    expect(entries[1]?.properties).toMatchObject({
      verdict: 'failed',
      previous_verdict: 'passed',
    });
  });

  it('emits a change from fail to pass', () => {
    const entries = ofType(derive([...run('t1', true), ...run('t2', false)]), 'verification_run');
    expect(entries.length).toBe(1);
    expect(entries[0]?.properties).toMatchObject({
      verdict: 'passed',
      previous_verdict: 'failed',
    });
  });

  it('emits NOTHING when a repeated run reaches the same verdict', () => {
    // The filter that turns 6,826 commands into 486 entries: a red-green loop
    // must not put a row in the store for every keystroke.
    const entries = ofType(
      derive([...run('t1', false), ...run('t2', false), ...run('t3', true), ...run('t4', true)]),
      'verification_run',
    );
    expect(entries.length).toBe(2); // the first pass, and the fail->pass change
  });

  it('records the runner label, not the whole command', () => {
    const command = `pnpm test ${'--flag '.repeat(50)}`;
    const entries = ofType(derive(run('t1', false, command)), 'verification_run');
    expect(entries[0]?.properties['runner']).toBe('pnpm test');
    expect(String(entries[0]?.properties['runner']).length).toBeLessThanOrEqual(60);
  });

  it('counts an unreadable verdict as unverdictable and emits nothing', () => {
    const deriver = createDeriver();
    const out = [
      ...deriver.accept(invoke('t1', 'Bash', 'pnpm test'), FILE),
      ...deriver.accept(record([{ type: 'tool_result', tool_use_id: 't1' }]), FILE),
    ];
    deriver.drain();
    expect(out).toEqual([]);
    expect(deriver.counters.unverdictable).toBe(1);
  });

  it('counts a first pass with no sessionId as unkeyable, and does not corrupt the chain', () => {
    // The mechanism `asc-joo` names: advancing the chain on a run nobody could attribute would
    // make the NEXT, attributable run compare against a value the store never held -- silently
    // swallowing the first entry the store COULD have written. Reproduced end to end at the CLI
    // in `ingest.test.ts`; this pins the deriver's own half of it.
    const deriver = createDeriver();
    const dropped = [
      ...deriver.accept(invoke('t1', 'Bash', 'pnpm test'), FILE),
      ...deriver.accept(
        record([{ type: 'tool_result', tool_use_id: 't1', is_error: false }], {
          sessionId: undefined,
        }),
        FILE,
      ),
    ];
    expect(dropped).toEqual([]);
    expect(deriver.counters.unkeyable).toBe(1);
    expect(deriver.counters.unverdictable).toBe(0);

    // The NEXT check, in the same file, IS attributable -- and must still be recorded as the
    // first verified pass, because as far as the store is concerned nothing came before it.
    const recovered = ofType(
      [
        ...deriver.accept(invoke('t2', 'Bash', 'pnpm test'), FILE),
        ...deriver.accept(result('t2', false), FILE),
      ],
      'verification_run',
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.properties).not.toHaveProperty('previous_verdict');
  });

  it('does NOT count a repeated, non-candidate verdict with no sessionId', () => {
    // Nothing would have been written even with a session id -- a repeat is filtered
    // regardless of attribution -- so counting this as a drop would overstate what was
    // actually lost.
    const deriver = createDeriver();
    deriver.accept(invoke('t1', 'Bash', 'pnpm test'), FILE);
    deriver.accept(result('t1', false), FILE); // establishes an attributable PASS baseline

    deriver.accept(invoke('t2', 'Bash', 'pnpm test'), FILE);
    const out = deriver.accept(
      record([{ type: 'tool_result', tool_use_id: 't2', is_error: false }], {
        sessionId: undefined,
      }),
      FILE,
    );
    expect(out).toEqual([]);
    expect(deriver.counters.unkeyable).toBe(0);
  });

  it('does not advance the chain when a verdict could not be read', () => {
    // Conservative by design: the next readable run is compared against the last
    // verdict actually READ, so an unreadable result cannot fabricate a change.
    const entries = ofType(
      derive([
        ...run('t1', false),
        invoke('t2', 'Bash', 'pnpm test'),
        record([{ type: 'tool_result', tool_use_id: 't2' }]), // no is_error
        ...run('t3', false),
      ]),
      'verification_run',
    );
    expect(entries.length).toBe(1); // only the first pass; t3 repeats it
  });

  it('reads the command from the tool_use record, which arrives BEFORE the result', () => {
    // The bug this test exists for: the command is on the assistant's tool_use
    // block and the result is on a later user record, so a lookup against the
    // current record finds nothing and reports zero checks.
    const entries = ofType(
      derive([invoke('t1', 'Bash', 'cargo test'), result('t1', false)]),
      'verification_run',
    );
    expect(entries[0]?.properties['runner']).toBe('cargo test');
  });

  it('ignores a non-Bash tool result even when its command looks like a check', () => {
    const entries = ofType(
      derive([invoke('t1', 'Read', 'pnpm test'), result('t1', false)]),
      'verification_run',
    );
    expect(entries).toEqual([]);
  });

  it('RESETS the verdict chain per FILE, not per session id', () => {
    // Measured: chaining across a session id gives 171 entries where per-file
    // gives 486, because a session's subagent transcripts share the parent's id
    // and a verdict carried between two conversations fabricates a relationship
    // neither one had. This asserts the reset: the second file's first pass is a
    // first pass, even though the same session id already ended green.
    const deriver = createDeriver();
    const first = deriver.accept(invoke('t1', 'Bash', 'pnpm test'), FILE);
    const firstResult = deriver.accept(result('t1', false), FILE);
    const second = deriver.accept(invoke('t2', 'Bash', 'pnpm test'), fileAt('bbb'));
    const secondResult = deriver.accept(result('t2', false), fileAt('bbb'));

    expect(first).toEqual([]);
    expect(ofType(firstResult, 'verification_run').length).toBe(1);
    expect(second).toEqual([]);
    // If the chain had carried across, this would be a repeat green and emit nothing.
    expect(ofType(secondResult, 'verification_run').length).toBe(1);
  });

  it('does not carry an invocation map across a file boundary', () => {
    const deriver = createDeriver();
    deriver.accept(invoke('t1', 'Bash', 'pnpm test'), FILE);
    // The result arrives in a DIFFERENT file, where that invocation does not exist.
    const out = deriver.accept(result('t1', false), fileAt('bbb'));
    expect(ofType(out, 'verification_run')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('user_correction', () => {
  it('carries the user text in evidence_text, which no other type records', () => {
    const entries = derive([
      invoke('t1', 'Bash', 'rm -rf build'),
      record([{ type: 'tool_result', tool_use_id: 't1' }], {
        uuid: 'fuuid',
        userFeedback: 'no, do not delete the build directory',
      }),
    ]);
    const [correction] = ofType(entries, 'user_correction');
    expect(correction?.evidenceText).toBe('no, do not delete the build directory');
  });

  it('resolves the tool being called when the correction arrived', () => {
    const entries = derive([
      invoke('t1', 'Bash', 'rm -rf build'),
      record([{ type: 'tool_result', tool_use_id: 't1' }], {
        uuid: 'fuuid',
        userFeedback: 'stop',
      }),
    ]);
    expect(ofType(entries, 'user_correction')[0]?.properties['tool_name']).toBe('Bash');
  });

  it('OMITS tool_name when no invocation is in view', () => {
    const entries = derive([record([], { uuid: 'fuuid', userFeedback: 'stop' })]);
    const [correction] = ofType(entries, 'user_correction');
    expect(correction).toBeDefined();
    expect(correction?.properties).not.toHaveProperty('tool_name');
  });

  it('keys on the record uuid', () => {
    const entries = derive([record([], { uuid: 'fuuid', userFeedback: 'stop' })]);
    expect(ofType(entries, 'user_correction')[0]?.key).toBe('sess-1:fuuid');
  });

  it('FRAGILE no more (asc-ik9): OMITS tool_name rather than guessing when a record has TWO tool_results', () => {
    // The entry itself keys on `sessionId:uuid`, not on the tool call, so ambiguity here does
    // not drop the entry -- but before the fix `tool_name` silently took the FIRST block's
    // invocation, which is a fabricated attribution when that is the wrong one. Omitting is the
    // honest answer: "which tool" is not knowable from this record alone.
    const entries = derive([
      invoke('t1', 'Bash', 'rm -rf build'),
      invoke('t2', 'Write', 'notes.md'),
      record(
        [
          { type: 'tool_result', tool_use_id: 't1' },
          { type: 'tool_result', tool_use_id: 't2' },
        ],
        { uuid: 'fuuid', userFeedback: 'stop' },
      ),
    ]);
    const [correction] = ofType(entries, 'user_correction');
    expect(correction).toBeDefined();
    expect(correction?.properties).not.toHaveProperty('tool_name');
  });

  it('attaches evidence_text ONLY to this type', () => {
    // The reader's contract is that no raw transcript text reaches a caller that
    // prints. This type is the one exception, and it must be the ONLY one.
    const entries = derive([
      invoke('t1', 'Bash', 'pnpm test'),
      result('t1', false),
      record([], {
        uuid: 'cuuid',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 1,
          postTokens: 1,
          cumulativeDroppedTokens: 1,
          durationMs: 1,
        },
      }),
      record([], { uuid: 'fuuid', userFeedback: 'the actual words' }),
      record([], { attributionSkill: 'bug-hunt' }),
    ]);
    const withText = entries.filter((entry) => entry.evidenceText !== undefined);
    expect(withText.length).toBe(1);
    expect(withText[0]?.type).toBe('user_correction');
  });
});

// ---------------------------------------------------------------------------

describe('keys and counters', () => {
  it('gives the SAME key for the same event, so a re-ingest is idempotent', () => {
    const records = [invoke('t1', 'Bash', 'pnpm test'), result('t1', false)];
    const first = derive(records).map((entry) => entry.key);
    const second = derive(records).map((entry) => entry.key);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('disambiguates a repeated key with #2 rather than dropping the event', () => {
    const deriver = createDeriver();
    const out = [
      ...deriver.accept(record([], { uuid: 'same', userFeedback: 'one' }), FILE),
      ...deriver.accept(record([], { uuid: 'same', userFeedback: 'two' }), FILE),
    ];
    deriver.drain();
    expect(out.map((entry) => entry.key)).toEqual(['sess-1:same', 'sess-1:same#2']);
    expect(deriver.counters.keyCollisions).toBe(1);
    expect(deriver.counters.entries).toBe(2);
  });

  it('keeps disambiguating past the first collision', () => {
    const deriver = createDeriver();
    const out = [
      deriver.accept(record([], { uuid: 'same', userFeedback: 'a' }), FILE),
      deriver.accept(record([], { uuid: 'same', userFeedback: 'b' }), FILE),
      deriver.accept(record([], { uuid: 'same', userFeedback: 'c' }), FILE),
    ].flatMap((entries) => [...entries]);
    deriver.drain();
    expect(out.map((entry) => entry.key)).toEqual([
      'sess-1:same',
      'sess-1:same#2',
      'sess-1:same#3',
    ]);
    expect(deriver.counters.keyCollisions).toBe(2);
  });

  it('resets the issued-key set per file, so two files do not collide', () => {
    const deriver = createDeriver();
    const a = deriver.accept(record([], { uuid: 'same', userFeedback: 'a' }), FILE);
    const b = deriver.accept(record([], { uuid: 'same', userFeedback: 'b' }), fileAt('bbb'));
    deriver.drain();
    expect([...a, ...b].map((entry) => entry.key)).toEqual(['sess-1:same', 'sess-1:same']);
    expect(deriver.counters.keyCollisions).toBe(0);
  });

  it('counts every record offered, including ones that yield nothing', () => {
    const deriver = createDeriver();
    deriver.accept(record([]), FILE);
    deriver.accept(record([]), FILE);
    deriver.drain();
    expect(deriver.counters.records).toBe(2);
    expect(deriver.counters.entries).toBe(0);
  });

  it('counts entries it actually emitted', () => {
    const deriver = createDeriver();
    const out = deriver.accept(record([], { uuid: 'f', userFeedback: 'x' }), FILE);
    deriver.drain();
    expect(deriver.counters.entries).toBe(out.length);
  });

  it('stamps every entry with the derived source', () => {
    const entries = derive([
      invoke('t1', 'Bash', 'pnpm test'),
      result('t1', false),
      record([], { uuid: 'f', userFeedback: 'x' }),
    ]);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.source).toBe('derived:claude-code');
  });
});

/**
 * `asc-5hs`: a derived entry records the REAL working directory and branch, not the label.
 *
 * THE FIXTURE'S `cwd` IS CHOSEN SO THAT NO READ OF THE PROJECT LABEL COULD PRODUCE IT. The file
 * above is `-Users-me-app`, so the record's cwd is a SUBDIRECTORY of it
 * (`/Users/me/app/packages/core`) and the branch is a feature branch. Both differ from anything
 * the encoded directory name carries, which is the point: the encoded name replaces both `/`
 * and `-` with `-`, so even a correct decoder could only ever reach `/Users/me/app` -- it cannot
 * produce a subdirectory, and it carries no branch at all. A deriver that took either value
 * from the label fails here.
 *
 * The measurement behind the size of the loss, re-taken 2026-09-16 because a live corpus makes
 * any such figure a date: 20 encoded project directories hold 301 distinct real working
 * directories (15.1:1), the largest collapsing 123:1. The bead's 15 / 282 / 115:1 of 2026-09-15
 * says the same thing about a smaller corpus.
 */
describe('the real cwd and branch, which the project label cannot express', () => {
  const AT = { cwd: '/Users/me/app/packages/core', gitBranch: 'feat/locality' };

  it('carries both on every one of the five types', () => {
    // All five, so "each type's emit path passes it" is one assertion rather than five. The
    // ids are distinct per record because a compaction, a skill run and a correction all key
    // on their record's uuid -- sharing one would collide them into a single key.
    const entries = derive([
      record(
        [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pnpm test' } }],
        AT,
      ),
      record([{ type: 'tool_result', tool_use_id: 'bash-1', is_error: false }], AT),
      record([{ type: 'tool_result', tool_use_id: 'write-1' }], {
        uuid: 'denial',
        toolDenialKind: 'user-rejected',
        ...AT,
      }),
      record([], {
        uuid: 'compact',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 1000,
          postTokens: 200,
          cumulativeDroppedTokens: 800,
          durationMs: 1234,
        },
        ...AT,
      }),
      record([], { uuid: 'skill', attributionSkill: 'sk', ...AT }),
      record([], { uuid: 'correct', userFeedback: 'no, use the other one', ...AT }),
    ]);

    // A guard on the guard: if a rule stops emitting, the loop below would pass over an
    // empty set and assert nothing.
    expect(new Set(entries.map((entry) => entry.type)).size).toBe(5);
    for (const entry of entries) {
      expect(entry.cwd, `${entry.type} lost its cwd`).toBe(AT.cwd);
      expect(entry.branch, `${entry.type} lost its branch`).toBe(AT.gitBranch);
      // Asserted separately from the equality above, so a deriver reading the DIRECTORY cannot
      // pass by coincidence. The label is `-Users-me-app`; even a correct DECODER could only
      // reach `/Users/me/app`, and the fixture's cwd is a subdirectory of that.
      expect(entry.cwd).not.toBe(FILE.project);
      expect(entry.cwd).not.toBe('/Users/me/app');
    }
  });

  it('reads them per RECORD, so an entry mid-file takes the cwd in force where it happened', () => {
    // The measured shape of the loss: one project label, many directories. A record that moves
    // under a subdirectory or a worktree must not inherit the previous record's.
    const entries = derive([
      record([], { uuid: 'a', userFeedback: 'first', ...AT }),
      record([], { uuid: 'b', userFeedback: 'second', cwd: '/Users/me/app/.worktrees/x' }),
    ]);
    const [first, second] = ofType(entries, 'user_correction');

    expect(first?.cwd).toBe('/Users/me/app/packages/core');
    expect(second?.cwd).toBe('/Users/me/app/.worktrees/x');
    // Absent on the second record, so OMITTED on the second entry -- never carried forward.
    expect(second?.branch).toBeUndefined();
  });

  it('OMITS both when the record carries neither, rather than writing an empty string', () => {
    // 21.4% of corpus records are control records -- `mode`, `permission-mode`, `ai-title` --
    // and carry neither field. `entries` has `CHECK (cwd IS NULL OR cwd <> '')`, so `''` is a
    // REFUSED write while an absent field is the honest "the transcript did not say".
    const entries = derive([record([], { uuid: 'f', userFeedback: 'x' })]);
    const [correction] = ofType(entries, 'user_correction');

    expect(correction).not.toHaveProperty('cwd');
    expect(correction).not.toHaveProperty('branch');
  });

  it('takes a skill activation’s locality from the FIRST record of the run', () => {
    // Same rule as `session_id`, `project` and `occurred_at`, and for the same reason: one
    // activation is one event, so the facts that belong to it are the ones in force when it
    // started. A run that carries the LAST record's facts would move the activation to wherever
    // it happened to end.
    const entries = derive([
      record([], { uuid: 'a', attributionSkill: 'sk', ...AT }),
      record([], { uuid: 'b', attributionSkill: 'sk', cwd: '/Users/me/app/elsewhere' }),
    ]);
    const [activation] = ofType(entries, 'skill_activation');

    expect(activation?.cwd).toBe('/Users/me/app/packages/core');
    expect(activation?.branch).toBe('feat/locality');
  });
});
