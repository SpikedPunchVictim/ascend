# 0059 — a "scratch project" fixture wrote into this repo's real store, and nothing said so

| | |
|---|---|
| **Bead** | `asc-squ` |
| **Surfaced** | 2026-10-03 |
| **Surfaced by** | re-running `spike/asc-squ-ratio-survey.mjs` after building a fixture it should have been unaffected by |
| **Entry type(s)** | `note_cjk` (project-defined, **accidental**) — 8 entries, plus the type registration |
| **Severity** | P2 — no committed state was corrupted and the writes were uncommitted, but the mechanism silently writes to the wrong corpus with no signal |
| **Status** | **reverted before commit** (see Consequences — this is the one place the doctrine's "prevention at write time" was available and was taken) |

## What was found

A shell fixture intended for a throwaway directory wrote **8 entries and one type registration into
this repository's own store**, and every command in the fixture exited 0 with no indication of where
it had written. `asc record`'s JSON confirms the write with an `id`, a `type` and a `recorded_at` —
and names no store, no path, and no project. So a caller who has set `HOME` and `XDG_CACHE_HOME` to a
scratch directory, which is what this repo's own `explore-budget.test.ts` does to isolate a fixture,
gets a write to the **cwd's** store. The isolation was assumed, not verified, and the tool said
nothing either way.

## How it surfaced

**Nobody was looking for it.** The fixture was built to produce a number for `dogfood/0058`, and the
write succeeded exactly as far as any of its own assertions were concerned.

What caught it was an *unrelated* measurement re-running and disagreeing with itself. The survey
behind `asc-squ`'s promotion condition (`spike/asc-squ-ratio-survey.mjs`) had recorded **0 non-Latin
script across 6,885 records** an hour earlier. Re-run after the fixture, it printed:

```
script                     string values containing it
CJK (han/kana/hangul)             8   fields: note
...
   U+6F22                       320
```

Eight values, one field, one code point — the fixture's exact shape. A survey that is supposed to be a
statement about a codebase's *language* had become a statement about a fixture written minutes before,
and the only reason that was visible is that the same figure had been taken twice.

**The generalizable mechanism: a measurement is also a tripwire, but only if it is re-run.** The
number here is not the point; the point is that a stored figure taken once and quoted thereafter has
no way to notice that the world it described has changed — which is `dogfood/0057` one layer out. The
cheap version of the check is to re-run your own survey at the end of the work and diff the answer.

## The metric

Exact output, `node spike/asc-squ-ratio-survey.mjs`, before the revert and after:

```
--- while the fixture was present
store: 14 record file(s), 6912 record(s), 110420 string value(s)
non-ASCII string values: 160
script                     string values containing it
CJK (han/kana/hangul)             8   fields: note
any non-Latin script present: YES
   U+6F22                       320

--- after reverting the accidental writes
store: 13 record file(s), 6904 record(s), 110348 string value(s)
non-ASCII string values: 152
script                     string values containing it
CJK (han/kana/hangul)             0
```

**Deltas: +8 records, +72 string values, +8 non-ASCII values, +320 U+6F22 code points, +1 record
file, +1 type registration.** Every one of them from the fixture. The `note` field on the second line
is the fixture's own property name, which is what makes the attribution unambiguous rather than a
plausible story.

The counts before and after are not identical for reasons that have nothing to do with the fixture —
the store gains records continuously, including this record's own subject. That is precisely why the
check is a **diff of the script's output** and not a remembered total: `6,885` became `6,904` legitimately
over the same hour, so a remembered number would not have located the 8.

## The pattern

**Isolation you have to remember to establish is isolation that will fail silently.** The repo already
has the right instinct in tests: `explore-budget.test.ts` sets `HOME` and `XDG_CACHE_HOME` and copies
a seed `.ascend/` into a fresh `mkdtemp` directory, and *also* runs with `cwd` set to that directory —
because the store resolves from the cwd. Reproducing that fixture in a shell, I kept the environment
half and dropped the cwd half, and nothing in the toolchain noticed. Two mechanisms that must agree
for a fixture to be isolated, with no way to assert that they do.

The narrower instance, and the one that is ascend's: **a write reports what it wrote and not where it
wrote it.** Every other destructive-or-durable command in this CLI names its target (`--dump <dir>`
resolves and warns, `init` prints the store it created). `record` is the one durable write that takes
no target and prints none, so "which corpus did that go into" is a question the caller answers from
their shell history.

## Why nothing else would have caught it

- **Every command in the fixture exited 0**, which is correct — the commands did what they were told.
  There was no error to notice.
- **The fixture's own assertions were satisfied**, because the entries really were recorded. A test
  that checked its own fixture would have passed.
- **`git status` shows it, and I had run it** — the untracked `.ascend/entries/note_cjk-…/` and the
  modified `.ascend/types/0001.jsonl` were both visible in output I read to check something else. It
  was there, in front of me, and read past. This is the honest answer to "why nothing else caught it":
  a signal existed and was not consulted, because it was being read for a different question.
- **A gate would not have caught it.** `pnpm test` and `align` do not read `.ascend/`; nothing in the
  quality gate observes the store's contents.

## Consequences and constraints

- **The writes were reverted rather than invalidated, and the doctrine says why that was available.**
  `entries_are_immutable` (enforced by trigger) makes an invalidation annotation the usual remedy for
  bad data. Here a second option applied that the usual case does not have: **nothing was committed**,
  so the writes had not entered any durable record — this was prevention at write time, taken late,
  rather than a cleanup of recorded data. Reverting a *committed* entry would be exactly the silent
  rewrite the invariant forbids, and is not what happened here.
- **The type registration was the more durable half.** A struck entry stops counting; a registered
  type is a line in `.ascend/types/0001.jsonl` that other surfaces enumerate. It is worth noting that
  the repo offers no in-band way to withdraw a type registration — the remedy was `git checkout` of a
  tracked corpus file, which is only available because the store is a git tree.
- **A real store has no equivalent.** A user who hits this with a real, pushed store cannot revert;
  they invalidate and live with the type. The mitigation is a signal at write time, which is what the
  record argues for.

## Links

- Bead: `asc-squ`
- The finding this fixture was being built for: `dogfood/0058`
- The figure it invalidated, and the record it rhymes with: `dogfood/0057`
- The measurement that caught it: `spike/asc-squ-ratio-survey.mjs`
- The test that does the isolation correctly: `packages/cli/test/explore-budget.test.ts` (`emptyProject`, `asc`)
