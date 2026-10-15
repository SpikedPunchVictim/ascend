# 0110 — a value list restated in prose three times, and two had drifted

| | |
|---|---|
| **Bead** | `asc-09wx.8.9` (the remaining prose copies; the two that had drifted are corrected in the working tree) |
| **Surfaced** | 2026-10-15 |
| **Surfaced by** | adding a fourth value to `entries.source` for `asc-09wx.8.7`, and grepping for every place the value list is spelled so the new value would reach all of them |
| **Entry type(s)** | none — the finding is about source comments, not about the record tree |
| **Severity** | P3 — nothing is recorded wrongly; the cost is a reader being told the vocabulary is smaller than it is |
| **Status** | both prose copies corrected in the working tree; a bead is filed for the remaining ones |

## What was found

**Every prose copy of the `entries.source` value list was wrong, and the only one that was right was
the one written on the same day the last value was.**

The vocabulary was `self`, `derived:claude-code`, `derived:git`. Three places restated it:

- `ARCHITECTURE.md`'s column listing read `-- 'self' | 'derived:claude-code'`
- `packages/cli/test/ingest.test.ts` read `source IN ('self','derived:claude-code')` — inside a docblock
  whose entire subject is *that this coupling must not drift*
- `packages/adapter-claude-code/test/derive-real-corpus.test.ts` quoted the CHECK in full, all three
  values, correctly

The two that said two-of-three were missing `derived:git`, which `asc-09wx.9` added to the SQL CHECK
and to `ENTRY_SOURCES` without either prose copy moving. The third was right for a reason that does
not generalize: it was written into the file by the same feature that added `derived:git`, so it was
correct by recency rather than by any mechanism — and it was stale again the next day, when
`observed:capture` landed and the quoted CHECK became a three-of-four list. Which is why it had to be
edited during `asc-09wx.8.7`, one day after it was written.

The executable declarations still agreed with each other, because
`packages/cli/test/ingest.test.ts` asserts the adapter's constant against the store's list — so the
one pair a test could check was checked, and the two pairs nothing could check had both rotted.

The ingest docblock is the sharper half, because it names the hazard and then commits it. It says
`recordEntry` does not validate `source` at runtime and that enforcement is the CHECK, so the
adapter's constant and the store's vocabulary are *"two independent declarations of the same fact
with nothing tying them together"* — and then spells the CHECK out a third time, wrong. A reader
who came to that comment to learn the vocabulary was told `derived:git` was not one of the values.

## How it surfaced

Not by the task. `asc-09wx.8.7` was about what `source` means for a row ascend **observed** rather
than derived or was told; the prose copies were found by grepping for the string so the new value
could be added to each of them. The grep was a *find-the-callers* pass, the kind that is normally
mechanical, and the hits it turned up included two that were already wrong about the value that was
there before the one being added — and a third that was right, and that the grep's own answer would
have been enough to trust.

The mechanism worth repeating: **an edit that adds a value to a list has to find every copy of the
list, and the copies that cannot be executed are the ones that were already stale.** The stale ones
do not announce themselves — they are the same shape as the correct ones, they sit next to correct
code, and the only thing distinguishing them is that no tool reads them.

## The metric

Exact text before the change, from `git show HEAD:` at each path:

```
ARCHITECTURE.md
  source,                                   -- 'self' | 'derived:claude-code'

packages/cli/test/ingest.test.ts
 * CHECK constraint (`source IN ('self','derived:claude-code')`). So the adapter's constant and the

packages/adapter-claude-code/test/derive-real-corpus.test.ts
    //     packages/store/src/schema.ts  CHECK (source IN ('self', 'derived:claude-code', 'derived:git'))
```

The constraint itself, which all three were restating:

```
CHECK (source IN ('self', 'derived:claude-code', 'derived:git', 'observed:capture')),
```

**2 of 3 prose restatements had drifted, each stale by the same value; the third was correct only
because it was written the same day. 2 of 2 executable declarations still agreed.** The executable
pair is held together by an assertion (`packages/cli/test/ingest.test.ts` asserts the adapter's
`DERIVED_SOURCE` is in the store's `ENTRY_SOURCES`); the prose copies are held together by nothing.
Two of them were wrong for the whole life of `asc-09wx.9`, and the third was wrong within a day.

A fourth prose site describes the axis rather than listing values (`packages/cli/src/entry-document.ts`'s
`source` bullet), and it was stale in the same way for the same reason, which is what `asc-09wx.8.7`
had to correct.

`n = 3` prose copies in `n = 1` checkout — well under `MIN_N = 20`, named as an anecdote rather than
reported as a rate.

## The pattern

**A fact restated where no tool can read it is not documentation, it is a second implementation with
no test.** The distinguishing property is not that prose is unreliable — it is that a restatement can
be *wrong and load-bearing at the same time*: the reader who opens `ingest.test.ts` to learn the
vocabulary gets the answer the comment gives, and the comment is the only thing there. This is the
class `dogfood/0109` is an instance of one level down: there, a docblock said a rule lived in one
place while the code kept a second copy; here, a docblock *describes* the copy and gets it wrong.

## Why nothing else would have caught it

Nothing asserts a comment. Both copies passed every gate on every commit, and the whole suite was
green throughout `asc-09wx.9` — correctly, because no behaviour depended on either sentence. The two
declarations that *could* disagree were tied by a test, and that test is exactly why they had not
disagreed; the prose had no equivalent and so had no signal at all. The correction available is the
one applied here: point the prose at the single spelling rather than repeating it, so there is
nothing left to drift.

## Consequences and constraints

The remaining prose copies are pointed at `schema.ts` now, which is the only spelling that cannot
drift. What is *not* fixed: the same class is still live wherever a value list is restated for a
reader — the class-wide work is filed as a bead rather than assumed, because each remaining copy has
to be judged on whether pointing at the source is enough or whether the reader genuinely needs the
values named locally.

## Links

- Bead: `asc-09wx.8.7` (the change), `asc-09wx.8.9` (the remaining prose copies)
- Related: `dogfood/0109` (a docblock claiming a rule lived in one place)
