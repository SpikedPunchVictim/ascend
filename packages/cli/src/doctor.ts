/**
 * The checks `asc doctor` runs (asc-12a), as pure functions over what the registry already reports.
 *
 * **Every check REPORTS; none refuses.** Doctor is how a registry is kept from fragmenting, and the
 * decisions it prompts -- deprecate a dead type, merge two confusable ones, re-derive across a
 * version change -- are the operator's. A `warn` is a thing to look at, not a failure, so the
 * command exits 0 either way.
 *
 * **Each finding is one row with a subject and a detail, and a check with nothing to say still
 * says so.** An `ok` row per quiet check is what tells "checked, clean" apart from "never ran",
 * the distinction a blank report cannot make.
 *
 * **What is NOT checked, and why.** Two checks the design review routed here have no signal to read
 * yet, and inventing one would be a number with no measurement behind it:
 *
 * - *Types past their threshold but never analysed.* `asc stats` runs are not recorded anywhere,
 *   so "never analysed" is not a fact the store holds (asc-z41.4 note on asc-12a).
 * - *Whether an export exists.* `asc export` writes to stdout and leaves no trace in the store, so
 *   the check below states that it cannot see one rather than claiming there is none.
 *
 * Pure: the command gathers `listTypes` and `profileType`; nothing here touches the store.
 */

import { Buffer } from 'node:buffer';

import { MIN_N } from '@ascend/analysis';
import { confusableNames } from '@ascend/core';
import type { TypeProfile, TypeSummary } from '@ascend/store';

import { BRIEF_CAP_BYTES, briefText } from './brief-text.js';
import { countCodePoints } from './budget.js';
import type { HookBinaryKind } from './hook-script.js';

export type DoctorCheck =
  | 'dead_type'
  | 'near_duplicate'
  | 'version_drift'
  | 'property_states'
  | 'brief_size'
  | 'export'
  | 'hook_generation';

export interface DoctorFinding {
  readonly check: DoctorCheck;
  readonly status: 'ok' | 'warn' | 'info';
  readonly subject: string;
  readonly detail: string;
}

/**
 * The brief's cost cap, in tokens (EV-16's decision). It is enforced as a DELIVERY bound: a
 * SessionStart payload past ~9 KB was measured truncated with nothing reporting the loss, and
 * 2,000 tokens lands inside that bracket.
 */
export const BRIEF_TOKEN_CAP = 2_000;

/**
 * Code points per token for BRIEF prose, measured in EV-16 as ~4.5 and stable across 4..400
 * types. Not `CHARS_PER_TOKEN = 2`, which EV-13 calibrated on JSON output: reusing it would
 * over-estimate the brief 2.2x and fire the cap near 13 types instead of ~30.
 */
export const BRIEF_CODE_POINTS_PER_TOKEN = 4.5;

const ALL = '(all)';

/** Active types registered and never recorded -- align's "dead rules", for a registry. */
export function deadTypes(summaries: readonly TypeSummary[]): readonly DoctorFinding[] {
  const active = summaries.filter((summary) => summary.status === 'active');
  const dead = active.filter((summary) => summary.entryCount === 0);
  if (dead.length === 0) {
    return [
      {
        check: 'dead_type',
        status: 'ok',
        subject: ALL,
        detail: `all ${String(active.length)} active types have entries`,
      },
    ];
  }
  return dead.map((summary) => ({
    check: 'dead_type',
    status: 'warn',
    subject: summary.name,
    // **Two different zeros, and only one of them is "never recorded"** (`asc-9xi0`). A type whose
    // every entry has been struck also reads a live count of 0, and calling that "never recorded"
    // sends a reader looking for entries that exist -- the whole class of confusion this bead is
    // about. Both still warn: a type with nothing standing is worth the same second look either
    // way, and the difference is in the reason, not the verdict.
    detail:
      summary.struckCount === 0
        ? `registered at v${String(summary.latestVersion)}, never recorded`
        : `registered at v${String(summary.latestVersion)}, every ${String(summary.struckCount)} ` +
          `recorded entries struck`,
  }));
}

/**
 * Pairs of active type names that share a whole token, each pair once. The same relation
 * `registerType` warns on at define time (`names.ts`), applied to the registry as it now stands --
 * a define-time warning is printed once and then forgotten.
 */
export function nearDuplicates(summaries: readonly TypeSummary[]): readonly DoctorFinding[] {
  const names = summaries
    .filter((summary) => summary.status === 'active')
    .map((summary) => summary.name)
    .sort();
  const findings: DoctorFinding[] = [];
  names.forEach((name, index) => {
    for (const match of confusableNames(name, names.slice(index + 1))) {
      findings.push({
        check: 'near_duplicate',
        status: 'warn',
        subject: `${name} ~ ${match.name}`,
        detail: `share ${match.shared.map((token) => `'${token}'`).join(', ')}`,
      });
    }
  });
  if (findings.length > 0) return findings;
  return [
    {
      check: 'near_duplicate',
      status: 'ok',
      subject: ALL,
      detail: 'no two active type names share a token',
    },
  ];
}

