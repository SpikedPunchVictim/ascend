# 0029 — `asc types define` writes prose onto a version nobody reads, and reports `prose-updated`

| | |
|---|---|
| **Bead** | `asc-w0b2` |
| **Surfaced** | 2026-09-28 |
| **Surfaced by** | a probe run to check whether `asc-my84`'s prose edit had reached the live store — `asc types define` on a document that carried version 1's shape |
| **Entry type(s)** | none. The defect is in `asc types define`'s outcome line, and in what it does not warn about |
| **Severity** | P3 |
| **Status** | fixed in the working tree 2026-10-09: the command now warns when the resolved version is not the latest. See *The fix* below |

## What was found

`asc types define` resolves the version a document belongs to **by shape**, and reports that version.
A document carrying an older shape — the ordinary case of an export file on disk that outlived a shape
bump, since `asc types export` has no `--version` flag and a saved document is not re-exported by
itself — therefore writes its prose to a version that is no longer the latest, and the outcome line
says `prose-updated`. It is not lying: the prose was updated, on version 1. What the line does not say
is the thing the reader needs — that `asc types show`, `findType` with no version, and every other
reader of this type *by name* resolve to the latest version, so the prose just written is invisible to
all of them. `outcome` answers *"did this document change anything"*; it does not answer *"did anything
a reader sees change"*, and those come apart exactly here.

**This is an absence, and absences are what a code review does not catch.** Every value printed is
correct. The missing thing is one warning.

## How it surfaced

**Nobody was looking for it**, and the route in was a wrong reading — which is the point, because the
wrong reading was *available*: the outcome was true and incomplete, so it supported a conclusion the
output did not contain.

I was verifying that `asc-my84`'s rewritten `review_finding` description had reached the live store. I
ran one query over `entry_types` and read the answer wrong: the row was

```
version  major  type_hash   dlen  plen  new_prop_prose  new_desc  probe
2        1      …           1753  7284  2377            129       0
```

and I took `new_desc` for `0`. It is `129` — `instr()` returns a **position**, not a flag, and I
inverted the last two columns. From that misreading I concluded the ingest had silently dropped the
description, and went looking for the mechanism that would explain it. What the wrong reading found
instead was the probe's own footprint: `review_finding` holds two versions, and the *earlier* probe —
the `asc types define` whose document I had exported before the shape bump — had written
`PROBE-description` into version 1, where nothing reads it, and reported `prose-updated`.

So the finding is not the ingest (it was correct: version 2 carries both the new description at
offset 129 and the new property prose), and not the query (it printed the right number under the right
label). It is that **a write reported as `prose-updated` can land where no reader will ever see it,
and nothing in the output marks the difference** — which is what made a plausible misdiagnosis cheap
to construct.

The `search_miss` type was considered and deliberately **not** recorded for the misreading: its own
`record_when` draws the line at "a zero read as 'does not exist' qualifies, a zero read as 'zero' does
not", and the test is whether the RESULT supported a conclusion the evidence did not. Here the result
supported the right conclusion and I read it backwards. That is a wrong searcher, not a lying
instrument, and counting it would corrupt the one number that type exists to produce.

## The metric

All of it obtained on 2026-09-28 against this project's store, `.ascend/ascend.db`.

**The two versions, and which one anything reads.** `asc query`:

```
name            version  major  status  entries
review_finding  1        1      active  0
review_finding  2        1      active  112
```

**The write, reproduced non-destructively.** A document built from version 2's export with the
`captured_by` property removed — version 1's shape, 12 properties, 12 prose keys — and an edited
description, defined as a dry run:

```
$ asc types define /tmp/rf1.json --dry-run
Warning: dry run: nothing was written.
name            version  major  outcome        bump
--------------  -------  -----  -------------  ----
review_finding  1        1      prose-updated  none
```

No warning, and nothing to say version 1 is not the latest.

**What the real run of the earlier probe left behind**, and that no reader showed it. Read through the
store's own API against the same database:

```
version 1: description "PROBE-description"           (17 chars)
version 2: description 1753 chars, contains "TWO ROUTES FILL THIS"
```

`asc types show review_finding` prints `version 2` — the version-1 prose above is reachable only by
querying `entry_types` for that version directly. The probe's write is invisible to every surface that
reads a type by name.

**Anecdote, not a proportion.** n = 1 occurrence, against `MIN_N` = 20
(`packages/analysis/src/proportion.ts:50`). The two-version layout is why this store could show it at
all; a type that has never been bumped has no older version to land on.

## The pattern

**A correct outcome line that answers a narrower question than the reader is asking.** `outcome` here
is one of `created` / `unchanged` / `prose-updated`, and the third of those is true of a write to any
version. The class is *the success signal that is accurate about the mechanism and silent about the
effect*: a green that does not mean what the reader takes it to mean, without ever being false.

It is the same shape as `dogfood/0026`, from the same day: there, `asc doctor`'s count was correct and
the *interpretation* it invited was wrong, because 0 of 112 measured says nothing until the 112 are
split by route. Here `prose-updated` is correct and says nothing until you know which version. Neither
is a false green in the strict sense; both are a true statement placed where a stronger claim will be
read into it.

## Why nothing else would have caught it

- **Not a test.** The behaviour is the specified behaviour: a document identifies its version by shape
  and the command reports the version it landed on. `define.ts`'s file comment says so — it prints
  "the version it landed on, the bump that produced it, and whether the shape changed". A test that
  asserted a warning would be asserting a design change, not a behaviour.
- **Not a code review.** Both functions are doing exactly what they document. The gap is between two
  of them: `registerDocument` resolves the version, and `updateTypeProse` writes to it, and neither is
  positioned to ask "is this the version anyone reads".
