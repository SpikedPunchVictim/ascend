---
name: ascend-analysis
description: 'Teaches the ascend analysis method -- profile, sample, cluster, propose rule, back-test, annotate -- over an ascend corpus. Triggers: "analyze the corpus", "ascend analyze", "classify entries", "propose an annotation rule", "back-test a rule".'
version: 1.0.0
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  tier: analysis
  category: evidence
---

# Ascend Analysis

## Before anything: know what you can even see

Run bare `asc` (it prints `asc types brief`) before analysing anything. It lists every entry
type this project registers and when each is supposed to be recorded. A type you did not know
about is a population you silently excluded from the analysis -- and you cannot back-test your
way out of a population you never sampled.

## The six-step method

### 1. Profile

```bash
asc explore <type>
```

The map, before any rows. Read the shape of a type before you read individual entries: its
properties, their distributions, its size. Profiling first is what keeps step 2 from being a
blind draw.

### 2. Sample

```bash
asc explore <type> --sample random|stratified|diverse|outlier [--by <prop>] [--limit N] [--seed S]
```

`--by` is REQUIRED by `--sample stratified` -- it names the categorical property to stratify on.
Omit `--seed` and the draw is fixed and reproducible; pass one only when you deliberately want a
different draw. Use `random` for a plain cross-section, `stratified` to guarantee coverage of a
known category, `diverse` to spread across the space, `outlier` to surface the edges a random
draw would dilute.

### 3. Cluster

```bash
asc stats <type> --cluster --threshold <t> [--linkage average|complete|single]
asc stats <type> --distinctive --by <prop>
asc stats <type> --duplicates
```

`--cluster` groups entries lexically over their prose (needs `--threshold`, a cosine distance
cut; `--linkage` defaults to `average`). `--distinctive` surfaces the terms that mark one group
out from the rest, grouped `--by` a property. `--duplicates` collapses near-duplicate entries
into one representative plus a count, so a cluster you're about to call "common" isn't actually
one entry repeated.

```bash
asc search <type> <text>
```

`asc search` covers `evidence_text` ONLY -- not properties, not the type name. A search that
comes back empty, or thin, may simply be looking in the wrong place: a property-level pattern is
invisible to it. Treat a clean `search` result as evidence about the prose, never as evidence
about the type as a whole -- a search that silently misses properties is how a wrong conclusion
gets drawn.

### 4. Hand-label a sample

```bash
asc annotate --scheme hand --ids '<label>=<id>,<id>'
```

Repeatable, and one pass may carry several labels this way. This hand pass is your ground truth
for step 5 -- it has to exist before you can grade anything against it.

### 5. Back-test BEFORE writing

```bash
asc annotate --scheme <s> --rule '<label>=sql: <predicate>' --backtest hand
```

This grades the proposed rule against the `hand` pass as ground truth and reports precision,
recall and support per label, plus the disagreements. **It writes nothing.** A separate check,
`--dry-run`, runs the rules and reports the census without writing either -- use it once a rule
has passed back-testing, to see what it would classify at full scale before committing.

### 6. Commit the pass

```bash
asc annotate --scheme <s> --rule '...' [--scope '<sql predicate>'] [--actor <who>]
asc kappa --scheme a --scheme b
asc kappa --scheme <s> --pass <t1> --pass <t2>
```

Only after back-testing clears, commit the real pass. `--scope` narrows which entries this run
considers (the reported unclassified remainder is a remainder of that scope, not the whole
type). `--actor` records who or what produced the pass. Then run `asc kappa` -- across two
schemes, or two passes of one scheme -- to measure whether the classification is reproducible or
the model was guessing.

**Rule syntax**: `'<label>=<kind>:<query>'`, where `kind` is `sql` (a predicate over an entry) or
`fts` (a text query over evidence text). Rules apply in the order given, and the **first match
wins**. Say that explicitly to anyone using this method -- rule order is a silent correctness
trap: a broad rule placed first will shadow every narrower rule after it, and the tool will not
warn you.

## The judgement rules this skill exists to carry

### Back-testing is not optional

A rule that has never been graded against hand truth is a guess with SQL syntax. The method is
hand-label -> propose -> back-test -> only then a real pass. This is the single most important
instruction in this file. Do not let "the rule looks obviously right" substitute for step 5.

### MIN_N = 20

(`packages/analysis/src/proportion.ts:50`). A group under 20 is an ANECDOTE and must be named as
one -- including when the anecdote is flattering. Report the n alongside every proportion you
state; a percentage with no n beside it is not a finding.

### Omitted, never fabricated

Where a value does not exist, omit it. Never write `0` for unknown -- a fabricated zero looks
identical to a measured zero to everyone downstream of you.

### Entries are immutable, and that is a feature

Enforced by SQL triggers. You never fix data. A classification you now believe is wrong is
corrected by running a NEW pass, not by editing anything -- both passes coexist, and `asc kappa`
is how you compare them. Immutability applies to the OBSERVATION; the INTERPRETATION is the
annotation layer, which is versioned and re-runnable by design.

### A pass is identified by (scheme, schemeVersion, createdAt)

Because the corpus is append-only, a pass timestamp is a sufficient statistic for what data that
classification could have seen. This is what lets you reason about a pass after the fact without
re-deriving it.

### Classifying by what came later is legal

An `annotate` rule's SQL predicate may contain a correlated subquery, so an entry can be
classified by what happened AFTER it was recorded. This is what makes after-the-fact,
data-over-time classification possible -- e.g., labelling a `decision` by whether it was later
reversed.

### `--ids` is the escape hatch

When a judgement cannot be expressed as a rule, label the entries directly by id
(`--ids '<label>=<id>,<id>'`) rather than bending a rule until it looks right. A contorted rule
that happens to match the hand set is not a generalization -- it's overfitting with extra steps.

## When the analysis is done, it is itself evidence

This is the half of "recall" that the opening section does not cover. Knowing which types exist
stops you excluding a population; this stops the analysis evaporating.

An analysis that reached a conclusion produced exactly the thing this corpus is for, and the
corpus does not know about it until someone records it:

- A question you named BEFORE running anything, now answered with numbers -- `evidence_record`.
  Copy the `measurement` verbatim, as the tool printed it. A paraphrase of a number is a new
  number, and only the exact text is what a later search or re-check can match against.
- A choice made between approaches that were both real options -- `decision`. If there was only
  one reasonable thing to do, it was not a decision, and recording it as one makes the entries
  that matter harder to find.
- A rule you back-tested and then REJECTED -- record that too. A rejected rule with its
  precision and recall is worth more than a silent retry, because the next person to propose the
  same rule can read why it failed instead of rediscovering it.

Run bare `asc` to see what each type wants before you record against it. If nothing here fits,
prefer the most specific type that does over reaching for `note` -- a corpus where everything is
a `note` is a corpus where nothing can be queried by shape.
