/**
 * Redaction at the EXPORT BOUNDARY: what `asc export` discloses about the operator, and how a
 * corpus is rewritten so it no longer does.
 *
 * **Why the boundary, and not the write path or a hash.** The store records what actually
 * happened -- an absolute `cwd`, a dash-encoded project label, the MCP servers and skills a
 * session used -- because that is the truth of the run and every other feature in this package
 * (`asc query`, `asc stats`, `asc kappa`) depends on it staying that way. `asc export` is the one
 * place that truth leaves the machine, so it is the one place the decision belongs. Hashing a
 * label instead of tokenising it was considered and rejected: a project root is a small,
 * guessable string (`/Users/<name>/...`, `/home/<name>/...`), so a hash of it is a dictionary
 * attack away from being the label again, and it would still change on every export of the same
 * project -- buying neither secrecy nor stability.
 *
 * **What this module is not.** It does not decide WHICH server or skill names are sensitive --
 * that is the operator's call, made once per export and passed in as `options.names`. It does not
 * touch `commands/export.ts`, does not do I/O, and never fabricates a value it cannot recover: a
 * `cwd` this module cannot express relatively is dropped to `null` and counted, never guessed.
 *
 * **Type lines carry no identity and pass through untouched.** Measured 2026-09-20 on this
 * project's own store: 0 of 12 `type` lines contain the operator's name in any field. A type
 * document describes a SHAPE (property names and kinds), not a recorded fact, so there is nothing
 * in one for this module to find. That is also why there is no `type_hash` cascade here the way
 * there is a `scheme_hash` one below -- rewriting nothing needs no re-hash.
 */

import { schemeHash } from '@ascend/store';
import { projectRelativeCwd } from '@ascend/adapter-claude-code';
import type { CorpusLine, EntryLine } from './corpus.js';

/** A value the stream discloses, and the number of LINES that carry it. */
export interface DisclosedValue {
  readonly value: string;
  readonly lines: number;
}

/** The three vocabulary classes a record discloses, each in first-seen order. */
export interface DisclosedVocabulary {
  readonly projects: readonly DisclosedValue[];
  readonly servers: readonly DisclosedValue[];
  readonly skills: readonly DisclosedValue[];
}

/**
 * What a whole corpus STREAM discloses: the three vocabulary classes, plus a count only a stream
 * can produce.
 *
 * `homePathLines` is deliberately not on `DisclosedVocabulary`. It is a property of LINES, and a
 * caller holding loose records (`identityVocabularyOf`) can only see the fields `Disclosing`
 * carries -- so the same field name would mean two different things depending on which function
 * returned it. Measured 2026-09-20 on this project's own store, that difference is 1,806 lines
 * against 1,800: the narrow view cannot see the 5 `type` lines whose prose contains a
 * documentation placeholder, and -- the one that matters -- cannot see the 1 `scheme` line whose
 * recorded SQL names four real project labels. A disclosure count blind to the one line carrying
 * the labels this module exists to remove would be worse than no count, so the narrow caller does
 * not get to return this field at all.
 */
export interface IdentityVocabulary extends DisclosedVocabulary {
  /** Lines carrying an absolute home-shaped path anywhere in their content, of ANY kind. */
  readonly homePathLines: number;
}

export interface RedactionMap {
  /** project label -> 'project-01' */
  readonly projects: ReadonlyMap<string, string>;
  /** MCP server name -> 'server-01' */
  readonly servers: ReadonlyMap<string, string>;
  /** skill name -> 'skill-01' */
  readonly skills: ReadonlyMap<string, string>;
}

export interface RedactionResult {
  readonly lines: readonly CorpusLine[];
  /** Lines still matching a home-path pattern after rewriting. Reported, never hidden. */
  readonly residueLines: number;
  /** Entry lines whose cwd could not be rewritten by any stated rule and was dropped to null. */
  readonly cwdOmitted: number;
}

/**
 * A home-shaped absolute path, wherever it turns up.
 *
 * Both separators, because the label encoding this module reads (`EntryLine.properties['project']`)
 * has already replaced `/` with `-` by the time an entry reaches this module -- `-Users-` is what
 * `/Users/` looks like after that encoding, not a different disclosure. Both roots, because the
 * store this reads from is not always macOS: `/home/` and `-home-` are the same pair for Linux.
 */
