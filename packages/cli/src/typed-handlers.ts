/**
 * Typed handlers at ingest (asc-tuur.3): a handler that declares `type:` has its rows written as
 * entries of that type, so capturing a type a user defined does not require the user's workflow
 * to report it in a new way -- a handler reads what the workflow already writes.
 *
 * **The same path as the deriver's entries, deliberately.** A row becomes a `DerivedEntry` and
 * joins the deriver's output before validation, so it is validated against its type, keyed,
 * refused on collision and tallied by exactly the code every derived entry already goes through.
 * Nothing here writes to the store.
 *
 * **Identity.** The key is `<handler>@<hash12>:<session>:<event id>[:<row>]`. The event id is the
 * trigger's own (a tool_use id), so a re-ingest proposes the same key; the hash is the handler's
 * meaning (`compileHandler`), so a changed handler proposes new keys rather than colliding with
 * the entries its previous version wrote -- the role `DERIVATION_VERSIONS` plays for the deriver.
 *
 * **Which handlers.** Every `*.yaml` under the project's `handlers/` that declares `type:`. A
 * handler that does not load is reported and skipped, never fatal: this runs inside the
 * SessionStart hook, where a refusal would stop every derived entry from being written because
 * one handler has a typo. `asc handlers check` is where a handler is made to load.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  DERIVED_SOURCE,
  HOOK_STAGES,
  createNormalizer,
  stageForKind,
  type HookStage,
  projectRelativeCwd,
  type DerivedEntry,
  type TranscriptFile,
  type TranscriptRecord,
} from '@ascend/adapter-claude-code';
import {
  HandlerError,
  runHandler,
  type CompiledHandler,
  type HandlerRow,
  type HandlerRun,
  type NormalizedEvent,
  type TypeSpec,
} from '@ascend/core';
import { loadHandler } from './handler-yaml.js';

/** The directory, under the project root, typed handlers are read from. */
export const HANDLERS_DIR = 'handlers';

export interface TypedHandler {
  readonly name: string;
  readonly handler: CompiledHandler & { readonly type: string };
}

export interface HandlerLoadFailure {
  readonly path: string;
  readonly message: string;
}

/** A handler that loaded from `handlers/`, named by its file. */
export interface ProjectHandler {
  readonly name: string;
  readonly handler: CompiledHandler;
}

/** A `say:` handler, with the lifecycle stage that delivers its trigger (asc-tuur.4). */
export interface SayHandler extends ProjectHandler {
  readonly stage: HookStage;
}

export interface ProjectHandlers {
  readonly typed: readonly TypedHandler[];
  readonly say: readonly SayHandler[];
  readonly failures: readonly HandlerLoadFailure[];
}

/**
 * The stage a say handler runs at, or a `HandlerError` naming why none can. Core accepts `say:` on
 * any kind, because core does not know which stages a harness has; this is where "a hook that
 * would never fire" is refused, for `asc handlers check` and for the loader alike.
 */
export function sayStage(handler: CompiledHandler): HookStage {
  const stage = stageForKind(handler.on);
  if (stage === undefined) {
    throw new HandlerError(
      `say: no lifecycle hook delivers ${handler.on}, so this handler would never run. ` +
        `A say handler triggers on one of: ${Object.values(HOOK_STAGES)
          .flatMap((one) => one.kinds)
          .join(', ')}`,
    );
  }
  return stage;
}

/**
 * Load every handler in `<projectRoot>/handlers`. Typed and say handlers are returned by role;
 * the rest only report, and are `asc handlers check`'s. A handler that does not load is a failure,
 * never a throw -- see the module doc.
 */
export function loadProjectHandlers(projectRoot: string): ProjectHandlers {
  const dir = join(projectRoot, HANDLERS_DIR);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((one) => /\.ya?ml$/.test(one))
      .sort();
  } catch (error) {
    // No handlers directory is the ordinary state of a project that never wrote one.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { typed: [], say: [], failures: [] };
    }
    throw error;
  }
  const typed: TypedHandler[] = [];
  const say: SayHandler[] = [];
  const failures: HandlerLoadFailure[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const name = basename(file).replace(/\.ya?ml$/, '');
    try {
      const handler = loadHandler(readFileSync(path, 'utf8'));
      if (handler.say) say.push({ name, handler, stage: sayStage(handler) });
      else if (handler.type !== undefined) {
        typed.push({ name, handler: { ...handler, type: handler.type } });
      }
    } catch (error) {
      if (!(error instanceof HandlerError)) throw error;
      failures.push({ path: join(HANDLERS_DIR, file), message: error.message });
    }
  }
  return { typed, say, failures };
}

/** What one typed handler did over the sweep. */
export interface TypedHandlerOutcome {
  readonly name: string;
  readonly type: string;
  readonly rows: number;
  readonly malformedItems: number;
  /** Rows dropped because another route already wrote this type in the session. */
  readonly superseded: number;
}

