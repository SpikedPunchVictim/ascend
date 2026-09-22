/**
 * Whether the running Node is new enough for ascend, and the sentence to print when it is not.
 *
 * `@ascend/store` imports `node:sqlite`, which Node added in 22.5.0 -- there is no earlier
 * version to fall back to, and importing it on an older Node throws a bare module-resolution
 * error with no mention of a version requirement. The root `package.json`'s `"node": ">=22"`
 * does not catch this: 22.0.0 through 22.4.x satisfy `>=22` and fail anyway. This module is the
 * one place that knows the real floor and can say so before the confusing error has a chance to
 * fire.
 *
 * **This file imports nothing, and that is load-bearing, not tidiness.** `bin.ts` calls
 * `nodeVersionRefusal` before `execute(...)` loads any command, specifically so that a Node too
 * old for `node:sqlite` gets a sentence instead of the module-resolution error that importing
 * `@ascend/store` (or anything that pulls it in, such as `errors.ts`) would throw on that same
 * Node. A module with a single import could reintroduce exactly the failure this one exists to
 * pre-empt, so none is added here, ever -- not `errors.ts`, not a type from `@ascend/store`, not
 * even a Node built-in beyond what the language itself provides.
 */

/**
 * The oldest Node this package runs on.
 *
 * The two parts are the source and the string is derived from them, rather than the other way
 * around, because the comparison below needs numbers and the message needs a sentence -- and a
 * floor written out twice is a floor that can be raised in one place only. There is no patch
 * component in the requirement (`node:sqlite` arrived in 22.5.0 itself), so the `.0` is part of
 * how the version is spelled, not a third thing to keep in step.
 */
const MINIMUM_MAJOR = 22;
const MINIMUM_MINOR = 5;
export const MINIMUM_NODE = `${String(MINIMUM_MAJOR)}.${String(MINIMUM_MINOR)}.0`;

/**
 * Major and minor, parsed as integers -- never compared as strings.
 *
 * `'22.10.0' < '22.5.0'` is `true` under string comparison (`'1' < '5'`) and `false` in fact:
 * 22.10 is newer than 22.5. That is not a hypothetical edge case -- it is the version Node
 * reaches after ten minor releases past the floor this module enforces, and it will exist.
 *
 * The pattern anchors at the start and stops after the minor, so a trailing patch and any
 * pre-release suffix (`23.0.0-nightly20260101...`) are simply ignored rather than required to
 * match a stricter shape. Unparseable input -- anything that does not start `<digits>.<digits>`
 * -- returns `undefined`, which `nodeVersionRefusal` treats as "let it run": a false refusal on a
 * Node this cannot make sense of would break a working install over a string this module failed
 * to read, and the real failure downstream (the `node:sqlite` import throwing) is already loud.
 */
function parseMajorMinor(
  version: string,
): { readonly major: number; readonly minor: number } | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (match === null) return undefined;
  // `?? ''` rather than an assertion: `noUncheckedIndexedAccess` cannot see that both groups are
  // mandatory (neither has a `?`), so it types every capture as possibly `undefined`. An empty
  // fallback fails `Number.parseInt` into `NaN`, which the `isFinite` check below turns into the
  // same "cannot parse" answer as a version string that never matched at all.
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return undefined;
  return { major, minor };
}

/**
 * The refusal message for `version`, or `undefined` when it is new enough to run.
 *
 * `version` is meant to be `process.versions.node` -- no leading `v`, unlike `process.version`.
 * Context, problem, fix, in that order, matching the shape `driver-errors.ts` uses everywhere
 * else in this package:
 *
 *   - context: what ascend needs and why (`node:sqlite`, added in 22.5)
 *   - problem: what is actually running
 *   - fix: install a new enough Node and re-run
 */
export function nodeVersionRefusal(version: string): string | undefined {
  const parsed = parseMajorMinor(version);
  if (parsed === undefined) return undefined;

  const { major, minor } = parsed;
  const newEnough = major > MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor >= MINIMUM_MINOR);
  if (newEnough) return undefined;

  return (
    `ascend requires Node ${MINIMUM_NODE} or later: '@ascend/store' imports 'node:sqlite', which ` +
    `Node added in ${String(MINIMUM_MAJOR)}.${String(MINIMUM_MINOR)}. This process is running ` +
    `Node ${version}, which does not have it. Install Node ${MINIMUM_NODE} or later and re-run.`
  );
}
