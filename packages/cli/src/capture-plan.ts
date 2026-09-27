/**
 * A capture plan for a type: where in the corpus this type's data already appears, and a draft
 * handler that would read it from there (asc-tuur.5).
 *
 * This is the proactive half of asc-tuur. A user who defines a type should not also have to work
 * out how ascend is to fill it, so after a define ascend looks at what the workflow ALREADY writes
 * and proposes the handler. Nothing is written by this module: a draft is text, the caller decides
 * whether to save it, and a saved draft is reviewed code under `handlers/` like any other.
 *
 * **Two signals, and what each can propose.**
 *
 *   - **Tables.** A Write whose content holds a markdown table with columns that match the type's
 *     properties. The match is by name, or by the column's words appearing in the FIRST sentence
 *     of a property's description (`lens` in "Which lens found this"), each column claimed by the
 *     one property whose first sentence names it earliest. The handler DSL reads tables
 *     (`each: {table}`), so this signal proposes a full draft.
 *   - **Tool calls.** A tool call whose input (or an array of objects in it) carries keys named
 *     like the type's properties. REPORTED, NOT DRAFTED: the handler DSL does not read tool input
 *     yet, and a draft that could not run would be a proposal to be wrong.
 *
 * **What it cannot see is said, not guessed.** A required property no column matches is named in
 * the draft and in the plan -- the rows will be refused by the type until something supplies it --
 * and an enum cell value that matches no enum value is listed rather than mapped to a guess. Where
 * the type is missing only columns, the plan also drafts a `say:` handler for the skills that were
 * active when the tables were written, asking for exactly those columns: route B, aimed at the
 * gap route A left.
 *
 * Every signal carries its session count, and one seen in fewer than `MIN_N` sessions is flagged
 * as an anecdote by the caller.
 */

import {
  createNormalizer,
  type TranscriptFile,
  type TranscriptRecord,
} from '@ascend/adapter-claude-code';
import {
  markdownTables,
  type NormalizedEvent,
  type PropertySpec,
  type TypeSpec,
} from '@ascend/core';

/** Properties every derived type carries and no report would: never proposed from a column. */
const PROVENANCE = new Set(['session_id', 'project', 'occurred_at']);

/** A column read as one of the type's properties. */
export interface ColumnMatch {
  readonly column: string;
  readonly property: string;
  /** `name`: the column is the property's name. `description`: its first sentence names it. */
  readonly how: 'name' | 'description';
}

export interface TableSignal {
  /** The matched columns, which are also the header a handler would select the table by. */
  readonly columns: readonly ColumnMatch[];
  readonly sessions: number;
  readonly writes: number;
  readonly rows: number;
  /** The skill loaded most recently before each Write, by the number of sessions. */
  readonly skills: readonly { readonly skill: string; readonly sessions: number }[];
  /** Required properties no column matched. */
  readonly missing: readonly string[];
  /** For an enum property, the distinct cell values seen and the enum value each maps to. */
  readonly values: ReadonlyMap<string, ReadonlyMap<string, string | undefined>>;
}

export interface ToolSignal {
  readonly tool: string;
  /** Where the keys are: `input`, or `input.<field>[]` for an array of objects. */
  readonly at: string;
  readonly properties: readonly string[];
  readonly sessions: number;
  readonly calls: number;
}

export interface CapturePlan {
  readonly tables: readonly TableSignal[];
  readonly tools: readonly ToolSignal[];
}

