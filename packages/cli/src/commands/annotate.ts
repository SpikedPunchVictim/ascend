/**
 * `asc annotate --scheme <s> --rule "<label>=<kind>:<query>"` -- classify the corpus by rule.
 *
 * `ARCHITECTURE.md`: the model does not label entries one at a time -- it proposes a RULE, ascend
 * applies it deterministically across the whole corpus, and reports the match count beside the
 * UNCLASSIFIED REMAINDER, which is the signal that the taxonomy is incomplete. This command is that
 * loop's apply-and-report step. The proposal half is the caller's.
 *
 * **A scheme is declared, not accumulated one label at a time.** Each run merges what it is given
 * into what the scheme already has, and the merge is asymmetric on purpose:
 *
 *   - **The vocabulary is UNIONED.** A label the scheme already declares survives a run that does
 *     not name it. Without this, hand-labelling a single entry (`--ids "other=e1"`) would
 *     register a scheme whose vocabulary is `[other]` -- silently dropping every label the rules
 *     had been assigning, and minting a version whose census calls all of that work unclassified.
 *   - **The rules are REPLACED when any are given.** A `--rule` run says what the rules are now; the
 *     alternative (append) makes a rule edit a silent no-op, because the first match wins and the
 *     rule you meant to change still matches first. Retyping the unchanged rules is the cost, and it
 *     buys a command whose text is the scheme.
 *
 * So `--rule` is what changes rules, `--ids` is what adds a hand label, and re-running either is
 * idempotent against the scheme: an unchanged shape registers as `unchanged` and writes only a new
 * pass.
 *
 * **`--scope` narrows what the run considers, and it is not optional decoration.** The remainder is
 * only a signal about the body of entries it was computed over: rules applied to a corpus-wide scope
 * while you are thinking about one type produce a remainder that is mostly "other types", which reads
 * as a taxonomy that does not fit. `--scope` is the predicate the census is a remainder OF, and it
 * is the same predicate the rules are applied within.
 *
 * **`--backtest` is refused rather than ignored.** The sketch has it, and a flag that parses and
 * does nothing is worse than one that does not exist -- a caller would read a precision/recall
 * number into an output that never computed one. It names `asc-3o9`, the bead that owns it.
 *
 * **`--dry-run` runs the rules and writes nothing**, so the preview is produced by the same rule
 * application the real run performs. It is not a second code path: the assignments are computed
 * first either way, and only the write is skipped. What differs is where the census comes from --
 * memory for the preview, SQLite for the real run, because reading the numbers back out of the store
 * is what shows the write landed.
 */

import { randomUUID } from 'node:crypto';
import { Flags } from '@oclif/core';
import {
  listSchemes,
  matchingEntryIds,
  recordAnnotations,
  registerScheme,
  schemeCensus,
  schemeHash,
  withTransaction,
  wrapPredicate,
  type SchemeCensus,
  type SchemeSpec,
  type SchemeSummary,
} from '@ascend/store';
import { parseAssignments, parseRules } from '../annotation-rules.js';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';

/**
 * The census that WOULD result, computed from the assignments in hand.
 *
 * A second implementation of the store's aggregation, and it is worth saying why: a dry run stores
 * nothing, so its numbers cannot be read back, and reporting no remainder in a preview would remove
 * the one number the preview exists to show. The store's version stays the real one -- a run that
 * writes reads `schemeCensus` -- and the two are pinned together by a test that runs one command
 * twice, once with `--dry-run`, and asserts the same census. If they ever drift, that is what fails.
 *
 * The ordering matches the SQL's `ORDER BY n DESC, a.label ASC`, so the biggest class is first in
 * both.
 */
function censusOf(assigned: ReadonlyMap<string, string>, considered: number): SchemeCensus {
  const counts = new Map<string, number>();
  for (const label of assigned.values()) counts.set(label, (counts.get(label) ?? 0) + 1);

  return {
    considered,
    labelled: assigned.size,
    unclassified: considered - assigned.size,
    labels: [...counts]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1)),
  };
}

