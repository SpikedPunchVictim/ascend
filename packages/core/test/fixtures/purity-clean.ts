/**
 * The control for purity-violation.ts: this must pass.
 *
 * A purity check that flags everything proves nothing -- it only shows the
 * checker runs. The pair is what demonstrates the rule discriminates.
 */

/** Time is injected, never read from the ambient environment. */
export type Clock = () => string;

export const stamp = (clock: Clock): string => clock();