const HOME_PATH_PATTERN = /\/Users\/|-Users-|\/home\/|-home-/;

/** A plain JSON object, as opposed to an array, a string, or any other scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether any string reachable from `value` matches `pattern`, walking arrays and plain objects
 * without limit.
 *
 * Used twice, for two different questions over the same shape: `identityVocabulary` asks it of the
 * RAW line (does this stream disclose a home path at all), and `redactLines` asks it of the
 * REWRITTEN line (did the rewrite actually remove it). One function answers both, because the
 * question -- "is a home path reachable from here" -- does not change; only which line is handed
 * to it does.
 */
function someStringMatches(value: unknown, pattern: RegExp): boolean {
  if (typeof value === 'string') return pattern.test(value);
  if (Array.isArray(value)) return value.some((item) => someStringMatches(item, pattern));
  if (isPlainObject(value))
    return Object.values(value).some((item) => someStringMatches(item, pattern));
  return false;
}

/**
 * One (label, token) pair, as the order `redactLines` applies them in. A plain 2-tuple rather than
 * `RedactionMap`'s own `Map` entries, because the replacement order is NOT the map's first-seen
 * order (see `orderedProjectReplacements`) and giving it a distinct type keeps the two from being
 * confused at a call site.
 */
type Replacement = readonly [label: string, token: string];

/**
 * Every mapped project label, longest first.
 *
 * A shorter label can be a genuine PREFIX of a longer, unrelated one -- `-Users-alice-app` is a
 * prefix of `-Users-alice-app2`, two different projects that happen to share a root segment.
 * Replacing the shorter one first would carve its token out of the middle of the longer label's
 * own text, and the longer label's own substitution would then never find an intact match to
 * replace. Longest-first guarantees a label is only ever matched against text that has not
 * already been partially consumed by a different label's replacement.
 */
function orderedProjectReplacements(projects: ReadonlyMap<string, string>): readonly Replacement[] {
  return [...projects.entries()].sort(([a], [b]) => b.length - a.length);
}

/** `text`, with every occurrence of every mapped label replaced by its token, in one pass each. */
function replaceLabels(text: string, replacements: readonly Replacement[]): string {
  let result = text;
  for (const [label, token] of replacements) {
    result = result.split(label).join(token);
  }
  return result;
}

/** `value`, with every string reachable from it (through arrays and plain objects) label-replaced. */
function deepReplaceLabels(value: unknown, replacements: readonly Replacement[]): unknown {
  if (typeof value === 'string') return replaceLabels(value, replacements);
  if (Array.isArray(value)) return value.map((item) => deepReplaceLabels(item, replacements));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepReplaceLabels(item, replacements)]),
    );
  }
  return value;
}

/**
 * The `<server>`, `<tool>` pair inside an identifier of the shape `mcp__<server>__<tool>`, or
 * `undefined` for anything else -- including a non-`mcp__` identifier, which this module never
 * touches.
 *
 * Split on the FIRST `__` after the `mcp__` prefix, not the last. Server names in the wild use
 * hyphens (`claude-in-chrome`) and tool names use single underscores (`browser_batch`); `__`
 * itself is the delimiter the transport reserves, so the first occurrence of it is where the
 * server segment ends, however many single underscores the tool name goes on to contain.
 */
function parseMcpIdentifier(
  id: string,
): { readonly server: string; readonly tool: string } | undefined {
  const prefix = 'mcp__';
  if (!id.startsWith(prefix)) return undefined;

  const rest = id.slice(prefix.length);
  const separator = rest.indexOf('__');
  if (separator === -1) return undefined;

  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (server === '' || tool === '') return undefined;

  return { server, tool };
}

/** Every server segment an entry's `tool_name` and `discovered_tools` disclose, in that order. */
function serversIn(properties: Readonly<Record<string, unknown>>): readonly string[] {
  const servers: string[] = [];

  const toolName = properties['tool_name'];
  if (typeof toolName === 'string') {
    const parsed = parseMcpIdentifier(toolName);
    if (parsed !== undefined) servers.push(parsed.server);
  }

  const discovered = properties['discovered_tools'];
  if (Array.isArray(discovered)) {
    for (const item of discovered) {
      if (typeof item !== 'string') continue;
      const parsed = parseMcpIdentifier(item);
      if (parsed !== undefined) servers.push(parsed.server);
    }
  }

  return servers;
}

