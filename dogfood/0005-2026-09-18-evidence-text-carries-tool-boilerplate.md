# 0005 — `evidence_text` on `user_correction` is 43 words of tool boilerplate before it is the user

| | |
|---|---|
| **Bead** | `asc-m4u` |
| **Surfaced** | 2026-09-18 |
| **Surfaced by** | `docs/evidence/EV-20.md` — hand-adjudicating every near-duplicate merge on the real corpus |
| **Entry type(s)** | `user_correction` (derived) |
| **Severity** | P2 |
| **Status** | open |

## What was found

`asc ingest claude-code` writes `record['userFeedback']` into the envelope's `evidence_text`
verbatim (`packages/adapter-claude-code/src/derive.ts:767-783`). That field is documented as
holding "what the user actually said and which no other type records"
(`derived-types.ts:159`) — and for the subset of corrections that arrive through Claude Code's
AskUserQuestion tool, it is not. Those entries open with 43 words of the harness's own preamble:

> The user wants to clarify these questions. This means they may have additional information,
> context or questions for you. Take their response into account and then reformulate the questions
> if appropriate. Start by asking them what they would like to clarify. Questions asked:

Identical in every such entry, before a word the user wrote. The adapter is not misreading the
transcript; the transcript's `userFeedback` really does contain this. The defect is that the field
is stored as prose when part of it is an envelope.

## How it surfaced

**Nobody was looking for it.** EV-20 was measuring something else entirely — the false-merge rate
of near-duplicate collapse at various Jaccard thresholds — and the pre-registered plan expected the
prose arm to be the boring one. It merged three entries at a 0.41 trigram threshold, which the
record required be read by hand. They turned out to be three corrections about a testnet wallet,
GitHub issue #11, and a Windows handle-pinning bug, held together by nothing but the preamble.

The mechanism generalizes: **a similarity measure is a detector for whatever is most repeated, and
what is most repeated is often not content.** The same measurement would have found this with any
threshold low enough to merge anything at all. Hand-adjudicating the merges is what made it
visible; a count of groups would have shown "1 group of 3" and read as a success.

## The metric

From the real store, 1,795 entries, `asc export` on 2026-09-18:

- `user_correction` entries: **19**. Carrying the preamble: **10**.
- Preamble length: **293 characters, 43 words.**
- Share of the `evidence_text` it sits in: **median 47.4%**, min 25.8%, max 68.0%.
- Those 10 entries produce **100% of every near-duplicate merge on the entire 97-entry prose
  corpus**, at every threshold, in both the trigram and bag-of-words arms.
- Removing the preamble at the `Questions asked:` marker and re-running:

```
threshold  k=3 groups  k=3 merged  k=1 groups  k=1 merged
0.40                0           0           0           0
0.50                0           0           0           0
0.60                0           0           0           0
0.70                0           0           0           0
0.80                0           0           0           0
```

Every merge in the corpus, gone, for 43 words.

**10 and 19 are both under `MIN_N`** (20, `packages/analysis/src/proportion.ts:50`). The share
figures are an anecdote about ten entries and are reported as counts rather than as an estimate of
any rate. What is not an anecdote is the consequence: the merge count going to zero is a census of
the whole prose corpus, not a sample of it.

## The pattern

**A field whose contract is "raw" inherits whatever the source decides to wrap it in.** The
adapter's rule — copy `userFeedback` verbatim, never paraphrase — is the right rule, and it is
exactly why this got in: verbatim copying is a promise about fidelity to the source, not about the
source being what you think it is. The class is "third-party envelope stored as first-party
content", and the tell is that the repeated part is at a fixed position and identical to the
character.

## Why nothing else would have caught it

No test would. The adapter does precisely what it says, the entries are well-formed, the text is
genuinely what the transcript held, and every existing test asserts round-tripping rather than
meaning. A code review would not either: the preamble is not in this repository's source, it is in
a third party's tool output, so there is nothing to read here that looks wrong.

The only thing that surfaces it is using the text for something that measures repetition — which
is what `asc-yce` was, and it was the first such use.

## Consequences and constraints

Entries are immutable (`entries_are_immutable`, `entries_cannot_be_deleted`, both enforced by
trigger), so the 10 existing entries cannot be rewritten. The options are the usual two: prevention
at write time for future ingests, or an invalidation annotation on what exists. Prevention is
cheap — the marker is a fixed string at a fixed position — but it is a decision about how much of a
third party's format the adapter should be allowed to know, and that is `asc-m4u`'s to make, not
this record's.

One thing this record can say: the near-duplicate module shipped with its default threshold at 0.9
partly because of this. At 0.9 nothing in the prose corpus merges at all, so the defect cannot
manufacture a group under the default.

## Links

- Bead: `asc-m4u`
- Evidence record this came out of: `docs/evidence/EV-20.md`
- Source: `packages/adapter-claude-code/src/derive.ts:767-783`, `derived-types.ts:146-159`

## Correction (2026-09-18)

**What this record originally claimed.** The body above, and its pull quote, describe the
affected entries as 43 words of preamble *followed by what the user wrote* — "before a word the
user wrote", as if the preamble were a prefix on top of real user content. That shape is wrong.

**The measurement that overturns it.** A read-only scan of every `*.jsonl` under
`~/.claude/projects/` on 2026-09-18 (script run in this session's scratchpad, not committed)
found 19 `userFeedback` values in total. **10** begin with the literal `The user wants to clarify
these questions.`; the other **9** are the user's own prose, so a `startsWith` test on that
literal alone has **0** false positives on this corpus. In the 10 affected values, what follows
the preamble is not the user's answer — it is **the questions Claude itself asked**, each
followed by a parenthetical answer line. Across those 10 values there are **17** such answer
lines, and **all 17 of 17** read exactly `(No answer provided)`. So the affected entries contain
**zero** words from the user, not "some preamble plus their words".

**How this changes the fix.** The body above frames the open question as "how much of a third
party's format the adapter should be allowed to know" and suggests stripping the preamble as the
likely answer. Stripping is now known to be the wrong move: with no user words present at all,
stripping the preamble would leave Claude's own questions standing as the `evidence_text` of a
`user_correction` — which reads as plausible user content to a later reader, or to a
`distinctive`/`cluster` run, and is worse than leaving recognizable boilerplate in place. The fix
implemented under `asc-m4u` instead detects the form by its first line only and emits the entry
with `evidence_text` omitted entirely — never stripped-and-kept, never dropped. See
`DeriveCounters.unquotable` in `packages/adapter-claude-code/src/derive.ts`.
