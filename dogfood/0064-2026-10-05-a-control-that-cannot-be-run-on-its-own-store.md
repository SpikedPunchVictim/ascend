# 0064 — a control that cannot be run on the store it was measured against

| | |
|---|---|
| **Bead** | `asc-h7nq` |
| **Surfaced** | 2026-10-05 |
| **Surfaced by** | `asc stats tool_denial --assoc --temporal weekday --blocks day` — run to write up `asc-fwpe`'s own dogfood record, not to test the flags |
| **Entry type(s)** | `tool_denial` (derived, 772 entries), and all 14 registered types |
| **Severity** | P2 |
| **Status** | corrected 2026-10-05: the finding stands — both controls were unrunnable on the store — and the **cause** this record names does not. See *The correction* below |

## What was found

Both controls `asc-fwpe` built, measured, and shipped **cannot be run against the store**, and the
re-issued `docs/evidence/EV-patterns.md` describes an analysis the store cannot reproduce.

The tautology check is unformable: the pair it exists to suppress, `project × repo`, is produced by
the **spike's SQL** over `spike/corpus.db` (`COALESCE(git_branch, '(none)')`), and **no registered
type declares a repository or branch property at all**. The temporal control is unrunnable: **no
registered type declares a date, weekday, day, month, branch or repo property** — the only temporal
property anywhere is `occurred_at`, a `timestamp`, which `--assoc` excludes as non-categorical and
which `--temporal` refuses by name.

This is an **absence**, and it is the kind a code review will not catch: every function in
`association.ts` is correct, every test passes, the flag parses, and the analysis the record
describes was really measured. What is missing is that the *data shape those measurements needed*
lives in a throwaway SQLite artifact and not in any type the store can hold.

## How it surfaced

Writing `dogfood/0064` for `asc-fwpe`, I ran the documented flag line against the live store to
capture output for the record. It refused.

**Nobody was looking for it.** The work up to that point had run the controls against
`spike/corpus.db` through `spike/spike-controls.mjs`, which reads the frozen snapshot with its own
`SELECT` and its own derived columns — `weekday` from `strftime('%w', recorded_at)`, `repo` from
`git_branch`. Both are columns *the spike invented*; neither is a property of `tool_denial`. Because
the spike reproduces EV-patterns exactly (N=409, 41.1 % Thursday, the same four χ² values), nothing
in the comparison looked wrong. The two corpora agree perfectly on every shared number, and disagree
on which fields exist.

The mechanism generalizes, and that is the part worth keeping: **a measurement taken over a
hand-written projection is not a measurement of the schema, and a control validated against the
projection can be unreachable from the schema.** The frozen snapshot made it worse rather than
better — being frozen, it could not drift into disagreement.

## The metric

**1. The tautology is unformable.** `asc stats tool_denial --assoc`, live store, exact output:

```
Warning: 3 pair(s) of 3 properties over 774 entries. q-values are corrected
across a family of 3, which is every pair in THIS run -- asking about ten
properties and asking twice about five are different questions with different
q-values.
a            b          n    excluded  cramers_v            chi2                df   p                      p_adjusted             mutual_information_bits  uncertainty          determinism          p_blocked  asymptotic_valid  small_group
-----------  ---------  ---  --------  -------------------  ------------------  ---  ---------------------  ---------------------  -----------------------  -------------------  -------------------  ---------  ----------------  -----------
denial_kind  project    774  0         0.5363762626339673   970.2171575198853   84   0                      0                      0.8556424877927247       0.36743841371451114  0.46532402994588856             false             false
denial_kind  tool_name  774  0         0.2266255685320021   206.24720947198966  48   0                      0                      0.1751206371148187       0.13837000197965965  0.25292427767320824             false             false
project      tool_name  774  0         0.09747150830533648  339.1985871814993   252  0.0002014210494276636  0.0002014210494276636  0.16313529788548217      0.09293044273601331  0.23561402048598268             false             false
```

Three pairs, no suppression line, family 3. `project × repo` is not among them because `repo` does
not exist here.

**2. The temporal control is unrunnable.** Exact output:

