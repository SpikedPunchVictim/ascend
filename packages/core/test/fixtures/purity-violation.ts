/**
 * DELIBERATE VIOLATION FIXTURE -- never imported, never built, never run.
 *
 * purity-enforcement.test.ts asserts ESLint still rejects this file. If it ever
 * stops rejecting it, the purity lint block has broken and every "pure core"
 * claim in the project is unverified.
 *
 * Each violation below is planted on purpose, and the test asserts the problem
 * count matches this list exactly. That is the point: a rule that never fires is
 * indistinguishable from a rule that passes, so every dimension of the purity
 * contract -- fs, the ambient clock, nondeterminism, the monotonic clock, ambient
 * randomness -- has to be shown failing, not just shown configured.
 *
 * (This file is intentionally excluded from any tsconfig project's build.)
 */
import { readFileSync } from 'node:fs';

export const violation = (): string => readFileSync('x', 'utf8') + String(Date.now());

/** Nondeterminism: a result computed from this is unreproducible. */
export const nondeterministic = (): number => Math.random();

/** An ambient monotonic clock is still an ambient clock. */
export const ambientElapsed = (): number => performance.now();

/** An ID drawn from the environment is not an injected ID. */
export const ambientId = (): string => crypto.randomUUID();
