# 0083 — an `absent` window that matches is counted nowhere, and reads as a window that never opened

| | |
|---|---|
| **Bead** | filed separately — see *Links* |
| **Surfaced** | 2026-10-12 |
| **Surfaced by** | `asc handlers check handlers/edit-unverified.yaml` over a foreign repo's corpus, answering *"how many units does one session produce?"* |
| **Entry type(s)** | `search_miss` — the type that fits; **not recorded at the time**, see *The metric* |
| **Severity** | P2 — an instrument that reports the opposite of what happened, in the counter a reader uses to find out |
| **Status** | open |

## What was found

`handlers/edit-unverified.yaml` triggers on `file.changed` and opens an `absent` window — *"nothing
checked this edit"* — bounded by `until: prompt.submit`, with `absent: {on: check.run}`. Over n8n's
four transcripts `asc handlers check` printed

```
edit-unverified  triggers                           6
edit-unverified  rows                               0
edit-unverified  unclosed                           1
edit-unverified  noMatch                            0
```

`rows 0` out of `triggers 6` reads as *no edit went unchecked* — which is the opposite of what
`absent` means. The window closes with a row when nothing matched; **five of those six windows are
gone because a `check.run` DID match**, and those five increment no counter at all. The tuple
accounts for one trigger: `6 = rows 0 + unclosed 1 + noMatch 0` leaves 5 unexplained.

**The mechanism is one `continue` that no longer reports.** In `step`'s close loop, a window whose
match is evaluated has three outcomes, and each is counted differently:

```ts
if (window.mode === 'first') { … out.push(… rows(…, 'match')); continue; }   // a ROW
if (window.mode === 'absent') {
  // Decided: something matched, so nothing is emitted and the window is done.
  continue;                                                                   // NOTHING
}
one.count += 1;                                                               // a COUNT
```

and `close()` — the other way a window leaves the open list — increments `unclosed` or `noMatch` in
every branch it has:

```ts
if (spec.mode === 'count')  { …; if (closedBy === 'session.end') unclosed += 1; else noMatch += 1; return []; }
if (spec.mode === 'absent') { …; if (closedBy === 'session.end' && spec.until !== 'session.end') { unclosed += 1; return []; }
                              return rows(one.trigger, one.scope, closedBy); }
if (closedBy === 'session.end') unclosed += 1; else noMatch += 1; return [];
```

Read end to end, those are the only two exits from the open list, and the `absent` branch of the
first one is **the only place in the whole handler where a decided window is neither emitted nor
counted.** A `first` that matches emits a row. A `count` that matches carries its count. An `absent`
that matches has a verdict — *"the watched thing happened, so the handler has nothing to say"* — and
the verdict is recorded as silence.

**This is the same silence `noMatch` was built to close, and its own docblock says so for two of the
three modes.** The counter's documentation reads:

> Windows DECIDED, with "no match" as the verdict, by a bound other than the stream ending: a `first`
> closed by its `until` or its `calls` limit without a match, or a `count` closed below `at_least`
> (asc-gtnu.4). **This counter closes a silence that predates this stage.** Before it, such a window
> emitted nothing and incremented nothing, so a reader with `triggers: 3326, rows: 2782, unclosed: 56`
> could not tell the remaining 488 windows from windows that never opened.

That is the exact reading I was misled by, in the exact shape — **488 of 3,326 triggers (14.7%)** for
a `first`/`count` handler then, 4,941 of 5,907 (83.6%) for this `absent` one now. `asc-gtnu.4` closed
the class for `first` and `count`, named both in the docblock, and left the third mode with the
silence intact.

## How it surfaced

By reading a counter as an answer, in a pilot that was not about counters. `asc-hllr` asked two
questions — does the hook fire in a foreign repo, and how many units does one session produce — and
`rows 0` was on screen beside the unit count. It was read as an outcome row: *n8n's sessions never run
a check after an edit.* It is not that. The handler was working exactly as designed; the number a
reader would take for the answer is the one number that cannot be the answer.

Nobody was looking for it, and the shape of the near-miss is the reason it is worth a record. The
five vanished windows had to be chased through three hypotheses — a broken replay, a `where` that
over-matched, a trigger counted twice — before the source was read line by line and the `continue`
was found. **The three failed hypotheses were all attempts to make the tool wrong.** The tool was
right; the counter was silent.

## The metric

