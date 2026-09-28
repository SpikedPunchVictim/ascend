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
 * and an enum cell value that matches no enum value is listed rather than mapped to a guess.
 *
 * **Two readings a real report needed (asc-tuur.8).** Both measured on this repository's own
 * bug-hunt report, where the first draft wrote 0 of 17 rows (dogfood/0022):
 *
 *   - **A path property read out of a cell or a section.** A file-shaped property (its name, or
 *     its description's first sentence, says `file` or `path`) that no column is named for is
 *     looked for as a `path:line` at the start of a text column's cells, and else in the markdown
 *     section the row's first cell names -- the same `each.section` join the DSL runs. A `line`
 *     integer property rides along. Proposed only when some row actually yields one.
 *   - **An enum cell given as a number.** A report that names a lens `6` means the skill's Lens 6,
 *     and the skill says which that is: its text reaches the transcript when it loads, headed
 *     `### Lens 6: Time & Concurrency`. A number is mapped through the numbered headings of the
 *     skill loaded before the table -- only headings whose leading word is the column's own name,
 *     each matched to the one enum value whose words it covers. NOT by the number's position in
 *     the enum: that was tried first, and on `review_finding`, whose enum is alphabetical, it
 *     mapped 3 to `cross_implementation_divergence` (bug-hunt's Lens 3 is Boundary Conditions).
 *
 * Where
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
  eventFieldType,
  markdownSections,
  markdownTables,
  type NormalizedEvent,
  type PropertySpec,
  type TypeSpec,
} from '@ascend/core';

/** A value with case and every separator dropped, so `Sev 2`, `SEV-2` and `sev2` are one. */
const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

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
  /** For an enum property, the distinct cell values seen and how each maps, if it does. */
  readonly values: ReadonlyMap<string, ReadonlyMap<string, CellMapping | undefined>>;
  /** File-shaped properties no column supplies, and where a `path:line` for them was found. */
  readonly paths: readonly PathSignal[];
}

/** How an enum cell maps: which piece of it (`lookup`'s order), onto which value, and by what. */
export interface CellMapping {
  /** The lowercased text the draft's `maps:` entry is keyed on: the whole cell, or its piece. */
  readonly key: string;
  readonly value: string;
  /** `name`: the piece spells the value. `skill`: it is a number the named skill's headings define. */
  readonly by: 'name' | 'skill';
  /** The skill whose numbered headings the number was read through, when `by` is `skill`. */
  readonly skill?: string;
}

/** A skill's numbered headings for one column, as that column's enum values. */
interface Numbering {
  readonly skill: string;
  readonly values: ReadonlyMap<string, string>;
}

/** The first four letters of each word: enough that `Path` covers `paths`, `Impl` not `Imply`. */
const stems = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.slice(0, 4));

/**
 * `### Lens 6: Time & Concurrency` in a skill's text, for the column `lens`: 6 is the enum value
 * whose every word the heading covers, when exactly one value does. A heading no value, or two
 * values, fit is left out -- a number read through it would be a guess.
 */
export function numberedHeadings(
  text: string,
  column: string,
  enumValues: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const heading = /^#{1,6}\s+([A-Za-z]+)\s+(\d+)\s*[:.)-]\s*(.+)$/gm;
  for (const found of text.matchAll(heading)) {
    if (fold(found[1] ?? '') !== fold(column)) continue;
    const words = new Set(stems((found[3] ?? '').replace(/\*.*$/, '')));
    const fits = enumValues.filter((value) => stems(value).every((stem) => words.has(stem)));
    if (fits.length === 1 && fits[0] !== undefined) out.set(found[2] ?? '', fits[0]);
  }
  return out;
}

/** The text a skill's load puts in the transcript: a meta user record naming its directory. */
const SKILL_TEXT = /^Base directory for this skill:/;

