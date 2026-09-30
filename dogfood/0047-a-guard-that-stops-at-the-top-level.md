# 0047 — a guard that stops at the top level

| | |
|---|---|
| **Bead** | `asc-y9ut` |
| **Surfaced** | 2026-09-28 (the first two); the class measured 2026-09-30 |
| **Surfaced by** | placing new modules for `asc-i5tj`, then sweeping every `readdirSync` over a package `src/` tree, then planting a violating file in each real tree and running the guards |
| **Entry type(s)** | none — this is a finding about the repository's own test suite, not about a store |
| **Severity** | P2 — nothing is unjudged today, and nothing is written wrongly; the loss is latent and arrives with the first subdirectory |
| **Status** | fixed in this working tree |

## What was found

Three source-scanning guards enumerate a package's `src/` tree with a single **non-recursive**
`readdirSync`:

- `packages/store/test/recorder.test.ts` — carries both the "exactly one write path" guard (a second
  `INSERT INTO entries`) and the "no ambient clock" guard (`Date.now`, `new Date`, `Math.random`,
  `randomUUID`, `performance.now`, `hrtime`) over `packages/store/src`.
- `packages/store/test/sql-port.test.ts` — carries the claim that `db.ts` and *nowhere else* in
  `packages/store/src` imports `node:sqlite`.
- `packages/adapter-claude-code/test/reader-source.test.ts` — carries the adapter's read-only promise:
  no module in `packages/adapter-claude-code/src` imports a write-capable `node:fs` binding.

Both `src/` trees are flat today, so every file is read and every guard is green. The first
subdirectory added under any of those trees is not read: the scan keeps reporting success while the
invariant it exists for stops being checked. **This is an absence.** No assertion is wrong and no
expected value is stale — the scan simply stops seeing, and a scan that sees less is
indistinguishable from a scan whose subjects are clean.

## How it surfaced

The first two were noticed 2026-09-28, while placing new modules for `asc-i5tj`: a file was being
considered for a subdirectory, and `readdirSync(SRC)` was one line away from the file being moved. The
question on the table was *where a file should live*, not *whether a guard works* — the guard's flat
read was incidental, read while checking whether the move would break something else.

**On 2026-09-30 the count was wrong, and that is the finding.** The bead names two guards. A sweep of
every `readdirSync` over a package `src/` tree in `packages/*/test` found **seven**, of which
**three** were flat — the third is `sql-port.test.ts`, which the bead does not name. Nobody had
looked for a third; it turned up by asking the class question the bead's own framing invites
("a guard that stops covering new code without saying so") rather than by re-reading its two
citations.

Nobody was looking for a guard defect in either pass.

## The metric

Measured 2026-09-30 on the real trees, by planting a violation and running only the guards that claim
to cover it. The planted trees (`packages/store/src/planted-probe/offender.ts` and
`packages/adapter-claude-code/src/planted-probe/offender.ts`) held, respectively,
`INSERT INTO entries` + `Date.now()` + `import { DatabaseSync } from 'node:sqlite'`, and
`import { writeFileSync } from 'node:fs'`.

**Before the fix — four guard tests, all green, with the violations sitting in the tree:**

```
### store: exactly one write path ###
exit=0
 ✓ packages/store/test/recorder.test.ts (43 tests | 42 skipped) 7ms
 Test Files  1 passed (1)
      Tests  1 passed | 42 skipped (43)

### store: no ambient clock ###
exit=0
 Test Files  1 passed (1)
      Tests  1 passed | 42 skipped (43)

### store: one module names the driver ###
exit=0
 Test Files  1 passed (1)
      Tests  1 passed | 2 skipped (3)

### adapter: reads every source file / never writes ###
exit=0
 ✓ packages/adapter-claude-code/test/reader-source.test.ts (11 tests) 8ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

**After `{ recursive: true }` on the three walkers, the same plant fails six assertions:**

```
   × exactly one write path, and no ambient clock > writes entries from exactly one module
   × exactly one write path, and no ambient clock > reads no clock and draws no randomness, in any module
   × the store names the driver in exactly one module > imports node:sqlite from db.ts and nowhere else in src/
   × the check is not vacuous > reads every source file in the package
   × the check is not vacuous > actually finds fs imports to judge
   × the adapter never writes > imports no write-capable fs binding in any source file