export interface HandlerProducer {
  accept(record: TranscriptRecord, file: TranscriptFile): void;
  /**
   * The entries, once the sweep is over. `reportedSessions` holds, per type, the sessions in which
   * the deriver wrote an entry of that type: a row of the same type from one of them is dropped,
   * because a reviewer who both reported and wrote a table would otherwise be counted twice. The
   * reported route wins because it is the one the reviewer structured on purpose.
   */
  finish(reportedSessions: ReadonlyMap<string, ReadonlySet<string>>): {
    readonly entries: readonly DerivedEntry[];
    readonly outcomes: readonly TypedHandlerOutcome[];
  };
}

/**
 * Run the typed handlers over the same records the deriver reads. `specFor` resolves a type's
 * spec -- a derived one or one the project registered -- so a row's values can be coerced to the
 * property types before validation, the way the deriver writes a number rather than its text.
 */
export function createHandlerProducer(
  handlers: readonly TypedHandler[],
  specFor: (type: string) => TypeSpec | undefined,
): HandlerProducer {
  const normalizer = createNormalizer();
  const runs = handlers.map((one) => ({
    ...one,
    run: runHandler(one.handler),
    rows: [] as HandlerRow[],
  }));
  /** Per session, the project label and the most recent locality its records carried. */
  const sessions = new Map<string, { project: string; cwd?: string; branch?: string }>();

  const offer = (event: NormalizedEvent): void => {
    for (const one of runs) one.rows.push(...one.run.accept(event));
  };

  const accept = (record: TranscriptRecord, file: TranscriptFile): void => {
    const session = typeof record['sessionId'] === 'string' ? record['sessionId'] : undefined;
    if (session !== undefined) {
      const known = sessions.get(session) ?? { project: file.project };
      const raw = typeof record['cwd'] === 'string' ? record['cwd'] : undefined;
      const cwd = raw === undefined ? undefined : projectRelativeCwd(file.project, raw);
      const branch = typeof record['gitBranch'] === 'string' ? record['gitBranch'] : undefined;
      sessions.set(session, {
        ...known,
        ...(cwd === undefined ? {} : { cwd }),
        ...(branch === undefined ? {} : { branch }),
      });
    }
    for (const event of normalizer.accept(record, file)) offer(event);
  };

  const finish: HandlerProducer['finish'] = (reportedSessions) => {
    for (const event of normalizer.drain()) offer(event);
    for (const one of runs) one.run.finish();
    const entries: DerivedEntry[] = [];
    const outcomes: TypedHandlerOutcome[] = [];
    for (const { name, handler, run, rows } of runs) {
      const spec = specFor(handler.type);
      const reported = reportedSessions.get(handler.type);
      let superseded = 0;
      for (const row of rows) {
        if (reported?.has(row.session_id) === true) {
          superseded += 1;
          continue;
        }
        entries.push(toEntry(name, handler, row, spec, sessions.get(row.session_id)));
      }
      outcomes.push(outcome(name, handler.type, rows.length, run, superseded));
    }
    return { entries, outcomes };
  };

  return { accept, finish };
}

function outcome(
  name: string,
  type: string,
  rows: number,
  run: HandlerRun,
  superseded: number,
): TypedHandlerOutcome {
  return { name, type, rows, malformedItems: run.malformedItems, superseded };
}

/** The part of the handler's hash that goes in the key: enough to tell two versions apart. */
export const HASH_IN_KEY = 12;

function toEntry(
  name: string,
  handler: TypedHandler['handler'],
  row: HandlerRow,
  spec: TypeSpec | undefined,
  session: { project: string; cwd?: string; branch?: string } | undefined,
): DerivedEntry {
  const declared = new Map((spec?.properties ?? []).map((one) => [one.name, one.type]));
  const properties: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row.fields)) {
    properties[field] = coerce(value, declared.get(field));
  }
  // The provenance a derived type declares, and ONLY if it declares it: a type the user defined
  // may not carry these, and an undeclared property is refused.
  if (declared.has('session_id')) properties['session_id'] = row.session_id;
  if (declared.has('project') && session !== undefined) properties['project'] = session.project;
  if (declared.has('occurred_at') && row.ts !== undefined) properties['occurred_at'] = row.ts;
  const item = row.item === undefined ? '' : `:${String(row.item)}`;
  return {
    type: handler.type,
    key: `${name}@${handler.hash.slice(0, HASH_IN_KEY)}:${row.session_id}:${row.event_id ?? ''}${item}`,
    source: DERIVED_SOURCE,
    occurredAt: row.ts,
    ...(session?.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session?.branch === undefined ? {} : { branch: session.branch }),
    properties,
  };
}

/**
 * A row's value is always text (every reference renders to a string); the store wants the type's
 * own. A value that does not read as the declared type is passed through as text, so validation
 * refuses it with the type's message rather than this function guessing a number.
 */
function coerce(value: string, type: string | undefined): unknown {
  if (
    (type === 'integer' || type === 'number' || type === 'duration') &&
    /^-?\d+(\.\d+)?$/.test(value)
  ) {
    return Number(value);
  }
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}