/**
 * Types whose entries were recorded under more than one version. An analysis over such a type
 * compares entries recorded against different definitions, and a property one version did not
 * declare reads as `not_declared` for its entries -- so the properties that differ are named.
 */
export function versionDrift(profiles: readonly TypeProfile[]): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const profile of profiles) {
    const carrying = profile.versions.filter((version) => version.entries > 0);
    if (carrying.length < 2) continue;
    const spread = carrying
      .map((version) => `v${String(version.version)}: ${String(version.entries)}`)
      .join(', ');
    const differing = profile.properties
      .filter((property) =>
        carrying.some((version) => !property.declaringVersions.includes(version.version)),
      )
      .map((property) => property.name);
    const retyped = profile.properties
      .filter((property) => property.declaredTypes.length > 1)
      .map((property) => property.name);
    const changes = [
      ...(differing.length > 0 ? [`not declared by every version: ${differing.join(', ')}`] : []),
      ...(retyped.length > 0 ? [`type changed: ${retyped.join(', ')}`] : []),
    ];
    findings.push({
      check: 'version_drift',
      status: changes.length > 0 ? 'warn' : 'info',
      subject: profile.type,
      detail:
        changes.length > 0
          ? `entries span ${spread}; ${changes.join('; ')}`
          : `entries span ${spread}; properties unchanged across them`,
    });
  }
  if (findings.length > 0) return findings;
  return [
    {
      check: 'version_drift',
      status: 'ok',
      subject: ALL,
      detail: 'every type’s entries are on one version',
    },
  ];
}

/**
 * Per property, how many of the entries that declared it measured it, and how many said
 * not_applicable or left it unmeasured. Only properties with anything other than `measured` are
 * listed. A property never measured is a `warn`: either the type asks for something nobody
 * supplies, or the recorder cannot. Counts, not percentages, and a group under `MIN_N` is named as
 * an anecdote, because a ratio over 3 entries reads like one over 300.
 */
export function propertyStates(profiles: readonly TypeProfile[]): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const profile of profiles) {
    for (const property of profile.properties) {
      const {
        measured,
        not_applicable: notApplicable,
        not_measured: notMeasured,
      } = property.states;
      const declared = measured + notApplicable + notMeasured;
      if (declared === 0 || measured === declared) continue;
      const anecdote = declared < MIN_N ? ` (n<${String(MIN_N)}: an anecdote)` : '';
      findings.push({
        check: 'property_states',
        status: measured === 0 ? 'warn' : 'info',
        subject: `${profile.type}.${property.name}`,
        detail:
          `measured ${String(measured)} of ${String(declared)}, not_applicable ` +
          `${String(notApplicable)}, not_measured ${String(notMeasured)}${anecdote}`,
      });
    }
  }
  if (findings.length > 0) return findings;
  return [
    {
      check: 'property_states',
      status: 'ok',
      subject: ALL,
      detail: profiles.some((profile) => profile.count > 0)
        ? 'every declared property is measured on every entry'
        : 'no entries to profile',
    },
  ];
}

/** The brief's size against the token cap, measured on the text `asc types brief` prints. */
export function briefSize(summaries: readonly TypeSummary[]): readonly DoctorFinding[] {
  const active = summaries.filter((summary) => summary.status === 'active');
  // The whole payload through the shared renderer, header and all (`asc-uftd`). This is why the
  // recording command lives in `brief-text.ts` and nowhere else: this check's contract is to report
  // the size of *what the brief actually prints*, and a line the payload prints that this does not
  // count is precisely the drift `brief-text.ts` exists to prevent. An empty registry renders to
  // `''` rather than to a bare command line, so a deprecated-only store measures 0.
  const text = briefText(active);
  const bytes = Buffer.byteLength(text, 'utf8');
  const tokens = Math.round(countCodePoints(text) / BRIEF_CODE_POINTS_PER_TOKEN);
  const over = tokens > BRIEF_TOKEN_CAP;
  const capped =
    bytes > BRIEF_CAP_BYTES
      ? `; the SessionStart brief prints only the lines that fit in ` +
        `${String(BRIEF_CAP_BYTES)} bytes and points to the rest`
      : '';
  return [
    {
      check: 'brief_size',
      status: over ? 'warn' : 'ok',
      subject: `${String(active.length)} active types`,
      detail:
        `${String(bytes)} bytes, ~${String(tokens)} tokens of ${String(BRIEF_TOKEN_CAP)}` +
        ` (a delivery bound: a larger payload is truncated silently)${capped}`,
    },
  ];
}

