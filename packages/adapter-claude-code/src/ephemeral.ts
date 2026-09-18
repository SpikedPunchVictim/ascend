/**
 * Ephemeral OS temp roots, as they appear in Claude Code's ENCODED project label.
 *
 * `asc-80m`. `~/.claude/projects/<encoded>` names one directory per project Claude Code has ever
 * been run in, and the encoding is a dash-encoded absolute path (`transcript-file.ts`'s own doc:
 * the encoding replaces both `/` and `-` with `-`). Some of those directories are OS temp
 * directories a benchmark run created and will never see again -- `asc ingest claude-code`
 * cannot tell that from the label alone, so today it ingests them as ordinary projects, and a
 * project that can never recur is a permanent singleton stratum in exactly the project-keyed
 * analysis this tool exists to do (EV-19).
 *
 * **A PURE FUNCTION OF THE LABEL, and deliberately not of `os.tmpdir()`, `process.env`, or the
 * filesystem.** Zero Node builtin imports in this file, on purpose. Reading the ingesting
 * machine's environment would make two machines ingesting the SAME corpus disagree about what is
 * in it -- the same determinism argument that governs the generated views in
 * `packages/store/src/views.ts`, whose own rule is that two stores with the same types get
 * byte-identical views (`views.ts:386`). A label is a fact recorded in 2026; the machine reading
 * it today has its own, unrelated `os.tmpdir()`, and letting that machine's answer decide what a
 * PAST session's directory was would make "is this project ephemeral" a question whose answer
 * depends on where you ask it from.
 *
 * **The match is ANCHORED, never a substring.** The label is the WHOLE encoded absolute path, so
 * a temp root is a PREFIX of it by construction -- never merely contained in it. `${root}-` (not
 * `${root}`) is the boundary that keeps a real project at `/tmpfoo` (label `-tmpfoo`) from
 * matching `-tmp`: `-tmpfoo` does not start with `-tmp-`, only `-tmp` itself or `-tmp-<anything>`
 * does. The DECISION comment on `asc-80m` (2026-09-18) is explicit that "contains temp" is the
 * WRONG rule -- the store holds a real project labelled `-Users-<user>-temp-<project>` that must
 * not be filtered, and that counter-example is what an unanchored or substring match would catch.
 *
 * **Why `-var-folders` names the whole subtree rather than the exact `os.tmpdir()` path.**
 * `os.tmpdir()` on macOS is `/var/folders/<41>/<per-user-per-boot-id>/T`, e.g.
 * `/var/folders/41/<id>/T` (measured on the machine that filed this bead, 2026-09-18). The `<id>`
 * segment is assigned per user and per boot and is not recoverable from a label alone, so there
 * is no exact path to anchor against -- and every Claude Code project directory anywhere under
 * `/var/folders` is, by construction, some process's OS-assigned scratch space, never a project a
 * person chose to work in. Anchoring on the shorter, stable prefix is therefore not an
 * approximation of the precise rule; it IS the precise rule for this root.
 *
 * **Why both the realpath'd and un-realpath'd spellings are listed.** On macOS, `/tmp` resolves
 * to `/private/tmp`, `/var/tmp` to `/private/var/tmp`, and `/var/folders` to
 * `/private/var/folders` (measured 2026-09-18, via `fs.realpathSync`). Which spelling ends up in
 * a transcript's `cwd` -- and hence in the encoded label -- depends on how the working directory
 * was spelled when the session ran, not on anything this module can observe after the fact. The
 * five ephemeral directories measured in the live corpus on 2026-09-18 all begin
 * `-private-var-folders-41-`, i.e. the realpath'd form, but a benchmark run that never resolved
 * the symlink would produce the un-realpath'd form instead, so both are listed.
 *
 * **Windows is OUT OF SCOPE, said rather than guessed.** No corpus measured for `asc-80m` --
 * including the 22-directory, 879-file live corpus census taken 2026-09-18 -- contains a Windows
 * transcript, so there is no observed label shape to anchor a Windows temp root against.
 * Inventing one (`%TEMP%`, `C:\Windows\Temp`, or any encoding of either) would be fabricating a
 * pattern from nothing, which `TASKS.md` rule #7 forbids: "Omitted, never fabricated. When a
 * value does not exist, omit it." (`TASKS.md:27`).
 */

/**
 * Encoded OS temp roots, in the order a person reading the DECISION would list them: the three
 * un-realpath'd forms Node's own `os.tmpdir()`/well-known constants would resolve to, and their
 * `/private`-prefixed realpath'd counterparts.
 */
export const EPHEMERAL_ROOTS: readonly string[] = [
  '-tmp',
  '-private-tmp',
  '-var-tmp',
  '-private-var-tmp',
  '-var-folders',
  '-private-var-folders',
];

/**
 * Whether `project` -- Claude Code's encoded project label -- names a directory under a known OS
 * temp root, and so can never recur.
 *
 * Anchored, per root: `project === root` (the temp root itself, if Claude Code were ever run
 * there directly) or `project.startsWith(\`${root}-\`)` (anything beneath it). The `${root}-`
 * form is load-bearing -- see this module's header for the `-tmpfoo` / `-tmp` case it exists to
 * separate.
 */
export function isEphemeralProject(project: string): boolean {
  return EPHEMERAL_ROOTS.some((root) => project === root || project.startsWith(`${root}-`));
}
