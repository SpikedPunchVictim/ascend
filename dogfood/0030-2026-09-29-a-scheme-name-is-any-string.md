# 0030 — a scheme name is any string, so it cannot be assumed to be a path segment

| | |
|---|---|
| **Bead** | `asc-i5tj.5` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | the first run of `readRecordTree`/`openRecordWriter` against the project's own `asc export` corpus |
| **Entry type(s)** | `decision` (`hand_empty`) — the record layer's path-segment rule |
| **Severity** | P2 |
| **Status** | open |

## What was found

E12's layout partitions records by name — `entries/<type_name>/0001.jsonl` and
`annotations/<scheme>/0001.jsonl` — and the first draft of `encodeSegment` (then `pathSegment`)
refused any name outside `[a-z0-9_]`, on the stated grounds that a name reaching the store is
canonical. That is true of a TYPE name and false of a SCHEME name. `canonicalName`
(`packages/core/src/spec.ts:105`) folds every non-alphanumeric run to `_` before a type name is
stored, so `a/b` becomes `a_b`. `requireName` (`packages/store/src/annotations.ts:394`) refuses only
the empty string and the reserved `invalidation`, so a scheme name is any string at all.

The layer therefore could not file a scheme the store had already accepted, and the refusing version
threw on this project's own store the instant it was pointed at real data. The guard is now
`encodeSegment`: bytes outside `[A-Za-z0-9._-]` are percent-encoded, `.` and `..` are escaped
explicitly, and the empty name is refused. Nothing is decoded on the way back — the name travels on
every line, so the directory never has to be read as a name.

## How it surfaced

Not by review, and not by any of the 26 tests written for the layer — every one of them passed with
the refusing guard in place. It surfaced from a round trip of **real** data: `asc export` piped into
`parseCorpus`, then through `openRecordWriter` and back out through `readRecordTree`. The first
append threw.

**Nobody was looking for it.** The trigger was a decision to strengthen weak evidence (synthetic
fixture literals) with a real corpus, not a suspicion about names. The fixture helper in the test
file generates `typeName: 'note'` and `scheme: 'review'` — names the author chose, which is the one
property a synthetic name can never have.

## The metric

The names that exist in the project's store, taken from the export the round trip was run over
(`asc export` → `/tmp/real-export.jsonl`, 10,263 lines, 7,787,742 bytes):

```
$ grep -o '"kind":"scheme","name":"[^"]*"' /tmp/real-export.jsonl | sort -u
"kind":"scheme","name":"by_kind"
"kind":"scheme","name":"hand_layer"
"kind":"scheme","name":"hand-denial"
"kind":"scheme","name":"invalidation"
"kind":"scheme","name":"layer"
"kind":"scheme","name":"rule-denial"
"kind":"scheme","name":"shuffled-denial"
```

3 of 7 scheme names are outside `[a-z0-9_]`. This is a census of one store, not an estimate — n=7 is
below `MIN_N`, so it is an anecdote about how many, and it is not evidence about how often. What it
does settle is the existence claim: a canonical-looking alphabet is not a property the store
enforces, so a layout may not rely on it.

The failure it caused, verbatim:

```
Error: record: scheme "hand-denial" is not usable as a path segment -- expected lowercase letters, digits and underscores (a canonical name).
    at pathSegment (packages/store/dist/jsonl-files.js:98:15)
```

## The pattern

**An assumption about data that only a synthetic fixture can satisfy.** The guard's premise was
checkable in one command against real data, and the test suite could not check it at all, because a
fixture is written by the same person who wrote the assumption: `note`, `review`, `todo` are all
canonical, so the tests confirmed the assumption instead of testing it. The class is broader than
names — anywhere a layer constrains an input by an alphabet, the question is not "do my fixtures
satisfy it" but "does the WRITER satisfy it", and the only way to answer is to feed it something the
author did not type.

## Why nothing else would have caught it

A review plausibly *could* have: the reviewer would have had to read `requireName` and notice that it
constrains less than `canonicalName` does. That is a real path, so this is not a case for "no review
would find it" — but nothing in the change *invited* that reading, because the layer's own tests and
its own fixtures agreed with it. `align check` cannot see it (no import edge is involved), and the
type system cannot (both are `string`).

## Consequences and constraints

Percent-encoding is a format decision, not just a code one: the directory names it produces are part
of the on-disk layout that E12.4 migrates to, and a hand-written or hand-merged tree has to match
them. It is recorded here rather than only in the code because the encoding is the kind of thing that
is invisible until a tree written by a different version is read.

The related question is **not** settled by this record: whether a scheme name *should* be any string.
`requireName`'s permissiveness may itself be the defect, and narrowing it would make the encoding
unnecessary for schemes — but that is a store-level decision with existing data behind it (`hand-denial`
is already recorded under that name), so it is a bead, not a change to be made here.

## Correction (2026-09-29, same day, after an adversarial review)

The **finding above stands** — a scheme name is any string, and a layout may not assume an alphabet.
The **remedy it describes does not**: percent-encoding was replaced the same day, because a review
found it was not injective, not bounded, and not case-safe. The three defects and their single cause
are in `dogfood/0032` and in the module's `encodeSegment` doc; the short version is that the segment
has to be a *function* of the name rather than a rendering of it, so it is now a readable slug plus a
12-hex digest of the name. That digest is itself taken over a lossless spelling of the string, because
`sha256Hex` encodes to UTF-8 and so collapses an unpaired surrogate — the first version of the digest
still produced one directory for `'\uD800'` and `'�'`.

Left as an appended correction rather than an edit, because the paragraph above is what was believed
at the time and the *shape* of the error is the point: a guard premised on an assumption that only a
synthetic fixture can satisfy. Rewriting it would delete the evidence that the first remedy was
chosen by the same instinct as the bug.

## Links

- Bead: `asc-i5tj.5`
- Parent: `asc-i5tj` (E12), stage `asc-i5tj.1`
- Related: `dogfood/0031` (a type line carries no version), surfaced by the same round trip