/**
 * The store is gitignored and local-only, so `asc export` is its only backup -- and it leaves no
 * trace, so this cannot say whether one exists. It says that, and how much is at stake.
 *
 * **Takes both counts, and guards on their SUM** (`asc-9xi0`). `live` is what still counts, and a
 * store can hold thousands of struck entries and no live ones -- guarding on `live === 0` alone
 * would tell someone with 3,000 struck rows and no export that they have nothing to lose. Struck
 * entries are still rows in a gitignored local store, so they are still at stake. When some are
 * struck the subject spells both out, so the total is never the only number on screen.
 */
export function exportStatus(live: number, struck: number): readonly DoctorFinding[] {
  const total = live + struck;
  if (total === 0) {
    return [{ check: 'export', status: 'ok', subject: ALL, detail: 'no entries to lose' }];
  }
  return [
    {
      check: 'export',
      status: 'info',
      subject:
        struck === 0
          ? `${String(total)} entries`
          : `${String(total)} entries (${String(live)} live, ${String(struck)} struck)`,
      detail:
        'cannot tell whether an export exists (asc export writes to stdout and records nothing); ' +
        'the store is local-only, so `asc export > corpus.jsonl` is its only backup',
    },
  ];
}

/**
 * What the command could see about this project's installed hook, as plain data (`asc-mu20`).
 *
 * Gathered by `commands/doctor.ts` rather than read here, for the reason this module is pure: the
 * check is a function of four facts, and none of them is a store call.
 *
 * `installed` and `scriptExists` are separate questions and neither implies the other. A settings
 * file can name the hook while the script is gone (a clone that dropped an untracked file, a hand
 * edit), and a script can be sitting there while the settings file names nothing -- in which case it
 * is not installed, whatever is on disk, and Claude Code will never run it.
 */
export interface HookState {
  /** Where the script lives, project-relative -- the same string `install-hook` writes. */
  readonly scriptPath: string;
  /** Whether `.claude/settings.json` names an ascend hook at all, by either generation marker. */
  readonly installed: boolean;
  /** Whether the script file is there. */
  readonly scriptExists: boolean;
  /**
   * Byte-equal to what `hookScript` would write today, exactly as `isScriptCurrent` defines it --
   * or `undefined` when this ascend cannot resolve its own executable and so cannot compute the
   * bytes it would write. Unknown is not the same answer as stale, and the check says so.
   */
  readonly scriptCurrent: boolean | undefined;
  /** Where the `asc` shim lives, project-relative -- the same string `install-hook` writes. */
  readonly shimPath: string;
  /**
   * Byte-equal to what `shimScript` would write today AND executable -- or `undefined` for the same
   * reason `scriptCurrent` is. Both files are the same generation of the same install, which is why
   * one check reports on both: "is the machinery current" is one question, and "which of the two is
   * stale" is a detail of the answer rather than a second verdict.
   */
  readonly shimCurrent: boolean | undefined;
  /**
   * Which branch of the install's own chain a hook run in this project reaches --
   * `resolveHookBinary`'s answer, with the path dropped, or `undefined` when there is no answer to
   * report: this ascend cannot resolve its own executable and so cannot ask, or none of the
   * install's own candidates resolves here. Either way the report makes no claim, which is the
   * right output for both -- see `hookGeneration`, which is the only reader.
   *
   * **Reported, never a verdict, and only where it describes the file on disk.** A *stale* script
   * runs the chain of whichever generation wrote it, which this ascend does not model; naming
   * today's branch for it would be a claim about bytes that are not there.
   */
  readonly resolvedVia: HookBinaryKind | undefined;
}

/**
 * The branch a hook reaches, in words a reader can act on rather than the kind's own spelling.
 *
 * `shim` and `relative` are internal names for two different filesystems facts, and a report is not
 * the place to make a reader learn them. What the sentence has to convey is whether the hook reaches
 * something this project OWNS or something the ambient machine happened to have -- which is the
 * difference that made `dogfood/0082` an hour of reading rather than a line of output.
 *
 * `undefined` returns nothing, because there is no branch to name; the caller says that instead.
 */
function branchPhrase(state: HookState): string | undefined {
  switch (state.resolvedVia) {
    case 'node-modules':
      return '`node_modules/.bin/asc` in this project';
    case 'relative':
      return 'the checkout ascend is running from';
    case 'shim':
      return `\`${state.shimPath}\`, written by this project's own install`;
    case undefined:
      return undefined;
  }
}