- **Not the person reading the output** — evidently, since the person reading it was the one who wrote
  the probe, and the version column is exactly what I did not look at. The information was present and
  was not enough; that is the whole finding.
- **The precedent that does exist** is in the same file, and it argues for the fix rather than against
  it: `droppedGuidance` (`packages/cli/src/register-document.ts`) already emits a warning for the
  shape-bump case, and its comment states the reason — *"What was wrong was the silence."* This is the
  mirror of that case, and the silence is the same.

## Consequences and constraints

- **A wrong write is repairable, and that is not the point.** Type prose is the one permitted in-place
  edit to a registered version, so the version-1 description was restored from `git show HEAD:…`
  (1162 chars, shape hash unchanged, version 2 untouched). Had it been a *shape* change there would be
  no repair: registration is append-only, and a version cannot be withdrawn.
- **`asc types export` cannot ask for a version**, so a document of an older shape can only be a file
  kept from before the bump — the `asc types export > review.json` workflow the command's own example
  shows. That is why this is P3 and not higher: the route in is a stale file rather than a flag.
- **The likely fix is a warning, not a refusal.** Defining an older version's document is legitimate;
  what is missing is the sentence `droppedGuidance` already knows how to write, naming the latest
  version and the entry count on each so the reader can see which one is live.

## Links

- Bead: `asc-w0b2` (P3, fixed in the working tree 2026-10-09)
- The work whose probe produced it: `asc-my84`, and `dogfood/0026` (the same silence about the same
  type, one day earlier)
- Related: `dogfood/0021` (a dated measurement in a type's own description — version 2's new text and
  version 1's restored text are both that), `dogfood/0024` (an edited handler re-keys its rows: the
  other way a write lands somewhere a reader does not look)

---

## The fix — 2026-10-09 (`asc-w0b2`)

The silence this record names is closed by a warning, in the voice and in the place `droppedGuidance`
already established in the same function.

`proseWrittenToAnOlderVersion` (`packages/cli/src/register-document.ts`) is asked when this
registration wrote prose, and answers nothing unless the version it wrote to is not the latest for
that name. When it does answer, it names both version numbers, says that the surfaces reading the
type *by name* read the latest and so do not show what was just written, says where it *is* readable
(`asc types show <name> --version N`), and says what to do about it (`asc types export <name>`, edit
that document, define it again).

**Three properties were decided rather than assumed, and each is why the fix is where it is.**

- **Asked only when prose was actually written.** `result.proseUpdated` is the producer's own answer
  to "did this emit a line for a prose change" (`packages/store/src/line-producers.ts`). An idempotent
  re-run of a stale document changes no fact, and warning on it would fire on every run of a command
  that did nothing — the same case `typeLines` already declines to emit a line for. A warning that
  fires when nothing happened is how a reader learns to skip a warning.
- **Placed in `registerDocumentVia`, not in `asc types define`.** That module's whole reason for
  existing is that a refusal noticed in one command must apply to all of them. `asc types import`,
  `asc import`, `asc init` and `asc ingest claude-code` reach the producer through the same function
  and all already render `result.warnings`, so the silence closes in every command that could have
  it rather than only in the one where it was noticed.
- **The latest version is asked of `findType(db, name)`** — the call `droppedGuidance` already makes
  one version up, with no version argument and so the `ORDER BY version DESC LIMIT 1` row — not of a
  new query, and not of the version just resolved, which is the thing being compared against.

**The one thing this record asked for that the fix deliberately does not do.** The suggestion below
was to name *the entry count on each* version. `TypeSummary.entryCount` is counted over entries
recorded against **any** version of the name and not yet struck (`packages/store/src/registry.ts`),
so it cannot produce the per-version 0/112 split this record quotes; `struckCount` is likewise a
name-level total. A new store query per version, carrying its own tests, for a number prose does not
by design affect, was not worth it — so the warning names the two versions and what to do, and stops
there.

**What was deliberately not changed.** `outcome` keeps its three values, so `--json` and the table
contract are unchanged and no existing caller or script has to learn a fourth.

**The evidence it works.** Five cases were added to `packages/cli/test/register-document.test.ts`
(15 → 20 tests): the warning itself and its four silences — the resolved version *is* the latest; an
idempotent re-run, which writes nothing; version 2's prose being left alone, which is the fact the
warning exists to report; and a dry run, which is when the document can still be fixed.

Four mutants went into `scripts/mutations/register-document-stale-prose.json`, and the run is the
assertion that the cases are load-bearing rather than merely green:

```
$ pnpm mutate register-document-stale-prose --allow-dirty
| id | verdict | killers that died | survivors |
| M1 | killed by every named killer | 2 | - |
| M2 | killed by every named killer | 2 | - |
| M3 | killed by every named killer | 1 | - |
| M4 | killed by every named killer | 1 | - |
rebuild: node_modules/typescript/bin/tsc -b ok -- no build output is left holding a mutant
4 mutant(s), 0 problem(s). Every named killer killed its mutant.
```

The two that matter are **M1**, which restores the silence this record is about, and **M3**, which
drops the `proseUpdated` guard so the warning fires on an idempotent re-run. M1 is killed only by the
cases that assert the warning, and M3 only by the idempotent-re-run case — so the guard and the
warning are each pinned by a different test, and neither can be removed without a red. **M4** is the
plausible future edit: looking the version up by number instead of asking for the latest, which makes
the two always agree and silently disables the whole check. The killer names were read off the
failing tests' own output after each mutant was planted, not guessed.