```

**The class, counted.** Guards in `packages/*/test` that walk a package `src/` tree:

| guard | tree | walk |
|---|---|---|
| `store/test/recorder.test.ts` | `packages/store/src` | **flat** |
| `store/test/sql-port.test.ts` | `packages/store/src` | **flat** |
| `adapter-claude-code/test/reader-source.test.ts` | `packages/adapter-claude-code/src` | **flat** |
| `cli/test/args.test.ts` | `packages/cli/src/commands` | recursive |
| `cli/test/index-build-is-explicit.test.ts` | every package's `src` | recursive |
| `cli/test/store-names.test.ts` | every package's `src` | recursive |
| `store/test/writer-callers.test.ts` | every package's `src` | recursive |

**3 of 7 flat.** `cli/test/skill-drift.test.ts` also recurses, but over `packages/cli/skill` — shipped
markdown, not a `src` tree — so it is outside the count, as are the `readdirSync` calls that read dump
targets, temp corpora and the `handlers/` data directory. Scope of the claim: every `readdirSync` over
a package `src/` tree, which is what a coverage guard of this shape is.

**The permanent tests bind, checked by mutation.** Each of the three suites gained a test that plants a
tree in a temp directory holding a nested file and asserts the walk (and the judgement built on it)
reaches it. Deleting `, { recursive: true }` from the three walkers and nothing else:

```
### ARM 1: flat walkers (the flag deleted) ###
   × the check is not vacuous > reaches a file in a subdirectory, so a new directory cannot escape the scan
   × the store names the driver in exactly one module > reaches a module in a subdirectory, so a new one cannot reach for the driver unseen
   × exactly one write path, and no ambient clock > reaches a file in a subdirectory, so a new directory cannot go unjudged
 Test Files  3 failed (3)
      Tests  3 failed | 57 passed (60)

### ARM 2: recursive walkers (restored) ###
 Test Files  3 passed (3)
      Tests  60 passed (60)
```

Three tests, exactly, and no others — the recursion is the only thing they measure. Full suite after:
**124 files / 2882 passed, 2 skipped** (2879 → 2882).

Coverage today, by directory listing rather than by assertion: `find packages/store/src
packages/adapter-claude-code/src -type d` returns the two `src` directories only, so no file is
currently unjudged. Nothing is wrong yet; the defect is that nothing would say so.

## The pattern

**A guard whose coverage is a directory listing is only as wide as the listing, and it cannot tell
that the listing narrowed.** The family is not "wrong answer" but "smaller question": the report is
true about what it read and false about what it claims. It is the same shape as `dogfood/0039` ("a
build that reports success from half a store" — `asc index build` reading the tree and only the tree,
exit 0 over 3,562 absent entries): the number printed is real, the scope it is read as covering is not.

The distinguishing test for this instance: **the guard's own anti-vacuity assertion is inside the
blind spot.** `reader-source.test.ts` enumerates every file it reads and asserts the list by hand —
the mechanism that forces a new file to be acknowledged. A file the walk cannot see is a file the
enumeration cannot miss, so the check that exists to prove the scan is not vacuous is exactly as blind
as the scan. That is why "the suite is green" carried no information here at all.

## Why nothing else would have caught it

A test could not. These guards *are* the tests, and green is what the defect looks like; there is no
second signal to disagree with the first.

A review could have, in principle — it is one line of code, and `withFileTypes` sitting there unused
for a filter that only ever sees files is a visible seam. But the question a review asks of a guard is
*"does this check the right thing"*, and it did: the pattern was correct, the plant tests passed, the
subjects were right. *"What does this listing not see"* is not a question the code invites, and the
three occurrences were written at different times and reviewed as three separate changes.

`align` does not cover it: it reads imports, and this is a test's directory walk.

The repository already had the idiom — four sibling src-scans use `{ recursive: true }` — so nothing
was missing but the habit. That is the honest statement of why it recurred: not a gap in tooling, but
three independent flat listings in a codebase that had already solved this four times.

## Consequences and constraints

**The class is closed at three instances, not as a class.** Each guard now recurses, but the recursion
is written three times and nothing enforces it: a fourth coverage guard written next month can be flat
again. Two structural remedies were considered and not taken — extracting one shared walker (three
packages, no shared test package, and a cross-package test import would need a project reference) and
asserting at check time that no guard lists a directory non-recursively (a meta-scan over test files,
which is itself a source scan and inherits the very shape it would police). The five-of-seven
recursive ratio is the whole enforcement.

**The new tests plant in a temp directory, never in `src/`.** That follows `writer-callers.test.ts`'s
recorded reasoning — "a planted file would make the test above fail for a reason that is not a
defect" — and it is why the live plant above was a measurement taken and reverted rather than a
permanent fixture. The temporary directory proves the walk recurses; the enumerated file list proves
the walk covers the real tree.

**`reader-source.test.ts`'s enumerated list is unchanged and now stronger.** It reads `src/` flat
today, so adding nested files changed no bytes of that assertion; when a subdirectory does appear, the
list is what will fail and force a human to acknowledge each file in it.

**Nothing was deleted or migrated.** The finding concerns which files are read, not what they contain;
no entry, no store row, and no artifact is affected.

## Links

- Bead: `asc-y9ut` (P2) — names two guards; this record's measurement found the third
- Related records: `dogfood/0039` (a build that reports success from half a store — same shape, a
  report true about what it read and false about what it claims); `dogfood/0043` (a rationale nobody
  checked — the other way a guard's *prose* can be the false part)
- Code: `packages/store/test/recorder.test.ts` (`sourcesUnder`), `packages/store/test/sql-port.test.ts`
  (`driverImportersUnder`), `packages/adapter-claude-code/test/reader-source.test.ts` (`sourceFilesUnder`)
