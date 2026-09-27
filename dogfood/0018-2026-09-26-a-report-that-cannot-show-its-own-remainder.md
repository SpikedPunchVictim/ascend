# 0018 — The handler report counted 3,358 triggers and accounted for 2,870

| | |
|---|---|
| **Bead** | `asc-gtnu.6` |
| **Surfaced** | 2026-09-26 |
| **Surfaced by** | `asc handlers check handlers/edit-verified.yaml ... --json`, read to sanity-check two counts being ADDED |
| **Entry type(s)** | — (no entry type is involved; this is the handler evaluator's own report) |
| **Severity** | P2 |
| **Status** | fixed in `25d4504` |

## What was found

A window that closes with "no match" as its verdict incremented nothing. Not a row, not `unclosed`,
not anything a reader could see. `asc handlers check` printed `triggers`, `rows` and `unclosed`, and
the three did not reconcile — the difference had no key of its own, so the number a reader would need
in order to notice was the number that was missing.

This is an absence, and absences are the ones a code review does not catch: the code was doing
exactly what it said. `close()` had a branch for `session.end` and a branch for everything else, and
the everything-else branch returned no rows without recording that it had. Nothing was wrong. The
report simply could not say what had happened.

## How it surfaced

Stage 3 of `asc-gtnu` was extending the handler DSL, and it added two reported counts
(`noMatch`, `unsatisfiedBefore`) because a construct that can decide a window without emitting a row
needs a way to say so. Checking the new counts meant re-reading the old ones, and the old ones did
not add up:

```
edit-verified  rows 2815  triggers 3358  unclosed 55
```

3358 − 2815 − 55 = 488. Nothing in the report could produce that 488.

**Nobody was looking for it.** The question in hand was whether the counts being *added* were right.
This one predates them by however long the handler evaluator has existed, and it survived every
review and every mutation test it had, because no test asserted that the report's own arithmetic
closes.

The mechanism, and it is the one worth remembering: **the new construct's honest-accounting
requirement exposed the old construct's dishonest accounting.** Writing down "a decided window must
be counted" for `noMatch` made the absence of that rule for the pre-existing path visible, by putting
a number next to it that did not fit.

## The metric

`/tmp/frozen-root` — a frozen copy of this project's transcripts, 90 files, 115,954 events, taken
because this session's own writes to the live transcript directory moved the corpus under the
measurement. Pre-fix binary, exact output:

```
edit-unverified   rows 488  triggers 3358  unclosed 55
edit-verified     rows 2815 triggers 3358  unclosed 55
read-unused       rows 367  triggers 2167  unclosed 0
subagent-outcome  rows 44   triggers 88    unclosed 44
```

`edit-verified`: **488 of 3,358 triggers (14.5%)** decided with "no match" and counted nowhere.
Post-fix, same corpus: `triggers 3358, rows 2815, unclosed 55, noMatch 488` — the arithmetic closes.

The live corpus at the time of discovery read `triggers 3326` for the same handler, giving 488 of
3,326 (14.7%); the two denominators differ only by this session's own activity after the freeze.
Both are stated rather than one being picked, because which corpus a denominator came from is part of
the number.

A second, smaller instance of the same class was found and reported at the same time: for a handler
declaring `before:`, a trigger whose reference had no match. Stage 0 measured that case at
**194 of 831 (23.3%)** on subagent pairs and **98 of 257 (38.1%)** on the main control — so it is the
common case, not an edge.

## The pattern

**A report that prints a total and its parts must print every part.** Any subtraction a reader can
perform and not complete is a silent zero waiting to be read as agreement. The general form: a
counter that exists for one branch of an expression and not the others. `asc-6ola.9` named the same
class for `until` equal to the watched kind (`dogfood/0016`); this is its second instance, and the
two together say the class is not rare here — it is what happens whenever a construct can terminate
without producing output.

The class has a cheap detector: **for every report, check that the headline count equals the sum of
the counts that decompose it.** That is not a test anyone writes spontaneously, because it asserts a
property of the *report* rather than of the *thing reported*.

## Why nothing else would have caught it

- **A test would not have.** There was no bug in the evaluator. Every existing handler test asserted
  the rows it got; none asserted that `triggers = rows + unclosed + noMatch`, and no test *could*
  have asserted it before `noMatch` existed as a key.
- **A review would not have.** `close()` read correctly: it closed the window, returned no rows, and
  the `session.end` branch counted correctly. The omission was in what the function did not say.
- **A mutation test would not have.** There was nothing to mutate. Removing the missing increment is
  not an edit.
- **What did catch it** was reading two numbers side by side and finding that they did not add up —
  possible only because a new key forced the old numbers to be looked at again.

So: not caught, and not catchable by the instruments this repo already had. It was caught by
arithmetic performed on a report while writing a different report.

## Consequences and constraints

None on the data — no entry was written wrongly, and entries are immutable anyway. The constraint is
on the response: this is a *report* defect, so the fix is a reported count, not a changed verdict.
Every window that was decided-no-match before is still decided-no-match; only the counting changed.
That distinction matters here, because the fix had to leave all four existing handlers' rows,
triggers and unclosed **byte-identical** — verified over the frozen corpus at matching `--samples`,
on the bytes actually committed.

## Links

- Bead: `asc-gtnu.6` (closed)
- Related class: `dogfood/0016-2026-09-24-single-form-window-kind-false-green.md` (`asc-6ola.9`)
- Related measurement: `spike/review-join/FINDINGS.md` (Stage 0's 194/831 and 98/257)
- Commit: `25d4504`
- Stage: `asc-gtnu.4`; transition entry `e2c02361-ae8d-45ad-a316-a54ea74ea97a`
