# 0122 — A scorer that reads a seed set the run never saw

| | |
|---|---|
| **Bead** | `asc-3yqq` |
| **Surfaced** | 2026-10-21 |
| **Surfaced by** | running `node spike/recall/score.mjs` to draw a cross-model complement for `asc-gtnu.13` |
| **Entry type(s)** | none — no entries were recorded; the finding is in a spike's stdout |
| **Severity** | P2 |
| **Status** | fixed in the working tree (not yet committed) |

## What was found

`spike/recall/score.mjs` reads `spike/recall/seeds.json` at run time and scores every run in
`spike/tmp/recall/ledger.json` against it. The two are not tied together. `asc-gtnu.15`'s
pre-registration commit (`b6b7630`) extended that document from 81 seeds to 190 — five new classes
and `time_concurrency` from 11 to 20 — while every tree in the ledger was built from the 81-seed
version.

The scorer therefore has no way to tell "the reviewer did not find this seed" from "the reviewer was
never shown this seed". It reports both as an escape. Re-running it today against the same 24
transcripts and the same findings does not reproduce EV-28: it produces a different measurement, and
the difference is largest exactly where the seed document grew.

## How it surfaced

Nobody was looking for it. The scorer was run to answer `asc-gtnu.13`'s question — which lens classes
does the other model find that this one does not — and its `Prediction 4` block came back with
`time_concurrency S=9 O=10`, against EV-28's published `S=8 O=9`. The EV record says those runs found
8 and 9 of 11 seeds; the scorer said 9 and 10 of 20. Both numbers were "correct" for the document each
had open.

The mechanism is the one this repository has already written down once, for a different input: a
measurement whose input is rebuilt instead of pinned cannot be re-run, only re-derived into something
else. Here the input was not rebuilt by the scorer, it was edited underneath it by a later bead that
had every right to edit it, and the scorer had no way to say so.

## The metric

Identical findings, identical ledger, identical scorer; only the seed document differs.

Against the live `seeds.json` (190 seeds), `node spike/recall/score.mjs`:

```
A claude-sonnet-5  time_concurrency                 45.0% (95% CI 25.8-65.8%, n=20)
A claude-opus-5-5  time_concurrency                 50.0% (95% CI 29.9-70.1%, n=20)
B claude-sonnet-5  time_concurrency                 45.0% (95% CI 25.8-65.8%, n=20)
B claude-opus-5-5  time_concurrency                 60.0% (95% CI 38.7-78.1%, n=20)
time_concurrency                 S=9 O=10 J=0.900
pooled J=0.766
```

Against the snapshot the trees were built from, `git show 1f50aba:spike/recall/seeds.json`
(`sha256=8c8a9d77127514bd1bf9926e54790a8dc26d473fd88fd2058ad5ca6c06981b5a`, n=81),
`node spike/recall/score.mjs --seeds spike/tmp/recall/seeds-ev28.json`:

```
A claude-sonnet-5  time_concurrency                 72.7% (95% CI 43.4-90.3%, n=11)  [SMALL GROUP n=11 < 20 -- treat as anecdote, not estimate]
A claude-opus-5-5  time_concurrency                 81.8% (95% CI 52.3-94.9%, n=11)  [SMALL GROUP n=11 < 20 -- treat as anecdote, not estimate]
B claude-sonnet-5  time_concurrency                 81.8% (95% CI 52.3-94.9%, n=11)  [SMALL GROUP n=11 < 20 -- treat as anecdote, not estimate]
B claude-opus-5-5  time_concurrency                100.0% (95% CI 74.1-100.0%, n=11)  [SMALL GROUP n=11 < 20 -- treat as anecdote, not estimate]
time_concurrency                 S=8 O=9 J=0.889
pooled J=0.762
```

Every other figure in the report is identical between the two runs, including `runs completed=24
failed=0 total spent=$11.7667` and the hand-label check `agreement 0.975, Cohen's kappa 0.844`. The
pinned run reproduces EV-28 exactly.

The worst part is not the recall: it is the flag. EV-28 reported `time_concurrency` as an anecdote at
n=11, under `MIN_N`=20. Against the longer document the class reads n=20 and the `[SMALL GROUP …]`
annotation disappears, so the same finding becomes a number a reader would take as an estimate.

## The pattern

An instrument that reads its own input from a mutable location, with nothing in its output naming
which version it read, cannot distinguish an edit to the input from a change in the measurement. The
edit was legitimate — `asc-gtnu.15` is a separate bead extending the seed set on purpose — which is
what makes the trap general: the danger is not a careless edit, it is a right edit arriving after the
runs.

This is the same class as `dogfood/0120` (a control reproducible from its seed and not its input
order): a reproducibility claim with one of its halves left to whatever the caller had open.

## Why nothing else would have caught it

There is no test. `spike/` is outside the suite by convention, and the scorer's output is a text file
in an ignored directory — EV-28 is prose plus pasted output, and nothing re-runs it. A gate would not
have caught it either: every run was green, and each individual number was the true output of the
document it was computed against.

What catches it is a reader noticing that a published count moved, which is what happened here, and
only because the `asc-gtnu.13` complement needed the same scorer.

## Consequences and constraints

- The fix is a flag, not a pin: `score.mjs` takes `--seeds <path>` and prints
  `seeds <path> sha256=<hash> n=<count>` as the first line of its report. The default is still the
  live document, because a fresh run against a fresh tree is the normal case. The report now says
  which document it read, so the two readings can no longer be mistaken for each other.
- No test was added: the scorer is a spike, and `spike/` is outside the suite. The runnable check is
  the reproduction above — `--seeds` on the pinned snapshot must return `pooled J=0.762`, and it does.
- The EV-28 record stands as published. Its numbers were the truth about the 81-seed document; what
  was missing was the document's identity, now carried by the scorer.

## Links

- Bead: `asc-3yqq`
- Evidence record: `docs/evidence/EV-28.md`
- Pre-registrations: `spike/recall/PREREG.md`, `spike/recall/PREREG-gtnu15.md`
- Seed snapshot: `git show 1f50aba:spike/recall/seeds.json`
