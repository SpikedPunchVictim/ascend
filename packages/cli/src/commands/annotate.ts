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
 * **`--backtest <hand-scheme>` grades `--rule` against a hand-labelled ground truth, and touches
 * nothing.** `asc-3o9`: the model hand-labels a small sample under its own scheme, writes a rule
 * meant to reproduce that sample's judgement, and this reports whether it does -- precision, recall
 * and support per label -- BEFORE the rule is ever applied to the corpus for real.
 *
 * `<hand-scheme>` is a bare scheme name, resolved to its LATEST pass -- the same name `--scheme`
 * takes everywhere else in this command and in `asc kappa`, and the same default `asc kappa` uses
 * when no `--pass` pins one. A specific historical pass is not addressable through this flag; that
 * asymmetry is deliberate rather than an oversight, because summing every pass a hand scheme has
 * ever recorded would risk two passes disagreeing about one entry (an ordinary result of relabelling
 * some of the sample), and there would be no principled way to pick a winner. One pass is
 * unambiguous, and the latest is the current judgement -- the same reasoning `annotationPasses`
 * gives for why `asc kappa` defaults there too.
 *
 * **This is graded, not compared, and that is why it is not `asc kappa` with an extra flag.** Kappa
 * is symmetric: two raters, neither one truth. Back-testing is asymmetric on purpose -- the hand
 * scheme's pass IS the ground truth by the premise of the task, and the rule is a predictor being
 * scored against it. Precision (of what the rule claimed, how much was right) and recall (of what is
 * actually true, how much the rule found) are both questions kappa cannot answer, because kappa has
 * no notion of which side is correct. `@ascend/analysis`'s `backtest()` is the module that computes
 * this, and its own comment says at length why `cohenKappa` is the wrong tool for it.
 *
 * **The hand sample is small by construction -- that is the whole premise of hand-labelling instead
 * of labelling the corpus -- so every precision and every recall is a `wilson()` proportion, never a
 * bare ratio.** A precision of 1.00 computed from 3 items is not printed as a bare `1.00`: it carries
 * its interval and, below `MIN_N`, the small-group flag `renderProportion` appends. A label the rule
 * never predicted has no precision to report and a label the hand truth never used has no recall to
 * report -- both are OMITTED, never a fabricated 0.00 (`TASKS.md` #7). This is the same discipline
 * the refusal this replaced was protecting: a precision/recall number that looks more certain than
 * it is would be worse than no back-test at all.
 *
 * **The disagreement is reported too, per label**: which entries the rule labelled that the hand
 * truth did not (false positives), and which the hand truth labelled that the rule missed (false
 * negatives) -- named by id, not only counted, because a rule's author fixes a rule by looking at the
 * specific entries it got wrong.
 *
 * **`--holdout <fraction>` scores the rule on entries its author did not tune it to** (asc-z41.2).
 * A rule written after reading the whole hand sample can score well by reproducing it, so the
 * sample is split -- by a hash of each id seeded with the hand scheme's name, fixed across runs --
 * and each side is reported with a `split` column. Holdout rows never name the entries they got
 * wrong: reading those and fixing the rule would fit it to the holdout too. `holdout.ts` has the
 * rest, including what the split cannot defend against.
 *
 * **Nothing is registered and nothing is written.** The rule's matches are computed the same way
 * `--dry-run`'s preview computes them -- run in memory against the store, read, and discarded -- so
 * `--backtest` shares that half of `--dry-run`'s reasoning without sharing its flag: combining the
 * two is refused as redundant, since a run that never writes gains nothing from being told twice not
 * to. `--ids` has nothing to backtest either and is refused with `--backtest` for the same reason:
 * an `--ids` pass IS a hand label, not a rule with something to grade.
 *
 * **`--dry-run` runs the rules and writes nothing**, so the preview is produced by the same rule
 * application the real run performs. It is not a second code path: the assignments are computed
 * first either way, and only the write is skipped. What differs is where the census comes from --
 * memory for the preview, SQLite for the real run, because reading the numbers back out of the store
 * is what shows the write landed.
 */

import { randomUUID } from 'node:crypto';
import { Flags } from '@oclif/core';
import { backtest, type Labelled } from '@ascend/analysis';
import {
  annotationPasses,
  annotationRows,
  listSchemes,
  matchingEntryIds,
  openIndex,
  previewProducedLines,
  schemeCensus,
  schemeHash,
  writeProducedLines,
  wrapPredicate,
  type Producers,
  type RegisteredScheme,
  type SchemeCensus,
  type SchemeSpec,
  type SchemeSummary,
  type SqlDatabase,
} from '@ascend/store';
import { parseAssignments, parseRules } from '../annotation-rules.js';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import { parseHoldoutFraction, splitHoldout } from '../holdout.js';
import { renderProportion } from '../output.js';
import { storePaths } from '../project.js';

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

/** What this run's single body produced, beyond what it wrote to the store. */
interface RunOutcome {
  /** The scheme version the pass was filed under -- what the report's `version` column is. */
  readonly registered: RegisteredScheme;
  /** The scheme's latest version as the transaction found it, or `undefined` if it is new. */
  readonly existing: SchemeSummary | undefined;
  /** The spec this run asked for, before `registerScheme` normalized it. */
  readonly spec: SchemeSpec;
  /** Entry id to label, as this run decided it inside the lock. */
  readonly assigned: ReadonlyMap<string, string>;
  /** How many entries the scope named -- the denominator the remainder is a remainder of. */
  readonly considered: number;
}

/**
 * Read the index through a handle opened NOW, and close it.
 *
 * A write's own handle is closed by the time it returns, and `writeProducedLines` may have rebuilt
 * the index by `renameSync` on the way -- so a handle opened before a write can be reading an inode
 * that no longer has a name. This is the read-after-write door: correct by construction rather than
 * by remembering, because there is no handle to have kept.
 */
function withFreshIndex<T>(tree: string, indexFile: string, body: (db: SqlDatabase) => T): T {
  const store = openIndex(tree, indexFile);
  try {
    return body(store.db);
  } finally {
    store.db.close();
  }
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
      description:
        "Grade --rule against the named scheme's latest pass, taken as ground truth: precision, " +
        'recall and support per label, and where the rule and the hand truth disagree. Writes ' +
        'nothing -- the rule never touches the corpus.',
    }),
    holdout: Flags.string({
      description:
        'With --backtest, hold this fraction of the hand sample out (0.3 = 30%) and score the ' +
        'rule on it separately. Which entries are held out is fixed per hand scheme, and ' +
        'holdout rows never name the entries they got wrong, so fixing the rule reads only ' +
        'training entries.',
    }),
    'dry-run': Flags.boolean({
      description: 'Run the rules and report the census, then write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Annotate);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);

    // Measured, not assumed: an absent `multiple` flag arrives as `undefined`, not `[]` -- probed
    // against this oclif, which reports `[]` for `--rule a --rule b` and NO `rule` key at all for a
    // command given none. The declared type says `string[]`, so the defaulting is real rather than a
    // redundant guard. Same class of fact as `flagValue` in `base.ts`.
    const rawRules = flags.rule ?? [];
    const rawIds = flags.ids ?? [];
    const declared = flags.label ?? [];
    const scope = this.optionalFlag(flags.scope);
    const backtestScheme = this.optionalFlag(flags.backtest);
    const rawHoldout = this.optionalFlag(flags.holdout);
    if (rawHoldout !== undefined && backtestScheme === undefined) {
      throw usageError(
        '--holdout splits the hand sample --backtest grades against, so it needs --backtest. ' +
          'Add --backtest <hand-scheme>, or drop --holdout.',
      );
    }
    const holdout = rawHoldout === undefined ? undefined : parseHoldoutFraction(rawHoldout);
    if (typeof holdout === 'string') throw usageError(holdout);

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
    // `--ids` IS a hand label -- there is nothing for --backtest to grade it against, since grading
    // needs a predictor (a rule) and a separate ground truth (the scheme named by --backtest).
    if (backtestScheme !== undefined && rawIds.length > 0) {
      throw usageError(
        '--backtest and --ids cannot be combined: --backtest grades a proposed --rule against an ' +
          'existing hand-labelled scheme, and --ids is itself a hand label with nothing to grade. ' +
          'Drop --ids, or drop --backtest and run this as an ordinary --ids pass.',
      );
    }
    // Redundant rather than contradictory, and refused for the same reason the sketch's `|` is: a
    // flag that adds nothing to what is already true is a flag whose presence a reader has to
    // puzzle over. `--backtest` already runs the rule without writing -- that is its entire point --
    // so pairing it with `--dry-run` says the same thing twice.
    if (backtestScheme !== undefined && dryRun) {
      throw usageError(
        '--backtest and --dry-run cannot be combined: --backtest already runs --rule without ' +
          "writing to the corpus, which is --dry-run's entire purpose. Drop --dry-run.",
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

    // `--backtest` never writes, so it keeps the READ door rather than the write one. Two reasons
    // and they are not the same reason: it must not take a write lock for a command that changes
    // nothing, and it must not make a stale index current just to grade a rule -- a read that builds
    // is the cost `asc-i5tj.3.1` removed.
    if (backtestScheme !== undefined) {
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

        // A backtest never writes, so it needs only the rule's matches -- computed exactly as the
        // write path computes them, in memory and thrown away -- and the hand scheme's latest pass,
        // read back and graded by `@ascend/analysis`'s `backtest()`.
        const registeredNow = listSchemes(store.db);
        if (!registeredNow.some((entry) => entry.name === backtestScheme)) {
          throw refusal(
            `there is no annotation scheme named '${backtestScheme}' to back-test against. ` +
              `Registered schemes: ${
                registeredNow.map((entry) => `'${entry.name}'`).join(', ') || '(none)'
              }. Hand-label a sample first with ` +
              `\`asc annotate --scheme ${backtestScheme} --ids "<label>=<id>,<id>"\`.`,
          );
        }

        // Latest pass only, and deliberately -- see the module doc. Summing every pass a hand scheme
        // has ever recorded risks two passes disagreeing about one entry, with no principled way to
        // pick a winner; the latest pass is the current hand judgement, unambiguous by construction.
        const passes = annotationPasses(store.db, backtestScheme);
        const latestPass = passes[passes.length - 1];
        if (latestPass === undefined) {
          throw refusal(
            `scheme '${backtestScheme}' is registered but has recorded no pass, so there is no ` +
              `hand-labelled ground truth to grade '--rule' against. Hand-label a sample first ` +
              `with \`asc annotate --scheme ${backtestScheme} --ids "<label>=<id>,<id>"\`.`,
          );
        }

        // Ground truth is the hand scheme's latest pass, narrowed to this run's --scope -- the same
        // meaning --scope has everywhere else in this command: what the run considers.
        const truthRows = annotationRows(store.db, {
          scheme: backtestScheme,
          pass: latestPass.createdAt,
        });
        const truth = truthRows
          .filter((row) => scopeIds.has(row.entryId))
          .map((row) => ({ id: row.entryId, label: row.label }));

        if (truth.length === 0) {
          throw refusal(
            `scheme '${backtestScheme}''s latest pass (${latestPass.createdAt}) labelled ` +
              `${String(truthRows.length)} entries, and none of them fall within ` +
              `${scope === undefined ? "this run's scope" : `--scope '${scope}'`}. There is no ` +
              `ground truth inside that scope to grade '--rule' against -- widen --scope, or drop ` +
              `it.`,
          );
        }

        // First match wins, exactly as the real (write) path applies rules below -- computed here
        // rather than shared with it because the real path also has to fold in `scopeIds` for a
        // WRITE, and this one only ever reads.
        const predictedIds = new Map<string, string>();
        for (const rule of parsed.rules) {
          for (const entryId of matchingEntryIds(store.db, rule)) {
            if (scopeIds.has(entryId) && !predictedIds.has(entryId)) {
              predictedIds.set(entryId, rule.label);
            }
          }
        }
        const predicted = [...predictedIds].map(([entryId, label]) => ({ id: entryId, label }));

        // The split is seeded by the hand scheme's name, so every backtest against it holds out
        // the same entries (`holdout.ts`). Either side empty is refused rather than reported as a
        // score over nothing.
        let sides: readonly { split?: 'train' | 'holdout'; truth: readonly Labelled[] }[] = [
          { truth },
        ];
        if (holdout !== undefined) {
          const divided = splitHoldout(truth, backtestScheme, holdout);
          if (divided.train.length === 0 || divided.holdout.length === 0) {
            throw refusal(
              `--holdout ${String(holdout)} over the ${String(truth.length)} hand-labelled ` +
                `entries in scope left ${String(divided.train.length)} to train on and ` +
                `${String(divided.holdout.length)} held out; both sides need at least one. ` +
                'Label more entries, or change --holdout.',
            );
          }
          sides = [
            { split: 'train', truth: divided.train },
            { split: 'holdout', truth: divided.holdout },
          ];
        }

        this.emit(format, {
          columns: [
            'scheme',
            'backtest',
            ...(holdout === undefined ? [] : ['split']),
            'pass',
            'compared',
            'label',
            'support',
            'predicted',
            'true_positives',
            'false_positives',
            'false_negatives',
            'precision',
            'recall',
          ],
          rows: sides.flatMap(({ split, truth: sideTruth }) => {
            const report = backtest(predicted, sideTruth);
            return report.measures.map((measure) => ({
              scheme: schemeName,
              backtest: backtestScheme,
              ...(split === undefined ? {} : { split }),
              pass: latestPass.createdAt,
              compared: report.compared,
              label: measure.label,
              support: measure.actual,
              predicted: measure.predicted,
              true_positives: measure.truePositives,
              false_positives: measure.falsePositives.length,
              false_negatives: measure.falseNegatives.length,
              // Rendered strings, so --table and --csv show the honest qualified form
              // (`renderProportion`'s CI and small-group flag) rather than a bare number or a
              // JSON-stringified object -- the same `tally`-plus-raw-field split `explore.ts`'s
              // `propertyRow` uses for its own proportion-shaped value.
              precision: renderProportion(measure.precision),
              recall: renderProportion(measure.recall),
              // The structured proportion, present only when there is one (never a `null` standing
              // in for "no estimate" -- `TASKS.md` #7) and omitted from `columns` so it reaches
              // `--json` only: a script that wants `successes`/`n`/`lower`/`upper` reads this
              // rather than re-parsing the display string.
              ...(measure.precision === null ? {} : { precision_measure: measure.precision }),
              ...(measure.recall === null ? {} : { recall_measure: measure.recall }),
              // Named, not only counted -- a rule's author fixes a rule by looking at the entries
              // it got wrong, not by knowing how many there were. NOT for the holdout: naming its
              // misses would invite fixing the rule against them, which spends the holdout.
              ...(split === 'holdout'
                ? {}
                : {
                    false_positive_ids: measure.falsePositives,
                    false_negative_ids: measure.falseNegatives,
                  }),
            }));
          }),
        });
      });
      return;
    }

    await this.withProjectRoot((root) => {
      const schemeName = flags.scheme;
      const { tree, index: indexFile } = storePaths(root);
      // Taken once, before the body, so every production in this run shares one timestamp rather
      // than one per call.
      const now = this.now();

      /**
       * Everything that decides what this run writes, and the write itself, as ONE body.
       *
       * This is the whole of the asc-q4p fix, and it is a shape rather than a comment: the scope,
       * the ids, the rule matches and the scheme's existing vocabulary are all reads that decide
       * what `registerScheme` and `recordAnnotations` then write, and every one of them is taken
       * through the TRANSACTION's handle -- inside `BEGIN IMMEDIATE` -- rather than through a handle
       * opened on the way in. A read taken before the lock is a snapshot a concurrent `asc annotate`
       * can invalidate between the read and the write, which is check-then-act across a transaction
       * boundary. `annotations.test.ts` measures it: two `asc annotate` processes started without
       * waiting for each other, each adding one label to the same scheme, and both labels must
       * survive; asc-q4p records a longer four-run trace of the unfixed behaviour. `registerType`
       * (`registry.ts`) is the reference for the same placement, measuring the race the other way --
       * a version collision instead of a dropped label.
       *
       * It returns what the report needs as well as what it wrote, because a preview of this run has
       * to be able to say what the real run would do -- `censusOf` over the assignment, and whether
       * the shape is new -- without a second reading of the store.
       */
      const run = (produce: Producers, db: SqlDatabase): RunOutcome => {
        // Through `wrapPredicate`, so a scope carrying a second statement is refused here rather than
        // silently truncated by `prepare` -- the same guard a stored predicate gets. The scope is read
        // through `db`, inside the lock, for the same reason every other read below is: it decides how
        // many entries this run considers, and therefore what it writes and what it reports.
        const scopeStatement =
          scope === undefined ? 'SELECT id FROM entries' : wrapPredicate('entries', scope);
        const scopeIds = new Set(
          (db.prepare(scopeStatement).all() as unknown as { id: string }[]).map((row) => row.id),
        );

        // Every entry that exists, scope or no scope -- fetched only when `--ids` might need to tell
        // a nonexistent id apart from one this run's `--scope` excludes. Without a `--scope`,
        // `scopeIds` already names every entry that exists, so there is no second question to ask and
        // no second query to run.
        const allIds =
          rawIds.length === 0 || scope === undefined
            ? scopeIds
            : new Set(
                (db.prepare('SELECT id FROM entries').all() as unknown as { id: string }[]).map(
                  (row) => row.id,
                ),
              );

        const assigned = new Map<string, string>();

        if (rawIds.length === 0) {
          // Rules in order, first match wins -- the order is the scheme's shape and is why
          // `normalizeSpec` hashes the rule list as a list.
          for (const rule of parsed.rules) {
            for (const entryId of matchingEntryIds(db, rule)) {
              if (scopeIds.has(entryId) && !assigned.has(entryId))
                assigned.set(entryId, rule.label);
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

        const existing = listSchemes(db).find((scheme) => scheme.name === schemeName);
        const spec = nextSpec(existing);

        // The two writers, in order: the scheme's version exists before the pass that names it.
        // `produce` rather than `registerScheme`/`recordAnnotations` directly, because the lines this
        // run appends to the tree are collected from these calls and nowhere else -- a direct call
        // would write rows the tree never receives (`writeProducedLines` states it at length).
        const scheme = produce.scheme(schemeName, spec, { createdAt: now });

        produce.annotation(
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

        return { registered: scheme, existing, spec, assigned, considered: scopeIds.size };
      };

      if (dryRun) {
        this.warn('dry run: nothing was written.');

        // The SAME body the real run uses, under a rollback, with the tree and the index left
        // exactly as they were -- so a preview cannot report an outcome the run would not produce.
        // It refuses a stale index rather than building one: `asc annotate --dry-run` against a
        // checkout that moved the tree now says `asc index build` instead of spending a rebuild on
        // a preview.
        const previewed = previewProducedLines(tree, indexFile, run);

        // The version is still OMITTED rather than predicted. Mirroring `registerScheme`'s
        // arithmetic here would be a second implementation of "which version comes next", and a
        // preview that disagreed with the run it previews is worse than one that declines to guess.
        // `outcome` answers the question a caller had -- whether the shape is new -- using the
        // store's own `schemeHash` on the store's own value.
        const wouldMatch =
          previewed.existing !== undefined &&
          schemeHash(previewed.spec) === schemeHash(previewed.existing.spec);
        const preview = censusOf(previewed.assigned, previewed.considered);

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

      const { registered } = writeProducedLines(tree, indexFile, { now }, run).result;

      // Read back out of SQLite -- from a FRESH handle, opened after the write. The write's own
      // handle is closed by the time it returns, and it may have rebuilt the index by `renameSync`,
      // so a handle opened before the write could be reading a replaced inode. The numbers reported
      // are the numbers stored -- not the ones the assignment loop was holding, which is the only way
      // a report can catch its own write having dropped a row -- and they are read from the index the
      // tree was just replayed into, so the round trip through the lines is what is being reported.
      //
      // The pass filter is this run's timestamp, so the census is about this pass rather than about
      // everything the scheme has ever said. The scope goes with it, because it is the body the
      // remainder is a remainder OF. Leaving it out was measured: a scoped run reported
      // `considered: 6, unclassified: 4` for a scope of two entries, which is the number this command
      // exists to report, wrong.
      const census = withFreshIndex(tree, indexFile, (db) =>
        schemeCensus(db, {
          scheme: schemeName,
          version: registered.version,
          pass: now,
          ...(scope === undefined ? {} : { scope }),
        }),
      );

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