/** The words of a property's description's first sentence, lowercased. */
function firstSentenceWords(property: PropertySpec): string[] {
  const text = property.description ?? '';
  const end = text.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? text : text.slice(0, end);
  return sentence
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Read a table's columns as properties: by name first, then by description, each column claimed
 * at most once and each property at most once.
 */
export function matchColumns(header: readonly string[], spec: TypeSpec): ColumnMatch[] {
  const properties = spec.properties.filter((one) => !PROVENANCE.has(one.name));
  const byName = new Map(properties.map((one) => [one.name, one]));
  const out: ColumnMatch[] = [];
  const claimed = new Set<string>();
  for (const column of header) {
    if (byName.has(column) && !claimed.has(column)) {
      out.push({ column, property: column, how: 'name' });
      claimed.add(column);
    }
  }
  const taken = new Set(out.map((one) => one.column));
  for (const column of header) {
    if (column === '' || taken.has(column)) continue;
    const words = column.split('_');
    let best: { property: string; at: number } | undefined;
    for (const property of properties) {
      if (claimed.has(property.name)) continue;
      const sentence = firstSentenceWords(property);
      const at = sentence.indexOf(words[0] ?? '');
      if (at === -1 || !words.every((word, index) => sentence[at + index] === word)) continue;
      if (best === undefined || at < best.at) best = { property: property.name, at };
    }
    if (best !== undefined) {
      out.push({ column, property: best.property, how: 'description' });
      claimed.add(best.property);
      taken.add(column);
    }
  }
  return out;
}

/** A value with case and every separator dropped, so `Sev 2`, `SEV-2` and `sev2` are one. */
const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The most distinct values kept per enum column: enough to see the vocabulary, bounded. */
const MAX_VALUES = 40;

interface TableAccumulator {
  columns: ColumnMatch[];
  sessions: Set<string>;
  writes: number;
  rows: number;
  skills: Map<string, Set<string>>;
  values: Map<string, Map<string, string | undefined>>;
}

export interface CapturePlanner {
  accept(record: TranscriptRecord, file: TranscriptFile): void;
  finish(): CapturePlan;
}

/** Scan records for where `spec`'s data already appears. */
export function createCapturePlanner(spec: TypeSpec): CapturePlanner {
  const normalizer = createNormalizer();
  const properties = new Map(spec.properties.map((one) => [one.name, one]));
  const names = new Set([...properties.keys()].filter((name) => !PROVENANCE.has(name)));
  const required = spec.properties.filter(
    (one) => one.required === true && !PROVENANCE.has(one.name),
  );
  const tables = new Map<string, TableAccumulator>();
  const tools = new Map<
    string,
    { tool: string; at: string; properties: string[]; sessions: Set<string>; calls: number }
  >();
  /**
   * The skill loaded most recently, per session: the one a Write is attributed to. Not every skill
   * loaded before it -- measured on this repository's corpus, that credited `find-skills` and
   * `cli-best-practices` with a bug-hunt report, and a say handler drafted from it would speak on
   * every one of them.
   */
  const lastSkill = new Map<string, string>();

  const onEvent = (event: NormalizedEvent): void => {
    if (event.kind === 'tool.use.start' && typeof event['skill'] === 'string') {
      lastSkill.set(event.session_id, event['skill']);
      return;
    }
    if (event.kind !== 'file.changed' || event['tool'] !== 'Write') return;
    const after = event['after'];
    if (typeof after !== 'string') return;
    for (const table of markdownTables(after)) {
      const columns = matchColumns(table.header, spec);
      if (columns.length < 2) continue;
      const key = columns.map((one) => `${one.column}=${one.property}`).join(',');
      const acc = tables.get(key) ?? {
        columns,
        sessions: new Set<string>(),
        writes: 0,
        rows: 0,
        skills: new Map<string, Set<string>>(),
        values: new Map<string, Map<string, string | undefined>>(),
      };
      acc.sessions.add(event.session_id);
      acc.writes += 1;
      acc.rows += table.rows.length;
      const skill = lastSkill.get(event.session_id);
      if (skill !== undefined) {
        const sessions = acc.skills.get(skill) ?? new Set<string>();
        sessions.add(event.session_id);
        acc.skills.set(skill, sessions);
      }
      for (const { column, property } of columns) {
        const enumValues = properties.get(property)?.enum_values;
        if (enumValues === undefined) continue;
        const index = table.header.indexOf(column);
        const seen = acc.values.get(property) ?? new Map<string, string | undefined>();
        for (const row of table.rows) {
          const cell = (row[index] ?? '').trim();
          if (cell === '' || seen.has(cell) || seen.size >= MAX_VALUES) continue;
          seen.set(
            cell,
            enumValues.find((one) => fold(one) === fold(cell)),
          );
        }
        acc.values.set(property, seen);
      }
      tables.set(key, acc);
    }
  };

  const onToolInput = (session: string, tool: string, input: Record<string, unknown>): void => {
    const places: [string, string[]][] = [['input', Object.keys(input)]];
    for (const [field, value] of Object.entries(input)) {
      if (!Array.isArray(value)) continue;
      const keys = new Set<string>();
      for (const element of value as unknown[]) {
        if (typeof element === 'object' && element !== null && !Array.isArray(element)) {
          for (const key of Object.keys(element)) keys.add(key);
        }
      }
      places.push([`input.${field}[]`, [...keys]]);
    }
    for (const [at, keys] of places) {
      const matched = keys.filter((key) => names.has(key)).sort();
      if (matched.length < 2) continue;
      const key = `${tool}\u0000${at}`;
      const acc = tools.get(key) ?? {
        tool,
        at,
        properties: matched,
        sessions: new Set<string>(),
        calls: 0,
      };
      acc.sessions.add(session);
      acc.calls += 1;
      tools.set(key, acc);
    }
  };

  const accept = (record: TranscriptRecord, file: TranscriptFile): void => {
    if (record['type'] === 'assistant') {
      const session =
        typeof record['sessionId'] === 'string' ? record['sessionId'] : (file.session ?? '');
      const message = record['message'];
      const content =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>)['content']
          : undefined;
      for (const block of Array.isArray(content) ? (content as unknown[]) : []) {
        if (typeof block !== 'object' || block === null) continue;
        const one = block as Record<string, unknown>;
        const input = one['input'];
        if (
          one['type'] === 'tool_use' &&
          typeof one['name'] === 'string' &&
          typeof input === 'object' &&
          input !== null
        ) {
          onToolInput(session, one['name'], input as Record<string, unknown>);
        }
      }
    }
    for (const event of normalizer.accept(record, file)) onEvent(event);
  };

  const finish = (): CapturePlan => {
    for (const event of normalizer.drain()) onEvent(event);
    const tableSignals = [...tables.values()].map((acc): TableSignal => ({
      columns: acc.columns,
      sessions: acc.sessions.size,
      writes: acc.writes,
      rows: acc.rows,
      skills: [...acc.skills.entries()]
        .map(([skill, sessions]) => ({ skill, sessions: sessions.size }))
        .sort((a, b) => b.sessions - a.sessions || a.skill.localeCompare(b.skill)),
      missing: required
        .map((one) => one.name)
        .filter((name) => !acc.columns.some((column) => column.property === name)),
      values: acc.values,
    }));
    tableSignals.sort((a, b) => b.sessions - a.sessions || b.rows - a.rows);
    const toolSignals = [...tools.values()]
      .map((acc): ToolSignal => ({
        tool: acc.tool,
        at: acc.at,
        properties: acc.properties,
        sessions: acc.sessions.size,
        calls: acc.calls,
      }))
      .sort((a, b) => b.sessions - a.sessions || b.calls - a.calls);
    return { tables: tableSignals, tools: toolSignals };
  };

  return { accept, finish };
}

