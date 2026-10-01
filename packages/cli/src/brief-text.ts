/**
 * The text of `asc types brief`, shared with `asc doctor` (asc-12a) so that the size doctor
 * reports is the size of what the brief actually prints -- a second rendering would be a second
 * number that could drift from the first.
 */

import type { TypeSummary } from '@ascend/store';

/**
 * The byte count this command refuses to exceed on its own stdout.
 *
 * Below every point measured **delivered** (8,990 bytes arrived whole) and below the smallest point
 * measured **truncated** (10,495), so the cap sits inside the region the measurement covers rather
 * than at its edge. The ceiling itself is bracketed, not located -- the bead says in as many words
 * not to quote a figure for it -- so the ~990 bytes of headroom (11%) are a judgement, stated here
 * as one rather than implied, and this constant is the single place to move it.
 *
 * The unit is BYTES because that is what the platform counts: `bd prime` at 47,381 bytes was
 * reported in this repository's own session as "Output too large (46.3KB)", and 47,381 / 1024 =
 * 46.3 exactly. A cap in code points would be the wrong unit by a factor that varies with the
 * text.
 */
export const BRIEF_CAP_BYTES = 8_000;

/**
 * Whether a type holds at least the entries its `review_after` names (asc-bli.6).
 *
 * A LEVEL, where `asc record`'s advisory is an edge: the advisory speaks once, on the write that
 * crosses; the brief states, every session, that the point has been reached. It stays true until
 * someone raises `review_after` -- dismissal is a real act of intent, and there is no snooze state
 * by design. It is never a gate and never a claim of statistical sufficiency; nobody measured one.
 *
 * **Measured against the LIVE count** (`asc-9xi0`), which means striking entries can drop a type
 * back below its threshold. That is the intended direction: `review_after` marks "enough recorded
 * evidence to look", and an entry that has stopped counting is not evidence. The alternative -- a
 * level that survives its own evidence being struck -- would hold the marker up with rows the store
 * says are wrong.
 */
export function reviewAfterReached(summary: TypeSummary): boolean | undefined {
  return summary.reviewAfter === null ? undefined : summary.entryCount >= summary.reviewAfter;
}

/**
 * The line a model reads. Recorded-never is stated, not left blank -- blank reads as "unknown".
 *
 * A reached `review_after` marks the existing line rather than adding a section, and costs nothing
 * on a type that has not reached it: this is the SessionStart payload, and EV-16 measured its cost
 * as linear in lines, so a header or a per-type count on every line would be a tax on every session.
 *
 * **A struck count rides inside the marker, and nowhere else** (`asc-9xi0`). The rule the owner set
 * is that the struck count is shown beside every count that moves, so that nothing is hidden -- and
 * the brief states exactly one count, in this marker, so this is where its struck count goes. The
 * consequence, stated rather than left to be discovered: a struck type whose `review_after` has NOT
 * been reached is byte-identical to an unstruck one, because that line states no count at all. The
 * per-type view of a strike is `asc types list` (`struck` column) and `asc explore <type> --struck`;
 * the brief is the recall prompt and its byte budget is a measured constraint.
 *
 * `struckCount === 0` renders nothing extra, so the common case is byte-identical to what it was.
 */
export function briefLine(summary: TypeSummary): string {
  const struck = summary.struckCount === 0 ? '' : `, ${String(summary.struckCount)} struck`;
  const marker =
    reviewAfterReached(summary) === true
      ? ` [review_after ${String(summary.reviewAfter)} reached: ${String(summary.entryCount)} entries${struck}]`
      : '';
  return summary.recordWhen === null
    ? `${summary.name}${marker} -- no record_when given`
    : `${summary.name}${marker} -- ${summary.recordWhen}`;
}

/**
 * The command that writes an entry, in `ARCHITECTURE.md:333`'s primary spelling for `asc record`.
 *
 * **A constant of its own, so the two artifacts that name it cannot disagree.** The brief prints it
 * (composed into `RECORD_COMMAND_LINE` below) and the comment in the generated
 * `.claude/ascend-hook.sh` tells a reader to run it by hand -- and the defect this fixes
 * (`asc-l38f`, `dogfood/0028`) was precisely those two naming the same program two different ways.
 * The script's way (`node "$root"/…/bin.js record …`) runs and is not granted; the bare way is
 * granted and resolves nowhere when the binary is off `PATH`. Sharing one spelling is how the class
 * is stopped rather than the instance. The `--prop=` flags are the convenience path, and
 * `asc record --help` is where a reader finds those.
 */
export const RECORD_COMMAND = 'asc record TYPE --json -';

/**
 * The one line naming the command that writes an entry, printed first (`asc-uftd`).
 *
 * **This is a deliberate reversal of a documented rule, and the measurement is the reason.** The
 * brief's contract was "one line per type, `name -- record_when`, and nothing else -- no header, no
 * rule, no counts", on the argument that this payload is injected into every session and every
 * extra line is a context tax. Measured on 2026-10-01, that contract produced a digest where
 * **`asc record` occurred 0 times in 3,381 bytes**: the only `asc <verb>` strings in the whole
 * document were `asc ingest` (6, all inside derived types' "Never by hand" text) and `asc query`
 * (1). It named every type and never the verb that writes one, so a session asked to record had to
 * *discover* the command -- and the artifact it found when it went looking, `.claude/ascend-hook.sh`,
 * teaches the form `Bash(asc record:*)` can never match, because an allow rule matches a command's
 * literal text and "doesn't match the same program invoked in a different form". Measured in
 * `spike/ev16-arms.mjs` arm F: the session that read the script tried that form **four times**, was
 * denied, and stopped. Recorded as `dogfood/0028`.
 *
 * The counter-argument the old rule was making is real and is why this is exactly one line rather
 * than a rule or a count: the payload's budget is a measured constraint (`BRIEF_CAP_BYTES`, and
 * EV-16 measured its cost as linear in lines), and it had 4,619 bytes free. The line costs 38 of
 * them, and the digest this repo serves now measures 3,419 bytes -- the number `asc doctor` reports,
 * which is this text's byte length because both go through here.
 *
 * Composed from `RECORD_COMMAND` rather than spelled again, so the sentence and the command inside
 * it cannot drift apart.
 */
export const RECORD_COMMAND_LINE = `Record with: ${RECORD_COMMAND}`;

/**
 * The type lines, in the order the registry already has them.
 *
 * A list rather than a joined string because `asc types brief` fits them one at a time against the
 * cap and drops from the end; joining here would mean splitting them again at the call site.
 */
export function briefLines(summaries: readonly TypeSummary[]): readonly string[] {
  return summaries.map(briefLine);
}

/**
 * The whole payload: the recording command, then one line per type.
 *
 * **The empty case is silence, not a bare command line.** A header with no types under it names a
 * command and shows a reader nothing to point it at, and the deprecated-only registry -- a store
 * whose every type has been retired -- is exactly the case where the old contract printed nothing
 * at all. Returning `''` here rather than `RECORD_COMMAND` keeps that, so the rule lives in one
 * place instead of in each caller's early return.
 *
 * Shared with `asc doctor` so the size that check reports is the size of what this renders, header
 * included; that sharing is the reason the command line belongs here rather than in the hook script,
 * which the doctor cannot see and `BRIEF_CAP_BYTES` does not bound.
 */
export function briefText(summaries: readonly TypeSummary[]): string {
  const lines = briefLines(summaries);
  return lines.length === 0 ? '' : [RECORD_COMMAND_LINE, ...lines].join('\n');
}
