/**
 * `asc types capture <name>` -- find where a type's data already appears in this project's
 * transcripts, and draft the handler that would capture it from there (asc-tuur.5).
 *
 * The proactive half of asc-tuur: a user who defines a type is shown how ascend would fill it
 * without their workflow changing, and `asc types define` points here as soon as a type is new.
 * The planning is `capture-plan.ts`'s; this command streams the corpus, prints the plan, and
 * VERIFIES the draft by running it -- the draft is compiled, replayed over the same transcripts
 * through the typed-handler path ingest uses, and every row validated against the type -- so a
 * proposal arrives with the count it would write and the count the type would refuse, rather
 * than as a guess.
 *
 * Read-only unless `--write`, which saves the drafts into `handlers/` and refuses to replace a
 * file already there. A saved draft is then an ordinary handler: `asc ingest claude-code` runs
 * it, and `asc install-hook` installs the stage a drafted `say:` handler needs.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { defaultTranscriptRoot } from '@ascend/adapter-claude-code';
import { BaseCommand } from '../../base.js';
import { type CapturePlan } from '../../capture-plan.js';
import { sweepCapture, sessionsNote, type Verification } from '../../capture-sweep.js';
import { refusal } from '../../errors.js';
import { encodeProjectDir } from '../../handler-replay.js';
import { describedProperties } from '../../property-shape.js';
import { requireType } from '../../type-lookup.js';
import { HANDLERS_DIR } from '../../typed-handlers.js';

const SIGNAL = 'signal';
const FIELD = 'field';
const VALUE = 'value';
type Row = Readonly<Record<typeof SIGNAL | typeof FIELD | typeof VALUE, unknown>>;

export default class TypesCapture extends BaseCommand {
  static override description =
    'Find where a type’s data already appears in this project’s Claude Code transcripts, and ' +
    'draft a handler that would capture it from there. Writes nothing unless --write.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review_finding',
    '<%= config.bin %> <%= command.id %> review_finding --write',
  ];

  static override args = {
    name: Args.string({
      description: 'The type to plan capture for.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    root: Flags.string({
      description: 'The directory holding transcript projects. Defaults to ~/.claude/projects.',
    }),
    project: Flags.string({
      description:
        'The transcript directory name to read, e.g. -Users-me-projects-app. Defaults to this ' +
        'project’s own.',
    }),
    write: Flags.boolean({
      description: `Save the drafts into ${HANDLERS_DIR}/, refusing to replace a file already there.`,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(TypesCapture);
    const format = this.resolveFormat(flags);
    const write = this.flagValue(flags.write);
    const root = resolve(this.optionalFlag(flags.root) ?? defaultTranscriptRoot());

    await this.withProject(async (project) => {
      const row = requireType(project.store, args.name);
      // Matching reads property descriptions, which may sit in the type's prose (`types show`).
      const spec = { ...row.spec, properties: describedProperties(row.spec.properties, row.prose) };
      const transcripts = this.optionalFlag(flags.project) ?? encodeProjectDir(project.root);
      const options = { root, projects: new Set([transcripts]), includeEphemeral: true };

      const { files: scanned, plan, table, say, verified } = await sweepCapture(spec, options);
      if (scanned === 0) {
        throw refusal(
          `There are no transcripts under ${join(root, transcripts)}, so there is nothing to ` +
            `plan capture from. Pass --project with the directory name Claude Code used.`,
        );
      }

      const rows = report(transcripts, scanned, plan, table, say, verified);
      this.emit(format, { columns: [SIGNAL, FIELD, VALUE], rows });

      if (table === undefined) {
        this.warn(
          `nothing in these transcripts reads as ${spec.name} yet: no table with two or more ` +
            `columns matching its properties.`,
        );
        return;
      }
      const files: [string, string | undefined][] = [
        [`${spec.name.replace(/_/g, '-')}-table.yaml`, table],
        [`${spec.name.replace(/_/g, '-')}-nudge.yaml`, say],
      ];
      if (!write) {
        const drafted = files
          .filter(([, text]) => text !== undefined)
          .map(([name]) => name)
          .join(' and ');
        this.warn(
          `run with --write to save the draft(s) into ${HANDLERS_DIR}/ as ${drafted}, or with ` +
            `--json to read them.`,
        );
        return;
      }
      const dir = join(project.root, HANDLERS_DIR);
      for (const [name, text] of files) {
        if (text !== undefined && existsSync(join(dir, name))) {
          throw refusal(
            `${join(HANDLERS_DIR, name)} already exists; it was not replaced, and nothing was written.`,
          );
        }
      }
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of files) {
        if (text === undefined) continue;
        writeFileSync(join(dir, name), text, 'utf8');
        this.warn(`wrote ${join(HANDLERS_DIR, name)}`);
      }
    });
  }
}

function report(
  transcripts: string,
  files: number,
  plan: CapturePlan,
  table: string | undefined,
  say: string | undefined,
  verified: Verification | undefined,
): Row[] {
  const rows: Row[] = [];
  const add = (signal: string, field: string, value: unknown): void => {
    rows.push({ [SIGNAL]: signal, [FIELD]: field, [VALUE]: value });
  };
  add('(log)', 'project', transcripts);
  add('(log)', 'files', files);
  plan.tables.forEach((one, index) => {
    const at = `table[${String(index)}]`;
    add(at, 'columns', one.columns.map((c) => `${c.column}->${c.property}`).join(', '));
    add(at, 'sessions', sessionsNote(one.sessions));
    add(at, 'writes', one.writes);
    add(at, 'rows', one.rows);
    if (one.missing.length > 0) add(at, 'missing', one.missing.join(', '));
    one.skills.forEach((skill, n) => {
      add(at, `skill[${String(n)}]`, `${skill.skill} (${sessionsNote(skill.sessions)})`);
    });
  });
  plan.tools.forEach((one, index) => {
    const at = `tool[${String(index)}]`;
    add(at, 'tool', `${one.tool} ${one.at}`);
    add(at, 'properties', one.properties.join(', '));
    add(at, 'sessions', sessionsNote(one.sessions));
    add(at, 'calls', one.calls);
    add(at, 'drafted', 'no: a handler cannot read tool input yet');
  });
  if (verified !== undefined) {
    add('draft', 'rows', verified.rows);
    add('draft', 'would_write', verified.valid);
    add('draft', 'refused', verified.refused);
    for (const [field, count] of verified.reasons) add('draft', `refused.${field}`, count);
  }
  if (table !== undefined) add('draft', 'table_handler', table);
  if (say !== undefined) add('draft', 'say_handler', say);
  return rows;
}
