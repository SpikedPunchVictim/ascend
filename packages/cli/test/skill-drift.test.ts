/**
 * A drift guard for the shipped agent skill: `packages/cli/skill/**\/*.md`.
 *
 * **The problem this exists to catch.** `SKILL.md` and `ascend-analyze.md` are instructions we
 * ship to an agent, teaching it `asc` commands and flags by example. Nothing in `tsc`, `eslint`
 * or the rest of this suite ever reads markdown, so renaming a flag or dropping a command breaks
 * the skill silently -- and it breaks in the USER'S project, the first time their agent tries to
 * run the example, not here. This file turns that into a test failure in THIS repo instead.
 *
 * **What it does.** Extract every `asc ...` invocation from the FENCED CODE BLOCKS in the skill
 * markdown (prose mentions, including a single-backtick \`asc query\` inline code span, are not
 * the contract and are ignored on purpose -- see `extractAscInvocations` below), then check each
 * one's command id and `--flag` names against the CLI's real, live command surface, loaded via
 * `@oclif/core`'s `Config.load` the same way the real binary resolves them (route (a) from the
 * task: preferred over importing command classes directly, because it resolves topic:command ids
 * -- `types list` -> `types:list` -- and merges `baseFlags` into each command's flags EXACTLY the
 * way oclif does at runtime, which `packages/cli/src/base.ts`'s `cacheCommand` merge is what makes
 * a bare `--json` on any command resolve without this file special-casing "global" flags at all).
 *
 * **What it does NOT prove -- read this before trusting a green run.** This guard proves that
 * every command and flag the skill teaches EXISTS. It does not prove the skill uses them
 * correctly: a flag combination that oclif accepts but the command then refuses at runtime (two
 * output formats at once, `--seed` without `--sample`, and so on) is invisible here. A green run
 * means "nothing in this skill names a command or flag that is not real" -- it is not a
 * correctness proof, and nobody should read it as one.
 *
 * **Build dependency.** `Config.load` reads `packages/cli`'s real command surface off disk --
 * `dist/commands`, per `package.json`'s `oclif.commands` -- so, like `cli.test.ts` and
 * `help-cli.test.ts`, this file builds once in `beforeAll` rather than trusting a human to
 * remember. Unlike those two files this test never spawns the binary; it loads the compiled
 * command classes directly, in-process, which is what lets it read `.flags` off them instead of
 * scraping `--help` text.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { beforeAll, describe, expect, it } from 'vitest';

/** This test file's own directory -- `packages/cli/test`. Every other path is relative to it. */
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

/** `packages/cli`, the package `Config.load` resolves the command surface against. */
const CLI_ROOT = join(TEST_DIR, '..');

/** The repo root, needed only to invoke `tsc -b` the same way `cli.test.ts` does. */
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');

/** Where the shipped skill markdown lives. */
const SKILL_DIR = join(TEST_DIR, '..', 'skill');

/**
 * Every `.md` file under `dir`, recursively.
 *
 * Written the same shape as `args.test.ts`'s `sources()`: walk with `withFileTypes` so a
 * directory is recursed into rather than read as a file, and filter on the extension rather than
 * assuming every entry is a markdown file.
 */
function findMarkdownFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findMarkdownFiles(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

/** A placeholder like `<type>`, `<text>`, `<s>` -- angle brackets around anything at all. */
function isPlaceholder(token: string): boolean {
  return /^<.+>$/.test(token);
}

/**
 * Strip a leading `[` and a trailing `]`.
 *
 * The skill markdown wraps OPTIONAL flags this way -- `[--scope '<sql predicate>']` -- and a
 * bracket left on the front of a token would hide the `--` a flag is detected by. Applied to
 * every token, not only ones that look like flags: the bracket can just as easily sit on the
 * flag's own VALUE (`<who>]`), and that token still has to normalise cleanly even though it is
 * never going to be treated as a flag.
 */
function stripBrackets(token: string): string {
  let result = token;
  if (result.startsWith('[')) result = result.slice(1);
  if (result.endsWith(']')) result = result.slice(0, -1);
  return result;
}

/** One `asc ...` line, as extracted from a fenced block. */
interface Invocation {
  /** The line exactly as it appeared (trimmed), for a readable failure message. */
  readonly raw: string;
  /** oclif's own colon-joined command id (`types:list`), or `undefined` for a bare `asc`. */
  readonly id: string | undefined;
  /** Flag NAMES only -- the text after `--`, before `=` or end of token. May contain repeats. */
  readonly flags: readonly string[];
}

/**
 * One `asc ...` line -> its command id and the flags it names.
 *
 * `raw` is assumed to already start with the token `asc` (checked by the caller, which is also
 * the thing deciding whether a line is a candidate at all).
 */
function parseInvocation(raw: string): Invocation {
  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  const rest = tokens.slice(1);

  if (rest.length === 0) {
    // Bare `asc` runs `types brief` (SKILL.md says so itself) -- valid, and with no id or flags
    // of its own for this guard to check.
    return { raw, id: undefined, flags: [] };
  }

  const idTokens: string[] = [];
  const flags: string[] = [];
  // Stays true only while every token so far has been part of the command id. The FIRST token
  // that looks like a flag or a placeholder ends it -- oclif itself works the same way: a
  // command's id is its leading run of non-flag positional words.
  let collectingId = true;

  for (const original of rest) {
    const token = stripBrackets(original);

    if (collectingId) {
      if (token.startsWith('-') || isPlaceholder(token)) {
        collectingId = false;
      } else {
        idTokens.push(token);
        continue;
      }
    }

    if (token.startsWith('--')) {
      const name = token.slice(2).split('=')[0] ?? '';
      // A flag's VALUE (`average|complete|single`, `<who>`, a quoted rule string) never starts
      // with `--`, so only the flag's own token reaches here. `name` can only be empty for the
      // literal token `--`, which does not occur in this skill's examples; guarded anyway
      // because `noUncheckedIndexedAccess` means the type says it could be.
      if (name.length > 0) flags.push(name);
    }
  }

  return { raw, id: idTokens.join(':'), flags };
}

/** Which fenced-block language tags count as the contract this guard checks. */
function isCountedFenceTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  // Only ```bash and untagged ``` blocks -- see the file header. A ```json or ```text block
  // showing sample output is not a claim that a command line runs, so it is not scanned.
  return normalized === '' || normalized === 'bash';
}

/**
 * Every `asc ...` invocation inside a FENCED code block of one markdown file's text.
 *
 * Prose is invisible to this on purpose: a line has to be INSIDE a fence whose tag
 * `isCountedFenceTag` accepts, and start with the literal token `asc`, to be extracted. A mention
 * inside a single-backtick inline code span never toggles fence state, so it can never match --
 * which is the behaviour the self-test below pins directly against a fixture.
 */
function extractAscInvocations(markdown: string): readonly Invocation[] {
  const invocations: Invocation[] = [];
  let inFence = false;
  let fenceCounts = false;

  for (const line of markdown.split('\n')) {
    const fenceMatch = /^```(\S*)\s*$/.exec(line.trim());
    if (fenceMatch !== null) {
      if (!inFence) {
        inFence = true;
        fenceCounts = isCountedFenceTag(fenceMatch[1] ?? '');
      } else {
        inFence = false;
        fenceCounts = false;
      }
      continue;
    }

    if (!inFence || !fenceCounts) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const firstToken = trimmed.split(/\s+/)[0] ?? '';
    if (firstToken === 'asc') invocations.push(parseInvocation(trimmed));
  }

  return invocations;
}

describe('the skill markdown extractor (self-test against an inline fixture)', () => {
  // Deliberately NOT a repo file: a fixture built to exercise one rule per line, so a failure
  // here points at the extractor rather than at the skill's own prose. Covers, in order: a
  // bracketed optional flag, a flag with `=value`, a pipe-separated option-list VALUE (which must
  // not itself be mistaken for a flag or a command-id token), and a `topic command` id. The two
  // prose lines -- one with an inline single-backtick span, one plain -- sit outside the fence and
  // must contribute nothing.
  const FIXTURE = [
    'Prose mentioning `asc query "select 1"` here is not fenced, so it does not count.',
    '',
    '```bash',
    'asc explore <type> [--dry-run]',
    'asc explore <type> --max-tokens=500',
    'asc stats <type> --linkage average|complete|single',
    'asc types list --json',
    '```',
    '',
    'And a second plain mention, asc kappa --scheme a --scheme b, also outside any fence.',
  ].join('\n');

  const extracted = extractAscInvocations(FIXTURE);

  it('extracts exactly the four fenced invocations, and none of the prose', () => {
    expect(extracted).toHaveLength(4);
  });

  it('strips a bracketed optional flag down to its name', () => {
    expect(extracted[0]).toEqual({
      raw: 'asc explore <type> [--dry-run]',
      id: 'explore',
      flags: ['dry-run'],
    });
  });

  it('reads a flag name up to `=`, dropping the value', () => {
    expect(extracted[1]).toEqual({
      raw: 'asc explore <type> --max-tokens=500',
      id: 'explore',
      flags: ['max-tokens'],
    });
  });

  it('does not mistake a pipe-separated option VALUE for a flag or a command token', () => {
    expect(extracted[2]).toEqual({
      raw: 'asc stats <type> --linkage average|complete|single',
      id: 'stats',
      flags: ['linkage'],
    });
  });

  it('joins a topic and its command with a colon, oclif-style', () => {
    expect(extracted[3]).toEqual({
      raw: 'asc types list --json',
      id: 'types:list',
      flags: ['json'],
    });
  });

  it('never extracts a prose mention, fenced or not', () => {
    // The count assertion above already proves this; this is the explicit, readable half of it --
    // a failure here says WHICH text leaked through, rather than just how many lines did.
    for (const invocation of extracted) {
      expect(invocation.raw).not.toContain('query');
      expect(invocation.raw).not.toContain('kappa');
    }
  });
});

