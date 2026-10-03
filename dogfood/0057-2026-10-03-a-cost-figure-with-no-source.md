# 0057 — a P1's central cost figure has no source, and is not reproducible

| | |
|---|---|
| **Bead** | `asc-igg8` |
| **Surfaced** | 2026-10-03 |
| **Surfaced by** | auditing the bead's own premise with `bd show asc-igg8` and `asc search`, before designing against it |
| **Entry type(s)** | `decision`, `evidence_record` (both starter) |
| **Severity** | P1 — the bead is a P1 and this is its spine |
| **Status** | open |

## What was found

`asc-igg8` asks for a retained event log and prices it at **16,380,630 bytes raw / 3,937,484 gz for
all 16,251 tool inputs in this project's ~35 days**, calling that *"a measurement rather than an
estimate"* and *"the whole argument for the cost"*. The figure has **no recoverable source**: it
appears only in the `asc-6ola` note that cites it and in a model-written compaction summary. It is
not in `spike/replay/FINDINGS.md`, not a field `spike/replay/replay.mjs` emits, not in git history,
and not in any `.ascend` entry. Re-measured over a frozen scope, no constructible scope produces it.

The same description carries a second unreproducible quantity: **"~35 days"**. This project's
transcript directory spans **2026-09-12 .. 2026-10-03, 21 days by mtime**.

## How it surfaced

**Someone was looking, deliberately.** The premise audit was commissioned as a step of the work
itself, not stumbled into — the bead is a P1 that would authorise building a new store surface, and
its justification is a premise chain, so the chain was checked before the design started. Saying so
plainly is the point: this is *not* the more valuable "nobody was looking for it" case, and it should
not be cited as evidence that dogfooding pays for itself. What it is evidence of is different and
narrower — **that a figure can survive a bead, a plan, a spike and a close reason without anyone
re-deriving it, and that the only thing which caught it was a reader choosing to check.**

The mechanism that made it visible is worth naming: the audit was **cheap**. Establishing that the
number had no source took one `bd show` and three `rg` calls, because the artifact that would have
held it (`spike/replay/FINDINGS.md`) is in the repo and searchable. The expensive part was only the
decision to look.

## The metric

Re-measured over a frozen scope (`timestamp <= 2026-10-03T09:08:02Z`, 132 files, 105,216 lines,
459,944,234 bytes), verbatim from `node spike/event-log/cost.mjs`:

```
--- Q4: the carried figure ---
bead note 6 (carried):     16251    16380630  3937484   (no recoverable source)
i   full tool inputs     27462   29276075  6221485   raw 1.787x gz 1.580x of carried
ii  slim (argv<=4)       27462   22043834  4404292   raw 1.346x gz 1.119x of carried
iii full, redacted       27462   29275995  6221477   raw 1.787x gz 1.580x of carried
```

The closest shape to what was actually built (`asc-bolz`'s slim log) is still **1.35× the carried raw
bytes over 27,462 inputs against the carried 16,251**. No scope this spike could construct yields
16,380,630.

Corpus span, read-only over `~/.claude/projects` (188 project directories):

```
projects total: 188 | machine-wide oldest transcript: 2026-08-27T06:45:13.557Z
age of machine-wide oldest: 37.1 days
```

Full method and every prediction, including the two that failed, in
`spike/event-log/PREREG.md` and `spike/event-log/FINDINGS.md`.

## The pattern

**A carried figure.** A number is measured once, on a scope nobody records, and thereafter is quoted
as though the scope travelled with it. Each re-quote makes it look better-sourced, because it is
cited from a document rather than from its own absence of a source.

This is the same class as `dogfood/0055` (an epic closed with no reason and three requirements that
never existed) one level down: there, a *requirement* was carried with nothing behind it; here, a
*measurement* is. `asc-6ola`'s own close note already warned *"A carried figure is not a measured
one"* — and then carried one, in the same description, in the same sentence as the words *"a
measurement rather than an estimate"*. **The warning and the failure are co-located, which is the
strongest statement of the class this series has.**

The tell, and it is a usable one: **right order of magnitude, wrong number, no scope.** A fabricated
figure tends to be wrong by a factor, not by 13%; a carried one is real but was measured on a
different corpus.

## Why nothing else would have caught it

Nothing in the repository's automated surface can: a figure in a bead description is prose, and prose
is not what `asc doctor`, `align`, or the test suite checks. **`asc` has no type that requires a
measurement to name its scope** — `evidence_record` asks for `measurement` verbatim, but it is keyed
to a question named in advance, and this figure was never that.

The honest counterfactual: the spike that produced the figure *would* have caught it, if the number
had been recorded as tool output in `spike/replay/FINDINGS.md` rather than summarised into a bead.
**The rule the repo already has — paste exact tool output rather than paraphrasing a number — would
have prevented this**, and it was the only thing that would have. It was followed in this spike's own
FINDINGS.md and in `dogfood/0056`, which is why both are reconstructible.

## Consequences and constraints

- **The bead's premise is unproven, not false.** Q2 found **no expiry observable** and the
  machine-wide oldest transcript at 37.1 days, past the ~30-day default the bead cites. The pressure
  the bead names is not present on this machine today. A 21-day project cannot observe a 30-day
  boundary at all.
- **The decision is now the owner's, on measured numbers.** Whether ascend needs a retained event log
  is a question about which questions handlers are asked; this record does not answer it. It removes
  the cost figure that was doing the answering.
- **Nothing here is a cleanup task.** The bead description can be amended (it is live metadata, not an
  immutable entry); the entries that cite the figure cannot. A correction belongs in a new entry that
  names the old one.
- The scope of the re-measurement is pinned by a timestamp cutoff rather than a clone — the copy that
  `asc-bolz` used was declined by the permission classifier here. A file deleted between the freeze
  and a later re-run would change the answer and nothing detects it. Stated in `PREREG.md`, repeated
  because it is the one way these numbers can silently drift.

## Links

- Bead: `asc-igg8` (P1)
- Audit commissioned from: the `asc-6ola` close note, which cites the figure and warns about carried ones
- Evidence record: `docs/evidence/EV-39.md`
- Method and predictions: `spike/event-log/PREREG.md`, `spike/event-log/FINDINGS.md`
- Same class, one level up: `dogfood/0055`