/** Where a file-shaped property's `path:line` was found, per row of the tables that matched. */
export interface PathSignal {
  readonly property: string;
  /** The `line` integer property filled beside it, when the type has one. */
  readonly line: string | undefined;
  /** The text column whose cells most often START with a `path:line`, if any do. */
  readonly column: string | undefined;
  /** Rows the column supplies it for. */
  readonly fromCell: number;
  /** Rows the column does not, whose own section (`each.section`) does. */
  readonly fromSection: number;
  readonly rows: number;
}

/** A `path:line` at the start of a cell, past any backtick or bold marker. */
export const CELL_PATH = '^[`*]*([A-Za-z0-9_./-]+\\.[A-Za-z0-9]+):\\d+';
export const CELL_LINE = '^[`*]*[A-Za-z0-9_./-]+\\.[A-Za-z0-9]+:(\\d+)';
/** A `path:line` anywhere in a section: a path with a directory, or a bare `name.ext`. */
export const SECTION_PATH =
  '([A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\\.[A-Za-z0-9]+|[A-Za-z0-9_-]+\\.[a-z]{1,4}):\\d+';
export const SECTION_LINE =
  '(?:[A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\\.[A-Za-z0-9]+|[A-Za-z0-9_-]+\\.[a-z]{1,4}):(\\d+)';

const CELL_PATH_RE = new RegExp(CELL_PATH);
const SECTION_PATH_RE = new RegExp(SECTION_PATH);

