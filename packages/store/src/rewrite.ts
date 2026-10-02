/**
 * The one-time upgrade of a tree written before a type line stated its own `version`.
 *
 * ## Why this exists and why it is the only path of its kind
 *
 * `asc-i5tj.6`. A type's version used to come from the line's POSITION: `registerType` minted
 * `latest.version + 1` and a `TypeLine` carried no number of its own. `.ascend/.gitattributes` is
 * `*.jsonl merge=union`, and a union merge concatenates both sides of a merge without asking -- so
 * the "no writer may interleave them" rule the layout rests on was one no code could enforce. Two
 * clones could number the same content differently, and the only thing that caught it was an entry's
 * `type_hash`, which is absent exactly when a multi-version type has no entries yet.
 *
 * The fix is that every type line states its own `version` and readers sort by it. That makes the
 * FORMAT stricter, so every tree already written needs the field added once, and this is the
 * function that adds it.
 *
 * **This is the only code that reads a tree `readRecordTree` would refuse**, and that is a
 * deliberate, bounded exception rather than a second reader. It parses with the same `parseCorpus`
 * and the same `parseDocument` the reader uses, relaxing exactly one rule through
 * `CorpusParseOptions.allowVersionlessTypeLines` -- the one this upgrade exists to satisfy. Anything
 * else a reader would refuse, this refuses too.
 *
 * **A rewrite is the door for a rule it can satisfy by rewriting, and not for the other kind.** The
 * versionless type line qualifies because this function can derive the missing number. Two lines
 * sharing one id with different contents (`onePerIdentity`, `jsonl-files.ts`) does not: there is
 * nothing to derive, because either choice discards a record, so a rewrite would be inventing which
 * content was meant. That refusal names the hand-edit itself rather than sending the caller here,
 * which is why this function needs no second option and the parse options stay at one.
 *
 * ## What it does NOT touch
 *
 * **Only files under `types/` are rewritten. Every other byte of the tree is left exactly as it
 * was.** Re-serializing the whole tree would be more general and costs nothing in principle --
 * `serializeCorpus` is canonical, so 6,532 entry lines should come back identical -- but "should"
 * is doing real work in that sentence, and a reformat that turns out not to be the identity would
 * rewrite the entire corpus to add a field to seventeen lines. A rewrite whose blast radius is the
 * thing it is fixing can be checked by reading the diff; one that touches everything cannot.
 *
 * ## The rule it applies, which is the rule being retired
 *
 * Each type line is assigned the version today's positional rule would give it: lines are replayed
 * in file order, an identical `(name, type_hash)` repeat is ABSORBED at the version it already had,
 * and anything else is `latest.version + 1` for that name. That is `registerType`'s arithmetic
 * (`registry.ts`) replayed once, by hand -- the semantics being replaced, used exactly once, which
 * is the only honest way to derive numbers for lines that do not state them.
 *
 * An identical repeat must be absorbed rather than numbered again, and not as a refinement: two
 * sides of a `merge=union` usually hold the SAME bytes, so a rewrite that numbered each line would
 * turn every ordinary merge duplicate into a new version. The measured behaviour being reproduced is
 * `registerType`'s own idempotence, which is what made the duplicate case harmless in the first
 * place.
 *
 * ## Idempotence and atomicity
 *
 * A second run finds every type line already stating a version, rewrites nothing, and reports zero.
 * Each file is replaced by writing a sibling temp file and renaming it over the original, the
 * discipline `buildIndex` uses (`jsonl-index.ts`), so a reader never sees a half-written file.
 *
 * A crash between two files leaves the tree partly upgraded -- and the upgrade is idempotent, so
 * re-running it finishes the job. In practice a tree holds one `types/` file until it passes
 * `MAX_RECORDS_PER_FILE`, so the ordinary case is a single rename.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCorpus, serializeCorpus, verifyTypeLine, type TypeLine } from './jsonl.js';
import { recordFiles } from './jsonl-files.js';

export interface RewrittenFile {
  /** Relative to the root, `/`-separated: `types/0001.jsonl`. */
  readonly file: string;
  /** How many of its lines gained a `version`. */
  readonly lines: number;
}

export interface RewriteResult {
  /** One entry per file whose bytes changed, in layout order. Empty on a second run. */
  readonly changed: readonly RewrittenFile[];
  /** Type lines that gained a `version`. Zero on a second run, which is the whole assertion. */
  readonly versioned: number;
}

