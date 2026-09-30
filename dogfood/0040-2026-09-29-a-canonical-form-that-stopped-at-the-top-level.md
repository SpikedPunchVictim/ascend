# 0040 — a canonical form that stopped at the top level

| | |
|---|---|
| **Bead** | `asc-i5tj.16` — "a canonical line did not order a nested scheme rule, so the migration refused to run on the real store" |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | the first real run of the cutover: `asc init` against this repository's own 23 MB store |
| **Entry type(s)** | none — the finding is in the line format (`jsonl.ts`), not in a recorded entry |
| **Severity** | P1 — a blocker rather than a data-loss class: the migration **refused**, which is the guard working, and the cutover could not proceed until the format agreed with itself |
| **Status** | fixed in-flight, uncommitted as of 2026-09-29 |

## What was found

`serializeCorpus` renders a line through `orderedLine`, which pins the key order of the line's **own**
fields — `kind`, `name`, `version`, `created_at`, `spec`, `scheme_hash` for a scheme. Everything it
passes *through* it passes through by reference, nested objects and all.

For three of the four kinds that is harmless, because the nested objects arrive from `JSON.parse` on
both sides of a round trip and therefore keep whatever order the JSON held. A **scheme** is the
exception. Its `spec` comes back from the store exactly as it was registered (`spec_json`, read back
verbatim), while `parseSchemeRule` **rebuilds** each rule from named fields in its own order:

```ts
return { label, kind: kind as SchemeRuleKind, query };   // jsonl.ts
```

`SCHEME_RULE_KEYS` lists them the same way, `['label', 'kind', 'query']`. The store's own bytes are
`{"kind":"sql","label":"decision","query":"..."}`. So one scheme had two canonical spellings, and the
only consumer that compares canonical text across the producer/reader boundary noticed:

`migrateStoreToTree` verifies its own work by reading the tree back and comparing the two sets of
canonical lines. It saw **3 lines missing and 3 that should not be there** and refused:

```
Error: the tree at /private/tmp/f2mig/.ascend does not read back as the corpus
that was written to it: 10386 line(s) written, 10386 read, 3 missing and 3 that
should not be there. Nothing has been archived -- the store is untouched -- but
the tree above is incomplete and must not be built on. This is a defect in the
write path rather than in the store.
```

Every count was right. Not one byte was lost. The two sides of the comparison simply disagreed about
the key order of a nested object, and the guard — correctly, and by design — refused to publish a tree
it could not verify.

## How it surfaced

`migrateStoreToTree` had never been run against a store holding a scheme with **any rules at all**.

This repository's store holds 7 schemes; 3 of them carry rules:

```
by_kind       rules: 4  labels: 4
layer         rules: 2  labels: 2
rule-denial   rules: 3  labels: 3
hand-denial   rules: 0      hand_layer  rules: 0      invalidation  rules: 0
shuffled-denial rules: 0
```

Exactly the 3 with rules mismatched, and the 4 without agreed to the byte. That is not a correlation
that needed statistics: a rule-count of zero is the only thing the defect needs, and the two fixtures
in the suite were both built that way —

- `packages/store/test/jsonl-files.test.ts`, `const SCHEME: SchemeLine` — `rules: []`
- `packages/store/test/migrate.test.ts`, `seeded()` — `registerScheme(… { labels: ['good','bad'], rules: [] } …)`

— so no test in the repository had ever put a rule through the format. Nobody was looking for this.
It was found by doing the thing the plan had listed as *not measured yet*: running `asc init` on the
real store, to size the cutover.

## The metric

- **The refusal, verbatim:** `10386 line(s) written, 10386 read, 3 missing and 3 that should not be
  there` — `asc init` exit 1, nothing archived, both copies still on disk. Obtained by copying
  `.ascend/ascend.db` (23,273,472 bytes, **6,473 entries**) into an empty directory and running the
  built binary there, so the real store was never the thing at risk.
- **Which lines:** 3 of 7 schemes — every rule-bearing one, and no rule-less one. The diff, printed by
  comparing `serializeCorpus(corpusLines(store))` against `serializeCorpus(readRecordTree(tree))`,
  showed `{"kind","label","query"}` against `{"label","kind","query"}` and nothing else.
