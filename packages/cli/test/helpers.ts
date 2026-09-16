/**
 * Shared helpers for the CLI suites.
 *
 * Not collected as a suite: `.test.ts` is what vitest includes, so this file is imported rather than
 * run. It lives here rather than in `src/` because nothing the product ships needs it.
 */

/**
 * stderr as one line, with oclif's decoration removed.
 *
 * **oclif wraps `this.warn` at the terminal width** and prefixes every continuation line with
 * ` ›   `. Measured: a warning containing `asc install-hook` arrives as `asc` then
 * ` ›    install-hook`, so `toContain('asc install-hook')` fails against the raw text on a
 * phrase that is plainly there. Collapsing the prefix and the runs of whitespace is what makes a
 * substring assertion mean what it reads like.
 *
 * The marker is stripped only where it is a LINE PREFIX, not everywhere it appears: `›` is ordinary
 * punctuation in a message, and a global replace would quietly rewrite the text under assertion.
 *
 * One copy, shared by `init.test.ts` and `install-hook.test.ts`. It was two, and the second was
 * written without the measurement the first records -- so it collapsed whitespace alone and failed
 * on the wrapped command it was written to read, which is exactly the rediscovery this file exists
 * to stop.
 */
export function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