/** The row's key as `each.section` reads it, for the planner's own join. */
const rowKey = (cell: string): string => cell.replace(/[`*#\s]/g, '').toLowerCase();

/**
 * How an enum cell maps, mirroring the runtime `map.` lookup's order -- the whole cell, its first
 * `,` piece, that piece's first `/` piece -- so the draft's map finds what the planner found.
 */
function mapCell(
  cell: string,
  enumValues: readonly string[],
  numbering: Numbering | undefined,
): CellMapping | undefined {
  const whole = cell.trim().toLowerCase();
  const first = (whole.split(',')[0] ?? '').trim();
  const firstOfFirst = (first.split('/')[0] ?? '').trim();
  const pieces = [whole, first, firstOfFirst];
  for (const piece of pieces) {
    const value = enumValues.find((one) => fold(one) === fold(piece));
    if (value !== undefined) return { key: piece, value, by: 'name' };
  }
  for (const piece of pieces) {
    const value = numbering?.values.get(piece);
    if (value !== undefined && numbering !== undefined) {
      return { key: piece, value, by: 'skill', skill: numbering.skill };
    }
  }
  return undefined;
}

/** Whether a property is file-shaped: `file`/`path` in its name or its description's opening. */
function isPathProperty(property: PropertySpec): boolean {
  if (property.type !== 'string') return false;
  const words = [...property.name.split('_'), ...firstSentenceWords(property).slice(0, 3)];
  return words.includes('file') || words.includes('path');
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

/** The most distinct values kept per enum column: enough to see the vocabulary, bounded. */
const MAX_VALUES = 40;

interface TableAccumulator {
  columns: ColumnMatch[];
  sessions: Set<string>;
  writes: number;
  rows: number;
  skills: Map<string, Set<string>>;
  values: Map<string, Map<string, CellMapping | undefined>>;
  /** Per file-shaped property: rows found per column cell, per section, and in all. */
  paths: Map<string, { cells: Map<string, number>; section: number; rows: number }>;
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
  const pathProperties = spec.properties.filter(isPathProperty).map((one) => one.name);
  const lineProperty = spec.properties.find(
    (one) => one.name === 'line' && one.type === 'integer',
  )?.name;
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
  /** The text of that skill, when its load put it in the transcript. */
  const skillText = new Map<string, { skill: string; text: string }>();

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
        values: new Map<string, Map<string, CellMapping | undefined>>(),
        paths: new Map<string, { cells: Map<string, number>; section: number; rows: number }>(),
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
        const seen = acc.values.get(property) ?? new Map<string, CellMapping | undefined>();
        const loaded = skillText.get(event.session_id);
        const numbering =
          loaded === undefined
            ? undefined
            : { skill: loaded.skill, values: numberedHeadings(loaded.text, column, enumValues) };
        for (const row of table.rows) {
          const cell = (row[index] ?? '').trim();
          if (cell === '' || seen.has(cell) || seen.size >= MAX_VALUES) continue;
          seen.set(cell, mapCell(cell, enumValues, numbering));
        }
        acc.values.set(property, seen);
      }
      const wanted = pathProperties.filter(
        (name) => !columns.some((column) => column.property === name),
      );
      if (wanted.length > 0) {
        const sections = markdownSections(after);
        const claimed = new Set(columns.map((one) => one.column));
        for (const name of wanted) {
          const found = acc.paths.get(name) ?? {
            cells: new Map<string, number>(),
            section: 0,
            rows: 0,
          };
          for (const row of table.rows) {
            found.rows += 1;
            let inCell = false;
            for (const [at, column] of table.header.entries()) {
              if (column === '' || !CELL_PATH_RE.test(row[at] ?? '')) continue;
              found.cells.set(column, (found.cells.get(column) ?? 0) + 1);
              if (claimed.has(column)) inCell = true;
            }
            const section = sections.get(rowKey(row[0] ?? ''));
            if (!inCell && section !== undefined && SECTION_PATH_RE.test(section)) {
              found.section += 1;
            }
          }
          acc.paths.set(name, found);
        }
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
    if (record['type'] === 'user' && record['isMeta'] === true) {
      const session =
        typeof record['sessionId'] === 'string' ? record['sessionId'] : (file.session ?? '');
      const skill = lastSkill.get(session);
      const message = record['message'];
      const content =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>)['content']
          : undefined;
      for (const block of Array.isArray(content) ? (content as unknown[]) : []) {
        const text =
          typeof block === 'object' && block !== null
            ? (block as Record<string, unknown>)['text']
            : undefined;
        if (skill !== undefined && typeof text === 'string' && SKILL_TEXT.test(text)) {
          skillText.set(session, { skill, text });
        }
      }
    }
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
      paths: [...acc.paths.entries()].map(([property, found]): PathSignal => {
        // The column the draft reads: a MATCHED column (it is the finding's own cell), the one
        // whose cells most often open with a path. The count the section join adds is for the
        // rows that column leaves.
        const best = [...found.cells.entries()]
          .filter(([column]) => acc.columns.some((one) => one.column === column))
          .sort((a, b) => b[1] - a[1])[0];
        return {
          property,
          line: lineProperty,
          column: best?.[0],
          fromCell: best?.[1] ?? 0,
          fromSection: found.section,
          rows: found.rows,
        };
      }),
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

/** A capture's name: the property's, unless a `file.changed` field already has it. */
const captureName = (property: string): string =>
  eventFieldType('file.changed', property) === undefined ? property : `${property}_found`;

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
  const paths = signal.paths.filter((one) => one.fromCell + one.fromSection > 0);
  const lines: string[] = [
    `# Drafted by \`asc types capture ${spec.name}\` -- review it before relying on it.`,
    `#`,
    `# Found in ${sessionsNote}: ${String(signal.writes)} Write(s) holding ${String(signal.rows)} table row(s).`,
    ...signal.columns.map(
      (one) =>
        `#   column ${one.column} -> ${one.property} (${one.how === 'name' ? 'same name' : "named in the property's description"})`,
    ),
    ...paths.map(
      (one) =>
        `#   ${one.property}: a path:line ${[
          one.column === undefined
            ? undefined
            : `opening the ${one.column} cell in ${String(one.fromCell)}`,
          one.fromSection > 0
            ? `in the row's own section in ${String(one.fromSection)}`
            : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(', and ')} of ${String(one.rows)} row(s)`,
    ),
  ];
  const filled = new Set(paths.map((one) => one.property));
  const refFill = signal.missing.filter((name) => properties.get(name)?.type === 'ref');
  const unfilled = signal.missing.filter((name) => !refFill.includes(name) && !filled.has(name));
  if (unfilled.length > 0) {
    lines.push(
      `#`,
      `# REQUIRED AND NOT IN THE TABLE: ${unfilled.join(', ')}. Every row is refused by the type until`,
      `# something supplies it -- a capture with a regex on another column, or a column the report adds.`,
    );
  }
  for (const [property, seen] of signal.values) {
    const unmapped = [...seen.entries()]
      .filter(([, mapping]) => mapping === undefined)
      .map(([cell]) => cell);
    if (unmapped.length > 0) {
      lines.push(
        `#`,
        `# ${property}: these cell values map to no enum value and are refused: ${unmapped.map(quote).join(', ')}`,
      );
    }
    const bySkill = [...seen.values()].filter(
      (mapping): mapping is CellMapping => mapping?.by === 'skill',
    );
    const skills = [...new Set(bySkill.map((one) => one.skill))];
    if (bySkill.length > 0) {
      lines.push(
        `#`,
        `# ${property}: number(s) ${bySkill.map((one) => quote(one.key)).join(', ')} read through the numbered headings of the`,
        `# skill ${skills.join(', ')}, loaded before the table.`,
      );
    }
  }
  const sectioned = paths.some((one) => one.fromSection > 0);
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
    ...(sectioned ? [`  section: section`] : []),
  );
  if (paths.length > 0) {
    lines.push(`capture:`);
    const sources = (one: PathSignal, cell: string, section: string): string[] => [
      ...(one.column === undefined
        ? []
        : [`    - field: row.${one.column}`, `      regex: ${quote(cell)}`]),
      ...(one.fromSection > 0
        ? [`    - field: row.section`, `      regex: ${quote(section)}`]
        : []),
    ];
    for (const one of paths) {
      lines.push(`  ${captureName(one.property)}:`, ...sources(one, CELL_PATH, SECTION_PATH));
    }
    const withLine = paths.find((one) => one.line !== undefined);
    if (
      withLine?.line !== undefined &&
      !signal.columns.some((one) => one.property === withLine.line)
    ) {
      lines.push(`  ${captureName(withLine.line)}:`, ...sources(withLine, CELL_LINE, SECTION_LINE));
    }
  }
  const maps = [...signal.values.entries()]
    .map(([property, seen]) => {
      const pairs = new Map<string, string>();
      for (const mapping of seen.values()) {
        if (mapping !== undefined && !pairs.has(mapping.key)) pairs.set(mapping.key, mapping.value);
      }
      return [property, [...pairs.entries()]] as const;
    })
    .filter(([, pairs]) => pairs.length > 0);
  if (maps.length > 0) {
    lines.push(`maps:`);
    for (const [property, pairs] of maps) {
      lines.push(`  ${property}:`);
      for (const [key, value] of pairs) lines.push(`    ${quote(key)}: ${value}`);
    }
  }
  lines.push(`emit:`);
  for (const { column, property } of signal.columns) {
    const mapped = maps.some(([name]) => name === property);
    lines.push(`  ${property}: ${quote(`\${row.${column}${mapped ? `|map.${property}` : ''}}`)}`);
  }
  for (const one of paths) {
    lines.push(`  ${one.property}: ${quote(`\${${captureName(one.property)}}`)}`);
  }
  const lineName = paths.find((one) => one.line !== undefined)?.line;
  if (lineName !== undefined && !signal.columns.some((one) => one.property === lineName)) {
    lines.push(`  ${lineName}: ${quote(`\${${captureName(lineName)}}`)}`);
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
  const filled = new Set(
    signal.paths.filter((one) => one.fromCell + one.fromSection > 0).map((one) => one.property),
  );
  const missing = signal.missing.filter(
    (name) => properties.get(name)?.type !== 'ref' && !filled.has(name),
  );
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
