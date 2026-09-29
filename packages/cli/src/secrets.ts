/**
 * Secret-shaped content in a corpus stream, found at the EXPORT BOUNDARY (asc-4a6.2) and reported
 * as counts (asc-4a6.3).
 *
 * **A different threat class from `redact.ts`, so a different module and a different response.**
 * Identity redaction tokenises: the same project label becomes the same placeholder everywhere,
 * so a redacted corpus stays analysable. A secret must not be treated that way -- a stable token
 * for a credential is itself a correlation handle -- and blanking one would ship a corpus that
 * silently differs from the store. The owner's decision (2026-09-28, on asc-4a6.2): a match
 * REFUSES the export. It fails as a false positive, never as a leak.
 *
 * **There is no escape, by decision (asc-42i1).** When this fires on a false positive -- a fixture
 * that looks like a key -- that store can never be exported again: entries are immutable, so the
 * text cannot be edited out, and there is no override flag to pass. The owner decided (d) on
 * 2026-09-28: build no escape until one actually fires, because the refusal already prints the
 * pattern names and line ids that any escape would key on.
 *
 * The options a later fix would choose between are kept HERE rather than only on the bead, and
 * that is a measured choice: `bd search` excludes closed issues by default (its own help says so),
 * so `bd search "recognise secret shapes"` returns nothing for the closed `asc-4a6.2` -- the rule
 * `dogfood/0013` records after a closed ruling was missed for exactly this reason. A closed bead
 * is not a durable place for the thing a future reader needs.
 *
 *   (a) `--allow-secret-pattern`, repeatable and per-pattern, the pattern named in the output;
 *   (b) `--allow-secret-in <line id>`, narrower, but longer to type;
 *   (c) an invalidation annotation on the entry, excluding it from the export.
 *
 * No detector is needed for the trigger: the refusal is self-announcing, and it now says so.
 *
 * **What a report may say.** A pattern NAME and a count of LINES, as `homePathLines` counts lines,
 * plus where each line is (an entry or annotation id, a type or scheme name) so the operator can
 * find it. Never the matched text, never a prefix or a hash of it: a report that quotes a secret
 * to say it hid it defeats the feature, and would land in the very transcript the next ingest
 * reads.
 *
 * **High precision over recall, by construction.** Every pattern is a published, prefixed format
 * or a structural marker, except `secret-assignment`, which requires an upper-case NAME containing
 * SECRET, TOKEN, PASSWORD, PASSWD or API_KEY assigned a literal of 8 or more characters -- and not
 * a `$` reference, a `<placeholder>`, a `{template}` or a `process.env` lookup. A generic
 * high-entropy detector was not added: it would refuse the export over every commit sha and
 * content hash this store holds, and a refusal that fires on everything is one an operator learns
 * to route around.
 *
 * Pure: no I/O, and nothing here is stored.
 */

import type { CorpusLine } from './corpus.js';

export interface SecretPattern {
  /** The name a report uses. Stable: a caller may match on it. */
  readonly name: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/,
  },
  { name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  // Negative lookahead so an Anthropic key is reported once, under its own name.
  { name: 'openai-api-key', pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'bearer-token', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    name: 'secret-assignment',
    pattern:
      /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[:=]\s*["']?(?![$<{]|process\.env)[^\s"'`]{8,}/,
  },
];

export interface SecretScan {
  /** Lines matching each pattern, for the patterns with any, in `SECRET_PATTERNS` order. */
  readonly byPattern: readonly { readonly name: string; readonly lines: number }[];
  /** Distinct lines matching any pattern. A line matching two patterns counts once here. */
  readonly lines: number;
  /** Where each matching line is, in stream order: `entry <id>`, `type <name>`, and so on. */
  readonly where: readonly string[];
}

/** Every secret-shaped pattern found in `lines`, as counts and locations -- never as text. */
export function scanSecrets(lines: readonly CorpusLine[]): SecretScan {
  const counts = new Map<string, number>();
  const where: string[] = [];
  for (const line of lines) {
    const strings = stringsIn(line);
    let matched = false;
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (!strings.some((text) => pattern.test(text))) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      matched = true;
    }
    if (matched) where.push(locate(line));
  }
  return {
    byPattern: SECRET_PATTERNS.filter(({ name }) => counts.has(name)).map(({ name }) => ({
      name,
      lines: counts.get(name) ?? 0,
    })),
    lines: where.length,
    where,
  };
}

/** Every string reachable from `value`, through arrays and plain objects. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) stringsIn(item, into);
  }
  return into;
}

function locate(line: CorpusLine): string {
  switch (line.kind) {
    case 'entry':
      return `entry ${line.id}`;
    case 'annotation':
      return `annotation ${line.id}`;
    case 'type':
      return `type ${line.document.name}`;
    case 'scheme':
      return `scheme ${line.name} v${String(line.version)}`;
  }
}