/**
 * The version each type line should state, keyed by its line in the file it came from.
 *
 * Kept as a separate function over the parsed lines so that the arithmetic is readable and
 * testable on its own: it is `registerType`'s rule, and a reader checking this against the
 * registry should not have to read file I/O to do it.
 */
function assignVersions(
  lines: readonly { readonly file: string; readonly line: TypeLine }[],
): readonly number[] {
  // `(name, type_hash)` -> the version minted for it. Keyed on `type_hash` rather than on the line's
  // contents because that is what `registerType` looks up, and `type_hash` is what `documentSpec`
  // hashes -- prose is outside it, so a prose edit REPEATS a pair rather than making a new one.
  const minted = new Map<string, number>();
  const latest = new Map<string, number>();

  return lines.map(({ file, line }) => {
    const { name, type_hash: hash } = line.document;
    if (hash === undefined) {
      throw new Error(
        `${file} holds a type definition with no type_hash, and a corpus line always carries one. ` +
          `That is not a tree this upgrade can number: it is a line no version of the format ever ` +
          `wrote. Export the definition again rather than editing the file by hand.`,
      );
    }

    const key = `${name}\u0000${hash}`;
    const already = minted.get(key);
    if (already !== undefined) return already;

    const version = (latest.get(name) ?? 0) + 1;
    minted.set(key, version);
    latest.set(name, version);
    return version;
  });
}

/**
 * Add `version` to every type line under `root` that does not state one.
 *
 * Returns what changed; writes nothing when nothing needs it.
 */
export function rewriteTree(root: string): RewriteResult {
  const typeFiles = recordFiles(root).filter((file) => file.kind === 'type');

  // Every type line of the tree is read FIRST, across all its files, before anything is written.
  // A name's numbering runs across the files holding it, so numbering per file would restart the
  // count at each rollover and hand the second file's first line version 1 again.
  const parsed: {
    file: string;
    segments: readonly string[];
    line: TypeLine;
    /** Whether the line already stated a version, which is what makes a second run a no-op. */
    readonly stated: boolean;
  }[] = [];
  for (const file of typeFiles) {
    const segments = file.relative.split('/');
    const text = readFileSync(join(root, ...segments), 'utf8');
    for (const { where, line } of parseCorpus(text, file.relative, {
      allowVersionlessTypeLines: true,
    })) {
      // The directory says these are type lines, and the file's own contents are checked against
      // that rather than trusted -- the same both-directions rule `readRecordTree` applies.
      if (line.kind !== 'type') {
        throw new Error(
          `${where}: a '${line.kind}' line is filed under 'types/', which holds 'type' lines.`,
        );
      }
      // The reader's own hash check, applied here so the upgrade accepts EXACTLY the trees
      // `readRecordTree` accepts plus the one rule it is here to relax -- no more. A line whose
      // claimed hash is not its own contents' is a broken tree rather than an old one, and
      // numbering it by a hash that does not describe it would hand `asc index build` a tree that
      // refuses for a reason this command appeared to fix.
      verifyTypeLine(line, where);
      parsed.push({
        file: file.relative,
        segments,
        line,
        stated: line.document.version !== undefined,
      });
    }
  }

  const versions = assignVersions(parsed);

  // Group back by file, in the order the lines were read, so each file is written once and its
  // lines keep their order.
  const byFile = new Map<
    string,
    { segments: readonly string[]; lines: TypeLine[]; needs: boolean }
  >();
  parsed.forEach((entry, index) => {
    const version = versions[index];
    if (version === undefined) throw new Error(`internal: no version assigned for ${entry.file}`);
    const group = byFile.get(entry.file) ?? { segments: entry.segments, lines: [], needs: false };
    group.lines.push({ kind: 'type', document: { ...entry.line.document, version } });
    if (!entry.stated) group.needs = true;
    byFile.set(entry.file, group);
  });

  const changed: RewrittenFile[] = [];
  let versioned = 0;

  for (const [relative, group] of byFile) {
    // A file already fully versioned is left alone -- not re-serialized "harmlessly". This is what
    // makes the second run a no-op in BYTES rather than only in meaning, which is the property
    // whoever reads the diff depends on.
    if (!group.needs) continue;

    const lines = parsed.filter((entry) => entry.file === relative && !entry.stated).length;
    versioned += lines;

    const text = group.lines.map((line) => `${serializeCorpus([line])}\n`).join('');
    const path = join(root, ...group.segments);
    const staging = `${path}.rewrite-tmp`;
    writeFileSync(staging, text);
    renameSync(staging, path);
    changed.push({ file: relative, lines });
  }

  return { changed, versioned };
}