```
Error: 'occurred_at' is not a `string` or `enum` property of 'tool_denial', so
--temporal cannot group by it. Groupable properties: denial_kind, project,
tool_name.
```

**3. No type declares the fields the controls need.** Every `property.<name> <type>` line from
`asc types show` over all 14 registered types, filtered for `/date|day|week|month|branch|repo/`:

```
--- (no output above = no date/day/week/month/branch/repo property in any registered type) ---
      36
```

The `36` is the count of `string`/`enum` properties across those types — the entire categorical
surface available to `--assoc`, none of which is derived from a timestamp.

**4. The two corpora agree on every shared number and disagree on the schema.** `tool_denial` on the
frozen snapshot: N=409, 35 days, Thursday 168/409 = 41.1 %. On the live store: **774 entries**.
`spike/spike-controls.mjs` reproduces the published χ² for all four weekday pairings exactly
(185.50, 327.60, 348.07, 95.88). Nothing about the comparison is wrong; the fields are.

*Not measured:* how many of the live store's 774 `tool_denial` entries carry a usable `git_branch`
in their transcript record — the corpus builder reads one, but no declared property exposes it.

## The pattern

**A capability validated against a projection of the data is not validated against the data.** The
projection here was a `SELECT` list in a throwaway script; the same shape applies to a hand-built
fixture, a scratch table, a denormalized view. The tell is that the validation and the product read
*the same numbers* while reading *different shapes* — which is precisely what makes it invisible.

It is also a **"reports success wrongly"** instance, in the severity-zero class the planning notes
name: `asc-fwpe`'s acceptance was met, the record was re-issued with real numbers, the suite went
green, and the user-facing capability does not work on the user's data.

## Why nothing else would have caught it

- **The analysis tests could not.** `controls.test.ts` and `association.test.ts` feed arrays
  directly; a column that no type declares is not a thing a unit test over `Crosstab` can notice.
- **The CLI tests could not**, and this is the honest part: they use a fixture type that *declares*
  `day` and `weekday` (added in this bead, `TIMED`). That fixture was written to exercise the flags,
  and it proves the flags work — while making the store's own schema invisible by construction. The
  fixture is not wrong; it is a stand-in, and a stand-in cannot report what is missing from the real
  thing.
- **`align check` could not** — it is a structural check and the structure is fine.
- **A code review plausibly would have**, if the reviewer asked "which type declares `weekday`?" That
  question is cheap and nobody asked it, which is an argument for asking it of every derived column a
  spike feeds a control.
- **The frozen snapshot actively hid it.** A live corpus might have grown a property; a frozen one
  cannot, so the two shapes could never drift into disagreement.

## Consequences and constraints

- **The record stands and must not be edited.** `docs/evidence/EV-patterns.md` is the analysis of
  `spike/corpus.db`, stated as such, and its numbers are correct for that snapshot. The 2026-10-05
  Amendment already says the live corpus has grown and that neither control has been re-run on it.
  What it does not say — and what `asc-h7nq` must add — is that the snapshot's *schema* differs from
  the store's, not only its size.
- **The help text is misleading in a way a refusal cannot fix.** `--temporal weekday --blocks day`
  is the documented example, and on this store there is no such property and never was. The refusal
  a user gets names the properties that do exist, which is honest, but it cannot distinguish "this
  corpus has no weekday" from "you misspelled a property" — and the first is the true one.
- **The fix is a choice, not an obvious patch**: derive a bucket from a declared `timestamp`
  property (the `--changepoints` `dayOf`/`weekOf` precedent already exists in the same file), or
  state plainly in the record and the help that the control requires a declared time-derived
  property and that no starter type has one. Deriving is more useful and more expensive; saying so
  is cheap and leaves `asc-jpka`'s shape (library-only capability) in place one level down.
- **Entries are immutable**, so nothing here is a cleanup task over stored data — this is about the
  schema and the record, both of which are prevention-at-write-time problems.

## Links

- Bead: `asc-h7nq`
- Related beads: `asc-fwpe` (the controls, closed by this work), `asc-jpka` (the same shape one bead
  over — capability met in the library, unmet on the surface), `asc-qt6r` (the third control),
  `asc-mqgy` (the two envelope columns nothing fills)