/**
 * Every value `valuesOf` reports over `records`, in first-seen order, counted by the number of
 * DISTINCT RECORDS that reported it -- not the number of times it was reported, so a record
 * naming the same server twice (once in `tool_name`, once in `discovered_tools`) counts once.
 *
 * Takes bare `properties` rather than a `Disclosing` or a `CorpusLine`, because that is the only
 * field either caller's records agree on: `identityVocabularyOf` filters nothing (a `Disclosing`
 * carries no `kind`), so the entry-line filter that used to live in this function moved to each
 * caller, which is the one place that knows what shape it started from.
 */
function disclosedValuesOf(
  records: readonly Readonly<Record<string, unknown>>[],
  valuesOf: (properties: Readonly<Record<string, unknown>>) => readonly string[],
): readonly DisclosedValue[] {
  const order: string[] = [];
  const counts = new Map<string, number>();

  for (const properties of records) {
    const distinct = new Set(valuesOf(properties));
    for (const value of distinct) {
      const previous = counts.get(value);
      if (previous === undefined) order.push(value);
      counts.set(value, (previous ?? 0) + 1);
    }
  }

  return order.map((value) => ({ value, lines: counts.get(value) ?? 0 }));
}

function projectOf(properties: Readonly<Record<string, unknown>>): readonly string[] {
  const project = properties['project'];
  return typeof project === 'string' ? [project] : [];
}

function skillOf(properties: Readonly<Record<string, unknown>>): readonly string[] {
  const skill = properties['skill'];
  return typeof skill === 'string' ? [skill] : [];
}

/**
 * The parts of a record this module can read identity out of, whatever shape carries them.
 *
 * A structural type rather than an import of `CorpusLine`, because the two callers this module
 * has do not share a concrete shape: `identityVocabulary` reads an EXPORTED `EntryLine`, and
 * `asc ingest claude-code`'s report reads a `DerivedEntry` (`packages/adapter-claude-code/src/
 * derive.ts:50`) -- a corpus that has not been written yet, and so has no `CorpusLine` to be.
 * Both carry `properties`; both carry a `cwd` and a free-text field under a different name
 * (`evidence_text` vs `evidenceText`), which is why `text` exists as this interface's own name
 * for it rather than committing to either caller's spelling. `null` is accepted alongside
 * `undefined` on both optional fields so a caller whose own field is typed `string | null`
 * (`EntryLine.cwd`) can pass it straight through without a conversion that would exist only to
 * satisfy this interface.
 */
export interface Disclosing {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly cwd?: string | null;
  readonly text?: string | null;
}

/**
 * What a set of records discloses about its operator, by class -- independent of what anyone
 * intends to redact, and independent of what shape carries the records. `buildRedactionMap`'s
 * `names` option narrows servers and skills down to what the operator chose; this function
 * answers the prior question, "what is there to choose from", which is why it takes no such
 * option.
 *
 * `homePathLines` here is narrower than `identityVocabulary`'s: it can only see what `Disclosing`
 * carries (`properties`, `cwd`, `text`), never an envelope field outside that shape -- `actor`,
 * `branch`, `workflow`, a scheme's `query`. A `DerivedEntry` has no such fields to leak in the
 * first place (`derive.ts`'s own doc: the envelope columns it sets are `cwd`, `branch`, and the
 * one type whose `evidenceText` is prose), so for ingest's report this is not a narrowing in
 * practice, only in principle -- and stating the difference here is cheaper than a caller
 * discovering it by comparing two counts that do not agree.
 */
export function identityVocabularyOf(records: readonly Disclosing[]): DisclosedVocabulary {
  const properties = records.map((record) => record.properties);

  return {
    projects: disclosedValuesOf(properties, projectOf),
    servers: disclosedValuesOf(properties, serversIn),
    skills: disclosedValuesOf(properties, skillOf),
  };
}