/**
 * Whether the installed hook script is the generation this ascend would write (`asc-mu20`).
 *
 * **The artifact is generated, the generator changes, and nothing re-runs it.** `asc install-hook`
 * is opt-in and user-triggered, because it writes shared, tracked `.claude/settings.json`; the
 * script beside it is rewritten only on a re-run. So upgrading ascend moves what the brief prints
 * and leaves every existing project's script teaching the previous generation's text, with nothing
 * reporting the skew. `install-hook --dry-run` does report it -- `upgrade` is one of its outcomes --
 * but that is a command nobody has a reason to run. This check is the same fact, on the command that
 * runs when someone asks whether their registry is healthy.
 *
 * **Byte equality, and deliberately the same one `isScriptCurrent` defines**, so there is one
 * identity rather than two: doctor computing currency its own way would be a second answer to a
 * question that already has one, and the two would drift.
 *
 * **A project that never opted in is `ok`, not a warning.** Nothing was installed, so nothing is
 * drifting, and a hook is a choice rather than a requirement. The row is still emitted: a quiet
 * check that says so is what tells "checked, clean" apart from "never ran", which is this module's
 * contract for every check it owns.
 *
 * The date on the file is not evidence and is not read. A script touched yesterday may be a
 * generation behind, and one written a year ago may be exactly right -- which is the whole reason
 * this compares bytes.
 */
export function hookGeneration(state: HookState): readonly DoctorFinding[] {
  if (!state.installed) {
    return [
      {
        check: 'hook_generation',
        status: 'ok',
        subject: state.scriptPath,
        detail:
          'no hook installed, so nothing is drifting; `asc install-hook` adds one if recall is ' +
          'wanted',
      },
    ];
  }
  if (!state.scriptExists) {
    return [
      {
        check: 'hook_generation',
        status: 'warn',
        subject: state.scriptPath,
        detail:
          'a hook is registered in .claude/settings.json but the script is missing, so every ' +
          'session runs nothing; `asc install-hook` writes it again',
      },
    ];
  }
  if (state.scriptCurrent === undefined || state.shimCurrent === undefined) {
    return [
      {
        check: 'hook_generation',
        status: 'info',
        subject: state.scriptPath,
        detail:
          'a hook is registered and the script is present, but this ascend cannot resolve its own ' +
          'executable, so what it would write cannot be computed and the answer is unknown',
      },
    ];
  }
  // Which of the two files is behind, named rather than assumed. They are written together, so in
  // practice they age together -- but the shim can lose its executable bit on its own (restored
  // from an archive, copied without `-p`) and a message that blamed the script for that would send
  // its reader to diff a file that is byte-identical to the one they should have.
  const stale = [
    ...(state.scriptCurrent ? [] : ['the hook script']),
    ...(state.shimCurrent ? [] : ['the `asc` shim']),
  ];
  if (stale.length === 0) {
    // The branch is named ONLY here, and the restriction is the whole honesty of this field. On
    // this path the installed bytes are the ones `hookScript` would write, so the chain the hook
    // runs is the chain `resolveHookBinary` walked and the two answers are about the same file. On
    // the paths above they are not: a script a generation behind runs the chain of whichever
    // ascend wrote it, and a stale message that named today's branch would be describing bytes
    // that are not on disk. That case already says the true thing -- "resolves a binary the way it
    // used to" -- which is why it needs no branch name to be correct.
    //
    // `resolvedVia === 'none'` cannot be reached from here and is not a case to write a sentence
    // for: reaching this point means `shimCurrent`, which is bytes AND the execute bit, and an
    // executable shim is the candidate `resolveHookBinary` returns. The field drops `none` for
    // that reason rather than reporting a state this check cannot be in.
    const branch = branchPhrase(state);
    return [
      {
        check: 'hook_generation',
        status: 'ok',
        subject: state.scriptPath,
        detail:
          'the installed script and shim are the generation this ascend would write' +
          (branch === undefined
            ? ''
            : `; it resolves its binary via ${branch} (unless \`$ASCEND_BIN\` overrides it)`),
      },
    ];
  }
  return [
    {
      check: 'hook_generation',
      status: 'warn',
      subject: state.scriptPath,
      detail:
        `${stale.join(' and ')} ${stale.length === 1 ? 'was' : 'were'} written by an older ascend, ` +
        `so it teaches what the brief used to say and resolves a binary the way it used to; ` +
        `\`asc install-hook\` rewrites both`,
    },
  ];
}

/** Every check, in the order the report prints them. */
export function runDoctor(
  summaries: readonly TypeSummary[],
  profiles: readonly TypeProfile[],
  hook: HookState,
): readonly DoctorFinding[] {
  const entries = summaries.reduce((sum, summary) => sum + summary.entryCount, 0);
  const struck = summaries.reduce((sum, summary) => sum + summary.struckCount, 0);
  return [
    ...deadTypes(summaries),
    ...nearDuplicates(summaries),
    ...versionDrift(profiles),
    ...propertyStates(profiles),
    ...briefSize(summaries),
    ...exportStatus(entries, struck),
    ...hookGeneration(hook),
  ];
}
