/**
 * The text of `asc types brief`, shared with `asc doctor` (asc-12a) so that the size doctor
 * reports is the size of what the brief actually prints -- a second rendering would be a second
 * number that could drift from the first.
 */

import type { TypeSummary } from '@ascend/store';

import type { DueGrade } from './intervention.js';
import { isBoundary } from './output.js';

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
 * The command that writes an entry, in the form this CLI documents for it -- the document as an
 * **operand**, which is `record.ts`'s own recorded deviation from `ARCHITECTURE.md`.
 *
 * **A constant of its own, so the two artifacts that name it cannot disagree.** The brief prints it
 * (composed into `RECORD_COMMAND_LINE` below) and the comment in the generated
 * `.claude/ascend-hook.sh` tells a reader to run it by hand -- and the defect this fixes
 * (`asc-l38f`, `dogfood/0028`) was precisely those two naming the same program two different ways.
 * The script's way (`node "$root"/…/bin.js record …`) runs and is not granted; the bare way is
 * granted and resolves nowhere when the binary is off `PATH`. Sharing one spelling is how the class
 * is stopped rather than the instance. The `--prop=` flags are the convenience path, and
 * `asc record --help` is where a reader finds those.
 *
 * **E12.13 rendered `ARCHITECTURE.md`'s spelling -- `asc record <type> --json -` -- and that
 * was one artifact teaching what three others had moved away from** (`asc-fkp1`, finding 1 of this
 * change's adversarial review). `--json` is already the versioned-**output** contract on every
 * command, so a `--json` that also meant "read JSON here" would be two meanings for one flag on one
 * command; `record.ts` records the deviation in full and implements the operand instead
 * (*"There is no spelling that keeps both"*). `asc record --help` documents it -- `[DOCUMENT]  Path
 * to an entry document, or \`-\` for standard input` -- and both of `README.md`'s examples are of the
 * form `cat reviews.json | asc record review_completed -`. This line is the spelling those three
 * teach; `--json` is a flag a caller adds for the envelope, not part of the path a reader is handed.
 * `ARCHITECTURE.md` itself still names the old spelling and is the document to reconcile -- the
 * brief is deliberately not the artifact carrying that.
 */
export const RECORD_COMMAND = 'asc record TYPE -';

/**
 * What the reader has to supply for `RECORD_COMMAND` to run at all: the entry, on standard input.
 *
 * **A constant of its own for the same reason `RECORD_COMMAND` is one.** Both artifacts that name
 * the command -- the brief's line and the hook script's by-hand comment -- need this clause, and a
 * note present on one and absent from the other is the asymmetry `RECORD_COMMAND` exists to
 * prevent, one level down. It is not appended to `RECORD_COMMAND` itself because that name means
 * *the command*: appending it would leave this file with no name for the bare string
 * `asc record --help` documents, and every consumer wanting that would have to parse the note back
 * off the end. (The doc here once justified that with a consumer that does not exist -- the
 * script's resolution comment names no command at all -- which finding 2 of this change's review
 * caught. The reason is the name, not a caller.)
 *
 * **Without it the command a session runs as printed exits 1** (`asc-k0l9`). Measured in a scratch
 * project created by `asc init`, on the form the line now teaches:
 *
 * ```
 * $ node packages/cli/dist/bin.js record review_completed - < /dev/null
 * Error: standard input is not valid JSON: Unexpected end of JSON input.
 * exit=1
 * ```
 *
 * `ARCHITECTURE.md` states its own spelling *with* this qualifier -- *"**`asc record <type>
 * --json -`** (stdin) is the primary path"* -- and the first rendering of this line dropped it. The
 * failure that left is the one `dogfood/0028` is about, one step further on: a session that has just
 * been told the verb runs it, gets an error about a document it never intended to write, and has to
 * work out from the error alone that the entry was supposed to arrive on stdin.
 *
 * **That `exit=1` is the closed-stdin case, which is not every case.** With stdin a TTY, or a pipe
 * its writer has not closed, the same command blocks in `readInput` -- called at `record.ts`, before
 * `findType` resolves the type -- and prints nothing at all, not even the unknown-type error. A tool
 * call closes stdin and does not meet this; a terminal does (`asc-fkp1`'s sibling finding).
 */
export const RECORD_COMMAND_INPUT = 'a JSON entry on stdin';

/**
 * The one line naming the command that writes an entry, printed first (`asc-uftd`).
 *
 * **This is a deliberate reversal of a documented rule, and the measurement is the reason.** The
 * brief's contract was "one line per type, `name -- record_when`, and nothing else -- no header, no
 * rule, no counts", on the argument that this payload is injected into every session and every
 * extra line is a context tax. Measured on 2026-10-01, that contract produced a digest where
 * **`asc record` occurred 0 times in the 3,382 bytes a session received** (3,381 as `asc doctor`
 * counts it -- the same text without the newline `this.log` appends; the two numbers name different
 * objects, and `.agents/research/2026-10-01-bug-hunt-e12-13.md` F3 found this file and three others
 * quoting one of them as if it were the other): the only `asc <verb>` strings in the whole
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
 * EV-16 measured its cost as linear in lines), and it had **4,619 bytes free** -- the cap less the
 * 3,381 the check reports. A headroom figure needs its object named as much as a size does, and F3
 * of `.agents/research/2026-10-01-bug-hunt-e12-13.md` is about the two being quoted as if they were
 * one.
 *
 * **The line's cost is stated here with its newline, every time**, because the newline is what
 * `commands/types/brief.ts` charges against the cap: `BRIEF_CAP_BYTES -
 * Buffer.byteLength(`${RECORD_COMMAND_LINE}\n`)`. It cost **38** bytes when E12.13 added it (37
 * characters plus that newline) and costs **56** now (55 plus the newline) -- the input note adding
 * 25 and the operand spelling taking 7 back. The digest this repo serves measures **3,437 bytes**
 * as `asc doctor` counts it (**3,438** on stdout, the same text plus the newline `this.log`
 * appends), leaving **4,563** free on the same basis as the 4,619 above.
 *
 * Composed from `RECORD_COMMAND` rather than spelled again, so the sentence and the command inside
 * it cannot drift apart -- and carrying `RECORD_COMMAND_INPUT` for the same reason, because a
 * command that reads standard input is not a command a reader can run until they are told so.
 */
export const RECORD_COMMAND_LINE = `Record with: ${RECORD_COMMAND}  (${RECORD_COMMAND_INPUT})`;

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
 * How many due grades the brief names before it stops and counts the rest (`asc-09wx.8.5`).
 *
 * **A bound is required of this block, because it is charged off the TOP of the cap where `fitBrief`
 * cannot drop it.** The type lines below it are fitted and a note accounts for what was dropped; a
 * block that cannot be dropped AND has no bound of its own would be the one way this payload could
 * be pushed past `BRIEF_CAP_BYTES`, which is a delivery bound nothing reports the breach of
 * (`commands/types/brief.ts` carries that measurement). With `CHANGE_CHARS` below bounding one line
 * as well, the block's worst case is this many lines plus one remainder line; `brief-text.test.ts`
 * measures that worst case against the cap rather than asserting it is small.
 *
 * **Five rather than one, and the remainder is not lost.** A backlog of ungraded rows is exactly what
 * this block exists to surface, so naming one of five would keep the other four invisible for another
 * session -- and grading the five named here is what brings the rest forward, because the block is
 * ordered by the bound that passed, oldest first.
 */
export const DUE_GRADE_LIMIT = 5;

/**
 * How much of a row's `change` a due-grade line prints.
 *
 * `change` is a free-text `string` property, so its length is whatever somebody typed, and a due
 * grade whose line ran to 10,000 bytes would be exactly the unbounded block `DUE_GRADE_LIMIT` exists
 * to prevent -- one line over the cap with nothing able to drop it. The name in full is on the row
 * and `asc handlers grade` prints it; what the brief needs is enough of it to recognize the row by.
 */
const CHANGE_CHARS = 60;

/**
 * `text` cut to at most `max` code points, backed off to a cluster boundary, marked when it was cut.
 *
 * **By code point and not by byte or code unit**, because a reader counts a name in characters and
 * cutting either of the other two severs one. `asc-bcv.23` is this repository's record of `--table`
 * splitting a grapheme cluster and showing a plausible-looking *different* character, which a reader
 * has no way to notice -- and a code-point cut is not enough on its own, because a combining mark, a
 * ZWJ sequence or a flag is several code points that render as one character.
 *
 * **The boundary rule is `output.ts`'s, imported rather than restated.** That file carries the fixed
 * subset of UAX #29 it was measured against and the reason it is not `Intl.Segmenter`; a second copy
 * here would be two implementations of one invariant, and this one would be the copy nobody
 * re-measures. What is local is the UNIT -- code points, because that is what the budget names -- and
 * the conversion from it to the code-unit index `isBoundary` reads.
 */
function clip(text: string, max: number): string {
  // `Array.from`, not a spread -- the same spelling `store/src/search.ts` uses for the same reason,
  // and the one the lint rule insists on: a spread over a string is the shape that silently
  // mishandles characters above the BMP in other hands.
  const points = Array.from(text);
  if (points.length <= max) return text;

  // Where the code-point cut falls, as a code-unit index: `isBoundary` reads code units, and a code
  // point above the BMP is two of them.
  let end = 0;
  for (const point of points.slice(0, max)) end += point.length;
  // Walk back until `isBoundary` allows the cut. The walk shrinks only, so the result is never
  // longer than `max` code points, and it terminates at 0 -- always a boundary.
  while (end > 0 && !isBoundary(text, end)) end = indexBefore(text, end);
  return `${text.slice(0, end)}...`;
}

/** The index at which the code point ending at `index` begins, reading a surrogate pair as one. */
function indexBefore(text: string, index: number): number {
  const previous = text.charCodeAt(index - 1);
  return previous >= 0xdc00 && previous <= 0xdfff && index >= 2 ? index - 2 : index - 1;
}

/**
 * One line for a grade the project owes itself.
 *
 * **The wording is the decision, not decoration** (`asc-09wx.8.5`, decision `c38bf1a2`). The instant
 * this names is `applied_at` plus `grading_point` in CALENDAR days while `grading_point` is stated in
 * ACTIVE days, so it is an earlier bound on when the wait is up rather than the moment it is: on the
 * sparsest corpus measured it lands 14.98 calendar days early and permits a grade holding 20 of the
 * 30 active days the row asked for (`dogfood/0106`, and `DueGrade` in `intervention.ts`). A line that
 * said "due" would be read as a verdict, and would be a false alarm on every sparse log -- so it says
 * **due to BECOME READABLE**, which is what the row means and what the reader can act on.
 *
 * **`--effect` is named with its placeholder because the command has no default for it and refuses
 * without it.** That refusal is deliberate (`grade.ts`: *"a figure this row did not choose would be
 * this command inventing an effect size for it"*), so the flag has to be taught somewhere; a reader
 * who discovers it from a usage error has spent a turn doing it, which is the discovery step
 * `dogfood/0028` records the cost of. The value itself is the reader's to supply, and the row's own
 * `prediction` is where they look for it.
 */
export function dueGradeLine(due: DueGrade): string {
  return (
    `grade owed: ${clip(due.change, CHANGE_CHARS)} -- waited ${String(due.days)} active days, and ` +
    `the earlier bound on it (${due.dueAt}) has passed, so it is due to become readable. ` +
    `Read it: asc handlers grade ${due.root} --effect <the size the row predicted>`
  );
}

/**
 * The due-grade lines, longest-waiting first, with one line accounting for any the limit left out.
 *
 * The remainder is a count and nothing else, deliberately: there is no command that lists due grades
 * (`asc handlers grade` takes one id), and a pointer naming `asc query` with SQL over a versioned
 * view would be a claim this module cannot keep true as the type is versioned. Grading the rows named
 * here is what brings the rest forward, so the line counts them and says so.
 */
export function dueGradeLines(due: readonly DueGrade[]): readonly string[] {
  const named = due.slice(0, DUE_GRADE_LIMIT).map(dueGradeLine);
  const rest = due.length - named.length;
  if (rest === 0) return named;
  return [
    ...named,
    `[and ${String(rest)} more rows' waits are up -- this list names the ${String(
      DUE_GRADE_LIMIT,
    )} that have waited longest, and grading those brings the next ones forward.]`,
  ];
}

/**
 * The fixed prefix: the recording command when there is a type to record, then the grades owed.
 *
 * **Separated from `briefText` because the command has to charge these bytes to the cap itself.**
 * `commands/types/brief.ts` hands `fitBrief` a budget of the cap less this text, exactly as it does
 * for the recording command alone -- so this is the one thing `fitBrief` can never drop, and it is
 * why `DUE_GRADE_LIMIT` is a bound rather than a preference.
 *
 * **The recording command is dropped when there is no active type, and that is a rule of its own.**
 * `asc record TYPE -` with no type to put in the TYPE slot is a command the project cannot run, and a
 * due-grade block is still something for a reader to point at -- so a registry with no active type
 * prints the grades owed and no header, rather than teaching a command that would refuse.
 */
export function briefHead(summaries: readonly TypeSummary[], due: readonly DueGrade[]): string {
  const header = summaries.length === 0 ? [] : [RECORD_COMMAND_LINE];
  return [...header, ...dueGradeLines(due)].join('\n');
}

/**
 * The whole payload: the recording command, the grades owed, then one line per type.
 *
 * **The empty case is silence, not a bare command line.** A header with no types under it names a
 * command and shows a reader nothing to point it at, and the deprecated-only registry -- a store
 * whose every type has been retired -- is exactly the case where the old contract printed nothing
 * at all. Returning `''` here rather than `RECORD_COMMAND` keeps that, so the rule lives in one
 * place instead of in each caller's early return. **A due grade counts as something to point at**:
 * it names a row, a command and an id, so a store with no active type and an ungraded row is not
 * the empty case and prints its grade.
 *
 * Shared with `asc doctor` so the size that check reports is the size of what this renders, header
 * included; that sharing is the reason the command line belongs here rather than in the hook script,
 * which the doctor cannot see and `BRIEF_CAP_BYTES` does not bound.
 */
export function briefText(summaries: readonly TypeSummary[], due: readonly DueGrade[]): string {
  const lines = briefLines(summaries);
  const head = briefHead(summaries, due);
  return head === '' ? lines.join('\n') : [head, ...lines].join('\n');
}