/**
 * `identityVocabularyOf`, specialised to a corpus stream: filters to entry lines (a `type`,
 * `scheme` or `annotation` line carries no `project`/`server`/`skill` vocabulary by this module's
 * own rules, stated at each of `projectOf`/`serversIn`/`skillOf`'s call sites), maps each to the
 * fields `Disclosing` can carry, and delegates.
 *
 * `homePathLines` is NOT delegated, and it is counted over EVERY line rather than over the entry
 * lines this function filtered down to. The vocabulary classes are an entry-line property; a home
 * path is not. Measured 2026-09-20 on this project's own store: 1,806 lines match a home-shaped
 * path, and 6 of them are not entries -- 5 `type` lines whose prose carries a documentation
 * placeholder, and 1 `scheme` line whose recorded SQL names four real project labels. Counting
 * only entry lines would return 1,800 and would be blind to exactly the line that motivated this
 * module, so the scan stays over `lines`, not over `entryLines`.
 */
export function identityVocabulary(lines: readonly CorpusLine[]): IdentityVocabulary {
  const entryLines = lines.filter((line): line is EntryLine => line.kind === 'entry');

  const vocab = identityVocabularyOf(
    entryLines.map((line) => ({
      properties: line.properties,
      cwd: line.cwd,
      text: line.evidence_text,
    })),
  );

  return {
    ...vocab,
    homePathLines: lines.filter((line) => someStringMatches(line, HOME_PATH_PATTERN)).length,
  };
}

/**
 * Every value `valuesOf` reports for an entry line, over the whole stream, in FIRST-SEEN order,
 * restricted to those `allow` accepts. `allow` is where `buildRedactionMap` draws the line
 * between "disclosed" (`identityVocabulary`, no filter) and "the operator chose to redact this"
 * (this function, called once per class below).
 */
function firstSeenAllowed(
  lines: readonly CorpusLine[],
  valuesOf: (properties: Readonly<Record<string, unknown>>) => readonly string[],
  allow: (value: string) => boolean,
): readonly string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  for (const line of lines) {
    if (line.kind !== 'entry') continue;
    for (const value of valuesOf(line.properties)) {
      if (!allow(value) || seen.has(value)) continue;
      seen.add(value);
      order.push(value);
    }
  }

  return order;
}

/**
 * `values`, tokenised `${prefix}-NN`, `NN` zero-padded to the digit width of `values.length` --
 * 14 entries pad to 2 digits (`project-01` .. `project-14`), 9 pad to 1 (`server-1` .. `server-9`).
 * A `Map` rather than a digest: injective by construction, since a `Map` cannot assign the same
 * key to two different values, and two different labels are always two different keys.
 */
function allocateTokens(prefix: string, values: readonly string[]): ReadonlyMap<string, string> {
  const width = String(values.length).length;
  const map = new Map<string, string>();
  values.forEach((value, index) => {
    map.set(value, `${prefix}-${String(index + 1).padStart(width, '0')}`);
  });
  return map;
}

/**
 * The redaction map for one export: every project label (always redacted -- a project root is
 * identifying by construction, and there is no version of `asc export` that should carry it
 * unasked), plus the server and skill names the OPERATOR named in `options.names`.
 *
 * Token allocation is a pure function of `lines`'s own order (see `corpus.ts`'s module doc: the
 * stream is already ordered by a foreign-key contract, so first-seen order over the array is
 * already stable) -- nothing here sorts, hashes, or reads the clock.
 */
export function buildRedactionMap(
  lines: readonly CorpusLine[],
  options: { readonly names: readonly string[] },
): RedactionMap {
  const chosen = new Set(options.names);

  return {
    projects: allocateTokens(
      'project',
      firstSeenAllowed(lines, projectOf, () => true),
    ),
    servers: allocateTokens(
      'server',
      firstSeenAllowed(lines, serversIn, (name) => chosen.has(name)),
    ),
    skills: allocateTokens(
      'skill',
      firstSeenAllowed(lines, skillOf, (name) => chosen.has(name)),
    ),
  };
}

/** Per-server tool-name -> token allocation, built lazily as `redactLines` walks the stream. */
class ToolTokens {
  private readonly byServer = new Map<string, Map<string, string>>();

  /** The token for `tool` under `server`, allocating `tool-1`, `tool-2`, ... on first sight. */
  tokenFor(server: string, tool: string): string {
    let tools = this.byServer.get(server);
    if (tools === undefined) {
      tools = new Map<string, string>();
      this.byServer.set(server, tools);
    }

    const existing = tools.get(tool);
    if (existing !== undefined) return existing;

    const token = `tool-${String(tools.size + 1)}`;
    tools.set(tool, token);
    return token;
  }
}

