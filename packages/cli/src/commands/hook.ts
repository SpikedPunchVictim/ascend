/**
 * `asc hook <stage>` -- run this project's `say:` handlers at one Claude Code lifecycle stage, and
 * hand what they say to the model (asc-tuur.4).
 *
 * This is route B of asc-tuur: rather than asking a user to change their workflow so that ascend
 * can record it, a handler speaks at the moment it matters -- a reviewer who has just loaded
 * `bug-hunt` is told how to report what it finds -- and the recording then happens through a path
 * that already exists. Installed by `asc install-hook`, per stage, only when a handler uses it.
 *
 * **NEVER FAILS THE SESSION.** Exit 0 whatever happens. A hook that exits 2 blocks the tool call
 * it was run for, and anything else non-zero is shown to the user as a hook error on every tool
 * call; neither is an acceptable price for a nudge. Every failure goes to stderr, and stdout
 * then carries nothing -- a partial say is not written.
 *
 * **Output channels, as measured.** PostToolUse plain stdout reached the model 0/2 and its JSON
 * `additionalContext` 2/2 (`spike/exposure/FINDINGS.md`); UserPromptSubmit plain stdout 2/2. So
 * post-tool-use prints the JSON envelope and user-prompt-submit prints the text. The total is
 * capped at `MAX_SAY_BYTES`, well under the ~9 KB measured delivery ceiling, and a sentence that
 * would cross it is dropped whole and named on stderr, never cut mid-word.
 */

import { resolve } from 'node:path';
import { Args } from '@oclif/core';
import { HOOK_STAGES, hookEvents, type HookStage } from '@ascend/adapter-claude-code';
import { runHandler } from '@ascend/core';
import { BaseCommand } from '../base.js';
import { readInput, STDIN } from '../input.js';
import { findProjectRoot } from '../project.js';
import { loadProjectHandlers, type SayHandler } from '../typed-handlers.js';

/** The most a stage prints, in bytes. */
export const MAX_SAY_BYTES = 4096;

const STAGES = Object.keys(HOOK_STAGES) as HookStage[];

export default class Hook extends BaseCommand {
  static override description =
    'Run this project’s say: handlers for one Claude Code lifecycle stage, reading the hook ' +
    'input on stdin. Installed by asc install-hook; not meant to be run by hand.';

  static override hidden = true;

  static override args = {
    stage: Args.string({
      description: 'The lifecycle stage this hook was installed for.',
      options: STAGES,
      required: true,
      // Load-bearing here above all: stdin is the hook's JSON input, and without this oclif would
      // read it as the stage when the argument is missing.
      ignoreStdin: true,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(Hook);
    const stage = args.stage as HookStage;

    let input: unknown;
    try {
      input = JSON.parse(await readInput(STDIN));
    } catch (error) {
      this.note(`the hook input was not JSON (${messageOf(error)}); nothing was said.`);
      return;
    }

    const cwd =
      typeof (input as { cwd?: unknown }).cwd === 'string'
        ? (input as { cwd: string }).cwd
        : process.cwd();
    const root = findProjectRoot(resolve(cwd));
    if (root === undefined) return;

    const loaded = loadProjectHandlers(root);
    for (const failure of loaded.failures) {
      this.note(`handler ${failure.path} was not run: ${failure.message}`);
    }
    const handlers = loaded.say.filter((one) => one.stage === stage);
    if (handlers.length === 0) return;

    const events = hookEvents(stage, input);
    if (events === undefined) {
      this.note(`the input is not a ${HOOK_STAGES[stage].event} hook input; nothing was said.`);
      return;
    }

    const said = this.fit(sayings(handlers, events));
    if (said === '') return;
    this.emitText(
      stage === 'post-tool-use'
        ? JSON.stringify({
            hookSpecificOutput: {
              hookEventName: HOOK_STAGES[stage].event,
              additionalContext: said,
            },
          })
        : said,
    );
  }

  /** Join what was said, dropping any sentence that would take the total past the cap. */
  private fit(sayings: readonly { name: string; text: string }[]): string {
    const kept: string[] = [];
    let bytes = 0;
    for (const { name, text } of sayings) {
      const cost = Buffer.byteLength(text, 'utf8') + (kept.length === 0 ? 0 : 1);
      if (bytes + cost > MAX_SAY_BYTES) {
        this.note(
          `handler ${name} was not said: the stage's output would pass ${String(MAX_SAY_BYTES)} bytes.`,
        );
        continue;
      }
      kept.push(text);
      bytes += cost;
    }
    return kept.join('\n');
  }

  private note(message: string): void {
    this.emitStderr('Warning', message);
  }

  /** Exit 0 on everything, including a stage oclif refused while parsing (see the module doc). */
  protected override catch(error: Error & { exitCode?: number }): Promise<void> {
    this.note(`asc hook did nothing: ${messageOf(error)}`);
    return Promise.resolve();
  }
}

/** Each handler's distinct sentences, in handler order, then trigger order. */
function sayings(
  handlers: readonly SayHandler[],
  events: ReturnType<typeof hookEvents> & object,
): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const { name, handler } of handlers) {
    const run = runHandler(handler);
    const rows = events.flatMap((event) => [...run.accept(event)]);
    run.finish();
    for (const row of rows) {
      const text = row.fields['say'];
      if (text === undefined || seen.has(text)) continue;
      seen.add(text);
      out.push({ name, text });
    }
  }
  return out;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