- Evidence record: `docs/evidence/EV-patterns.md`, Amendments 2026-10-05 (`asc-fwpe`) and 2026-10-05
  (`asc-h7nq`)
- Regenerable measurement: `node spike/spike-controls.mjs` (frozen `spike/corpus.db`, 2026-09-11)

## Correction — 2026-10-05, in place, `asc-h7nq`

**The finding stands and half the cause does not.** Both controls really were unrunnable against the
store, and both refusals are quoted above verbatim. What this record gets wrong is *why the tautology
half was unrunnable* — and the *why* is the part that generalizes, so the correction is written out
rather than folded into the prose above. **The temporal half it got right**: nothing declares a
weekday, the only temporal property is a `timestamp`, and the remedy this record itself lists as
option 1 (derive a bucket from a declared `timestamp`, per the `--changepoints` `dayOf`/`weekOf`
precedent) is what `asc-h7nq` built. Its own framing — *"the fix is a choice, not an obvious patch"* —
was accurate, and the choice it ranked first was taken.

**What was wrong.** The record says the fields the tautology check needed are **absent**: *"no
registered type declares a repository or branch property at all"*, and the Consequences section
concludes *"the snapshot's schema differs from the store's"*. The first sentence is true of the
**declared properties**; the conclusion is not true of the **entry**. `RecordedEntry`
(`packages/store/src/recorder.ts:92-118`) carries an envelope of `cwd`, `repo`, `gitSha`, `branch`,
`recordedAt`, `runId`, `workflow`, `actor`, `source` and more, and `ENVELOPE_PROPERTY_NAMES`
(`packages/core/src/spec.ts:148-165`) reserves those names against declaration, so a spec *cannot*
expose them. Measured over the live store's 774 `tool_denial` entries:

```
repo     nonnull 0    levels 0
git_sha  nonnull 0    levels 0
branch   nonnull 774  levels 12
cwd      nonnull 774  levels 45
```

So `branch` — which `asc ingest claude-code` fills from each transcript's `gitBranch` — was present on
every single entry of the type, and unnameable, because `runAssoc` built its columns from
`categoricalProperties(spec)` alone (`stats.ts:422`, `stats.ts:455`). The pair `EV-patterns` builds
its headline tautology on, `project × repo`, is unformable for a **different** reason than the record
gives: `repo` is a dead column, declared in the envelope and filled by no writer (`asc-mqgy`), while
`branch` is the live analogue and sits at determinism **0.876**, above `DEFINITIONAL_AT`.

**How it happened.** The record's own *"How it surfaced"* names the mechanism and then states it one
level too narrowly. The spike's `SELECT` did invent `weekday` and `repo` (`strftime('%w', recorded_at)`,
`COALESCE(git_branch, '(none)')`) — but it also **dropped** `branch` and `cwd`, which the schema does
carry, so the projection differed from the schema in both directions while the record named only one.
The evidence that looked conclusive was `asc types show` filtered for `/date|day|week|month|branch|repo/`,
which reads **declared properties** and is structurally unable to see the envelope. The check that
would have caught it is one line: `asc stats tool_denial --assoc` now prints *"2 of those columns are
read from the entry ENVELOPE rather than a declared property (cwd, branch)"*; before `asc-h7nq` there
was no way to ask the question, because nothing on the command surface read an envelope field.

**What this does not change.** Severity P2, and the "reports success wrongly" classification: a
capability shipped, the suite went green, the record was re-issued with real numbers, and the
user-facing flag did not work on the user's data. The CLI tests' blindness is also unchanged and still
the honest part — the fixture declares `day` and `weekday`, proving the flags work while making the
real schema invisible by construction.

**What it changes about the pattern.** The class was stated as *"a capability validated against a
projection of the data is not validated against the data"*, and the tell as *"the validation and the
product read the same numbers while reading different shapes"*. Both hold. The generalization this
record got wrong is the direction: **a projection can also drop a column the schema carries**, not only
invent one it does not — and when it drops one, the column is still there to be named; what went
missing was any way to **ask** for it. Here the only artifact that could answer "which fields does an
entry have" was `recorder.ts`, while `asc types show` answered a different question that reads like
the same one.
