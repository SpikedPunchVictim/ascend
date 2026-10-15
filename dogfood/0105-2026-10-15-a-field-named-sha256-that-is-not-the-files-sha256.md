# 0105 — A field named `sha256` that is not the file's sha256

| | |
|---|---|
| **Bead** | `asc-09wx.8.8` |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | Building the fixture for `asc handlers grade` (`asc-09wx.8.3`) — the grader refused a row whose metric had been written from the file's byte hash |
| **Entry type(s)** | `intervention` (starter) |
| **Severity** | P3 |
| **Status** | open |

## What was found

`intervention`'s `metric.sha256` does not hold the sha256 of the handler file it names. It holds the
sha256 of that handler's **canonical parsed form** — `CompiledHandler.hash`, `sha256Hex(canonicalJson(parsed))`
in `packages/core/src/handler.ts`. The property is described in `packages/cli/src/starters.ts` as the
handler's *"content identity"*, and it is named after an algorithm rather than after the thing the
digest is taken over, so `shasum -a 256 handlers/beads-delivery.yaml` is the natural reading and
returns a different number.

The stored value is the **better** ruler identity, not a bug in itself: a reformatted handler is not
the ruler moving, and the canonical parse is invariant to formatting while the bytes are not.
`packages/core/src/handler.ts` already says so exactly — *"IDENTITY is the sha256 of the canonical
parsed form: comments and formatting do not change it, and any change of meaning does."* The gap is
that the package that *owns the definition a ledger writer reads* does not carry that sentence, and
the field name points the other way. This is a documentation defect with a naming cause, not an
arithmetic one — which is why it cost a debugging cycle rather than a wrong number.

## How it surfaced

Writing `packages/cli/test/handlers-grade.test.ts`, I needed the row's `metric.sha256` for a fixture.
The obvious way to get it was to hash the handler:

```
$ shasum -a 256 handlers/beads-delivery.yaml
e75a2d0b51ff42097e099c06208318116d2079a3190327cff4ddb5463c1908ab  handlers/beads-delivery.yaml
```

and the grader refused, in its own words: *"The ruler has moved since intervention row … was
written."* The ruler had not moved. Read off the handler instead of hashed from disk, the value the
EV-55 row actually stores is

```
da8bdfa79040bfe35c61c3af93c5e4935eff75d8e4360633df304d22f0a6d926
```

**Nobody was looking for it.** The task was "write a fixture". The instrument that caught it was
`asc handlers grade`'s own refusal — a command written in the same session, refusing correctly, on a
value I had produced by taking the field's name at face value.

## The metric

**The two numbers for one file**, and the one that says the stored value is the canonical parse:

```
$ shasum -a 256 handlers/beads-delivery.yaml
e75a2d0b51ff42097e099c06208318116d2079a3190327cff4ddb5463c1908ab  handlers/beads-delivery.yaml

EV-55 row metric.sha256, via `asc handlers grade eee14db2-45a5-4bf4-81a0-853f73674524 --effect 0.5`:
da8bdfa79040bfe35c61c3af93c5e4935eff75d8e4360633df304d22f0a6d926
```

**Invariance under reformatting**, measured against a copy carrying one added comment line
(`load()` from `packages/cli/dist`, and `shasum` on both paths):

```
file bytes        e75a2d0b51ff42097e099c06208318116d2079a3190327cff4ddb5463c1908ab
commented bytes   6e78565f0d503b1426ed8027a2cff36ccf4dd13ef39332ddf47519a8b53ece72
file identity     da8bdfa79040bfe35c61c3af93c5e4935eff75d8e4360633df304d22f0a6d926
commented ident.  da8bdfa79040bfe35c61c3af93c5e4935eff75d8e4360633df304d22f0a6d926
```

The bytes move and the identity does not. That is the property the digest is for, and it is the
property neither the field name nor the description states.

