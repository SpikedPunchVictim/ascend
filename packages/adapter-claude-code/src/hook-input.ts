/**
 * A Claude Code lifecycle hook's input, as normalized events (asc-tuur.4).
 *
 * **THROUGH THE NORMALIZER, NOT BESIDE IT.** A hook's JSON is turned into the transcript records
 * the same moment would have written -- a tool call becomes an assistant `tool_use` record and a
 * user `tool_result` record, a prompt becomes a user record -- and those go through
 * `createNormalizer`. So a `say:` handler sees, live, exactly the events `asc handlers check`
 * replays for it, and there is one definition of what a `Skill` call or a `Write` means, not two.
 *
 * **Which stages.** Only the ones measured to fire and to reach the model
 * (`spike/capture-hooks/FINDINGS.md`, `spike/exposure/FINDINGS.md`): PostToolUse, including inside
 * a subagent, and UserPromptSubmit, both measured before the model; and PreToolUse, whose JSON
 * `additionalContext` was delivered 2/2 (n=2, one model, not a rate). A kind no stage delivers is
 * refused when a say handler is loaded (`stageForKind`), rather than accepted and never run.
 *
 * **Two stages deliver `tool.use.start`**, so a kind alone no longer names a stage: the caller says
 * which it wants (`stageForKind(kind, prefer)`), and with no preference the answer is the stage the
 * one live say handler was measured under. PreToolUse fires BEFORE the call, so its input carries no
 * `tool_response` and normalizes to the start alone -- a handler reading an end there would be
 * reading a result that does not exist yet.
 */

import type { NormalizedEvent } from '@ascend/core';
import type { TranscriptRecord } from './decode.js';
import { createNormalizer } from './normalize.js';
import type { TranscriptFile } from './transcript-file.js';

/** A lifecycle stage `asc hook <stage>` runs at, named as the CLI spells it. */
export type HookStage = 'user-prompt-submit' | 'post-tool-use' | 'pre-tool-use';

export interface HookStageSpec {
  /** The `hook_event_name` Claude Code sends, and the settings.json key the hook is under. */
  readonly event: 'UserPromptSubmit' | 'PostToolUse' | 'PreToolUse';
  /** The normalized kinds this stage's input produces. */
  readonly kinds: readonly string[];
}

export const HOOK_STAGES: Readonly<Record<HookStage, HookStageSpec>> = {
  'user-prompt-submit': { event: 'UserPromptSubmit', kinds: ['prompt.submit'] },
  'post-tool-use': {
    event: 'PostToolUse',
    kinds: [
      'tool.use.start',
      'tool.use.end',
      'command.run',
      'search.run',
      'check.run',
      'file.read',
      'file.changed',
    ],
  },
  'pre-tool-use': { event: 'PreToolUse', kinds: ['tool.use.start'] },
};

/**
 * The order a kind is resolved in when no stage is asked for. Listed rather than read off
 * `HOOK_STAGES`, because the two stages that deliver `tool.use.start` are both real and only one of
 * them is measured: `post-tool-use` is where `review-finding-nudge` was measured, so it is the
 * default and `pre-tool-use` is reached only by asking for it.
 */
const DEFAULT_ORDER: readonly HookStage[] = ['user-prompt-submit', 'post-tool-use', 'pre-tool-use'];

/**
 * The stage that delivers `kind`, or `undefined` when no measured stage does. `prefer` names the
 * stage a caller wants when more than one delivers the kind; a preference for a stage that does not
 * deliver it is ignored rather than obeyed, so the answer still names a hook that will run.
 */
export function stageForKind(kind: string, prefer?: HookStage): HookStage | undefined {
  const delivers = (stage: HookStage): boolean => HOOK_STAGES[stage].kinds.includes(kind);
  if (prefer !== undefined && delivers(prefer)) return prefer;
  return DEFAULT_ORDER.find((stage) => stage !== prefer && delivers(stage));
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The events a hook input stands for, or `undefined` when the input is not one this stage's
 * input can be (the wrong `hook_event_name`, or a field it needs missing). The caller treats that
 * as "nothing to say", never as an error the user's session sees.
 */
export function hookEvents(
  stage: HookStage,
  input: unknown,
): readonly NormalizedEvent[] | undefined {
  const hook = rec(input);
  const session = str(hook?.['session_id']);
  if (hook === undefined || session === undefined) return undefined;
  if (hook['hook_event_name'] !== HOOK_STAGES[stage].event) return undefined;

  const records =
    stage === 'user-prompt-submit'
      ? promptRecords(hook)
      : toolRecords(hook, session, stage === 'pre-tool-use');
  if (records === undefined) return undefined;

  const agent = str(hook['agent_id']);
  // `agentIdOf` reads a subagent's id off its file name, so the synthetic path carries it there.
  const file: TranscriptFile = {
    path: agent === undefined ? `hook/${session}.jsonl` : `hook/${session}/agent-${agent}.jsonl`,
    project: '',
    session,
    kind: agent === undefined ? 'session' : 'subagent',
  };
  const normalizer = createNormalizer();
  return [...records.flatMap((record) => normalizer.accept(record, file)), ...normalizer.drain()];
}

function toolRecords(
  hook: Record<string, unknown>,
  session: string,
  pre: boolean,
): TranscriptRecord[] | undefined {
  const tool = str(hook['tool_name']);
  const id = str(hook['tool_use_id']);
  if (tool === undefined || id === undefined) return undefined;
  const call: TranscriptRecord = {
    type: 'assistant',
    sessionId: session,
    message: {
      id: `hook-${id}`,
      content: [{ type: 'tool_use', id, name: tool, input: rec(hook['tool_input']) ?? {} }],
    },
  };
  // PreToolUse fires before the call, and its input carries no `tool_response` to normalize. A
  // result record is not invented here: `is_error: false` would tell a handler the call had
  // succeeded at the one moment nothing is known about it. The call stays unfinished.
  if (pre) return [call];
  const response = hook['tool_response'];
  return [
    call,
    {
      type: 'user',
      sessionId: session,
      // PostToolUse fires for a call that succeeded; a failed one is PostToolUseFailure.
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: false,
            content: typeof response === 'string' ? response : JSON.stringify(response ?? ''),
          },
        ],
      },
      ...(rec(response) === undefined ? {} : { toolUseResult: response }),
    },
  ];
}

function promptRecords(hook: Record<string, unknown>): TranscriptRecord[] | undefined {
  const prompt = str(hook['prompt']);
  if (prompt === undefined) return undefined;
  return [{ type: 'user', sessionId: hook['session_id'], message: { content: prompt } }];
}
