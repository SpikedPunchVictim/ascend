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
 * `additionalContext` 2/2; UserPromptSubmit plain stdout 2/2; PreToolUse JSON `additionalContext`
 * 2/2 (`spike/exposure/FINDINGS.md`, row PRE; n=2, one model, not a rate). So the two tool stages
 * print the JSON envelope and user-prompt-submit prints the text. The total is capped at
 * `MAX_SAY_BYTES`, well under the ~9 KB measured delivery ceiling, and a sentence that would cross
 * it is dropped whole and named on stderr, never cut mid-word.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import {
  HOOK_STAGES,
  hookEvents,
  segmentIndexFrom,
  type HookStage,
} from '@ascend/adapter-claude-code';
import { runHandler } from '@ascend/core';
import { BaseCommand } from '../base.js';
import { readInput, STDIN } from '../input.js';
import { findProjectRoot, storePaths } from '../project.js';
import { unitKey } from '../handler-replay.js';
import { armFor, type Arm, type Intervention } from '../holdout-arm.js';
import { exposureIdOf, writeDecided } from '../exposure-log.js';
import { parseHoldoutFraction } from '../holdout.js';
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

  static override flags = {
    /**
     * The holdout rate, baked in by `asc install-hook --holdout` (asc-xn4g). Absent means no
     * experiment is running and every match is delivered, which is what this command did before
     * the arm existed.
     */
    holdout: Flags.string({
      description:
        'A fraction strictly between 0 and 1; the share of units deliberately not shown.',
      required: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Hook);
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

    const rate = this.holdoutRate(flags.holdout);
    const unit = rate === undefined ? undefined : this.unitOf(input);
    const armOf = (one: SayHandler): Arm =>
      rate === undefined || unit === undefined
        ? 'delivered'
        : armFor(unit, interventionOf(one), rate);

    const matched = sayings(handlers, events, armOf);
    if (rate !== undefined && unit !== undefined) {
      this.record(matched, { unit, rate, stage, input, root });
    }

    const said = this.fit(deliverable(matched));
    if (said === '') {
      // Held out and broken are the same shape on the wire -- exit 0, stderr, empty stdout -- and
      // the module doc makes that so for every failure. Nothing here may leave "silence" to be read
      // as "no handler matched", so a withheld match says so.
      if (matched.some((one) => one.arm === 'held_out')) {
        this.note(
          `held out: ${String(matched.filter((one) => one.arm === 'held_out').length)} match(es) this unit was deliberately not shown.`,
        );
      }
      return;
    }
    // Both tool stages deliver through the JSON `additionalContext` -- PostToolUse 2/2 and
    // PreToolUse 2/2 (`spike/exposure/FINDINGS.md`, row PRE). UserPromptSubmit is the odd one:
    // plain stdout 2/2. So the exception is named rather than a rule that now has two members.
    this.emitText(
      stage === 'user-prompt-submit'
        ? said
        : JSON.stringify({
            hookSpecificOutput: {
              hookEventName: HOOK_STAGES[stage].event,
              additionalContext: said,
            },
          }),
    );
  }

  /**
   * The rate the run is under, or `undefined` when none was configured. An unparseable value is
   * noted and treated as NO experiment rather than as an error: this command may not fail the
   * session, and the safe reading of "I cannot tell what rate you meant" is to withhold nothing.
   */
  private holdoutRate(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const parsed = parseHoldoutFraction(raw);
    if (typeof parsed === 'string') {
      this.note(`${parsed} No unit will be held out.`);
      return undefined;
    }
    return parsed;
  }

  /**
   * The unit this invocation is in: `unitKey`'s (session, agent, segment), read from the hook input
   * and the transcript it names. Returns `undefined` when the input carries no transcript, which
   * means the segment cannot be known -- and an arm decided on a guessed segment would be a silent
   * wrong answer, so no arm is decided at all.
   */
  private unitOf(input: unknown): string | undefined {
    const hook =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const session = typeof hook['session_id'] === 'string' ? hook['session_id'] : undefined;
    const path = typeof hook['transcript_path'] === 'string' ? hook['transcript_path'] : undefined;
    if (session === undefined || path === undefined) return undefined;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      this.note(`the transcript could not be read (${messageOf(error)}); no unit was held out.`);
      return undefined;
    }
    const agent = typeof hook['agent_id'] === 'string' ? hook['agent_id'] : 'main';
    return unitKey(session, agent, segmentIndexFrom(text));
  }

  /**
   * Write one decision per match, held-out matches included, because a control arm the log cannot
   * see is not a control arm.
   *
   * The write is wrapped rather than left to `catch`. An exception escaping to `catch` would note
   * and return exit 0 -- and then `emitText` would never run, so a broken log would silently cancel
   * the delivery it exists to measure. A failure here is reported and the delivery proceeds.
   */
  private record(
    matched: readonly Said[],
    context: {
      readonly unit: string;
      readonly rate: number;
      readonly stage: HookStage;
      readonly input: unknown;
      readonly root: string;
    },
  ): void {
    const hook =
      typeof context.input === 'object' && context.input !== null
        ? (context.input as Record<string, unknown>)
        : {};
    const trigger =
      (typeof hook['tool_use_id'] === 'string' ? hook['tool_use_id'] : undefined) ??
      (typeof hook['prompt_id'] === 'string' ? hook['prompt_id'] : undefined) ??
      '';
    for (const one of matched) {
      const intervention: Intervention = { id: one.name, version: one.hash };
      const exposure_id = exposureIdOf({
        intervention: one.name,
        version: one.hash,
        unit: context.unit,
        trigger,
      });
      try {
        // The store TREE, not the project root: `writeDecided` takes it in the form the store's own
        // API takes it, and the `join(root, STORE_DIR)` belongs to `storePaths` rather than here.
        writeDecided(storePaths(context.root).tree, {
          exposure_id,
          intervention_id: intervention.id,
          intervention_version: intervention.version,
          arm: one.arm,
          rate: context.rate,
          session: str(hook['session_id']) ?? '',
          agent: str(hook['agent_id']) ?? 'main',
          segment: Number(context.unit.slice(context.unit.lastIndexOf('\u0000') + 1)),
          hook_event: HOOK_STAGES[context.stage].event,
          ...(trigger === '' ? {} : { tool_use_id: trigger }),
        });
      } catch (error) {
        this.note(`the exposure log could not be written (${messageOf(error)}).`);
      }
    }
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

/** One sentence a handler matched, with the arm it was decided into. `hash` is its intervention. */
interface Said {
  readonly name: string;
  readonly hash: string;
  readonly arm: Arm;
  readonly text: string;
}

/** The intervention a `say:` handler stands for: its name, and the hash of its content. */
const interventionOf = (one: SayHandler): Intervention => ({
  id: one.name,
  version: one.handler.hash,
});

/**
 * Every sentence the handlers matched, in handler order then trigger order, each carrying its arm.
 *
 * **NO DEDUPE HERE, DELIBERATELY.** Two handlers can say the same sentence and be in different arms
 * -- the arm is per unit AND per intervention -- so a withheld handler's copy must not suppress a
 * delivered one's. Dedupe happens at `deliverable`, over the delivered rows alone.
 */
function sayings(
  handlers: readonly SayHandler[],
  events: ReturnType<typeof hookEvents> & object,
  armOf: (one: SayHandler) => Arm,
): Said[] {
  const out: Said[] = [];
  for (const one of handlers) {
    const run = runHandler(one.handler);
    const rows = events.flatMap((event) => [...run.accept(event)]);
    run.finish();
    for (const row of rows) {
      const text = row.fields['say'];
      if (text === undefined) continue;
      out.push({ name: one.name, hash: one.handler.hash, arm: armOf(one), text });
    }
  }
  return out;
}

/** The rows to say: the delivered ones, deduped by sentence, first handler wins as before. */
function deliverable(matched: readonly Said[]): { name: string; text: string }[] {
  const seen = new Set<string>();
  const out: { name: string; text: string }[] = [];
  for (const one of matched) {
    if (one.arm !== 'delivered' || seen.has(one.text)) continue;
    seen.add(one.text);
    out.push({ name: one.name, text: one.text });
  }
  return out;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
