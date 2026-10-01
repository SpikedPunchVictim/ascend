# 0048 — a premise that expired without saying so

| | |
|---|---|
| **Bead** | `asc-y7p` |
| **Surfaced** | 2026-09-30 |
| **Surfaced by** | going to measure `asc-y7p`'s own stated trigger — `bd show asc-y7p` names the condition, and the first thing measuring it required was checking whether the instance it was written about still existed |
| **Entry type(s)** | `user_correction@1` (derived), `verification_run@1..@3` (derived), `skill_activation@1` (derived), `review_finding@2` (derived) |
| **Severity** | P2 — matching the bead. Nothing is recorded wrongly; the cost is a question that cannot fire |
| **Status** | no code change. The premise is corrected by this record and by the bead comment it accompanies |

## What was found

**A bead's factual premise had expired, and the count it was stated in still agreed.**

`asc-y7p` holds the case for field-scoped invalidation, deliberately unbuilt, against "the 10 legacy
entries" whose `evidence_text` carried the AskUserQuestion clarification preamble. That state no longer
exists: `grep -ro "The user wants to clarify these questions" .ascend/entries/` returns **0**. The
deriver fix (`asc-m4u`) makes `derive.ts` pass `evidenceText` as `undefined` for an unquotable form, and
re-derivation is what removed the contamination — nothing was invalidated, and no strike was written.

The premise is nevertheless self-confirming. The corpus still holds **10** `user_correction` entries
whose `evidence_text` is absent, so the number in the bead is still the number in the store; only the
fact behind it changed, from *contaminated* to *deliberately withheld*. A later reader who checked
"are there still 10?" would find yes. The tool_denial strike note two sections down makes the same
observation about a different pair of numbers — *"the two numbers agree by coincidence rather than by
derivation"* — and this is that sentence's second instance.

The bead's other premise is not evaluable at all. Its trigger reads *"Reopen the design question when a
SECOND, unrelated instance appears — that is the trigger, not the passage of time."* That is a condition
on the store, and **no query evaluates it**: it fires only if someone re-measures by hand, which is what
this session did.

## How it surfaced

Measuring the trigger. The question on the table was *has a second instance appeared*, which is a
question about a corpus — and answering it honestly required first establishing that the first instance
was still there. It was not. Nobody was looking for an expired premise; the search was for a second
instance, and the premise expired in the course of the search.

Three successive detectors built for that search were themselves blind, and each printed a confident
number before being caught:

1. A shared-prefix scan keyed on the **longest common prefix of the whole bucket** cannot see the case it
   was built for — the preamble was 10 of 19, and the genuine prose in the other 9 shortens the LCP
   below any threshold. It reported `none`.
2. A field census keyed on `type_name` alone reports `failure_scenario: absent 112` of 130, because a
   field declared in `review_finding@2` reads as absent on every `@1` row. Keyed on
   `(type_name, type_version)` the version explains it, and the remaining 112 are all `captured_by:
   parsed` — a route, not a loss.