/**
 * `id`, rewritten to `mcp__<serverToken>__<toolToken>` when its server is mapped, left untouched
 * otherwise (a non-`mcp__` identifier, or an `mcp__` one whose server the operator did not name).
 *
 * A private server's own tool names are as disclosing as the server name itself -- `discovered_tools`
 * from an internal server can spell out what it does -- so tokenising the server and leaving its
 * tools as plain text would still leak. `toolTokens` is shared across every call from one
 * `redactLines` run, so the same `(server, tool)` pair gets the same token everywhere it appears.
 */
function rewriteToolIdentifier(id: string, map: RedactionMap, toolTokens: ToolTokens): string {
  const parsed = parseMcpIdentifier(id);
  if (parsed === undefined) return id;

  const serverToken = map.servers.get(parsed.server);
  if (serverToken === undefined) return id;

  const toolToken = toolTokens.tokenFor(parsed.server, parsed.tool);
  return `mcp__${serverToken}__${toolToken}`;
}

/**
 * `properties`, with `tool_name` / `discovered_tools` / `skill` tokenised.
 *
 * Project labels are NOT replaced here. They are replaced once, at the whole-line level in
 * `redactLines`, because a label is an exact string that may appear in any field -- see that
 * function's doc for why an enumerated list of fields was the wrong shape for that rule. This
 * function handles only the vocabulary classes, which ARE field-specific: a server name is
 * meaningful inside `tool_name` and `discovered_tools` and nowhere else.
 */
function tokeniseVocabulary(
  properties: Readonly<Record<string, unknown>>,
  map: RedactionMap,
  toolTokens: ToolTokens,
): Record<string, unknown> {
  const rewritten = properties;
  const out: Record<string, unknown> = { ...rewritten };

  const toolName = rewritten['tool_name'];
  if (typeof toolName === 'string') {
    out['tool_name'] = rewriteToolIdentifier(toolName, map, toolTokens);
  }

  const discovered = rewritten['discovered_tools'];
  if (Array.isArray(discovered)) {
    // `Array.isArray` narrows to `any[]`, not `unknown[]` -- an explicit cast keeps `item` from
    // being `any` in the callback below, which is what `@typescript-eslint/no-unsafe-return`
    // objects to when the untouched branch returns it as-is.
    out['discovered_tools'] = (discovered as readonly unknown[]).map((item) =>
      typeof item === 'string' ? rewriteToolIdentifier(item, map, toolTokens) : item,
    );
  }

  const skill = rewritten['skill'];
  if (typeof skill === 'string') {
    const skillToken = map.skills.get(skill);
    if (skillToken !== undefined) out['skill'] = skillToken;
  }

  return out;
}

/** `root`, minus its own trailing slash if it had one -- so a caller-supplied `root/` and `root` agree. */
function withoutTrailingSlash(root: string): string {
  return root.endsWith('/') && root !== '/' ? root.slice(0, -1) : root;
}

/**
 * `cwd`'s POSIX-relative spelling under `root`, or `undefined` when `cwd` is not `root` itself and
 * not below it. The root itself is spelled `'.'`, never `''` -- the store's CHECK constraint on
 * `cwd` refuses an empty string, and `'.'` is what every other POSIX tool spells "here" as.
 */
function relativeUnderRoot(root: string, cwd: string): string | undefined {
  const normalizedRoot = withoutTrailingSlash(root);
  if (cwd === normalizedRoot) return '.';
  const prefix = normalizedRoot === '' ? '/' : `${normalizedRoot}/`;
  return cwd.startsWith(prefix) ? cwd.slice(prefix.length) : undefined;
}

/**
 * One entry's `cwd`, made relative rather than tokenised (`cwd` is a PATH, not a name from a fixed
 * vocabulary, so there is no label to allocate a token for) -- in the five steps the module doc
 * states, in order:
 *
 *  1. `null` stays `null` -- not recorded is not a disclosure.
 *  2. Already relative (does not start with `/`) is left alone.
 *  3. `rawProject` (the entry's OWN, unrewritten `properties['project']`) decodes `cwd` via
 *     `projectRelativeCwd` -- checked BEFORE the export's own root, because a derived entry can
 *     belong to a different project than the store it landed in, and that entry's own label is
 *     the correct root for ITS `cwd`, not the store's.
 *  4. Otherwise, `cwd` at or under the store's own `projectRoot` becomes relative to that.
 *  5. Otherwise, `cwd` cannot be expressed relatively without disclosing a directory outside
 *     either root, so it is dropped to `null` and counted -- never guessed.
 */
