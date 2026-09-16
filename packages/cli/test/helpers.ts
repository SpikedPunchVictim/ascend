/**
 * Shared helpers for the CLI suites.
 *
 * Not collected as a suite: `.test.ts` is what vitest includes, so this file is imported rather than
 * run. It lives here rather than in `src/` because nothing the product ships needs it.
 */

/**
 * stderr as one line, with ascend's own wrapping undone.
 *
 * **ascend wraps a failure or a warning at 80 columns** (`errors.ts`, `renderForStderr`), at spaces
 * only. A phrase in a message can therefore still land either side of a line break, so
 * `toContain('asc install-hook')` fails against the raw text on a phrase that is plainly there.
 * Collapsing the runs of whitespace is what makes a substring assertion mean what it reads like.
 *
 * **Nothing strips a `›` any more, and this function is the check that none is needed.** Until
 * asc-98c, oclif rendered every error and every warning, wrapping with `wrapAnsi(..., { hard: true })`
 * and prefixing each continuation line with ` ›   ` -- and breaking mid-token, so a path arrived as
 * `.../asc-ingest-IgAq9O › /.claude/projects` and could neither be read nor pasted. ascend now
 * renders its own, so there is no marker to strip; if one comes back, the assertions that go
 * through here fail, which is the only way they should learn about it.
 *
 * One copy, shared by `init.test.ts` and `install-hook.test.ts`. It was two, and the second was
 * written without the measurement the first records -- so it collapsed whitespace alone and failed
 * on the wrapped command it was written to read, which is exactly the rediscovery this file exists
 * to stop.
 */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