describe('the shipped skill teaches commands and flags that exist', () => {
  let config: Config;
  let allInvocations: readonly Invocation[];

  beforeAll(async () => {
    // `Config.load` reads the command surface off `packages/cli/dist/commands` (no
    // `oclif.manifest.json` is checked in), so -- exactly like `cli.test.ts` -- this needs a
    // fresh build before it can tell the truth about the CLI's current shape. `tsc -b` is a
    // no-op when nothing changed, so this costs about a second warm.
    execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-b'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

    config = await Config.load(CLI_ROOT);

    const files = findMarkdownFiles(SKILL_DIR);
    allInvocations = files.flatMap((file) => extractAscInvocations(readFileSync(file, 'utf8')));
  });

  it('is not vacuous: the extractor finds at least the invocations counted by hand', () => {
    // Counted BY HAND from the fenced ```bash blocks in packages/cli/skill/**/*.md, 2026-09-20 --
    // never read off `allInvocations.length`, which is exactly the number a vacuous extractor
    // returning `[]` cannot be checked against by any OTHER test in this file:
    //
    //   ascend-analysis/SKILL.md (11):
    //     1. asc explore <type>
    //     2. asc explore <type> --sample random|stratified|diverse|outlier [--by <prop>]
    //        [--limit N] [--seed S]
    //     3. asc stats <type> --cluster --threshold <t> [--linkage average|complete|single]
    //     4. asc stats <type> --distinctive --by <prop>
    //     5. asc stats <type> --duplicates
    //     6. asc search <type> <text>
    //     7. asc annotate --scheme hand --ids '<label>=<id>,<id>'
    //     8. asc annotate --scheme <s> --rule '<label>=sql: <predicate>' --backtest hand
    //     9. asc annotate --scheme <s> --rule '...' [--scope '<sql predicate>'] [--actor <who>]
    //    10. asc kappa --scheme a --scheme b
    //    11. asc kappa --scheme <s> --pass <t1> --pass <t2>
    //
    //   commands/ascend-analyze.md (0): its only `asc` mention ("run `asc types list`") is
    //     single-backtick inline prose, not inside a fenced block, so it contributes nothing.
    //
    // A guard that silently matched zero invocations would make every other `it` in this file
    // pass for free -- this is the one test built specifically to catch that failure mode.
    const HAND_COUNTED_MINIMUM = 11;
    expect(allInvocations.length).toBeGreaterThanOrEqual(HAND_COUNTED_MINIMUM);
  });

  it('names a real command for every invocation', () => {
    const commandIds = new Set(config.commands.map((command) => command.id));

    const unknown = allInvocations
      .filter((invocation) => invocation.id !== undefined)
      .filter((invocation) => !commandIds.has(invocation.id as string))
      .map((invocation) => invocation.raw);

    expect(unknown).toEqual([]);
  });

  it('names only real flags for every invocation, on the command it is used with', () => {
    const commandsById = new Map(config.commands.map((command) => [command.id, command]));

    // Every command's `.flags` here already carries `base.ts`'s `OUTPUT_FLAGS` merged in --
    // oclif's own `cacheCommand`/`aggregateFlags` do that merge before `Config.commands` is ever
    // populated (probed directly: `explore`'s cached flags include `json`, `table`, `csv`,
    // `csv-raw` and `debug` alongside its own, with no `baseFlags` read separately here). So a
    // bare `--json` used against any command in the skill is checked against exactly the same
    // object a command-specific flag is, with no special-casing for "global" flags needed.
    const badInvocations: string[] = [];

    for (const invocation of allInvocations) {
      if (invocation.id === undefined) continue; // bare `asc`: nothing to check.
      const command = commandsById.get(invocation.id);
      if (command === undefined) continue; // reported by the command-existence test above.

      const unknownFlags = invocation.flags.filter((flag) => !(flag in command.flags));
      if (unknownFlags.length > 0) {
        badInvocations.push(
          `"${invocation.raw}" uses ${unknownFlags.map((flag) => `--${flag}`).join(', ')}, ` +
            `not a flag on '${invocation.id}'`,
        );
      }
    }

    expect(badInvocations).toEqual([]);
  });
});