| | n8n corpus | this repo's corpus | |
|---|---|---|---|
| `triggers` | **6** | **5907** | events matching `on` + `where` |
| `rows` | **0** | **910** | windows that closed with nothing matched |
| `unclosed` | **1** | **56** | undecided when the stream ended |
| `noMatch` | **0** | **0** | decided "no match" by another bound |
| **accounted for** | **1** | **966** | `rows + unclosed + noMatch` |
| **counted nowhere** | **5** | **4941** | `absent` windows closed BY a match |
| **share** | **83.3 %** | **83.6 %** | |

Obtained by running `asc handlers check handlers/edit-unverified.yaml` — over
`--project -Users-…-ascend-backtest-n8n` for the left column, over this repository's own log for the
right. Both counts are exact integers from the tool; the shares are arithmetic on them.

**Two corpora is under `MIN_N` (20), so no rate is being claimed and none should be read out.** 83 %
is not an estimate of how often an `absent` window matches — it is what these two corpora happen to
show, and the two agree only because a `check.run` following an edit is common in both. The claim
that carries is structural and is verified exhaustively rather than sampled: reading every branch of
every exit from the open list, `absent`-matched is the only uncounted one. A third corpus could move
the share anywhere; it could not move the mechanism.

**The entry that would have carried this was not recorded.** `search_miss` is the type for it —
*"the test is whether the RESULT supported a conclusion the evidence did not: a zero read as 'does
not exist' qualifies"* — and the condition was met the moment `rows 0` was read as an outcome. It was
not, because by the time the mechanism was understood the reading had already been discarded and the
chase had moved on to the source. That is a second, smaller instance of the thing this series keeps
finding: **the record that would document a near-miss is skipped precisely when the near-miss is
caught**, since catching it makes it feel as though it never happened.

## The pattern

**A counter that exists to make a verdict visible must cover every mode that can produce the verdict,
or it re-creates the silence one mode over.** `noMatch` was designed against an enumeration — `first`,
`count` — and the enum it enumerated was not the enum of window modes. The three modes are decided in
two functions, and the person adding the counter read one of them.

The narrower statement is about what a zero means. **`rows: 0` over `triggers: 6` is a number with two
readings, and the tool prints no way to tell them apart**: the watched thing never happened (the
handler's whole purpose, working), or the watched thing happened six times (the handler deliberately
saying nothing six times). In a control experiment the second reading is the one that matters, and it
is the one the display cannot reach.

## Why nothing else would have caught it

The handler's tests would not, and do not. `absent` is well covered —
`packages/core/test/handler.test.ts` pins that an `absent` window emits when nothing matched, and that
it stays silent once a watcher has matched, which is the behavior I read out of the source and which is
**correct**. Nothing about emitting nothing is a bug. What no test asserts is the *partition*: the
file's own driver returns `{ rows, noMatch, unclosed }` and not `triggers`, so no assertion in it
could notice that the three do not sum to the fourth. The counter docblock states the intent at
length and no test states the invariant.

A code review would not. The `continue` carries a comment — *"Decided: something matched, so nothing
is emitted and the window is done"* — which is a true and complete description of what the line does.
The omission is in the line's *neighborhood*, not in the line: the counter that should have been
incremented is declared on the interface, documented against a list of modes that does not include this
one, and the person reading the `continue` is reading a sentence about emission.

`asc store verify` and the corpus tests would not: nothing is stored wrongly and nothing about the
event stream is in question. The corpus is read-only and this is a display of it.

## Consequences and constraints

**The pilot's own conclusion had to be corrected before it was written down.** Measurement 4 of
`docs/evidence/EV-49.md` was going to report the outcome handler's count as an outcome. It now reports
the counter tuple as the finding and says explicitly that `0` is not a statement about n8n.

The `noMatch` precedent argues for the fix and gives it its shape: a counter for the third mode,
incremented in the `absent` branch of the match loop, with the invariant — `triggers` partitions
across the counters — asserted by a test rather than by a docblock. The name is the open design
question, not the mechanism: `noMatch` reads as *"decided, nothing matched"* and this is *"decided,
something matched"*, so the pair needs names that cannot be mistaken for each other.

An immutable-entry note, because this record is about a measurement and not about data: no stored
corpus is affected and no annotation is owed. The counts that were wrong were never written to disk —
they were on a terminal and in a draft that was corrected before it was committed.

## Links

- `docs/evidence/EV-49.md` — Measurement 4, where this surfaced and where the corrected reading lives
- `dogfood/0082` — the other defect the same pilot surfaced
- `asc-hllr` — the pilot bead
- `packages/core/src/handler.ts` — `close()`, the match loop's `absent` branch, and `noMatch`'s docblock
- `asc-gtnu.4` — the stage that added `noMatch` and closed this silence for `first` and `count`
- `packages/core/test/handler.test.ts` — the `absent` coverage that is green throughout