3. A check for the field `category` found **0** of 130 entries carrying it. The type does not declare
   `category`: the nine lens slugs live in `class`, and `review_completed.findings[].category` is an
   explicitly *different axis* (`review_finding@2`'s own prose says so).

Each of these is an instrument that would have manufactured a defect had its first output been
believed, and they are recorded here rather than discarded because they are the same failure as the
finding: **a result read as an answer when it was only a measurement of the instrument.**

## The metric

Measured 2026-09-30 on this repo's own tree (`.ascend/`), by walking the JSONL corpus directly — the
derived index was not used, because two of the three detectors above were wrong in ways the index would
have shared.

**The first instance is gone:**

```
grep -ro "The user wants to clarify these questions" .ascend/entries/ | wc -l
0
```

`user_correction@1`, **24** entries: `evidence_text` present on **14** / absent on **10**. All 10
absences carry `tool_name: AskUserQuestion` (10 of 10); the 14 present values are other tools and are
genuine prose (lengths 59, 67, 81, 88, 100, 151, 159, 228, 240, 283, 329, 407, 419, 761, 2832 — 14 of
the 15 listed because one is a duplicate key). That is what ties the 10 absences to the preamble entries
by a field other than the one under test, rather than by the count alone.

**No second instance exists.** The corpus holds **3,144** invalidation lines under **20 distinct notes** —
every decision this store has ever recorded about why an entry stopped counting is one of 20 sentences:

```
superseded    2,579    verdict superseded  563    wrong_subject  2
```

Every one is entry-level by design. The sharpest candidate for the bead's shape is the batch whose note
says *"the verdict is the check's own, but previous_verdict was taken from an earlier run whose
`is_error` a later command owned"* — a right subject with one wrong field, struck whole. The test is
whether a re-derived sibling exists (the offending field simply absent, the entry otherwise sound):

```
struck 498 across the wrong_value batches on verification_run
  with a re-derived sibling: 1
```

**497 of 498 have no sibling**, so the store's own decision — *"v2 writes no entry for such a run"* — was
actually carried out: the event yields no entry under the fixed deriver, and striking the whole row is
the correct granularity rather than a wider one. The single sibling is confounded (its v4 note credits
the status to a *different* entry under a different bug).

Two groups in that count are **anecdotes, under `MIN_N` (20)**: the 3-line batch above and the 2
`wrong_subject` strikes on `tool_denial`. Both are reported as instances, not as rates.

**Structural facts that bear on the design question:**

```
strikes naming a DERIVED entry id   3,140 of 3,144
events carrying more than one type version   89 of 1,951
types whose entries are ALL derived   context_compaction@1, review_finding@2,
                                      skill_activation@1, tool_denial@1,
                                      user_correction@1, verification_run@1, verification_run@2
entries declaring a non-empty na[]   2 of 6,618
```

The first line is the one the bead did not have: a strike names a deterministic derived id, and a derived
row is regenerated under that id, so **a strike outlives the defect it named**. It cannot be retracted
(`asc-k6p.2`, deliberately unbuilt). Every field absence found in the census — `discovered_tools` 282 of
854, `previous_verdict` 769 of 4,442, `line` 2 of 130, `agent` 83 of 232, `tests_passing` 3 of 51,
`wrong_conclusion` 4 of 17, `arms` 18 of 43, `measured_on` 24 of 43 — carries declared type prose naming
the absence as intended, each distinguishing it from an empty array (*"looked and found nothing"*) and
from zero (*"line 0 is not a place in a file"*). The 730 entries with a `<user>`/`<project-A>`
placeholder project are redaction (`asc export --redact`, `entryDifference`'s `redacted` list), not
contamination.

## The pattern

**A stored claim about a body of data, which the data can falsify and nothing checks.** The claim is not
code, so no test reads it; it is not a query, so no run evaluates it; and it is not the data, so
re-derivation does not touch it. It expires silently in the one direction nobody looks — the claim stays
put while its subject moves.

`dogfood/0043` is the same shape one level down ("a rationale nobody checked" — a doc comment false
about the module it names, where the *behavior* was already tested and green). `dogfood/0047` is the same
shape on coverage ("a guard that stops at the top level" — a listing that narrows without saying so). In
all three the report is true about what was read and false about what it claims, and in all three the
distinguishing test is the same: **ask what would have said so.**

Here the answer was *nothing*, and the sharper form is that a cheap check confirms the stale premise
rather than contradicting it, because the count survived the change.

## Why nothing else would have caught it

A test could not: the premise is prose in an issue tracker, and no test reads it.

A review could have, but only by checking the claim against the store rather than reading it — which is
what a review of a *design question* does not do. The bead's own comment shows the failure mode plainly:
it records that option (b) was taken for the documentation half on 2026-09-22 and that *"THIS BEAD STAYS
OPEN ON PURPOSE"*, so the last person to read it was reading it carefully, and the premise was already
stale by then — the fix that made it stale (`asc-m4u`) had shipped.

`asc doctor` does not cover it: it reads the store for dead types, near-duplicates and drift, and this is
a claim held outside the store.

The honest counter: re-reading the bead *could* have caught it. The bead names `annotations.ts:83` and
the ten entries, and the ten are still ten. Catching it required going to the corpus and reading the
field's *content* rather than its count.

## Consequences and constraints

**The bead stays open**, as its own comment instructs, and no field-scoped invalidation should be built
on this evidence. The trigger has not fired: there is no second instance, and the first is gone. If
anything the measurement argues against the feature from the other side — for a derived row the remedy
that works is fixing the deriver and re-deriving, which is what removed instance 1 and what the 2,579
`superseded` strikes record; a narrower strike would still be a permanent annotation on a row that gets
rebuilt.

**Entries are immutable** (`entries_are_immutable`, `entries_cannot_be_deleted` enforced by trigger), so
nothing here is a cleanup task, and there is nothing to clean: the 10 entries are correct as they stand,
with the prose withheld and `derive.ts:1289-1294` stating why.

**There is no invalidation vocabulary for a bead's prose.** The three labels act on entries. A premise
that expired has no representation, which is why this record and the bead comment are the remedy rather
than a mechanism.

**One open question, NOT measured and deliberately not claimed:** whether `asc ingest claude-code
--dry-run` could be extended to report which existing rows a fresh derive would no longer produce, which
is what the 20 strike notes assert in prose (several say the fixed deriver writes no entry for the shape
they struck). The dry run already previews produced lines and the deriver is documented as deterministic
and idempotent over event-keyed ids, so the gap may be small or may not exist. It is recorded here as
unmeasured rather than filed as a bead on the strength of a reading.

## Links

- Bead: `asc-y7p` (P2) — holds the field-granular question; its premise is corrected by this record
- Related records: `dogfood/0043` (a rationale nobody checked), `dogfood/0047` (a guard that stops at the
  top level), `dogfood/0005` (the preamble, the record the stale premise was derived from),
  `dogfood/0012` (the verdict defect behind the 498 `wrong_value` strikes)
- Code: `packages/adapter-claude-code/src/derive.ts:1283-1294` (`quotable`, `counters.unquotable`),
  `ARCHITECTURE.md:159-169` (three-state property values), `.ascend/types/0001.jsonl` (`review_finding@2`
  prose on `failure_scenario`, `class`, `catchable_by`)
- No entries were recorded at the time: this finding is about a claim held outside the store.