function rewriteCwd(
  cwd: string | null,
  rawProject: unknown,
  projectRoot: string,
  onOmitted: () => void,
): string | null {
  if (cwd === null) return null;
  if (!cwd.startsWith('/')) return cwd;

  if (typeof rawProject === 'string') {
    const relative = projectRelativeCwd(rawProject, cwd);
    if (relative !== undefined) return relative;
  }

  const relative = relativeUnderRoot(projectRoot, cwd);
  if (relative !== undefined) return relative;

  onOmitted();
  return null;
}

/**
 * Rewrite a corpus stream against a redaction map already built for it (`buildRedactionMap`).
 *
 * **A mapped label is replaced in EVERY string a line reaches, not in a list of fields.** That is
 * a rule rather than an enumeration on purpose. Measured 2026-09-20 on this project's own store,
 * a label appears literally in exactly two places -- `properties.project` (1,702 lines) and a
 * scheme rule's `query` (3) -- so an enumeration of those two would be correct TODAY and correct
 * only because of what the corpus happens to contain. An annotation note, an `actor`, a `branch`
 * or a nested property is free text that can carry one tomorrow, and a leak this module failed to
 * rewrite would still be counted by its own `residueLines` -- reported, but already written. A
 * label is an exact, known-identity string, so replacing it wherever it occurs costs nothing and
 * closes the class. `cwd` is the single exception, for the reason stated at its call site.
 *
 * Pure: the same `lines`, `map` and `options` always produce the same `RedactionResult`, because
 * every step is a function of its arguments -- no I/O, no clock, no randomness, and per-server
 * tool-token allocation is seeded fresh on every call (`ToolTokens` is local to this function).
 */
export function redactLines(
  lines: readonly CorpusLine[],
  map: RedactionMap,
  options: { readonly projectRoot: string },
): RedactionResult {
  const projectReplacements = orderedProjectReplacements(map.projects);
  const toolTokens = new ToolTokens();
  let cwdOmitted = 0;

  const rewritten = lines.map((line): CorpusLine => {
    if (line.kind === 'entry') {
      // `cwd` is computed from the RAW line, BEFORE any substitution. `projectRelativeCwd` matches
      // the label's characters against `cwd`'s own, so a `cwd` whose text had already been
      // rewritten would no longer decode -- and it is excluded from the substitution below because
      // it is a PATH, handled by relativising rather than by replacing.
      const cwd = rewriteCwd(line.cwd, line.properties['project'], options.projectRoot, () => {
        cwdOmitted += 1;
      });

      const replaced = deepReplaceLabels(
        { ...line, cwd: null },
        projectReplacements,
      ) as typeof line;

      return {
        ...replaced,
        properties: tokeniseVocabulary(replaced.properties, map, toolTokens),
        cwd,
      };
    }

    if (line.kind === 'scheme') {
      const replaced = deepReplaceLabels(line, projectReplacements) as typeof line;
      // `scheme_hash` is the line's own claim about `spec` (`corpus.ts`'s `SchemeLine` doc), and
      // `import` refuses a line whose hash disagrees with its spec (`verifySchemeLine`). Rewriting
      // a rule's query without recomputing this would export a line that fails its own integrity
      // check on the very next `asc import`.
      return { ...replaced, scheme_hash: schemeHash(replaced.spec) };
    }

    if (line.kind === 'annotation') {
      // An annotation's `note` is free text a person or an agent wrote, so it is exactly the kind
      // of field a label turns up in unannounced. Measured 2026-09-20 on this project's store: 0
      // of 747 annotations carry a note at all, so this rewrites nothing today -- which is the
      // reason to state the rule now, while it costs one line, rather than after a corpus exists
      // that needed it.
      return deepReplaceLabels(line, projectReplacements) as typeof line;
    }

    // `type` lines pass through untouched -- see the module doc: they describe a SHAPE, 0 of 12
    // carry the operator's name, and rewriting one would force a `type_hash` cascade through every
    // entry that names it.
    return line;
  });

  return {
    lines: rewritten,
    residueLines: rewritten.filter((line) => someStringMatches(line, HOME_PATH_PATTERN)).length,
    cwdOmitted,
  };
}