- **After the fix:** `asc init` succeeded **4.43 s** wall on the same store, writing 10,386 lines (7
  scheme, 17 type, 6,473 entry, 3,889 annotation) and archiving `ascend.db` to
  `.ascend-archived/2026-09-30T02-22-35-351Z/`. This is also the first measurement of a cost the plan
  listed as unmeasured — *"`asc init`'s new cost on a legacy store (this repo: 23 MB, 6,404 entries)"*.
- **Load-bearing, checked by mutation:** reverting the one changed line (`spec: orderedSpec(line.spec)`
  back to `spec: line.spec`) fails **7 tests** across the two suites, each with the same 1:1 swap on a
  6-line fixture — *"1 missing and 1 that should not be there"*. Restored, both suites are green (47
  tests).
- **n = 2 for the cutover as a whole:** the same numbers came out of a copy and out of this repository
  — 6,515 entry lines both times, and all 2,911 ids the pre-existing partial tree held present with
  **0 missing**.

## The pattern

**A canonical form that stops at the top level is not canonical.** "Fixed key order" was written into
`orderedLine`'s doc as the property that makes a diff of two exports mean something — and it was true
of the fields the function names, false of the object it passed through. The generalizable check: for
every field a canonicalizer passes through unchanged, ask who *rebuilds* it on the other side. Where
one side constructs an object literal and the other reads the JSON, the order is a coincidence of two
edits in two files, and the disagreement is invisible until something compares the two.

**And its companion, which is the sharper half: a fixture that cannot hold the shape is a fixture that
cannot fail.** Two `rules: []` literals, in two suites, in a repository with a 6,473-entry corpus and
four rule-bearing schemes. The suite was not thin — it was 47 tests over this format, including a
byte-for-byte round trip. It was *shaped* so that the defect was unreachable. Both fixtures now carry
a rule, which is the part of the fix that keeps the class closed.

## Why nothing else would have caught it

A review would have had to ask "does `orderedLine` recurse?" — plausible, and cheap, which is the
honest answer. The suite could not: `jsonl-files.test.ts`'s round trip compares `serializeCorpus(read)`
against `serializeCorpus(canonical(lines))`, and both sides run `orderedLine`, so a nested order the
function does not pin is not pinned on **either** side of that comparison. The test that would have
caught it is the one added here, which asserts the property directly: one scheme spelled two ways
serializes to one line.

The migration's own `verify` is what caught it in production, and it deserves the credit: it refused,
named the counts, said *"This is a defect in the write path rather than in the store"*, and left both
copies intact. A migration that had published the tree and archived the store would have turned a
3-line format disagreement into a cutover nobody could re-run.

## Consequences and constraints

The order pinned is `{ kind, label, query }` — the order the store's `spec_json` already holds — so **no
bytes on disk change**. The reader was brought to the writer rather than the other way round; the
alternative (changing `parseSchemeRule` to emit `kind` first) would have made a TS object literal in
one file the definition of a format in another, with nothing to catch the next drift.

**The fix is not general.** It pins the nesting of a scheme's `spec.rules` and nothing else. If a
future line kind gains a nested object that the parser rebuilds field-by-field, the class returns — and
nothing in the format would notice. Stated here rather than defended: the general fix is a canonical
serializer that recurses into every nested object, and it was not taken because the two candidate
generalizations both have real costs (ordering `properties` would change the exported bytes of every
entry, and a generic deep sort would order a user's property map, which is data rather than format).

## Links

- Bead: `asc-i5tj.16`; the cutover it blocked is `asc-i5tj.4.4`
- Plan: `IMPLEMENTATION_PLAN.md` E12.4a/4d (the migration's read-back check) and E12.4e (the cutover)
- Related: `dogfood/0039` (a build that reports success from half a store) — the same cutover, the
  other failure mode: there the guard was **missing**, here it **fired**, and both were found by
  running the real thing rather than by reading the code
- Source: `packages/store/src/jsonl.ts` (`orderedLine`, `orderedSpec`, `parseSchemeRule`),
  `packages/store/src/migrate.ts` (`verify`)
- Entries recorded at the time: none — surfaced by driving `asc init`, not from stored entries