export default class Annotate extends BaseCommand {
  static override description =
    'Classify entries by rule, and report the unclassified remainder a scheme leaves.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --scheme review --rule "bug=sql: evidence_text LIKE \'%crash%\'"',
    '<%= config.bin %> <%= command.id %> --scheme review --rule "docs=fts: install" --scope "type_name = \'decision\'"',
    '<%= config.bin %> <%= command.id %> --scheme hand --ids "bug=e1,e7,e9" --ids "docs=e4"',
    '<%= config.bin %> <%= command.id %> --scheme review --rule "bug=sql: 1=1" --dry-run',
  ];

  static override flags = {
    scheme: Flags.string({
      required: true,
      description:
        'The scheme to write under. Created on first use, versioned when its shape changes.',
    }),
    rule: Flags.string({
      multiple: true,
      description:
        "A rule as '<label>=<kind>:<query>', applied in the order given; the first match wins. " +
        "'sql' is a predicate over an entry, 'fts' a text query over its evidence text.",
    }),
    label: Flags.string({
      multiple: true,
      description:
        'Declare a vocabulary label that nothing assigns -- a label you expect to need. Repeatable.',
    }),
    ids: Flags.string({
      multiple: true,
      description:
        "Annotate named entries as '<label>=<id>,<id>', instead of --rule. Repeatable, and one " +
        'pass may carry several labels this way.',
    }),
    scope: Flags.string({
      description:
        'A SQL predicate over entries, narrowing what this run considers. The unclassified ' +
        'remainder is a remainder of this scope.',
    }),
    actor: Flags.string({
      description: 'Who or what produced this pass. Stored as created_by; omitted by default.',
    }),
    backtest: Flags.string({
      description: 'Not implemented -- owned by asc-3o9.',
    }),
    'dry-run': Flags.boolean({
      description: 'Run the rules and report the census, then write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Annotate);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);

    if (flags.backtest !== undefined) {
      throw refusal(
        `--backtest is not implemented yet: measuring a rule against a hand-labelled sample is ` +
          `asc-3o9, which is deferred. It is refused rather than ignored because a precision/recall ` +
          `number that was never computed is exactly the kind of output a caller would read ` +
          `confidence out of. Use --dry-run to see the match counts a rule produces meanwhile.`,
      );
    }

    // Measured, not assumed: an absent `multiple` flag arrives as `undefined`, not `[]` -- probed
    // against this oclif, which reports `[]` for `--rule a --rule b` and NO `rule` key at all for a
    // command given none. The declared type says `string[]`, so the defaulting is real rather than a
    // redundant guard. Same class of fact as `flagValue` in `base.ts`.
    const rawRules = flags.rule ?? [];
    const rawIds = flags.ids ?? [];
    const declared = flags.label ?? [];
    const scope = this.optionalFlag(flags.scope);

    // The sketch's `|`: the two modes write different kinds of pass and cannot be one call. A run
    // that mixed them would have to decide what a rule matched that a hand label contradicts.
    if (rawRules.length > 0 && rawIds.length > 0) {
      throw usageError(
        '--rule and --ids cannot be combined. Rules classify a scope; --ids annotates named ' +
          'entries. Run them separately -- each is its own pass, which is also what makes the two ' +
          'comparable with `asc kappa`.',
      );
    }
    if (rawRules.length === 0 && rawIds.length === 0) {
      throw usageError(
        'nothing to do: give --rule to apply rules, or --ids "<label>=<id>,<id>" to annotate named ' +
          'entries. An empty run would register a scheme and write no pass.',
      );
    }

    const parsed = parseRules(rawRules, declared);
    const assignments = parseAssignments(rawIds);

    // One vocabulary from both sources: what the rules assign, what `--ids` assigns, and what
    // `--label` declares. A label the scheme already has survives (see the merge note above), so
    // this is the run's addition rather than the whole vocabulary.
    const added = [...new Set([...parsed.labels, ...assignments.labels])].sort();

    // The union and the replacement described at the top of this file: the vocabulary only grows,
    // the rules are what this run says they are. Takes `existing` as a parameter rather than
    // reading it itself, because WHERE that read happens is the whole fix for asc-q4p -- see the
    // real write below.
    const nextSpec = (existing: SchemeSummary | undefined): SchemeSpec => ({
      labels: [...new Set([...(existing?.spec.labels ?? []), ...added])].sort(),
      rules: parsed.rules.length > 0 ? parsed.rules : (existing?.spec.rules ?? []),
    });

    await this.withProject(({ store }) => {
      const schemeName = flags.scheme;

      // Through `wrapPredicate`, so a scope carrying a second statement is refused here rather than
      // silently truncated by `prepare` -- the same guard a stored predicate gets.
      const scopeStatement =
        scope === undefined ? 'SELECT id FROM entries' : wrapPredicate('entries', scope);
      const scopeIds = new Set(
        (store.db.prepare(scopeStatement).all() as unknown as { id: string }[]).map(
          (row) => row.id,
        ),
      );

      // Every entry that exists, scope or no scope -- fetched only when `--ids` might need to tell
      // a nonexistent id apart from one this run's `--scope` excludes. Without a `--scope`,
      // `scopeIds` already names every entry that exists, so there is no second question to ask and
      // no second query to run.
      const allIds =
        rawIds.length === 0 || scope === undefined
          ? scopeIds
          : new Set(
              (store.db.prepare('SELECT id FROM entries').all() as unknown as { id: string }[]).map(
                (row) => row.id,
              ),
            );

      const assigned = new Map<string, string>();

      if (rawIds.length === 0) {
        // Rules in order, first match wins -- the order is the scheme's shape and is why
        // `normalizeSpec` hashes the rule list as a list.
        for (const rule of parsed.rules) {
          for (const entryId of matchingEntryIds(store.db, rule)) {
            if (scopeIds.has(entryId) && !assigned.has(entryId)) assigned.set(entryId, rule.label);
          }
        }
      } else {
        for (const [entryId, label] of assignments.pairs) {
          // An id outside the scope makes the report incoherent, not just incomplete: the entry is
          // labelled while the scope that the remainder is computed over does not contain it, so
          // `labelled + unclassified` would exceed `considered`. But "not in scope" is ambiguous
          // between a typo and a real id the scope predicate excludes, and the two need different
          // fixes -- so a nonexistent id is named as one, and only a real id that fails the scope
          // predicate is told to drop it or widen --scope.
          if (!scopeIds.has(entryId)) {
            if (!allIds.has(entryId)) {
              throw refusal(
                `entry '${entryId}' does not exist, so there is nothing to annotate under ` +
                  `'${label}'. Check the id -- 'asc query' lists what is actually recorded.`,
              );
            }
            throw refusal(
              `entry '${entryId}' exists but is excluded by this run's scope ` +
                `${scope === undefined ? '(every entry)' : `'${scope}'`}, so it cannot be ` +
                `annotated by a run whose remainder is computed over that scope. Drop it from ` +
                `--ids, or widen --scope.`,
            );
          }
          // Refused here rather than left to the store's identical check, and the reason is
          // `--dry-run`: a preview writes nothing, so a duplicate that only the write refused would
          // let a dry run report a census for a pass the real run then rejects. The store keeps its
          // own check as the backstop for a pass written through the API.
          if (assigned.has(entryId)) {
            throw refusal(
              `entry '${entryId}' is named twice in this pass, under '${String(assigned.get(entryId))}' ` +
                `and '${label}'. One pass gives one label per entry -- ` +
                `\`asc kappa\` pairs two raters by entry id and cannot rank two labels for one ` +
                `entry. Name it once, or write the two labels as two passes.`,
            );
          }
          assigned.set(entryId, label);
        }
      }

      if (rawRules.length > 0 && assigned.size === 0 && scopeIds.size > 0) {
        this.warn(
          `no rule matched any of the ${String(scopeIds.size)} entries in scope, so the whole ` +
            `scope is unclassified. That remainder is the signal a taxonomy is incomplete, not a ` +
            `failure -- but an empty pass is not written, so the scheme's next version is all this ` +
            `run changed.`,
        );
      }

      const now = this.now();

      if (dryRun) {
        this.warn('dry run: nothing was written.');

        // Read here, outside any transaction -- a preview writes nothing, so there is no write for
        // a concurrent run to invalidate the input of, unlike the real write below (asc-q4p).
        const existing = listSchemes(store.db).find((scheme) => scheme.name === schemeName);
        const spec = nextSpec(existing);

        // The version is OMITTED rather than predicted. Mirroring `registerScheme`'s arithmetic here
        // would be a second implementation of "which version comes next", and a preview that
        // disagreed with the run it previews is worse than one that declines to guess. `outcome`
        // answers the question a caller had -- whether the shape is new -- using the store's own
        // `schemeHash` on the store's own value.
        const wouldMatch = existing !== undefined && schemeHash(spec) === schemeHash(existing.spec);
        const preview = censusOf(assigned, scopeIds.size);

        this.emit(format, {
          columns: [
            'scheme',
            'version',
            'outcome',
            'pass',
            'considered',
            'labelled',
            'unclassified',
            'dry_run',
          ],
          rows: [
            {
              scheme: schemeName,
              outcome: wouldMatch ? 'would-unchanged' : 'would-create',
              considered: preview.considered,
              labelled: preview.labelled,
              unclassified: preview.unclassified,
              labels: preview.labels,
              dry_run: true,
            },
          ],
        });
        return;
      }

      const registered = withTransaction(store.db, () => {
        // `existing` is read HERE, inside the transaction `withTransaction` opens with `BEGIN
        // IMMEDIATE`, rather than before it. That placement is the entire fix for asc-q4p: the
        // vocabulary union below is a read that decides what `registerScheme` writes, and a read
        // taken before the write lock is a snapshot a concurrent `asc annotate` can invalidate
        // between the read and the write -- check-then-act across a transaction boundary. The test
        // in `annotations.test.ts` measures it: two `asc annotate` processes started without
        // waiting for each other, each adding one label to the same scheme, and both labels must
        // survive. asc-q4p records a longer four-run trace of the unfixed behaviour; it is that
        // bead's measurement, not this one's. `registerType` (`registry.ts`) is the reference for
        // this placement and measures the same race the other way -- a version collision instead of
        // a dropped label -- with the fix in the same place: the read joins the transaction that
        // commits it.
        const existing = listSchemes(store.db).find((scheme) => scheme.name === schemeName);
        const spec = nextSpec(existing);

        // One transaction, so a pass is never registered into a version that the write then fails
        // against. `registerScheme` joins this transaction rather than nesting into it.
        const scheme = registerScheme(store.db, schemeName, spec, { createdAt: now });

        recordAnnotations(
          store.db,
          {
            scheme: schemeName,
            schemeVersion: scheme.version,
            annotations: [...assigned].map(([entryId, label]) => ({
              id: randomUUID(),
              entryId,
              label,
            })),
          },
          { createdAt: now, ...(flags.actor === undefined ? {} : { createdBy: flags.actor }) },
        );

        return scheme;
      });

      // Read back out of SQLite. The numbers reported are the numbers stored -- not the ones the
      // assignment loop was holding, which is the only way a report can catch its own write having
      // dropped a row. The pass filter is this run's timestamp, so the census is about this pass
      // rather than about everything the scheme has ever said.
      //
      // The scope goes with it, because it is the body the remainder is a remainder OF. Leaving it
      // out was measured: a scoped run reported `considered: 6, unclassified: 4` for a scope of two
      // entries, which is the number this command exists to report, wrong.
      const census = schemeCensus(store.db, {
        scheme: schemeName,
        version: registered.version,
        pass: now,
        ...(scope === undefined ? {} : { scope }),
      });

      this.emit(format, {
        columns: [
          'scheme',
          'version',
          'outcome',
          'pass',
          'considered',
          'labelled',
          'unclassified',
          'dry_run',
        ],
        rows: [
          {
            scheme: schemeName,
            version: registered.version,
            outcome: registered.outcome,
            pass: now,
            considered: census.considered,
            labelled: census.labelled,
            unclassified: census.unclassified,
            labels: census.labels,
            // Present rather than omitted, so `--json` carries the same keys whether or not the run
            // was a preview: a consumer that reads the field's absence as "this command does not
            // report dry runs" would be right today and wrong the moment it saw a real run.
            dry_run: false,
          },
        ],
      });
    });
  }
}