**Corrected: the remedy is a free prose edit, and the way this record first got that wrong is the
same defect it is about, one level down.** The first draft of this section claimed the remedy had to
ride a type-version bump, because a property description is part of a type's identity. That was
measured through `typeHash` (`packages/core/src/hash.ts`), which is `sha256Hex(canonicalJson(spec))`
over whatever spec the caller hands it. A *registered* type is not hashed that way: `specHash`
(`packages/store/src/registry.ts`) is
`typeHash(definitionShape(canonicalizeTypeSpec(spec).spec))`, and `definitionShape` drops the prose
fields — `description`, `record_when` — before hashing. Measured on the real `intervention` starter,
rewording `metric`'s description and re-hashing through both paths:

```
specHash(before)   ab4cad18af3b4b01470527ed629f1ef2da94c083da68f915a2498f150f4348b6
specHash(reworded) ab4cad18af3b4b01470527ed629f1ef2da94c083da68f915a2498f150f4348b6
moves? false

typeHash(before)   f6dcbc17f30090ac05642f8335df32d2a3b46079e33fd05aae9a77a57d200353
typeHash(reworded) b814d93706ea8bd236794c4767e26ef4a74343f1cbca0933fe3c9ccc7603ace2
moves? true

specHash(status enum narrowed) aa6e7dcccb4648e13bee2c353e13ceb557c593287962a76ab5a29a5ebc666f9c
moves? true
```

So the remedy is free — a prose edit mints no version — while a change of meaning still moves it.
`starters.ts` says this outright and this record was written without reading it: *"Prose is free.
`definitionShape` drops `description` and `record_when` before hashing."* **`typeHash` is the trap**,
and it is the finding's own shape recurring: it is exported, its docblock instructs a caller to pass
an already-canonicalized spec and never to pass a *shape-stripped* one, so a caller asking "would this
edit mint a new type version" reaches for it and gets an answer about a definition the store never
hashes.

## The pattern

**A field named after a mechanism, holding the output of a different computation.** `sha256` names
an algorithm; the value is "sha256 *of the canonical parse of* the thing this path points at". Every
word the reader needs is in the phrase the name leaves out. This is the same class as a parameter
named `timeout` that means milliseconds in one call and seconds in the next: the name is true and the
question it answers is not the question the reader asked.

The class recurs wherever **an identity is derived rather than read**. A derived identity has to name
its input, because there is always more than one way to hash the same artifact — raw bytes, canonical
form, normalized form — and all of them are sha256s.

## Why nothing else would have caught it

Honest answer: **a code review plausibly would have**, if the reviewer had been asked "is this
property's name true of its value". Nothing in the test suite is positioned to: every test in this
repo's handler corpus constructs the hash by calling the same compiler the writer calls, so the two
agree by construction and a name that describes neither never gets exercised. The type's own
validator (`metricWithoutRuleIssue`, `packages/cli/src/starters.ts`) checks that a `sha256` is
*present*, not what it is a digest of — and it cannot check more, since a definition language cannot
say "this string is the sha256 of the canonical parse of the file at the sibling property".

That is the argument for the sentence, not for a check: the fact is not machine-checkable at write
time, so it has to be written down where the writer reads it.

## Consequences and constraints

- **Entries are immutable.** The EV-55 row stores `da8bdfa7…` and always will. Nothing here is a data
  repair; a renamed property would need a migration for rows already carrying `sha256`, which is a
  reason to prefer the rewording.
- **A description edit is free** (measured above: `specHash` does not move), so the remedy has no
  version bump to ride and needs none. This is the cheapest possible fix, and the first draft of
  this record made it look expensive by hashing the wrong function.
- **That mistake is a candidate for the same class as the finding itself**, and is left here rather
  than cleaned up: a caller reaching for a plausible exported hash function got a number that
  answers a different question, exactly as a reader reaching for `shasum -a 256` did.
- The refusal itself was correct and cost nothing but time. The instrument is not implicated; the
  documentation is.

## Links

- Bead: `asc-09wx.8.8`
- Built by: `asc-09wx.8.3` (`asc handlers grade`), whose refusal surfaced it
- Entries recorded at the time: the EV-55 intervention row `eee14db2-45a5-4bf4-81a0-853f73674524`
