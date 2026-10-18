/**
 * Attribution tests for `asc standing-costs`.
 *
 * Every case here is chosen so that ONE wrong rule fails it. A test that only asserted a total
 * would pass under several of the wrong attributions this file exists to separate: a character
 * count instead of a byte count, a record counted once instead of once per file, `content` measured
 * where EV-54 measured `stdout`, or a Bash call labelled from a segment that did not run.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptFile, TranscriptRecord } from '@ascend/adapter-claude-code';
import {
  REPORT_BASH,
  REPORT_HELP,
  REPORT_INJECTED,
  REPORT_INSTRUCTIONS,
  REPORT_SKILLS,
  REPORT_TOOLS,
  createStandingCostMeter,
  firstCommandLabel,
  standingCostOutput,
  type StandingCostMeasurement,
} from '../src/standing-costs.js';

const HOME = '/home/me';

function file(session = 'sess-1', path = `/p/${session}.jsonl`): TranscriptFile {
  return { path, project: 'p', session, kind: 'session' };
}
const record = (value: Record<string, unknown>): TranscriptRecord => value;

function use(id: string, command: string, session = 'sess-1'): TranscriptRecord {
  return record({
    type: 'assistant',
    sessionId: session,
    message: {
      id: `msg-${id}`,
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  });
}

function result(id: string, content: string, session = 'sess-1'): TranscriptRecord {
  return record({
    type: 'user',
    sessionId: session,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
}

function call(id: string, command: string, output: string, session = 'sess-1'): TranscriptRecord[] {
  return [use(id, command, session), result(id, output, session)];
}

function attachment(value: Record<string, unknown>, session = 'sess-1'): TranscriptRecord {
  return record({ type: 'attachment', sessionId: session, attachment: value });
}

function measure(
  records: readonly TranscriptRecord[],
  sessions = ['sess-1'],
): StandingCostMeasurement {
  const meter = createStandingCostMeter({ home: HOME });
  for (const value of records) {
    const session =
      typeof value['sessionId'] === 'string' ? value['sessionId'] : (sessions[0] ?? 'sess-1');
    meter.accept(value, file(session));
  }
  return meter.finish();
}

function rows(
  measurement: StandingCostMeasurement,
  report: string,
): readonly Record<string, unknown>[] {
  const found = measurement.reports.find((entry) => entry.id === report);
  if (found === undefined) throw new Error(`no report ${report}`);
  return found.rows;
}

function row(
  measurement: StandingCostMeasurement,
  report: string,
  key: string,
): Record<string, unknown> | undefined {
  return rows(measurement, report).find((entry) => entry['key'] === key);
}

function value(measurement: StandingCostMeasurement, report: string, key: string): unknown {
  return row(measurement, report, key)?.['value'];
}

describe('injected context', () => {
  it('measures UTF-8 bytes across every file of one instructions record, and loads per file', () => {
    // 'αβ' is 4 bytes and 2 characters; 'hello' is 5 either way. A character count gives 7.
    const measured = measure([
      attachment({
        type: 'instructions',
        files: [
          { path: `${HOME}/.claude/CLAUDE.md`, type: 'text', content: 'αβ' },
          { path: '/srv/app/CLAUDE.md', type: 'text', content: 'hello' },
        ],
      }),
    ]);

    expect(row(measured, REPORT_INJECTED, 'instructions')).toMatchObject({ bytes: 9, count: 1 });
    expect(row(measured, REPORT_INSTRUCTIONS, '~/.claude/CLAUDE.md')).toMatchObject({
      bytes: 4,
      count: 1,
    });
    expect(row(measured, REPORT_INSTRUCTIONS, '/srv/app/CLAUDE.md')).toMatchObject({
      bytes: 5,
      count: 1,
    });
    // Two loads, one record: the two denominators EV-54 printed and the reason they can disagree.
    expect(value(measured, REPORT_INSTRUCTIONS, '(groups)')).toBe(2);
  });

  it('sums names rather than the harness skillCount, and unions the distinct names', () => {
    const measured = measure([
      attachment({ type: 'skill_listing', content: 'abc', names: ['a', 'b'], skillCount: 5 }),
    ]);

    expect(row(measured, REPORT_INJECTED, 'skill_listing')).toMatchObject({ bytes: 3, count: 1 });
    expect(value(measured, REPORT_SKILLS, 'skills_summed')).toBe(2);
    expect(value(measured, REPORT_SKILLS, 'distinct_listed')).toBe(2);
    expect(value(measured, REPORT_SKILLS, 'bytes_per_listing')).toBe(3);
  });

  it('reads a file attachment from its nested content, not from a string that is not there', () => {
    const measured = measure([
      attachment({
        type: 'file',
        content: { type: 'text', file: { filePath: '/x', content: '12345' } },
      }),
    ]);
    expect(row(measured, REPORT_INJECTED, 'file')).toMatchObject({ bytes: 5, count: 1 });
  });

  it('sums every block of an mcp instructions delta', () => {
    const measured = measure([
      attachment({ type: 'mcp_instructions_delta', addedBlocks: ['abc', 'de'] }),
    ]);
    expect(row(measured, REPORT_INJECTED, 'mcp_instructions_delta')).toMatchObject({ bytes: 5 });
  });

  it('sizes hook_success by stdout, names the channel, and says so when it had to use content', () => {
    // `content` and `stdout` differ on most real attachments, and the event stream measures
    // `content`. EV-54's column is `hook_success(stdout)`.
    const measured = measure([
      attachment({
        type: 'hook_success',
        hookEvent: 'SessionStart',
        command: 'bd prime --hook-json',
        stdout: '1234567890',
        content: 'x',
      }),
      attachment({ type: 'hook_success', hookEvent: 'Stop', command: 'notify', content: 'yz' }),
    ]);

    expect(
      row(measured, REPORT_INJECTED, 'hook_success(stdout) SessionStart bd prime --hook-json'),
    ).toMatchObject({ bytes: 10, count: 1 });
    expect(row(measured, REPORT_INJECTED, 'hook_success(content) Stop notify')).toMatchObject({
      bytes: 2,
    });
  });

  it('distinguishes a persisted hook preview from inline context', () => {
    const persisted = '<persisted-output>\nOutput too large (19.9KB).';
    const measured = measure([
      attachment({
        type: 'hook_additional_context',
        hookEvent: 'SessionStart',
        hookName: 'beads',
        content: [persisted],
      }),
      attachment({
        type: 'hook_additional_context',
        hookEvent: 'PostToolUse',
        hookName: 'lens',
        content: ['inline text'],
      }),
      // Mentions the marker without being one: the wrapper is matched at the START, because a hook
      // that discusses a persisted file has not been persisted.
      attachment({
        type: 'hook_additional_context',
        hookEvent: 'Stop',
        hookName: 'mentions',
        content: ['see <persisted-output> below'],
      }),
    ]);

    expect(
      row(measured, REPORT_INJECTED, 'hook_additional_context(persisted) SessionStart beads'),
    ).toMatchObject({ bytes: Buffer.byteLength(persisted, 'utf8') });
    expect(
      row(measured, REPORT_INJECTED, 'hook_additional_context(inline) PostToolUse lens'),
    ).toMatchObject({ bytes: 11 });
    expect(
      row(measured, REPORT_INJECTED, 'hook_additional_context(inline) Stop mentions'),
    ).toMatchObject({ bytes: 28 });
  });
});

describe('tool results and the first command', () => {
  it('attributes a Bash result to the head and its subcommand', () => {
    const measured = measure(call('t1', 'git diff --stat', '0123456789'));
    expect(row(measured, REPORT_TOOLS, 'Bash')).toMatchObject({ bytes: 10, count: 1 });
    expect(row(measured, REPORT_BASH, 'git diff')).toMatchObject({ bytes: 10, count: 1 });
  });

  it('attributes a multi-segment call to the FIRST executed segment only', () => {
    // `git status && git diff` runs two segments; the whole result belongs to the first, which is
    // EV-54's stated rule and the reason `tool.use.start.argv` (flattened) cannot be the label.
    const measured = measure(call('t1', 'git status && git diff', '0123456789'));
    expect(row(measured, REPORT_BASH, 'git status')).toMatchObject({ bytes: 10 });
    expect(row(measured, REPORT_BASH, 'git diff')).toBeUndefined();
  });

  it('does not join a subcommand across a segment boundary', () => {
    // `git && git diff` would read `git git` from the flattened argv.
    const measured = measure(call('t1', 'git && git diff', '0123456789'));
    expect(row(measured, REPORT_BASH, 'git')).toMatchObject({ bytes: 10 });
    expect(row(measured, REPORT_BASH, 'git git')).toBeUndefined();
  });

  it('labels a call whose every segment was stripped rather than losing its bytes', () => {
    const measured = measure(call('t1', 'cd /tmp', '0123456789'));
    expect(row(measured, REPORT_BASH, '(no command)')).toMatchObject({ bytes: 10 });
    const total = rows(measured, REPORT_BASH)
      .filter((entry) => entry['key'] !== '(groups)')
      .reduce((sum, entry) => sum + Number(entry['bytes'] ?? 0), 0);
    expect(total).toBe(10);
  });

  it('labels heads without a subcommand join, and takes a flag as no subcommand', () => {
    expect(firstCommandLabel(['git', 'diff'])).toBe('git diff');
    expect(firstCommandLabel(['git', '--version'])).toBe('git');
    expect(firstCommandLabel(['grep', 'needle', 'file'])).toBe('grep');
    expect(firstCommandLabel([])).toBe('(no command)');
  });

  it('counts an unpaired tool result as a normalizer drop, not as measured bytes', () => {
    const measured = measure([result('ghost', '0123456789')]);
    expect(measured.log).toContainEqual(
      expect.objectContaining({ key: 'normalizer.unpairedResults', value: 1 }),
    );
    expect(row(measured, REPORT_TOOLS, 'Bash')).toBeUndefined();
  });
});

describe('--help look-ups', () => {
  it('keys by the exact command and counts distinct stream segments, not calls', () => {
    const command = 'node packages/cli/dist/bin.js record --help';
    const measured = measure([
      ...call('h1', command, '0123456789'),
      ...call('h2', command, '0123456789'),
      ...call('h3', 'bd create --help', '01234', 'sess-2'),
    ]);

    expect(row(measured, REPORT_HELP, command)).toMatchObject({
      bytes: 20,
      count: 2,
      stream_segments: 1,
    });
    expect(row(measured, REPORT_HELP, 'bd create --help')).toMatchObject({
      count: 1,
      stream_segments: 1,
    });
    // The key is the exact text, not the head: collapsing to `node` would lose the table's meaning.
    expect(row(measured, REPORT_HELP, 'node')).toBeUndefined();
  });

  it('aggregates a piped look-up under the command up to the flag', () => {
    // Help output is almost always piped, so a whole-text key would split one look-up into a row
    // per way of piping it. EV-54's keys stop at the flag.
    const measured = measure([
      ...call('h1', 'bd create --help', '01234'),
      ...call('h2', 'bd create --help 2>&1 | head -40', '0123456789'),
    ]);

    expect(row(measured, REPORT_HELP, 'bd create --help')).toMatchObject({ count: 2, bytes: 15 });
    expect(row(measured, REPORT_HELP, 'bd create --help 2>&1 | head -40')).toBeUndefined();
  });

  it('does not count a command that merely starts with --help', () => {
    const measured = measure(call('h1', 'true --helpful', '0000'));
    expect(rows(measured, REPORT_HELP).every((entry) => entry['count'] === undefined)).toBe(true);
  });
});

describe('skills', () => {
  it('reports never-invoked as a set difference, so an invoked name that was never listed is not invented', () => {
    const measured = measure([
      attachment({ type: 'skill_listing', content: 'x', names: ['alpha', 'beta'] }),
      record({
        type: 'assistant',
        sessionId: 'sess-1',
        message: {
          id: 'msg-s1',
          content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'gamma' } }],
        },
      }),
    ]);

    expect(value(measured, REPORT_SKILLS, 'distinct_listed')).toBe(2);
    expect(value(measured, REPORT_SKILLS, 'distinct_invoked')).toBe(1);
    // 2 listed, 1 invoked, and the invoked one was never listed: 2 never-invoked, not 1.
    expect(value(measured, REPORT_SKILLS, 'listed_never_invoked')).toBe(2);
  });
});

describe('the small-group floor', () => {
  it('judges MIN_N on sessions, not on calls', () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      call(`t${String(index)}`, 'grep needle', 'ab', 'sess-1'),
    ).flat();
    const measured = measure(many);
    expect(row(measured, REPORT_TOOLS, 'Bash')?.['note']).toMatch(/anecdote: 1 sessions < 20/);
  });
});

describe('invariants', () => {
  const corpus: TranscriptRecord[] = [
    attachment({
      type: 'instructions',
      files: [
        { path: `${HOME}/CLAUDE.md`, type: 'text', content: 'abc' },
        { path: '/srv/MEMORY.md', type: 'text', content: 'de' },
      ],
    }),
    attachment({ type: 'skill_listing', content: 'list', names: ['a'] }),
    ...call('t1', 'git diff', '0123456789'),
    ...call('t2', 'sed -n 1p f', '01234'),
    ...call('t3', 'grep --help', '0123456789'),
  ];

  it('reconciles the instruction file bytes with the injected total', () => {
    const measured = measure(corpus);
    const files = rows(measured, REPORT_INSTRUCTIONS)
      .filter((entry) => entry['key'] !== '(groups)')
      .reduce((sum, entry) => sum + Number(entry['bytes'] ?? 0), 0);
    expect(files).toBe(row(measured, REPORT_INJECTED, 'instructions')?.['bytes']);
  });

  it('reconciles the skill listing bytes with the injected total', () => {
    const measured = measure(corpus);
    expect(row(measured, REPORT_SKILLS, 'listings')?.['bytes']).toBe(
      row(measured, REPORT_INJECTED, 'skill_listing')?.['bytes'],
    );
  });

  it('reconciles every Bash byte with the tool total, and help within it', () => {
    const measured = measure(corpus);
    const bashBytes = rows(measured, REPORT_BASH)
      .filter((entry) => entry['key'] !== '(groups)')
      .reduce((sum, entry) => sum + Number(entry['bytes'] ?? 0), 0);
    expect(bashBytes).toBe(row(measured, REPORT_TOOLS, 'Bash')?.['bytes']);
    const helpBytes = rows(measured, REPORT_HELP)
      .filter((entry) => entry['key'] !== '(groups)')
      .reduce((sum, entry) => sum + Number(entry['bytes'] ?? 0), 0);
    expect(helpBytes).toBeLessThanOrEqual(bashBytes);
  });
});

describe('limit and coverage', () => {
  it('trims ranked reports per report, states each population, and leaves fact rows alone', () => {
    const measured = measure([
      ...call('t1', 'git diff', '0123456789'),
      ...call('t2', 'sed -n 1p f', '01234'),
      ...call('t3', 'grep x', '012'),
    ]);
    const output = standingCostOutput(measured, 1);

    const bashRows = output.rows.filter((entry) => entry['report'] === REPORT_BASH);
    // One ranked row plus the (groups) row, which is never trimmed.
    expect(bashRows).toHaveLength(2);
    expect(bashRows.at(-1)).toMatchObject({ key: '(groups)', value: 3 });
    expect(output.coverage).toMatchObject({ has_more: true });
    // The skills metrics are fixed rows and must survive any limit.
    expect(output.rows.filter((entry) => entry['report'] === REPORT_SKILLS).length).toBeGreaterThan(
      1,
    );
  });
});