const quote = (value: string): string => JSON.stringify(value);

/**
 * The draft handler for a table signal, as YAML text `asc handlers check` can load.
 *
 * A required `ref` property no column supplies is filled with the Write's own id, which is what a
 * parsed entry is keyed on anyway; any other missing required property is left out and NAMED, so
 * the draft's refusals are the reader's to see rather than hidden behind a guess.
 */
export function draftTableHandler(
  spec: TypeSpec,
  signal: TableSignal,
  sessionsNote: string,
): string {
  const properties = new Map(spec.properties.map((one) => [one.name, one]));
  const lines: string[] = [
    `# Drafted by \`asc types capture ${spec.name}\` -- review it before relying on it.`,
    `#`,
    `# Found in ${sessionsNote}: ${String(signal.writes)} Write(s) holding ${String(signal.rows)} table row(s).`,
    ...signal.columns.map(
      (one) =>
        `#   column ${one.column} -> ${one.property} (${one.how === 'name' ? 'same name' : "named in the property's description"})`,
    ),
  ];
  const refFill = signal.missing.filter((name) => properties.get(name)?.type === 'ref');
  const unfilled = signal.missing.filter((name) => !refFill.includes(name));
  if (unfilled.length > 0) {
    lines.push(
      `#`,
      `# REQUIRED AND NOT IN THE TABLE: ${unfilled.join(', ')}. Every row is refused by the type until`,
      `# something supplies it -- a capture with a regex on another column, or a column the report adds.`,
    );
  }
  for (const [property, seen] of signal.values) {
    const unmapped = [...seen.entries()]
      .filter(([, value]) => value === undefined)
      .map(([cell]) => cell);
    if (unmapped.length > 0) {
      lines.push(
        `#`,
        `# ${property}: these cell values map to no enum value and are refused: ${unmapped.map(quote).join(', ')}`,
      );
    }
  }
  lines.push(
    `type: ${spec.name}`,
    `on: file.changed`,
    `description: ${quote(`${spec.name} rows read from a table with columns ${signal.columns.map((one) => one.column).join(', ')}.`)}`,
    `where:`,
    `  tool: Write`,
    `each:`,
    `  table: after`,
    `  header: [${signal.columns.map((one) => one.column).join(', ')}]`,
    `  as: row`,
  );
  const maps = [...signal.values.entries()]
    .map(
      ([property, seen]) =>
        [
          property,
          [...seen.entries()].filter((pair): pair is [string, string] => pair[1] !== undefined),
        ] as const,
    )
    .filter(([, pairs]) => pairs.length > 0);
  if (maps.length > 0) {
    lines.push(`maps:`);
    for (const [property, pairs] of maps) {
      lines.push(`  ${property}:`);
      for (const [cell, value] of pairs) lines.push(`    ${quote(cell.toLowerCase())}: ${value}`);
    }
  }
  lines.push(`emit:`);
  for (const { column, property } of signal.columns) {
    const mapped = maps.some(([name]) => name === property);
    lines.push(`  ${property}: ${quote(`\${row.${column}${mapped ? `|map.${property}` : ''}}`)}`);
  }
  for (const name of refFill) lines.push(`  ${name}: ${quote('${id}')}`);
  const capturedBy = properties.get('captured_by')?.enum_values;
  if (capturedBy?.includes('parsed') === true) lines.push(`  captured_by: parsed`);
  return `${lines.join('\n')}\n`;
}

/**
 * The draft `say:` handler that asks, when the skills behind a table load, for the required
 * columns the table lacks. `undefined` when nothing is missing or no skill was seen.
 */
export function draftSayHandler(spec: TypeSpec, signal: TableSignal): string | undefined {
  const properties = new Map(spec.properties.map((one) => [one.name, one]));
  const missing = signal.missing.filter((name) => properties.get(name)?.type !== 'ref');
  const skills = signal.skills.map((one) => one.skill);
  if (missing.length === 0 || skills.length === 0) return undefined;
  const columns = signal.columns.map((one) => one.column).join(', ');
  return [
    `# Drafted by \`asc types capture ${spec.name}\` -- review it before relying on it.`,
    `# Asks for the required column(s) the ${columns} table lacks, when a skill that wrote it loads.`,
    `on: tool.use.start`,
    `where:`,
    `  tool: Skill`,
    `  skill:`,
    `    in: [${skills.join(', ')}]`,
    `say: ${quote(
      `ascend records ${spec.name} from the table with columns ${columns} in the report you write. ` +
        `Give that table a column for each of: ${missing.join(', ')}.`,
    )}`,
    '',
  ].join('\n');
}
